"""TTL dict cache for the dashboard aggregation endpoints (sub-0007-01).

TL decision (epic-0007, sub-0007-01): **stdlib-only TTL dict** — no
``cachetools`` or ``aiocache`` dependency. The cache is intentionally
tiny (~40 LOC, in-process, not persisted, not shared between workers)
because:

* The data dependency graph is well-known (six read endpoints over
  four tables) so the invalidation hooks stay simple — see the
  :func:`invalidate` table below for which endpoints each table
  invalidates.
* Multi-worker consistency is intentionally traded for simplicity: a
  fresh uvicorn worker boots with an empty cache and the first
  dashboard load per user is uncached; everything after that hits the
  TTL until a write path nukes the relevant key. The 60-second TTL
  keeps the worst-case staleness bounded even across workers.

Cache contract:

* **Key.** ``(user_id, endpoint_name, params_hash)`` — three-tuple.
  ``user_id`` scopes the cache per-caller (no leak across accounts).
  ``endpoint_name`` is one of the six dashboard endpoints
  (``"summary"`` / ``"networth-trend"`` / ``"income-expense-trend"`` /
  ``"top-categories"`` / ``"goals-progress"`` / ``"debts-summary"``).
  ``params_hash`` is a deterministic ``sha256`` of the sorted query
  params (``months=12&limit=5`` etc.) so two requests with the same
  effective params share a cache slot.
* **Value.** The route's response payload as a plain ``dict`` (the
  Pydantic model dumps it before ``set`` and ``model_validate`` reads
  it on ``get``).
* **TTL.** 60 seconds by default — long enough to absorb the FE's
  navigation-driven re-renders (a user moving between dashboard tabs
  within a minute sees the same numbers, no recompute) and short
  enough that a missed invalidation clears within a minute. Tunable
  via :data:`DEFAULT_TTL_SECONDS` for tests.
* **TTL clock.** :func:`time.monotonic` (not :func:`time.time`) so the
  cache stays sane when the system clock jumps (NTP correction, leap
  second, container suspend/resume). A monotonic drift would only
  reduce cache life, never extend it past the 60s budget.

Invalidation table — which write path clears which endpoint:

================  ====================================================
Write endpoint    Invalidated cache keys
================  ====================================================
POST/PATCH/DELETE ``transactions`` → all six endpoints (the FE
                   dashboard re-aggregates everything when a
                   transaction lands or its category flips).
POST/PATCH/DELETE ``accounts`` → `summary`, `networth-trend` (only
                   these two depend on the accounts aggregate).
POST/PATCH/DELETE ``goals`` → `summary` (EF pct), `goals-progress`.
POST/PATCH/DELETE ``debts`` → `summary` (total liabilities when a CC
                   is touched), `debts-summary`.
================  ====================================================

The module-level helpers (:func:`get`, :func:`set`, :func:`invalidate`,
:func:`reset_for_test`) are the only API the routes need; everything
else is internal state kept behind a lock so two concurrent requests
don't race on the eviction sweep.

Thread safety: :class:`threading.Lock` is sufficient because every
caller is a FastAPI route handler running in the same process (uvicorn
workers are separate processes — the cache is *not* shared across
them; see the worker caveat above). The lock is held only across the
dict mutation, never across the SQL query the route is about to run.
"""

from __future__ import annotations

import hashlib
import threading
import time
from typing import Any, Final

DEFAULT_TTL_SECONDS: Final = 60.0
"""Default TTL for every cached entry.

The same constant is used by every endpoint; per-endpoint overrides
would just complicate the invalidation table. Tests use
:func:`set_default_ttl` to shrink the value to keep the suite fast.
"""

# All six dashboard endpoint names — keep them in a frozenset so the
# invalidation helpers can sanity-check their inputs without having to
# import the route module (which would pull SQLAlchemy).
ENDPOINT_NAMES: Final = frozenset(
    {
        "summary",
        "networth-trend",
        "income-expense-trend",
        "top-categories",
        "goals-progress",
        "debts-summary",
    }
)

# Invalidation table — maps the *write surface* (table name) to the set
# of cached endpoint names that read from it. The route layer uses
# these to clear the right keys on POST/PATCH/DELETE.
#
# Wire to all six endpoints when a ``transactions`` row changes — every
# dashboard card eventually rolls up the transaction set, so it's
# simpler (and not measurably slower) to flush everything than to
# reason about which card is affected by which column.
_INVALIDATION_TABLE: Final[dict[str, frozenset[str]]] = {
    "transactions": ENDPOINT_NAMES,
    "accounts": frozenset({"summary", "networth-trend"}),
    "goals": frozenset({"summary", "goals-progress"}),
    "debts": frozenset({"summary", "debts-summary"}),
}

# Module-level state — single global cache for the process. Tests call
# :func:`reset_for_test` to start each test with an empty slate.
_lock = threading.Lock()
_store: dict[tuple[Any, ...], tuple[float, Any]] = {}
_default_ttl: float = DEFAULT_TTL_SECONDS


