"""Health endpoint smoke tests."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_health_ok(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_api_ping(client: TestClient) -> None:
    resp = client.get("/api/v1/ping")
    assert resp.status_code == 200
    assert resp.json() == {"pong": "ok"}
