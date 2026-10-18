"""Create the configured local ML scope using private operator credentials."""

import argparse
import hashlib
import json
from pathlib import Path
import urllib.request
from urllib.parse import urlparse


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config-dir', type=Path, required=True)
    parser.add_argument('--api-url', default='http://127.0.0.1:8002')
    args = parser.parse_args()
    url = urlparse(args.api_url)
    if url.scheme not in {'http', 'https'} or url.hostname not in {'127.0.0.1', 'localhost', '::1'} or url.path not in {'', '/'} or url.username or url.password or url.query or url.fragment:
        parser.error('Bootstrap accepts an explicitly local coordinator URL')
    credentials = json.loads((args.config_dir / 'client-tokens.json').read_text())
    model = json.loads((args.config_dir / 'registry.json').read_text())['model']
    model_key = hashlib.sha256(json.dumps(model, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()
    request = urllib.request.Request(args.api_url.rstrip('/') + '/v1/scopes/' + credentials['scope_id'],
                                     method='PUT', data=json.dumps({'model_key': model_key}).encode(),
                                     headers={'Authorization': 'Bearer ' + credentials['admin_token'],
                                              'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=10) as response:
        assert response.status == 200
    print('Configured ML scope created; credentials remain in private files')
