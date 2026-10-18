"""Draft ML wire contract and pure validation helpers; no serving or storage."""

import hashlib
import json
import math
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

Digest = Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]
Identifier = Annotated[str, Field(pattern=(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))]
Counter = Annotated[int, Field(ge=1, le=9_007_199_254_740_991)]


class WireModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)


class ModelSpec(WireModel):
    model_id: Annotated[str, Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$')]
    revision: Annotated[str, Field(pattern=r'^(?:[0-9a-f]{40}|[0-9a-f]{64})$')]
    artifact_digest: Digest
    preprocessing_digest: Digest
    dimensions: Annotated[int, Field(ge=1, le=4096)]


class Subject(WireModel):
    asset_id: Identifier
    scope_id: Identifier
    generation: Counter


class ImageDescriptor(WireModel):
    sha256: Digest
    byte_size: Annotated[int, Field(ge=1, le=20 * 1024 * 1024)]
    media_type: Literal['image/jpeg', 'image/png', 'image/webp']


class ImageRequest(WireModel):
    schema_version: Literal['1']
    task: Literal['image_embedding']
    request_id: Identifier
    subject: Subject
    model: ModelSpec
    image: ImageDescriptor


class TextRequest(WireModel):
    schema_version: Literal['1']
    task: Literal['text_embedding']
    request_id: Identifier
    scope_id: Identifier
    model: ModelSpec
    text: Annotated[str, Field(min_length=1, max_length=1024)]

    @model_validator(mode='after')
    def meaningful_text(self) -> Self:
        if not self.text.strip():
            raise ValueError('Text must contain non-whitespace characters')
        return self


class EmbeddingResult(WireModel):
    schema_version: Literal['1']
    request_id: Identifier
    model: ModelSpec
    normalization: Literal['l2']
    embedding: Annotated[list[float], Field(min_length=1, max_length=4096)]

    @model_validator(mode='after')
    def valid_vector(self) -> Self:
        if len(self.embedding) != self.model.dimensions:
            raise ValueError('Embedding dimension does not match the selected model')
        if not math.isclose(math.sqrt(math.fsum(v * v for v in self.embedding)),
                            1.0, abs_tol=1e-4, rel_tol=0):
            raise ValueError('Embedding must have unit L2 norm within 1e-4')
        return self


class ImageResult(EmbeddingResult):
    task: Literal['image_embedding']
    subject: Subject
    image_sha256: Digest


class TextResult(EmbeddingResult):
    task: Literal['text_embedding']
    scope_id: Identifier


ErrorCode = Literal['INVALID_REQUEST', 'INVALID_IMAGE', 'UNSUPPORTED_MEDIA',
                    'PAYLOAD_TOO_LARGE', 'MODEL_MISMATCH', 'MODEL_UNAVAILABLE',
                    'BUSY', 'TIMEOUT', 'INTERNAL']
ERROR_STATUS = {
    'INVALID_REQUEST': 422, 'INVALID_IMAGE': 422, 'UNSUPPORTED_MEDIA': 415,
    'PAYLOAD_TOO_LARGE': 413, 'MODEL_MISMATCH': 409, 'MODEL_UNAVAILABLE': 503,
    'BUSY': 429, 'TIMEOUT': 504, 'INTERNAL': 500,
}
RETRYABLE = frozenset({'MODEL_UNAVAILABLE', 'BUSY', 'TIMEOUT', 'INTERNAL'})


class ErrorResult(WireModel):
    schema_version: Literal['1']
    request_id: Identifier
    code: ErrorCode
    retry_after_ms: Annotated[int, Field(ge=100, le=60_000)] | None

    @model_validator(mode='after')
    def retry_hint(self) -> Self:
        if self.retry_after_ms is not None and self.code not in RETRYABLE:
            raise ValueError('Permanent errors cannot include a retry delay')
        return self


class InvalidationEvent(WireModel):
    schema_version: Literal['1']
    event_id: Identifier
    event: Literal['asset.ml_invalidated']
    asset_id: Identifier
    scope_id: Identifier
    generation: Counter
    reason: Literal['trashed', 'deleted', 'content_changed', 'scope_changed',
                    'ml_disabled', 'restored']


def image_job_key(request: ImageRequest) -> str:
    """Same semantic operation has the same key across HTTP attempts.

    No authorization is conferred by this key. Queue consumers must recheck
    current eligibility and perform transactional compare-and-set persistence.
    """
    identity = request.model_dump(mode='json', exclude={'request_id'})
    canonical = json.dumps(identity, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    return 'ml-v1-' + hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def validate_image_bytes(request: ImageRequest, content: bytes) -> None:
    """Check transfer integrity only; format decoding is a service responsibility."""
    if len(content) != request.image.byte_size:
        raise ValueError('Image byte count mismatch')
    if hashlib.sha256(content).hexdigest() != request.image.sha256:
        raise ValueError('Image digest mismatch')


def can_persist_image(request: ImageRequest, result: ImageResult, *,
                      current_subject: Subject | None, current_model: ModelSpec,
                      eligible: bool) -> bool:
    """Pure illustration of the worker's gate; does not read or lock any state.

    The real worker must bind these checks to a transaction that also publishes
    the derived row. Checking outside the transaction leaves a deletion race.
    """
    return (eligible and current_subject is not None
            and request.subject == current_subject == result.subject
            and request.model == current_model == result.model
            and request.request_id == result.request_id
            and request.image.sha256 == result.image_sha256)


def matches_text_request(request: TextRequest, result: TextResult) -> bool:
    return (request.request_id == result.request_id and request.scope_id == result.scope_id
            and request.model == result.model)


SCHEMAS = {
    'image-request': ImageRequest, 'text-request': TextRequest,
    'image-result': ImageResult, 'text-result': TextResult,
    'error-result': ErrorResult, 'invalidation-event': InvalidationEvent,
}
