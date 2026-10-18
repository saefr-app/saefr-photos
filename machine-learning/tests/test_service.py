import hashlib
import io
import json
from pathlib import Path
import struct
import threading
import time
import unittest
import zlib

from fastapi.testclient import TestClient
from PIL import Image

from saefr_ml.app import Settings, create_app
from saefr_ml.contract import ImageResult, ModelSpec, TextResult
from saefr_ml.engine import decode_image
from saefr_ml.errors import ServiceError
from saefr_ml.ingress import ImageParts, JSON_LIMIT, IMAGE_LIMIT

TOKEN = 'test-token-for-local-tests-only-0000000000'
AUTH = {'Authorization': 'Bearer ' + TOKEN}
SPEC = ModelSpec(model_id='example/paired', revision='1' * 40,
                 artifact_digest='2' * 64, preprocessing_digest='3' * 64, dimensions=3)


def png():
    output = io.BytesIO()
    with Image.new('RGB', (8, 4), 'red') as image:
        image.save(output, 'PNG')
    return output.getvalue()


def text_request():
    return {'schema_version': '1', 'task': 'text_embedding',
            'request_id': '00000000-0000-4000-8000-000000000003',
            'scope_id': '00000000-0000-4000-8000-000000000002',
            'model': SPEC.model_dump(), 'text': 'a red square'}


def image_request(content):
    text = text_request()
    return {key: value for key, value in {
        **text, 'task': 'image_embedding', 'text': None, 'scope_id': None,
        'subject': {'asset_id': '00000000-0000-4000-8000-000000000001',
                    'scope_id': text['scope_id'], 'generation': 1},
        'image': {'sha256': hashlib.sha256(content).hexdigest(), 'byte_size': len(content),
                  'media_type': 'image/png'},
    }.items() if value is not None}


class FakeEngine:
    spec = SPEC

    def load(self):
        pass

    def embed_text(self, text):
        return [1.0, 0.0, 0.0]

    def embed_image(self, content, media_type):
        with decode_image(content, media_type):
            return [1.0, 0.0, 0.0]


