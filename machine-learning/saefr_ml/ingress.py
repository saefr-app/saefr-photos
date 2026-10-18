"""Bounded in-memory body parsing, without Starlette temporary upload files."""

import json
import logging

from python_multipart import MultipartParser
from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import parse_options_header

from .errors import ServiceError

IMAGE_LIMIT = 20 * 1024 * 1024
JSON_LIMIT = 16 * 1024
ENVELOPE_LIMIT = IMAGE_LIMIT + 64 * 1024
# The parser can otherwise log pieces of malformed private request data.
logging.getLogger('python_multipart.multipart').disabled = True


def parse_json(raw, model):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate field')
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError('Non-finite JSON constant')

    return model.model_validate(json.loads(raw, object_pairs_hook=pairs,
                                          parse_constant=invalid_constant))


async def chunks(request, limit):
    length = request.headers.get('content-length')
    if length is not None:
        if len(length) > 10 or not length.isascii() or not length.isdigit():
            raise ServiceError('INVALID_REQUEST')
        if int(length) > limit:
            raise ServiceError('PAYLOAD_TOO_LARGE')
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise ServiceError('PAYLOAD_TOO_LARGE')
        yield chunk


async def text_body(request):
    if request.headers.get('content-type', '').split(';')[0].lower() != 'application/json':
        raise ServiceError('INVALID_REQUEST')
    content = bytearray()
    async for chunk in chunks(request, JSON_LIMIT):
        content.extend(chunk)
    return bytes(content)


class ImageParts:
    def __init__(self, boundary):
        self.parts = {}
        self.ended = False
        self.count = 0
        self.parser = MultipartParser(boundary, {
            'on_part_begin': self.begin, 'on_header_field': self.header_field,
            'on_header_value': self.header_value, 'on_header_end': self.header_end,
            'on_headers_finished': self.headers_finished, 'on_part_data': self.data,
            'on_part_end': self.part_end, 'on_end': self.end,
        })

    def begin(self):
        self.count += 1
        if self.count > 2:
            raise ServiceError('INVALID_REQUEST')
        self.headers, self.field, self.value = {}, bytearray(), bytearray()
        self.header_bytes = 0
        self.name = None
        self.content = bytearray()

    def append_header(self, target, data, start, end):
        self.header_bytes += end - start
        if self.header_bytes > 4096:
            raise ServiceError('INVALID_REQUEST')
        target.extend(data[start:end])

    def header_field(self, data, start, end):
        self.append_header(self.field, data, start, end)

    def header_value(self, data, start, end):
        self.append_header(self.value, data, start, end)

    def header_end(self):
        field = bytes(self.field).lower()
        if field in self.headers or field not in {b'content-disposition', b'content-type'}:
            raise ServiceError('INVALID_REQUEST')
        self.headers[field] = bytes(self.value)
        self.field.clear()
        self.value.clear()

    def headers_finished(self):
        kind, options = parse_options_header(self.headers.get(b'content-disposition', b''))
        name = options.get(b'name')
        if kind.lower() != b'form-data' or name not in {b'metadata', b'image'}:
            raise ServiceError('INVALID_REQUEST')
        self.name = name.decode('ascii')
        if self.name in self.parts or (name == b'metadata' and b'filename' in options):
            raise ServiceError('INVALID_REQUEST')

    def data(self, data, start, end):
        if self.name is None:
            raise ServiceError('INVALID_REQUEST')
        limit = JSON_LIMIT if self.name == 'metadata' else IMAGE_LIMIT
        if len(self.content) + end - start > limit:
            raise ServiceError('PAYLOAD_TOO_LARGE')
        self.content.extend(data[start:end])

    def part_end(self):
        self.parts[self.name] = bytes(self.content)
        self.content.clear()

    def end(self):
        self.ended = True


async def image_body(request):
    kind, options = parse_options_header(request.headers.get('content-type', ''))
    boundary = options.get(b'boundary', b'')
    if kind.lower() != b'multipart/form-data' or not 1 <= len(boundary) <= 200:
        raise ServiceError('INVALID_REQUEST')
    parts = ImageParts(boundary)
    try:
        async for chunk in chunks(request, ENVELOPE_LIMIT):
            parts.parser.write(chunk)
        parts.parser.finalize()
    except MultipartParseError:
        raise ServiceError('INVALID_REQUEST') from None
    if not parts.ended or set(parts.parts) != {'metadata', 'image'}:
        raise ServiceError('INVALID_REQUEST')
    return parts.parts['metadata'], parts.parts['image']
