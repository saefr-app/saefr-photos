from fastapi import FastAPI

app = FastAPI(
    title="Saefr Photos API",
    version="0.0.1"
)

@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "saefr-photos"
    }