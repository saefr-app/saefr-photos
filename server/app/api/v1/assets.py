from fastapi import APIRouter

from app.models.asset import Asset

router = APIRouter(
    prefix="/api/v1/assets",
    tags=["assets"],
)

fake_assets: list[Asset] = []


@router.get("/", response_model=list[Asset])
def list_assets():
    return fake_assets

@router.post(
    "/",
    response_model=Asset,
    status_code=201,
)
def create_asset(asset: Asset):
    fake_assets.append(asset)
    return asset