"""Exercise real local CLIP inference through HTTP handlers using synthetic PNG."""

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import secrets
import time

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from saefr_ml.app import Settings, create_app
from saefr_ml.contract import ImageResult, TextResult
from saefr_ml.engine import verify_registry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output exists; choose a new filename')
    registry = verify_registry(args.model_dir, args.registry)
    token = secrets.token_urlsafe(32)
    headers = {'Authorization': 'Bearer ' + token}
    settings = Settings(token, args.model_dir, args.registry)
    buffer = io.BytesIO()
    with Image.new('RGB', (224, 224), 'white') as source:
        ImageDraw.Draw(source).rectangle((48, 48, 176, 176), fill='red')
        source.save(buffer, 'PNG')
    content = buffer.getvalue()
    common = {'schema_version': '1', 'request_id': '00000000-0000-4000-8000-000000000003',
              'model': registry.model.model_dump(mode='json')}
    scope = '00000000-0000-4000-8000-000000000002'
    image_request = {**common, 'task': 'image_embedding',
                     'subject': {'asset_id': '00000000-0000-4000-8000-000000000001',
                                 'scope_id': scope, 'generation': 1},
                     'image': {'sha256': hashlib.sha256(content).hexdigest(),
                               'byte_size': len(content), 'media_type': 'image/png'}}
    text_request = {**common, 'task': 'text_embedding', 'scope_id': scope,
                    'text': 'a red square on a white background'}
    start = time.perf_counter()
    app = create_app(settings)
    with TestClient(app) as client:
        assert client.get('/health/ready', headers=headers).status_code == 200, 'Model not ready'
        load_seconds = time.perf_counter() - start
        start = time.perf_counter()
        response = client.post('/v1/embeddings/image', headers=headers, files=[
            ('metadata', (None, json.dumps(image_request), 'application/json')),
            ('image', ('synthetic.png', content, 'image/png'))])
        assert response.status_code == 200, 'Image inference failed'
        image_result = ImageResult.model_validate_json(response.content)
        image_seconds = time.perf_counter() - start
        start = time.perf_counter()
        response = client.post('/v1/embeddings/text', headers=headers, json=text_request)
        assert response.status_code == 200, 'Text inference failed'
        text_result = TextResult.model_validate_json(response.content)
        text_seconds = time.perf_counter() - start
        overlong = {**text_request, 'text': 'red ' * 200}
        assert client.post('/v1/embeddings/text', headers=headers, json=overlong).status_code == 422
    report = {'scope': 'real local CLIP; synthetic PNG; in-process HTTP transport',
              'model': registry.model.model_dump(mode='json'), 'dimensions': len(image_result.embedding),
              'startup_ready_seconds': load_seconds, 'image_seconds': image_seconds,
              'text_seconds': text_seconds,
              'image_l2_norm': math.sqrt(sum(v*v for v in image_result.embedding)),
              'text_l2_norm': math.sqrt(sum(v*v for v in text_result.embedding)),
              'over_token_limit_rejected': True, 'backend_connected': False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write('\n')
    print('Real model HTTP smoke passed; vectors and credentials omitted from evidence')


if __name__ == '__main__':
    main()
