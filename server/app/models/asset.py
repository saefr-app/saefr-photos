from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlmodel import Field, SQLModel


class AssetBase(SQLModel):
    filename: str
    mime_type: str
    size: int


class AssetCreate(AssetBase):
    pass


class Asset(AssetBase, table=True):
    id: UUID = Field(
        default_factory=uuid4,
        primary_key=True,
    )

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )