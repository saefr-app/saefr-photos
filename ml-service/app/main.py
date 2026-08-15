"""Saefr Photos ML service.

Stub only for this milestone: no real models are loaded and /analyze returns a
canned response. The point right now is proving that the api container can
reach this service over the internal Docker network.
"""

from typing import Any, Dict, Optional

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Saefr Photos ML Service", version="0.1.0")

# Populated lazily by get_models(). Deliberately NOT filled at import time:
# keeping every bit of model loading behind a function is what lets a future
# select_model(hardware_profile) slot in here without restructuring anything.
_models: Optional[Dict[str, Any]] = None


def load_models(hardware_profile: str = "default") -> Dict[str, Any]:
    """Load the model set for a hardware profile.

    No models exist yet, so this returns an empty set. When real models land,
    this is where a select_model(hardware_profile) call chooses between the
    eco/performance variants — the call site below does not need to change.
    """
    return {"hardware_profile": hardware_profile, "loaded": []}


def get_models() -> Dict[str, Any]:
    """Lazy accessor so the first request pays the load cost, not the import."""
    global _models
    if _models is None:
        _models = load_models()
    return _models


class AnalyzeRequest(BaseModel):
    storage_key: str


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/analyze")
def analyze(request: AnalyzeRequest) -> Dict[str, Any]:
    models = get_models()

    # Canned response — shaped roughly like the real one will be so the caller
    # does not have to change when actual inference is wired in.
    return {
        "storage_key": request.storage_key,
        "stub": True,
        "hardware_profile": models["hardware_profile"],
        "models_loaded": models["loaded"],
        "results": {
            "labels": ["stub-label"],
            "faces": [],
            "embedding": None,
        },
    }
