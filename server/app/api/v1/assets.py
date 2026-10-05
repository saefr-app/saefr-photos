from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from app.database.database import get_session
from app.models.asset import Asset
from app.storage.local import get_asset_storage_path


router = APIRouter(
    prefix="/api/v1/assets",
    tags=["assets"],
)


ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


@router.get("/", response_model=list[Asset])
def list_assets(
    session: Session = Depends(get_session),
):
    statement = select(Asset)
    assets = session.exec(statement).all()

    return assets


@router.post(
    "/upload",
    response_model=Asset,
    status_code=201,
)
async def upload_asset(
    file: UploadFile,
    session: Session = Depends(get_session),
):
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

    asset = Asset(
        id=asset_id,
        filename=file.filename or f"{asset_id}{extension}",
        mime_type=file.content_type,
        size=len(file_bytes),
        storage_path=str(storage_path),
    )

    session.add(asset)
    session.commit()
    session.refresh(asset)

    return asset


@router.get("/{asset_id}/original")
def get_original_asset(
    asset_id: UUID,
    session: Session = Depends(get_session),
):
    asset = session.get(
        Asset,
        asset_id,
    )

    if asset is None:
        raise HTTPException(
            status_code=404,
            detail="Asset not found",
        )

    file_path = Path(asset.storage_path)

    if not file_path.exists():
        raise HTTPException(
            status_code=404,
            detail="Asset file not found",
        )

    return FileResponse(
        path=file_path,
        media_type=asset.mime_type,
    )