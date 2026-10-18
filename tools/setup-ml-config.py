"""Create new private local ML capability/config files, never overwrite secrets."""

import argparse
import hashlib
import json
from pathlib import Path
import secrets
import shutil
from uuid import uuid4


def write_json(path, value, mode):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    path.chmod(mode)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--inference-url', default='http://inference:8001')
    args = parser.parse_args()
    model = json.loads(args.registry.read_text())['model']
    target = args.output_dir.resolve()
    target.mkdir(parents=True, exist_ok=False, mode=0o700)
    admin, inference, reader, manager = [secrets.token_urlsafe(32) for _ in range(4)]
    scope = str(uuid4())
    hashed = lambda value: hashlib.sha256(value.encode()).hexdigest()
    write_json(target / 'access.json', {'admin_token_sha256': hashed(admin), 'principals': [
        {'token_sha256': hashed(reader), 'scopes': [scope], 'permissions': ['search']},
        {'token_sha256': hashed(manager), 'scopes': [scope], 'permissions': ['manage']}]}, 0o600)
    write_json(target / 'models.json', {'models': [
        {'model': model, 'url': args.inference_url, 'token_env': 'ML_INFERENCE_TOKEN'}]}, 0o644)
    write_json(target / 'client-tokens.json', {'admin_token': admin, 'search_token': reader, 'manager_token': manager,
                                              'scope_id': scope}, 0o600)
    shutil.copyfile(args.registry, target / 'registry.json')
    (target / 'registry.json').chmod(0o644)
    values = {'ML_CONFIG_DIR': target.as_posix(), 'ML_MODEL_DIR': args.model_dir.resolve().as_posix(),
              'ML_SERVICE_TOKEN': inference, 'ML_INFERENCE_TOKEN': inference}
    (target / 'credentials.env').write_text(''.join(
        key + '=' + json.dumps(value) + '\n' for key, value in values.items()), encoding='utf-8')
    (target / 'credentials.env').chmod(0o600)
    print('Created private ML configuration and scoped client credentials; no tokens printed')


if __name__ == '__main__':
    main()
