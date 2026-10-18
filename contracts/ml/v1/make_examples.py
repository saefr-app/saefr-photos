"""Generate small illustrative fixtures; vectors are not model inference."""

import hashlib
import json
from pathlib import Path

from contract import SCHEMAS


def examples():
    subject = {'asset_id': '00000000-0000-4000-8000-000000000001',
               'scope_id': '00000000-0000-4000-8000-000000000002', 'generation': 1}
    model = {'model_id': 'example/paired-encoder', 'revision': '1' * 40,
             'artifact_digest': '2' * 64, 'preprocessing_digest': '3' * 64, 'dimensions': 3}
    request_id = '00000000-0000-4000-8000-000000000003'
    image = {'sha256': hashlib.sha256(b'fixture-bytes').hexdigest(),
             'byte_size': len(b'fixture-bytes'), 'media_type': 'image/jpeg'}
    common = {'schema_version': '1', 'request_id': request_id, 'model': model}
    return {
        'image-request': {**common, 'task': 'image_embedding', 'subject': subject, 'image': image},
        'text-request': {**common, 'task': 'text_embedding', 'scope_id': subject['scope_id'],
                         'text': 'a red square on a white background'},
        'image-result': {**common, 'task': 'image_embedding', 'subject': subject,
                         'image_sha256': image['sha256'], 'normalization': 'l2',
                         'embedding': [1.0, 0.0, 0.0]},
        'text-result': {**common, 'task': 'text_embedding', 'scope_id': subject['scope_id'],
                        'normalization': 'l2', 'embedding': [1.0, 0.0, 0.0]},
        'error-result': {'schema_version': '1', 'request_id': request_id,
                         'code': 'BUSY', 'retry_after_ms': 1000},
        'invalidation-event': {'schema_version': '1',
                               'event_id': '00000000-0000-4000-8000-000000000004',
                               'event': 'asset.ml_invalidated',
                               'asset_id': subject['asset_id'], 'scope_id': subject['scope_id'],
                               'generation': 2, 'reason': 'deleted'},
    }


if __name__ == '__main__':
    root = Path(__file__).parent / 'examples'
    root.mkdir(exist_ok=True)
    for name, value in examples().items():
        SCHEMAS[name].model_validate(value)
        (root / f'{name}.json').write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
