"""Isolated resource-limited ML/Redis/BullMQ container test. No application DB."""

import argparse
import hashlib
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time
import urllib.request
from uuid import uuid4

from PIL import Image, ImageDraw


def docker(*args, timeout=300):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Docker operation failed: {args[0]}; {result.stderr[-1200:]}')
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--coordinator-image', default='saefr-ml-coordinator:local')
    parser.add_argument('--inference-image', default='saefr-ml-candidate:local')
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Choose a new evidence filename')
    owner = str(uuid4())
    root = Path(tempfile.mkdtemp(prefix='saefr-ml-stack-')).resolve()
    (root / 'owner.json').write_text(json.dumps({'owner': owner}))
    config = root / 'config'
    fixtures = root / 'fixtures'
    config.mkdir()
    fixtures.mkdir()
    (fixtures / 'owner.json').write_text(json.dumps({'kind': 'saefr-synthetic-fixtures'}))
    for color in ['red', 'blue', 'green', 'yellow']:
        with Image.new('RGB', (224, 224), 'white') as source:
            ImageDraw.Draw(source).rectangle((48, 48, 176, 176), fill=color)
            source.save(fixtures / (color + '.png'))
    token = secrets.token_urlsafe(32)
    admin_token = secrets.token_urlsafe(32)
    credentials = root / 'credentials.env'
    credentials.write_text('ML_SERVICE_TOKEN=' + token + '\nML_TEST_INFERENCE_TOKEN=' + token
                           + '\nML_INFERENCE_TOKEN=' + token + '\nML_SMOKE_ADMIN_TOKEN=' + admin_token + '\n')
    credentials.chmod(0o600)
    network = 'saefr-ml-test-' + owner
    names = []
    network_created = False
    state_volume = None
    label = 'saefr.test.owner=' + owner
    try:
        docker('network', 'create', '--internal', '--label', label, network)
        network_created = True
        print('Created isolated internal test network', flush=True)
        # Registry is generated with the exact Linux runtime; no model download.
        prepare_name = 'saefr-ml-prepare-' + owner
        names.append(prepare_name)
        docker('run', '--name', prepare_name, '--label', label, '--network', 'none', '--read-only',
               '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--cpus', '2', '--memory', '2g',
               '--mount', f'type=bind,source={args.model_dir.resolve()},target=/models,readonly',
               '--mount', f'type=bind,source={config},target=/config', args.inference_image,
               'python', '-m', 'saefr_ml.prepare_model', '--model-dir', '/models',
               '--model-id', 'openai/clip-vit-base-patch32',
               '--revision', '3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268',
               '--output', '/config/registry.json')
        (config / 'registry.json').chmod(0o644)
        print('Prepared model registry inside the container runtime', flush=True)
        inference_name = 'saefr-ml-inference-' + owner
        names.append(inference_name)
        docker('run', '-d', '--name', inference_name, '--label', label, '--network', network,
               '--network-alias', 'inference', '--read-only', '--cpus', '2', '--memory', '2g',
               '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--env-file', str(credentials),
               '--mount', f'type=bind,source={args.model_dir.resolve()},target=/models,readonly',
               '--mount', f'type=bind,source={config / "registry.json"},target=/config/registry.json,readonly',
               args.inference_image)
        details = json.loads(docker('inspect', inference_name))[0]
        assert details['Config']['Labels']['saefr.test.owner'] == owner
        deadline = time.monotonic() + 90
        probe = ("import os,urllib.request; "
                 "r=urllib.request.Request('http://127.0.0.1:8001/health/ready',"
                 "headers={'Authorization':'Bearer '+os.environ['ML_SERVICE_TOKEN']}); "
                 "assert urllib.request.urlopen(r,timeout=1).status==200")
        while True:
            try:
                docker('exec', inference_name, 'python', '-c', probe, timeout=5)
                break
            except RuntimeError:
                if time.monotonic() > deadline:
                    state = json.loads(docker('inspect', inference_name))[0]['State']
                    raise RuntimeError('Container readiness failed: ' + json.dumps(
                        {key: state[key] for key in ['Status', 'OOMKilled', 'ExitCode']})) from None
                time.sleep(0.2)
        print('Resource-limited offline inference container is ready', flush=True)
        redis_name = 'saefr-ml-redis-' + owner
        names.append(redis_name)
        docker('run', '-d', '--name', redis_name, '--label', label, '--network', network,
               '--network-alias', 'redis', '--read-only', '--memory', '128m', '--cpus', '0.25',
               '--tmpfs', '/data:rw,noexec,nosuid,size=64m', 'redis:7-alpine',
               'redis-server', '--save', '', '--appendonly', 'no', '--maxmemory', '96mb',
               '--maxmemory-policy', 'noeviction')
        integration_name = 'saefr-ml-coordinator-test-' + owner
        names.append(integration_name)
        output = docker('run', '--name', integration_name, '--label', label, '--network', network,
                        '--read-only', '--cpus', '1', '--memory', '1g',
                        '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--env-file', str(credentials),
                        '--mount', f'type=bind,source={fixtures},target=/fixtures,readonly',
                        '--mount', f'type=bind,source={config / "registry.json"},target=/config/registry.json,readonly',
                        '-e', 'ML_TEST_FIXTURE_DIR=/fixtures', '-e', 'ML_TEST_REGISTRY=/config/registry.json',
                        '-e', 'ML_TEST_INFERENCE_URL=http://inference:8001', '-e', 'ML_TEST_REDIS_HOST=redis',
                        '-e', 'ML_TEST_REDIS_PORT=6379', args.coordinator_image, 'npm', 'run', 'test:integration')
        lines = [line for line in output.splitlines() if line.startswith('{')]
        evidence = json.loads(lines[-1])
        # Exercise the independent production entrypoints and their shared durable volume.
        registry = json.loads((config / 'registry.json').read_text())
        (config / 'models.json').write_text(json.dumps({'models': [
            {'model': registry['model'], 'url': 'http://inference:8001', 'token_env': 'ML_INFERENCE_TOKEN'}]}))
        (config / 'access.json').write_text(json.dumps({
            'admin_token_sha256': hashlib.sha256(admin_token.encode()).hexdigest(), 'principals': []}))
        (config / 'models.json').chmod(0o644)
        (config / 'access.json').chmod(0o644)
        state_volume = 'saefr-ml-state-test-' + owner
        docker('volume', 'create', '--label', label, state_volume)
        api_name, worker_name = 'saefr-ml-api-' + owner, 'saefr-ml-worker-' + owner
        common = ['--label', label, '--network', network, '--read-only', '--memory', '1g', '--cpus', '1',
                  '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--env-file', str(credentials),
                  '--mount', f'type=volume,source={state_volume},target=/app/state',
                  '--mount', f'type=bind,source={config / "models.json"},target=/config/models.json,readonly',
                  '--mount', f'type=bind,source={config / "access.json"},target=/config/access.json,readonly',
                  '-e', 'ML_ACCESS_FILE=/config/access.json', '-e', 'ML_MODELS_FILE=/config/models.json',
                  '-e', 'ML_REDIS_HOST=redis', '-e', 'ML_REDIS_PORT=6379',
                  '-e', 'ML_QUEUE_NAME=saefr-ml-runtime-' + owner]
        names.append(api_name)
        docker('run', '-d', '--name', api_name, *common,
               '--mount', f'type=bind,source={fixtures},target=/fixtures,readonly', args.coordinator_image)
        names.append(worker_name)
        docker('run', '-d', '--name', worker_name, *common, args.coordinator_image,
               'node', '--experimental-sqlite', 'src/worker-main.mjs')
        api_probe = ("const r=await fetch('http://127.0.0.1:8002/health/ready',"
                     "{headers:{Authorization:'Bearer '+process.env.ML_SMOKE_ADMIN_TOKEN}});"
                     "if(r.status!==200)process.exit(1);")
        def wait_api():
            deadline = time.monotonic() + 45
            while True:
                try:
                    docker('exec', api_name, 'node', '--input-type=module', '-e', api_probe, timeout=5)
                    return
                except RuntimeError:
                    if time.monotonic() > deadline:
                        raise RuntimeError('Independent coordinator did not become ready') from None
                    time.sleep(0.2)
        wait_api()
        runtime_scope, runtime_asset = str(uuid4()), str(uuid4())
        runtime_probe = """
import {readFileSync,readdirSync} from 'node:fs';
import {modelKey} from './src/protocol.mjs';
const scope=process.argv[1],asset=process.argv[2];
const model=JSON.parse(readFileSync('/config/models.json','utf8')).models[0].model;
const base='http://127.0.0.1:8002/v1/scopes/'+scope;
const auth={Authorization:'Bearer '+process.env.ML_SMOKE_ADMIN_TOKEN};
async function json(path,method,body){const r=await fetch(base+path,{method,headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error('runtime request failed');return r.json();}
await json('','PUT',{model_key:modelKey(model)});
const upload=await fetch(base+'/assets/'+asset,{method:'PUT',headers:{...auth,'Content-Type':'image/png','X-Asset-Generation':'1'},body:readFileSync('/fixtures/red.png')});
if(upload.status!==202)throw new Error('runtime upload failed');
const job=(await upload.json()).job;
const deadline=Date.now()+60000;
while(true){const r=await fetch(base+'/jobs/'+job.id,{headers:auth});const j=await r.json();if(j.state==='done')break;if(j.state==='failed'||Date.now()>deadline)throw new Error('runtime worker failed');await new Promise(r=>setTimeout(r,50));}
const search=await json('/search','POST',{text:'a red square on a white background'});
if(search.results[0]?.asset_id!==asset)throw new Error('runtime ranking failed');
await json('/settings','PATCH',{enabled:false});
if(readdirSync('/app/state/inputs').some(name=>name.endsWith('.blob')))throw new Error('runtime purge failed');
"""
        docker('exec', api_name, 'node', '--input-type=module', '-e', runtime_probe,
               runtime_scope, runtime_asset, timeout=90)
        docker('stop', '--time', '45', worker_name)
        docker('stop', '--time', '45', api_name)
        stopped = [json.loads(docker('inspect', name))[0]['State']['ExitCode'] for name in [api_name, worker_name]]
        assert stopped == [0, 0], 'API and worker must stop gracefully'
        docker('start', api_name, worker_name)
        wait_api()
        restart_probe = ("const r=await fetch('http://127.0.0.1:8002/v1/scopes/" + runtime_scope
                         + "/status',{headers:{Authorization:'Bearer '+process.env.ML_SMOKE_ADMIN_TOKEN}});"
                         "const s=await r.json();if(s.enabled!==false||s.indexed!==0)process.exit(1);")
        docker('exec', api_name, 'node', '--input-type=module', '-e', restart_probe)
        evidence.update({'independent_api_worker_entrypoints': True, 'shared_volume_restart': True,
                         'disabled_state_preserved_after_restart': True,
                         'api_worker_graceful_exit_codes': stopped})
        evidence.update({'container_limits': {'inference_cpus': 2, 'inference_memory_bytes': 2 * 1024 ** 3,
                                              'coordinator_cpus': 1, 'coordinator_memory_bytes': 1024 ** 3},
                         'read_only_rootfs': details['HostConfig']['ReadonlyRootfs'],
                         'network_internal': json.loads(docker('network', 'inspect', network))[0]['Internal'],
                         'no_development_volumes': True})
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(evidence, indent=2) + '\n')
        print('Real CLIP + Redis/BullMQ + scoped search/lifecycle container flow passed', flush=True)
    finally:
        for name in reversed(names):
            try:
                details = json.loads(docker('inspect', name))[0]
                if details['Config'].get('Labels', {}).get('saefr.test.owner') == owner:
                    docker('rm', '-f', name)
            except RuntimeError:
                pass
        if network_created:
            details = json.loads(docker('network', 'inspect', network))[0]
            if details.get('Labels', {}).get('saefr.test.owner') == owner:
                docker('network', 'rm', network)
        if state_volume:
            details = json.loads(docker('volume', 'inspect', state_volume))[0]
            if details.get('Labels', {}).get('saefr.test.owner') == owner:
                docker('volume', 'rm', state_volume)
        assert root.parent == Path(tempfile.gettempdir()).resolve()
        assert root.name.startswith('saefr-ml-stack-')
        assert json.loads((root / 'owner.json').read_text())['owner'] == owner
        shutil.rmtree(root)
        print('Removed only the labeled test containers/network and owned temporary files', flush=True)


if __name__ == '__main__':
    main()
