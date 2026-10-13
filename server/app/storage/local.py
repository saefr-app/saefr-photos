from pathlib import Path
from uuid import UUID


STORAGE_ROOT = Path(__file__).resolve().parents[3] / "storage"

ORIGINALS_ROOT = STORAGE_ROOT / "originals"
THUMBNAILS_ROOT = STORAGE_ROOT / "thumbnails"


def get_asset_storage_path(
    asset_id: UUID,
    extension: str,
) -> Path:
    ORIGINALS_ROOT.mkdir(
        parents=True,
        exist_ok=True,
    )

    return ORIGINALS_ROOT / f"{asset_id}{extension}"


def get_thumbnail_storage_path(
    asset_id: UUID,
) -> Path:
    THUMBNAILS_ROOT.mkdir(
        parents=True,
        exist_ok=True,
    )

    return THUMBNAILS_ROOT / f"{asset_id}.jpg"
