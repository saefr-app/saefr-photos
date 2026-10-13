from pathlib import Path
from uuid import UUID, uuid4

from fastapi import HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlmodel import Session

from app.models.asset import Asset
from app.repositories.asset_repository import (
    create_asset,
    get_asset_by_id,
    list_assets,
)
from app.storage.local import (
    get_asset_storage_path,
    get_thumbnail_storage_path,
)


ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}

THUMBNAIL_SIZE = (300, 300)


def get_assets(session: Session) -> list[Asset]:
    return list_assets(session)


def get_asset(
    session: Session,
    asset_id: UUID,
) -> Asset:
    asset = get_asset_by_id(
        session,
        asset_id,
    )

    if asset is None:
        raise HTTPException(
            status_code=404,
            detail="Asset not found",
        )

    return asset


async def upload_asset_file(
    file: UploadFile,
    session: Session,
) -> Asset:
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Unsupported image type",
        )

    asset_id = uuid4()

    extension = ALLOWED_IMAGE_TYPES[file.content_type]

    storage_path = get_asset_storage_path(
        asset_id,
        extension,
    )

    file_bytes = await file.read()

    storage_path.write_bytes(file_bytes)

    try:
        generate_thumbnail(
            asset_id,
            storage_path,
        )
    except UnidentifiedImageError:
        storage_path.unlink(
            missing_ok=True,
        )

        raise HTTPException(
            status_code=415,
            detail="Uploaded file is not a valid image",
        )

    asset = Asset(
        id=asset_id,
        filename=file.filename or f"{asset_id}{extension}",
        mime_type=file.content_type,
        size=len(file_bytes),
        storage_path=str(storage_path),
    )

    return create_asset(
        session,
        asset,
    )


def generate_thumbnail(
    asset_id: UUID,
    original_path: Path,
) -> Path:
    thumbnail_path = get_thumbnail_storage_path(
        asset_id,
    )

    with Image.open(original_path) as image:
        image = ImageOps.exif_transpose(image)

        image.thumbnail(
            THUMBNAIL_SIZE,
        )

        if image.mode != "RGB":
            image = image.convert("RGB")

        image.save(
            thumbnail_path,
            format="JPEG",
            quality=85,
        )

    return thumbnail_path


def get_original_file_path(
    asset: Asset,
) -> Path:
    file_path = Path(asset.storage_path)

    if not file_path.exists():
        raise HTTPException(
            status_code=404,
            detail="Asset file not found",
        )

    return file_path


def get_thumbnail_file_path(
    asset: Asset,
) -> Path:
    thumbnail_path = get_thumbnail_storage_path(
        asset.id,
    )

    if not thumbnail_path.exists():
        raise HTTPException(
            status_code=404,
            detail="Asset thumbnail not found",
        )

    return thumbnail_path
