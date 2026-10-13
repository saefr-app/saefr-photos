from uuid import UUID

from fastapi import APIRouter, Depends, UploadFile
from fastapi.responses import FileResponse
from sqlmodel import Session

from app.database.database import get_session
from app.models.asset import Asset
from app.services.asset_service import (
    get_asset,
    get_assets,
    get_original_file_path,
    get_thumbnail_file_path,
    upload_asset_file,
)


router = APIRouter(
    prefix="/api/v1/assets",
    tags=["assets"],
)


@router.get("/", response_model=list[Asset])
def list_assets(
    session: Session = Depends(get_session),
):
    return get_assets(session)


@router.post(
    "/upload",
    response_model=Asset,
    status_code=201,
)
async def upload_asset(
    file: UploadFile,
    session: Session = Depends(get_session),
):
    return await upload_asset_file(
        file,
        session,
    )


@router.get("/{asset_id}/original")
def get_original_asset(
    asset_id: UUID,
    session: Session = Depends(get_session),
):
    asset = get_asset(
        session,
        asset_id,
    )

    file_path = get_original_file_path(
        asset,
    )

    return FileResponse(
        path=file_path,
        media_type=asset.mime_type,
    )


@router.get("/{asset_id}/thumbnail")
def get_asset_thumbnail(
    asset_id: UUID,
    session: Session = Depends(get_session),
):
    asset = get_asset(
        session,
        asset_id,
    )

    thumbnail_path = get_thumbnail_file_path(
        asset,
    )

    return FileResponse(
        path=thumbnail_path,
        media_type="image/jpeg",
    )
