from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from app.database.database import get_session
from app.models.asset import Asset, AssetCreate


router = APIRouter(
    prefix="/api/v1/assets",
    tags=["assets"],
)


@router.get("/", response_model=list[Asset])
def list_assets(
    session: Session = Depends(get_session),
):
    statement = select(Asset)
    assets = session.exec(statement).all()

    return assets


@router.post(
    "/",
    response_model=Asset,
    status_code=201,
)
def create_asset(
    asset_data: AssetCreate,
    session: Session = Depends(get_session),
):
    asset = Asset.model_validate(asset_data)

    session.add(asset)
    session.commit()
    session.refresh(asset)

    return asset