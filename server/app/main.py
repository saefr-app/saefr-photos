from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.v1.assets import router as assets_router
from app.database.database import create_db_and_tables


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    yield


app = FastAPI(
    title="Saefr Photos API",
    version="0.0.1",
    lifespan=lifespan,
)


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "saefr-photos",
    }


app.include_router(assets_router)