class ServiceTests(unittest.TestCase):
    def client(self, engine=None, timeout=1):
        settings = Settings(TOKEN, Path('unused-model'), Path('unused-registry'),
                            inference_timeout=timeout)
        return TestClient(create_app(settings, lambda: engine or FakeEngine()))

    def upload(self, client, content=None, metadata=None, more=()):
        content = png() if content is None else content
        metadata = image_request(content) if metadata is None else metadata
        return client.post('/v1/embeddings/image', headers=AUTH, files=[
            ('metadata', (None, json.dumps(metadata), 'application/json')),
            ('image', ('ignored.png', content, 'image/png')), *more])

    def test_health_auth_and_fail_closed_configuration(self):
        with self.client() as client:
            self.assertEqual(client.get('/health/live').status_code, 200)
            self.assertEqual(client.get('/health/ready').status_code, 401)
            self.assertEqual(client.get('/health/ready', headers=AUTH).status_code, 200)
            self.assertEqual(client.post('/v1/embeddings/text', json=text_request()).status_code, 401)
            self.assertEqual(client.get('/docs').status_code, 404)
        with self.assertRaises(ValueError):
            Settings('short', Path('x'), Path('y'))

    def test_image_and_text_success_echo_contract(self):
        with self.client() as client:
            response = self.upload(client)
            self.assertEqual(response.status_code, 200, response.text)
            result = ImageResult.model_validate_json(response.content)
            self.assertEqual(result.subject.generation, 1)
            response = client.post('/v1/embeddings/text', headers=AUTH, json=text_request())
            self.assertEqual(response.status_code, 200)
            TextResult.model_validate_json(response.content)

    def test_model_failure_blocks_readiness_without_leaking_paths(self):
        engine = FakeEngine()
        engine.load = lambda: (_ for _ in ()).throw(ValueError('/private/model/secret'))
        with self.client(engine) as client:
            self.assertEqual(client.get('/health/live').status_code, 200)
            self.assertEqual(client.get('/health/ready', headers=AUTH).status_code, 503)
            response = client.post('/v1/embeddings/text', headers=AUTH, json=text_request())
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()['code'], 'MODEL_UNAVAILABLE')
            self.assertNotIn('private', response.text)

    def test_model_mismatch_and_unknown_fields(self):
        with self.client() as client:
            request = text_request()
            request['model']['revision'] = 'a' * 40
            response = client.post('/v1/embeddings/text', headers=AUTH, json=request)
            self.assertEqual(response.status_code, 409)
            request = text_request()
            request['storage_path'] = '/private/file'
            self.assertEqual(client.post('/v1/embeddings/text', headers=AUTH,
                                         json=request).status_code, 422)

    def test_corruption_mime_and_transfer_integrity(self):
        with self.client() as client:
            for content in [b'not an image', b'broken\xff\xd8']:
                response = self.upload(client, content=content)
                self.assertEqual(response.json()['code'], 'INVALID_IMAGE')
            metadata = image_request(png())
            metadata['image']['sha256'] = 'a' * 64
            response = self.upload(client, metadata=metadata)
            self.assertEqual(response.json()['code'], 'INVALID_IMAGE')
            self.assertEqual(response.json()['request_id'], metadata['request_id'])
            metadata = image_request(png())
            metadata['image']['media_type'] = 'image/jpeg'
            self.assertEqual(self.upload(client, metadata=metadata).json()['code'], 'INVALID_IMAGE')

    def test_repeated_unknown_and_truncated_multipart_rejected(self):
        with self.client() as client:
            for name in ['metadata', 'unexpected']:
                response = self.upload(client, more=[(name, (None, '{}'))])
                self.assertEqual(response.status_code, 422)
            response = client.post('/v1/embeddings/image', headers={
                **AUTH, 'Content-Type': 'multipart/form-data; boundary=cut'},
                content=b'--cut\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{}')
            self.assertEqual(response.status_code, 422)

    def test_streamed_json_size_duplicate_and_nonfinite_rejected(self):
        with self.client() as client:
            response = client.post('/v1/embeddings/text', headers={**AUTH, 'Content-Type': 'application/json'},
                                   content=iter([b' ' * 8192, b' ' * 8193]))
            self.assertEqual(response.status_code, 413)
            for content in [b'{"text":"a","text":"b"}', b'{"value":NaN}']:
                response = client.post('/v1/embeddings/text', headers={
                    **AUTH, 'Content-Type': 'application/json'}, content=content)
                self.assertEqual(response.status_code, 422)

    def test_part_limits_before_extension(self):
        parts = ImageParts(b'x')
        parts.begin()
        parts.name = 'metadata'
        with self.assertRaises(ServiceError):
            parts.data(b'x' * (JSON_LIMIT + 1), 0, JSON_LIMIT + 1)
        self.assertEqual(len(parts.content), 0)
        parts.name = 'image'
        parts.content = bytearray(IMAGE_LIMIT)
        with self.assertRaises(ServiceError):
            parts.data(b'x', 0, 1)
        self.assertEqual(len(parts.content), IMAGE_LIMIT)

    def test_invalid_engine_vectors_and_exception_are_sanitized(self):
        for outcome in [[0.0, 0.0, 0.0], [float('nan'), 0.0, 0.0],
                        ValueError('/private/secret'), ServiceError('/private/secret')]:
            engine = FakeEngine()
            def operation(_, value=outcome):
                if isinstance(value, Exception):
                    raise value
                return value
            engine.embed_text = operation
            with self.client(engine) as client:
                response = client.post('/v1/embeddings/text', headers=AUTH, json=text_request())
                self.assertEqual(response.status_code, 500, response.text)
                self.assertEqual(response.json()['code'], 'INTERNAL')
                self.assertNotIn('secret', response.text)

    def test_timeout_holds_slot_until_actual_completion(self):
        engine = FakeEngine()
        release = threading.Event()
        def slow(_):
            release.wait(2)
            return [1.0, 0.0, 0.0]
        engine.embed_text = slow
        with self.client(engine, timeout=0.02) as client:
            try:
                response = client.post('/v1/embeddings/text', headers=AUTH, json=text_request())
                self.assertEqual(response.status_code, 504)
                response = client.post('/v1/embeddings/text', headers=AUTH, json=text_request())
                self.assertEqual(response.status_code, 429)
                self.assertEqual(client.get('/health/live').status_code, 200)
            finally:
                release.set()
            deadline = time.monotonic() + 1
            while client.app.state.busy and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertFalse(client.app.state.busy)
            self.assertEqual(client.post('/v1/embeddings/text', headers=AUTH,
                                         json=text_request()).status_code, 200)

    def test_new_service_instance_reloads_model(self):
        loads = []
        for _ in range(2):
            engine = FakeEngine()
            engine.load = lambda: loads.append(1)
            with self.client(engine) as client:
                self.assertEqual(client.get('/health/ready', headers=AUTH).status_code, 200)
        self.assertEqual(len(loads), 2)


class DecodeTests(unittest.TestCase):
    def test_orientation_and_rgb(self):
        output = io.BytesIO()
        with Image.new('RGB', (8, 4), 'red') as source:
            exif = Image.Exif()
            exif[274] = 6
            source.save(output, 'JPEG', exif=exif)
        with decode_image(output.getvalue(), 'image/jpeg') as decoded:
            self.assertEqual(decoded.size, (4, 8))
            self.assertEqual(decoded.mode, 'RGB')

    def test_animated_and_excessive_pixels(self):
        output = io.BytesIO()
        with Image.new('RGB', (2, 2), 'red') as first, Image.new('RGB', (2, 2), 'blue') as second:
            first.save(output, 'PNG', save_all=True, append_images=[second])
        with self.assertRaises(ServiceError):
            decode_image(output.getvalue(), 'image/png')
        content = bytearray(png())
        content[16:24] = struct.pack('>II', 10000, 4001)
        content[29:33] = struct.pack('>I', zlib.crc32(content[12:29]))
        with self.assertRaises(ServiceError):
            decode_image(bytes(content), 'image/png')


if __name__ == '__main__':
    unittest.main()
