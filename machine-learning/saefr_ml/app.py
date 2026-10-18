import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import hmac
import os
from pathlib import Path
import re
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.requests import ClientDisconnect

from .contract import (ERROR_STATUS, RETRYABLE, ErrorResult, ImageRequest, ImageResult,
                       TextRequest, TextResult, validate_image_bytes)
from .engine import ClipEngine
from .errors import ServiceError
from .ingress import image_body, parse_json, text_body


@dataclass
class Settings:
    token: str = field(repr=False)
    model_dir: Path
    registry_path: Path
    threads: int = 2
    inference_timeout: float = 30.0
    body_timeout: float = 15.0

    def __post_init__(self):
        if (not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', self.token)
                or not 1 <= self.threads <= 32
                or not 0 < self.inference_timeout <= 300
                or not 0 < self.body_timeout <= 60):
            raise ValueError('Invalid ML service configuration')

    @classmethod
    def from_env(cls):
        try:
            return cls(token=os.environ['ML_SERVICE_TOKEN'],
                       model_dir=Path(os.environ['ML_MODEL_DIR']),
                       registry_path=Path(os.environ['ML_REGISTRY_PATH']),
                       threads=int(os.environ.get('ML_CPU_THREADS', '2')))
        except (KeyError, ValueError):
            raise ValueError('Invalid ML service configuration') from None


def error_response(code, request_id):
    if code not in ERROR_STATUS:
        code = 'INTERNAL'
    result = ErrorResult(schema_version='1', request_id=request_id, code=code,
                         retry_after_ms=1000 if code in RETRYABLE else None)
    headers = {'Retry-After': '1'} if code in RETRYABLE else None
    return JSONResponse(result.model_dump(mode='json'), status_code=ERROR_STATUS[code], headers=headers)


def create_app(settings=None, engine_factory=None):
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        app.state.ready, app.state.busy = False, False
        app.state.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='saefr-inference')
        app.state.pending = set()
        try:
            app.state.engine = (engine_factory() if engine_factory else
                                ClipEngine(settings.model_dir, settings.registry_path, settings.threads))
            await asyncio.get_running_loop().run_in_executor(app.state.executor, app.state.engine.load)
            app.state.ready = True
        except Exception:
            # Keep liveness available while configuration/model failure blocks readiness.
            app.state.engine = None
        try:
            yield
        finally:
            app.state.ready = False
            # Threads cannot be force-cancelled safely. Wait for real work to finish.
            if app.state.pending:
                await asyncio.gather(*app.state.pending, return_exceptions=True)
            app.state.executor.shutdown(wait=True, cancel_futures=True)

    app = FastAPI(title='Saefr experimental ML candidate', lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)

    def authenticated(request):
        authorization = request.headers.get('authorization', '')
        return hmac.compare_digest(authorization.encode('utf-8'),
                                   ('Bearer ' + settings.token).encode('ascii'))

    def unauthorized():
        return JSONResponse({'status': 'unauthorized'}, status_code=401,
                            headers={'WWW-Authenticate': 'Bearer'})

    @app.get('/health/live')
    async def live():
        return {'status': 'ok'}

    @app.get('/health/ready')
    async def ready(request: Request):
        if not authenticated(request):
            return unauthorized()
        return JSONResponse({'status': 'ready' if app.state.ready else 'unavailable'},
                            status_code=200 if app.state.ready else 503)

    async def infer(request, image):
        if not authenticated(request):
            return unauthorized()
        request_id = str(uuid4())
        if not app.state.ready:
            return error_response('MODEL_UNAVAILABLE', request_id)
        if app.state.busy:
            return error_response('BUSY', request_id)
        # Event-loop-only admission; there is no await between check and claim.
        app.state.busy = True
        owns_slot = True
        try:
            async with asyncio.timeout(settings.body_timeout):
                if image:
                    raw, content = await image_body(request)
                    try:
                        metadata = parse_json(raw, ImageRequest)
                    except (ValueError, ValidationError, RecursionError):
                        raise ServiceError('INVALID_REQUEST') from None
                    request_id = metadata.request_id
                    try:
                        validate_image_bytes(metadata, content)
                    except ValueError:
                        raise ServiceError('INVALID_IMAGE') from None
                else:
                    try:
                        metadata = parse_json(await text_body(request), TextRequest)
                    except (ValueError, ValidationError, RecursionError):
                        raise ServiceError('INVALID_REQUEST') from None
            request_id = metadata.request_id
            if metadata.model != app.state.engine.spec:
                raise ServiceError('MODEL_MISMATCH')
            if image:
                operation = lambda: app.state.engine.embed_image(content, metadata.image.media_type)
            else:
                operation = lambda: app.state.engine.embed_text(metadata.text)
            future = asyncio.get_running_loop().run_in_executor(app.state.executor, operation)
            app.state.pending.add(future)

            def completed(done):
                app.state.pending.discard(done)
                app.state.busy = False
                if not done.cancelled():
                    done.exception()  # Consume late failures without logging private details.

            future.add_done_callback(completed)
            owns_slot = False  # Only the actual inference completion can release it now.
            vector = await asyncio.wait_for(asyncio.shield(future), settings.inference_timeout)
            common = dict(schema_version='1', request_id=request_id, model=metadata.model,
                          normalization='l2', embedding=vector)
            if image:
                try:
                    result = ImageResult(**common, task='image_embedding', subject=metadata.subject,
                                         image_sha256=metadata.image.sha256)
                except ValidationError:
                    raise ServiceError('INTERNAL') from None
            else:
                try:
                    result = TextResult(**common, task='text_embedding', scope_id=metadata.scope_id)
                except ValidationError:
                    raise ServiceError('INTERNAL') from None
            return JSONResponse(result.model_dump(mode='json'))
        except ServiceError as error:
            return error_response(error.code, request_id)
        except TimeoutError:
            return error_response('TIMEOUT', request_id)
        except (UnicodeError, ClientDisconnect):
            return error_response('INVALID_REQUEST', request_id)
        except Exception:
            return error_response('INTERNAL', request_id)
        finally:
            if owns_slot:
                app.state.busy = False

    @app.post('/v1/embeddings/image')
    async def image_endpoint(request: Request):
        return await infer(request, image=True)

    @app.post('/v1/embeddings/text')
    async def text_endpoint(request: Request):
        return await infer(request, image=False)

    return app