def _params_hash(params: dict[str, Any] | None) -> str:
    """Hash the query-param dict into a stable cache suffix.

    Sorts by key so ``{"months": 12, "limit": 5}`` and ``{"limit": 5,
    "months": 12}`` produce the same hash. ``None`` and empty dict
    share a single hash so the "no params" path doesn't accidentally
    fragment the cache. Values are stringified through ``repr`` so a
    non-string value (int, UUID, etc.) doesn't blow up the join.
    """
    if not params:
        return "0"
    items = ",".join(f"{k}={v!r}" for k, v in sorted(params.items()))
    return hashlib.sha256(items.encode("utf-8")).hexdigest()[:16]


def _evict_expired(now: float) -> None:
    """Drop entries whose TTL has elapsed.

    Called inside the lock by :func:`get` before the lookup so a cold
    cache doesn't accumulate dead entries. We sweep lazily — every
    :func:`get` clears the expired prefix rather than running a
    timer, which keeps the module free of background threads.
    """
    expired = [key for key, (expires_at, _) in _store.items() if expires_at <= now]
    for key in expired:
        _store.pop(key, None)


def set_default_ttl(seconds: float) -> None:
    """Override the default TTL for the lifetime of the process.

    Test-only escape hatch — production code should leave the default
    alone. The change is process-global so callers should set it once
    in a fixture and reset it afterwards.
    """
    global _default_ttl
    if seconds <= 0:
        raise ValueError("TTL must be positive")
    _default_ttl = float(seconds)


def get(
    *,
    user_id: Any,
    endpoint: str,
    params: dict[str, Any] | None = None,
) -> Any | None:
    """Return the cached payload for ``(user_id, endpoint, params)`` if fresh.

    Returns ``None`` for a cache miss *or* a TTL-expired entry — the
    caller treats both as "recompute + cache". The sweep inside the
    lock removes the expired entry as a side effect.
    """
    key = (user_id, endpoint, _params_hash(params))
    now = time.monotonic()
    with _lock:
        _evict_expired(now)
        entry = _store.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if expires_at <= now:
            _store.pop(key, None)
            return None
        return value


def put(
    *,
    user_id: Any,
    endpoint: str,
    params: dict[str, Any] | None,
    value: Any,
    ttl_seconds: float | None = None,
) -> None:
    """Store ``value`` under ``(user_id, endpoint, params)``.

    ``ttl_seconds`` overrides :data:`_default_ttl` for this one entry;
    only used by tests that want to exercise expiry behaviour without
    monkey-patching the clock.
    """
    if endpoint not in ENDPOINT_NAMES:
        raise ValueError(f"unknown dashboard endpoint: {endpoint!r}")
    ttl = float(ttl_seconds) if ttl_seconds is not None else _default_ttl
    if ttl <= 0:
        raise ValueError("ttl_seconds must be positive")
    key = (user_id, endpoint, _params_hash(params))
    expires_at = time.monotonic() + ttl
    with _lock:
        _store[key] = (expires_at, value)


def invalidate(*, user_id: Any, endpoints: set[str] | frozenset[str]) -> int:
    """Drop every cache entry for ``user_id`` whose endpoint is in ``endpoints``.

    Returns the number of entries removed (handy for tests + for the
    debug log the routers emit on the slow path). A no-op for an
    empty ``endpoints`` set so the call sites stay simple.
    """
    if not endpoints:
        return 0
    unknown = endpoints - ENDPOINT_NAMES
    if unknown:
        raise ValueError(f"unknown dashboard endpoint(s): {sorted(unknown)!r}")
    removed = 0
    with _lock:
        keys = list(_store.keys())
        for key in keys:
            cached_user_id, cached_endpoint, _ = key
            if cached_user_id == user_id and cached_endpoint in endpoints:
                _store.pop(key, None)
                removed += 1
    return removed


def invalidate_for_table(*, user_id: Any, table: str) -> int:
    """Drop the cache entries the :data:`_INVALIDATION_TABLE` maps ``table`` to.

    Convenience wrapper used by the write-side routers. Unknown table
    names raise :class:`ValueError` so a typo in the call site is
    caught immediately rather than silently leaving stale entries on
    the cache.
    """
    endpoints = _INVALIDATION_TABLE.get(table)
    if endpoints is None:
        raise ValueError(f"no invalidation mapping for table {table!r}")
    return invalidate(user_id=user_id, endpoints=endpoints)


def reset_for_test() -> None:
    """Empty the cache + restore the default TTL.

    Used by the test suite's fixture setup. Production code never calls
    this; a warm cache survives process restart only by accident (it
    doesn't, but the TTL absorbs that).
    """
    global _default_ttl
    with _lock:
        _store.clear()
    _default_ttl = DEFAULT_TTL_SECONDS


def cache_size() -> int:
    """Return the live cache size (for tests + debug logs)."""
    with _lock:
        return len(_store)
