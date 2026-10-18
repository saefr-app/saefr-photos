import uvicorn

from .app import create_app


if __name__ == '__main__':
    uvicorn.run(create_app(), host='127.0.0.1', port=8001, workers=1,
                access_log=False, log_level='warning', limit_concurrency=8,
                timeout_keep_alive=5)
