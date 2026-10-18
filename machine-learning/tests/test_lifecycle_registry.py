import asyncio
import json
from pathlib import Path
import tempfile
import threading
import unittest

import httpx

from saefr_ml.app import Settings, create_app
from saefr_ml.engine import prepare_registry, verify_registry
from test_service import AUTH, TOKEN, FakeEngine, text_request


class CancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_request_cancellation_does_not_release_running_inference(self):
        release, started = threading.Event(), threading.Event()
        engine = FakeEngine()
        def operation(_):
            started.set()
            release.wait(2)
            return [1.0, 0.0, 0.0]
        engine.embed_text = operation
        app = create_app(Settings(TOKEN, Path('unused'), Path('unused')), lambda: engine)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url='http://test') as client:
                task = asyncio.create_task(client.post('/v1/embeddings/text', headers=AUTH,
                                                       json=text_request()))
                try:
                    for _ in range(100):
                        if started.is_set():
                            break
                        await asyncio.sleep(0.005)
                    self.assertTrue(started.is_set())
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                    self.assertTrue(app.state.busy)
                    response = await client.post('/v1/embeddings/text', headers=AUTH,
                                                 json=text_request())
                    self.assertEqual(response.status_code, 429)
                finally:
                    release.set()
                    await asyncio.gather(task, return_exceptions=True)

    async def test_slow_body_times_out_and_releases_admission(self):
        settings = Settings(TOKEN, Path('unused'), Path('unused'), body_timeout=0.01)
        app = create_app(settings, FakeEngine)
        async def slow_body():
            await asyncio.sleep(0.1)
            yield b'{}'
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url='http://test') as client:
                response = await client.post('/v1/embeddings/text',
                                             headers={**AUTH, 'Content-Type': 'application/json'},
                                             content=slow_body())
                self.assertEqual(response.status_code, 504)
                self.assertFalse(app.state.busy)
                response = await client.post('/v1/embeddings/text', headers=AUTH,
                                             json=text_request())
                self.assertEqual(response.status_code, 200)


class RegistryTests(unittest.TestCase):
    def fixture(self, root):
        snapshot = root / 'model'
        snapshot.mkdir()
        (snapshot / 'config.json').write_text(json.dumps({'model_type': 'clip', 'projection_dim': 3}))
        for name in ['preprocessor_config.json', 'vocab.json']:
            (snapshot / name).write_text('{}')
        (snapshot / 'merges.txt').write_text('#fixture')
        (snapshot / 'pytorch_model.bin').write_bytes(b'not actual weights')
        registry = prepare_registry(snapshot, 'example/model', '1' * 40)
        registry_path = root / 'registry.json'
        registry_path.write_text(registry.model_dump_json())
        return snapshot, registry_path

    def test_changed_weights_and_preprocessing_rejected(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            snapshot, registry = self.fixture(Path(temporary))
            verify_registry(snapshot, registry)
            original = (snapshot / 'pytorch_model.bin').read_bytes()
            (snapshot / 'pytorch_model.bin').write_bytes(b'tampered')
            with self.assertRaises(ValueError):
                verify_registry(snapshot, registry)
            (snapshot / 'pytorch_model.bin').write_bytes(original)
            data = json.loads(registry.read_text())
            data['preprocessing']['adapter'] = 'changed'
            registry.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                verify_registry(snapshot, registry)

    def test_extra_model_code_or_missing_weights_rejected(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            snapshot, registry = self.fixture(Path(temporary))
            (snapshot / 'remote.py').write_text('raise RuntimeError()')
            with self.assertRaises(ValueError):
                verify_registry(snapshot, registry)
            (snapshot / 'remote.py').unlink()
            (snapshot / 'pytorch_model.bin').unlink()
            with self.assertRaises(ValueError):
                verify_registry(snapshot, registry)


if __name__ == '__main__':
    unittest.main()
