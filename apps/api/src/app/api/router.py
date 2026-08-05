"""API v1 router aggregator."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import accounts as accounts_v1
from app.api.v1 import auth as auth_v1
from app.api.v1 import categories as categories_v1
from app.api.v1 import category_rules as category_rules_v1
from app.api.v1 import debts as debts_v1
from app.api.v1 import export as export_v1
from app.api.v1 import export_json as export_json_v1
from app.api.v1 import goals as goals_v1
from app.api.v1 import preferences as preferences_v1
from app.api.v1 import settings as settings_v1
from app.api.v1 import transactions as transactions_v1
from app.api.v1 import user_settings as user_settings_v1

api_v1_router = APIRouter(prefix="/api/v1")

api_v1_router.include_router(auth_v1.router)
api_v1_router.include_router(categories_v1.router)
api_v1_router.include_router(category_rules_v1.apply_router)
api_v1_router.include_router(category_rules_v1.router)
api_v1_router.include_router(preferences_v1.router)
api_v1_router.include_router(accounts_v1.router)
api_v1_router.include_router(transactions_v1.router)
api_v1_router.include_router(goals_v1.router)
api_v1_router.include_router(debts_v1.router)
api_v1_router.include_router(export_json_v1.router)
api_v1_router.include_router(user_settings_v1.router)
api_v1_router.include_router(export_v1.router)
api_v1_router.include_router(settings_v1.router)


@api_v1_router.get("/ping", tags=["meta"])
async def ping() -> dict[str, str]:
    """Liveness probe for the API surface."""
    return {"pong": "ok"}
