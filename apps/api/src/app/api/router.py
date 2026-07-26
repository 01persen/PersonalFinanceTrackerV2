"""API v1 router aggregator."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import auth as auth_v1
from app.api.v1 import categories as categories_v1
from app.api.v1 import preferences as preferences_v1

api_v1_router = APIRouter(prefix="/api/v1")

api_v1_router.include_router(auth_v1.router)
api_v1_router.include_router(categories_v1.router)
api_v1_router.include_router(preferences_v1.router)


@api_v1_router.get("/ping", tags=["meta"])
async def ping() -> dict[str, str]:
    """Liveness probe for the API surface."""
    return {"pong": "ok"}
