from fastapi import FastAPI

from app.api.v1.assets import router as assets_router


app = FastAPI(
    title="Saefr Photos API",
    version="0.0.1",
)


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "saefr-photos",
    }


app.include_router(assets_router)