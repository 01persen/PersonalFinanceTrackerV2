"""Shared pytest fixtures."""

from __future__ import annotations

import os

os.environ.setdefault("APP_ENV", "test")
# 32+ bytes so pyjwt doesn't complain the HMAC key is too short for SHA256.
os.environ.setdefault("JWT_SECRET", "test-secret-not-for-production-32b-min")

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = create_app()
    with TestClient(app) as c:
        yield c
