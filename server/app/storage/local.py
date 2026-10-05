from pathlib import Path
from uuid import UUID


STORAGE_ROOT = Path(__file__).resolve().parents[3] / "storage" / "originals"


def get_asset_storage_path(asset_id: UUID, extension: str) -> Path:
    STORAGE_ROOT.mkdir(parents=True, exist_ok=True)

    return STORAGE_ROOT / f"{asset_id}{extension}"