"""Start an isolated loopback Uvicorn process, check real HTTP, then stop it."""

import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

from saefr_ml.contract import TextResult
from saefr_ml.engine import verify_registry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Choose a new output filename')
    registry = verify_registry(args.model_dir, args.registry)
    token = secrets.token_urlsafe(32)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    base_url = f'http://127.0.0.1:{port}'
    environment = {**os.environ, 'ML_SERVICE_TOKEN': token,
                   'ML_MODEL_DIR': str(args.model_dir.resolve()),
                   'ML_REGISTRY_PATH': str(args.registry.resolve()), 'ML_CPU_THREADS': '2'}
    process = subprocess.Popen(
        [sys.executable, '-m', 'uvicorn', 'saefr_ml.app:create_app', '--factory',
         '--host', '127.0.0.1', '--port', str(port), '--workers', '1',
         '--limit-concurrency', '8', '--no-access-log', '--log-level', 'warning'],
        cwd=Path(__file__).parent, env=environment,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        deadline = time.monotonic() + 60
        while True:
            if process.poll() is not None:
                raise RuntimeError('Isolated service exited before readiness')
            try:
                with urllib.request.urlopen(urllib.request.Request(
                        base_url + '/health/ready', headers={'Authorization': 'Bearer ' + token}),
                        timeout=1) as response:
                    if response.status == 200:
                        break
            except (OSError, urllib.error.HTTPError):
                if time.monotonic() > deadline:
                    raise RuntimeError('Isolated service readiness timed out') from None
                time.sleep(0.1)
        with urllib.request.urlopen(base_url + '/health/live', timeout=1) as response:
            assert response.status == 200
        body = {'schema_version': '1', 'task': 'text_embedding',
                'request_id': '00000000-0000-4000-8000-000000000003',
                'scope_id': '00000000-0000-4000-8000-000000000002',
                'model': registry.model.model_dump(mode='json'), 'text': 'a red square'}
        with urllib.request.urlopen(urllib.request.Request(
                base_url + '/v1/embeddings/text', data=json.dumps(body).encode('utf-8'),
                headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}),
                timeout=30) as response:
            result = TextResult.model_validate_json(response.read())
        assert result.model == registry.model
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=10)
    with socket.socket() as probe:
        assert probe.connect_ex(('127.0.0.1', port)) != 0, 'Listener remained open'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump({'scope': 'isolated process on loopback; real local CLIP text inference',
                   'readiness': 'pass', 'liveness': 'pass', 'embedding_dimensions': len(result.embedding),
                   'process_stopped': process.poll() is not None, 'listener_closed': True,
                   'graceful_shutdown_proven': False, 'backend_connected': False}, stream, indent=2)
        stream.write('\n')
    print('Isolated process HTTP smoke passed; process stopped and listener closed')


if __name__ == '__main__':
    main()
