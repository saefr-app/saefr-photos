from datetime import datetime
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class Asset(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    filename: str
    mime_type: str
    size: int
    created_at: datetime = Field(default_factory=datetime.utcnow)