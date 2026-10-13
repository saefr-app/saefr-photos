from uuid import UUID

from sqlmodel import Session, select

from app.models.asset import Asset


def list_assets(session: Session) -> list[Asset]:
    statement = select(Asset)
    assets = session.exec(statement).all()

    return assets


def get_asset_by_id(
    session: Session,
    asset_id: UUID,
) -> Asset | None:
    return session.get(
        Asset,
        asset_id,
    )


def create_asset(
    session: Session,
    asset: Asset,
) -> Asset:
    session.add(asset)
    session.commit()
    session.refresh(asset)

    return asset
