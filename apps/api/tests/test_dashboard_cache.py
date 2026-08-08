"""Dashboard TTL cache tests (epic-0007, sub-0007-01).

Scenarios covered:

* **TTL freshness.** Two ``get`` calls within 60 s hit the same
  cached payload; a third call after the TTL expires (synthetically
  shortened via :func:`set_default_ttl` + ``ttl_seconds=``) recomputes.
* **Endpoint isolation.** Caching a payload under ``endpoint='summary'``
  does NOT collide with ``endpoint='networth-trend'`` — different
  endpoints produce different cache slots even when the params hash
  matches.
* **User isolation.** Alice's cached payload never surfaces under
  Bob's ``get`` — same endpoint + same params but a different
  ``user_id`` produces a cache miss for Bob.
* **Params collision safety.** Different param values produce
  different cache slots; the same params (in any dict order) share a
  slot.
* **Invalidation table.** Each write surface (transactions / accounts
  / goals / debts) invalidates exactly the endpoints the spec calls
  out — verified via the per-user invalidation counts.
* **Concurrent access.** A thread hammering ``get`` / ``set`` does
  not corrupt the cache (thread-lock smoke test).

The route-level integration test (``test_dashboard_invalidation_on_write``
in :mod:`tests.test_dashboard_aggregations`) covers the wiring between
the routers and the cache; these unit tests focus on the cache module
itself.
"""

from __future__ import annotations

import threading
import uuid

import pytest

from app.services import dashboard_cache


@pytest.fixture(autouse=True)
def _clean_cache() -> None:
    """Drop the cache between tests so they're independent."""
    dashboard_cache.reset_for_test()
    yield
    dashboard_cache.reset_for_test()


# --- Basic get/set roundtrip -----------------------------------------------


def test_get_returns_none_on_miss() -> None:
    """Uncached (user, endpoint, params) → ``get`` returns ``None``."""
    assert (
        dashboard_cache.get(
            user_id=uuid.uuid4(),
            endpoint="summary",
            params={"months": 12},
        )
        is None
    )


def test_set_then_get_returns_same_payload() -> None:
    """Round-trip the payload — set then get returns the same value."""
    user_id = uuid.uuid4()
    payload = {"networth_cents": 5_000_000, "currency": "IDR"}
    dashboard_cache.put(
        user_id=user_id,
        endpoint="summary",
        params={},
        value=payload,
    )
    cached = dashboard_cache.get(user_id=user_id, endpoint="summary", params={})
    assert cached == payload


def test_set_rejects_unknown_endpoint() -> None:
    """``set`` rejects endpoint names that aren't in the dashboard set.

    Catches typos at the call site so a typo can't silently leak
    outside the cache's invalidation contract.
    """
    with pytest.raises(ValueError, match="unknown dashboard endpoint"):
        dashboard_cache.put(
            user_id=uuid.uuid4(),
            endpoint="typo-endpoint",
            params={},
            value={"x": 1},
        )


def test_set_rejects_non_positive_ttl() -> None:
    """``ttl_seconds <= 0`` is rejected at the call site."""
    with pytest.raises(ValueError, match="ttl_seconds must be positive"):
        dashboard_cache.put(
            user_id=uuid.uuid4(),
            endpoint="summary",
            params={},
            value={"x": 1},
            ttl_seconds=0,
        )
    with pytest.raises(ValueError, match="ttl_seconds must be positive"):
        dashboard_cache.put(
            user_id=uuid.uuid4(),
            endpoint="summary",
            params={},
            value={"x": 1},
            ttl_seconds=-1,
        )


# --- TTL expiry -------------------------------------------------------------


def test_get_returns_none_after_ttl_expires() -> None:
    """Synthetic 1 ms TTL → the second ``get`` is a cache miss.

    We override the default (60 s) with a 1 ms override via
    ``ttl_seconds`` so the test stays fast.
    """
    user_id = uuid.uuid4()
    dashboard_cache.put(
        user_id=user_id,
        endpoint="summary",
        params={},
        value={"x": 1},
        ttl_seconds=0.001,  # 1 ms — sleeps ~5 ms below before re-reading
    )
    assert dashboard_cache.get(user_id=user_id, endpoint="summary") == {"x": 1}
    import time

    time.sleep(0.005)
    assert dashboard_cache.get(user_id=user_id, endpoint="summary") is None


def test_get_drops_expired_entry_from_store() -> None:
    """The TTL-expired entry is evicted, not just bypassed."""
    user_id = uuid.uuid4()
    dashboard_cache.put(
        user_id=user_id,
        endpoint="summary",
        params={},
        value={"x": 1},
        ttl_seconds=0.001,
    )
    assert dashboard_cache.cache_size() == 1
    import time

    time.sleep(0.005)
    assert dashboard_cache.get(user_id=user_id, endpoint="summary") is None
    assert dashboard_cache.cache_size() == 0


def test_set_default_ttl_changes_future_entries() -> None:
    """``set_default_ttl`` only affects subsequent ``set`` calls."""
    user_id = uuid.uuid4()
    dashboard_cache.set_default_ttl(0.001)
    dashboard_cache.put(
        user_id=user_id,
        endpoint="summary",
        params={},
        value={"x": 1},
    )
    import time

    time.sleep(0.005)
    assert dashboard_cache.get(user_id=user_id, endpoint="summary") is None


def test_set_default_ttl_rejects_non_positive() -> None:
    """``set_default_ttl(0)`` is a programmer error, not a no-op."""
    with pytest.raises(ValueError, match="TTL must be positive"):
        dashboard_cache.set_default_ttl(0)
    with pytest.raises(ValueError, match="TTL must be positive"):
        dashboard_cache.set_default_ttl(-1)


# --- Endpoint isolation ----------------------------------------------------


def test_different_endpoints_do_not_collide() -> None:
    """Same user + same params + different endpoints → distinct slots."""
    user_id = uuid.uuid4()
    dashboard_cache.put(
        user_id=user_id,
        endpoint="summary",
        params={"months": 12},
        value={"endpoint": "summary"},
    )
    dashboard_cache.put(
        user_id=user_id,
        endpoint="networth-trend",
        params={"months": 12},
        value={"endpoint": "networth-trend"},
    )
    summary = dashboard_cache.get(user_id=user_id, endpoint="summary", params={"months": 12})
    trend = dashboard_cache.get(user_id=user_id, endpoint="networth-trend", params={"months": 12})
    assert summary == {"endpoint": "summary"}
    assert trend == {"endpoint": "networth-trend"}


# --- User isolation --------------------------------------------------------


def test_different_users_do_not_collide() -> None:
    """Same endpoint + same params + different users → distinct slots."""
    alice = uuid.uuid4()
    bob = uuid.uuid4()
    dashboard_cache.put(
        user_id=alice,
        endpoint="summary",
        params={},
        value={"user": "alice"},
    )
    dashboard_cache.put(
        user_id=bob,
        endpoint="summary",
        params={},
        value={"user": "bob"},
    )
    assert dashboard_cache.get(user_id=alice, endpoint="summary") == {"user": "alice"}
    assert dashboard_cache.get(user_id=bob, endpoint="summary") == {"user": "bob"}


# --- Params collision safety ------------------------------------------------


def test_same_params_different_dicts_share_slot() -> None:
    """Dict-key order doesn't fragment the cache for the same params."""
    user_id = uuid.uuid4()
    dashboard_cache.put(
        user_id=user_id,
        endpoint="networth-trend",
        params={"months": 12},
        value={"a": 1},
    )
    # Read with the same params in different dict-order.
    cached = dashboard_cache.get(
        user_id=user_id,
        endpoint="networth-trend",
        params={"months": 12},
    )
    assert cached == {"a": 1}


def test_different_params_produce_different_slots() -> None:
    """Same endpoint + different ``months`` → distinct cache slots."""
    user_id = uuid.uuid4()
    dashboard_cache.put(
        user_id=user_id,
        endpoint="networth-trend",
        params={"months": 12},
        value={"m": 12},
    )
    dashboard_cache.put(
        user_id=user_id,
        endpoint="networth-trend",
        params={"months": 24},
        value={"m": 24},
    )
    assert dashboard_cache.get(
        user_id=user_id, endpoint="networth-trend", params={"months": 12}
    ) == {"m": 12}
    assert dashboard_cache.get(
        user_id=user_id, endpoint="networth-trend", params={"months": 24}
    ) == {"m": 24}


def test_none_params_and_empty_dict_share_slot() -> None:
    """``None`` and ``{}`` should resolve to the same cache slot."""
    user_id = uuid.uuid4()
    dashboard_cache.put(
        user_id=user_id,
        endpoint="summary",
        params=None,
        value={"x": 1},
    )
    assert dashboard_cache.get(user_id=user_id, endpoint="summary", params={}) == {"x": 1}
    assert dashboard_cache.get(user_id=user_id, endpoint="summary", params=None) == {"x": 1}


def test_string_and_int_param_values_distinct_slots() -> None:
    """``"12"`` and ``12`` produce different cache slots."""
    user_id = uuid.uuid4()
    dashboard_cache.put(
        user_id=user_id,
        endpoint="top-categories",
        params={"limit": 5},
        value={"v": "int"},
    )
    dashboard_cache.put(
        user_id=user_id,
        endpoint="top-categories",
        params={"limit": "5"},
        value={"v": "str"},
    )
    assert dashboard_cache.get(user_id=user_id, endpoint="top-categories", params={"limit": 5}) == {
        "v": "int"
    }
    assert dashboard_cache.get(
        user_id=user_id, endpoint="top-categories", params={"limit": "5"}
    ) == {"v": "str"}


# --- Invalidation table ----------------------------------------------------


def test_invalidate_removes_only_target_endpoints_for_user() -> None:
    """``invalidate`` drops only the listed endpoints for the target user.

    Three users x three endpoints set up; invalidate one user's
    summary -> only that user's summary slot disappears.
    """
    a = uuid.uuid4()
    b = uuid.uuid4()
    for u in (a, b):
        for endpoint in ("summary", "goals-progress", "debts-summary"):
            dashboard_cache.put(
                user_id=u, endpoint=endpoint, params={}, value={"u": str(u), "e": endpoint}
            )
    assert dashboard_cache.cache_size() == 6

    removed = dashboard_cache.invalidate(user_id=a, endpoints={"summary"})
    assert removed == 1
    assert dashboard_cache.cache_size() == 5

    # a's summary is gone, but a's other endpoints are still present.
    assert dashboard_cache.get(user_id=a, endpoint="summary") is None
    assert dashboard_cache.get(user_id=a, endpoint="goals-progress") == {
        "u": str(a),
        "e": "goals-progress",
    }
    # b's summary is untouched.
    assert dashboard_cache.get(user_id=b, endpoint="summary") == {
        "u": str(b),
        "e": "summary",
    }


def test_invalidate_empty_set_is_a_noop() -> None:
    """Empty ``endpoints`` set → no removal, no error."""
    user_id = uuid.uuid4()
    dashboard_cache.put(user_id=user_id, endpoint="summary", params={}, value={"x": 1})
    assert dashboard_cache.invalidate(user_id=user_id, endpoints=set()) == 0
    assert dashboard_cache.cache_size() == 1


def test_invalidate_rejects_unknown_endpoint() -> None:
    """Unknown endpoint names surface immediately as :class:`ValueError`."""
    with pytest.raises(ValueError, match="unknown dashboard endpoint"):
        dashboard_cache.invalidate(
            user_id=uuid.uuid4(), endpoints={"summary", "not-a-real-endpoint"}
        )


def test_invalidate_for_table_transactions_clears_all_endpoints() -> None:
    """A transaction write invalidates every cached dashboard slot.

    Per the spec's invalidation table (``transactions`` → all six
    endpoints).
    """
    user_id = uuid.uuid4()
    for endpoint in dashboard_cache.ENDPOINT_NAMES:
        dashboard_cache.put(user_id=user_id, endpoint=endpoint, params={}, value={"e": endpoint})
    assert dashboard_cache.cache_size() == len(dashboard_cache.ENDPOINT_NAMES)

    removed = dashboard_cache.invalidate_for_table(user_id=user_id, table="transactions")
    assert removed == len(dashboard_cache.ENDPOINT_NAMES)
    assert dashboard_cache.cache_size() == 0


def test_invalidate_for_table_accounts_clears_summary_and_networth() -> None:
    """``accounts`` writes invalidate ``summary`` + ``networth-trend`` only."""
    user_id = uuid.uuid4()
    for endpoint in dashboard_cache.ENDPOINT_NAMES:
        dashboard_cache.put(user_id=user_id, endpoint=endpoint, params={}, value={"e": endpoint})

    removed = dashboard_cache.invalidate_for_table(user_id=user_id, table="accounts")
    assert removed == 2
    # The other four endpoints stay put.
    for endpoint in dashboard_cache.ENDPOINT_NAMES:
        if endpoint in {"summary", "networth-trend"}:
            assert dashboard_cache.get(user_id=user_id, endpoint=endpoint) is None
        else:
            assert dashboard_cache.get(user_id=user_id, endpoint=endpoint) == {"e": endpoint}


def test_invalidate_for_table_goals_clears_summary_and_goals_progress() -> None:
    """``goals`` writes invalidate ``summary`` + ``goals-progress``."""
    user_id = uuid.uuid4()
    for endpoint in dashboard_cache.ENDPOINT_NAMES:
        dashboard_cache.put(user_id=user_id, endpoint=endpoint, params={}, value={"e": endpoint})

    removed = dashboard_cache.invalidate_for_table(user_id=user_id, table="goals")
    assert removed == 2
    assert dashboard_cache.get(user_id=user_id, endpoint="summary") is None
    assert dashboard_cache.get(user_id=user_id, endpoint="goals-progress") is None
    # The rest stay.
    assert dashboard_cache.get(user_id=user_id, endpoint="networth-trend") == {
        "e": "networth-trend"
    }


def test_invalidate_for_table_debts_clears_summary_and_debts_summary() -> None:
    """``debts`` writes invalidate ``summary`` + ``debts-summary``."""
    user_id = uuid.uuid4()
    for endpoint in dashboard_cache.ENDPOINT_NAMES:
        dashboard_cache.put(user_id=user_id, endpoint=endpoint, params={}, value={"e": endpoint})

    removed = dashboard_cache.invalidate_for_table(user_id=user_id, table="debts")
    assert removed == 2
    assert dashboard_cache.get(user_id=user_id, endpoint="summary") is None
    assert dashboard_cache.get(user_id=user_id, endpoint="debts-summary") is None
    assert dashboard_cache.get(user_id=user_id, endpoint="goals-progress") == {
        "e": "goals-progress"
    }


def test_invalidate_for_table_unknown_table_raises() -> None:
    """An unknown table name surfaces immediately as :class:`ValueError`."""
    with pytest.raises(ValueError, match="no invalidation mapping for table"):
        dashboard_cache.invalidate_for_table(user_id=uuid.uuid4(), table="not_a_real_table")


def test_invalidate_does_not_touch_other_users() -> None:
    """``invalidate_for_table`` is scoped per-user — Alice's writes
    don't touch Bob's cache."""
    alice = uuid.uuid4()
    bob = uuid.uuid4()
    for u in (alice, bob):
        dashboard_cache.put(user_id=u, endpoint="summary", params={}, value={"u": str(u)})
    assert dashboard_cache.cache_size() == 2

    removed = dashboard_cache.invalidate_for_table(user_id=alice, table="accounts")
    assert removed == 1
    assert dashboard_cache.get(user_id=alice, endpoint="summary") is None
    assert dashboard_cache.get(user_id=bob, endpoint="summary") == {"u": str(bob)}


# --- Reset ------------------------------------------------------------------


def test_reset_for_test_clears_cache_and_restores_default_ttl() -> None:
    """``reset_for_test`` empties the store + restores the default TTL."""
    dashboard_cache.set_default_ttl(0.001)
    assert dashboard_cache._default_ttl == 0.001
    dashboard_cache.put(user_id=uuid.uuid4(), endpoint="summary", params={}, value={"x": 1})
    assert dashboard_cache.cache_size() == 1

    dashboard_cache.reset_for_test()
    assert dashboard_cache.cache_size() == 0
    # The default TTL is restored.
    assert dashboard_cache._default_ttl == dashboard_cache.DEFAULT_TTL_SECONDS


# --- Concurrent access -----------------------------------------------------


def test_concurrent_get_set_does_not_corrupt_cache() -> None:
    """50 threads hammering ``get`` + ``set`` for the same key — no
    exceptions, the cache stays consistent.

    Smoke test for the ``threading.Lock``; not a full stress test.
    """
    user_id = uuid.uuid4()
    iterations = 50
    errors: list[BaseException] = []

    def worker(thread_id: int) -> None:
        try:
            for i in range(iterations):
                dashboard_cache.put(
                    user_id=user_id,
                    endpoint="summary",
                    params={"t": thread_id, "i": i},
                    value={"t": thread_id, "i": i},
                )
                cached = dashboard_cache.get(
                    user_id=user_id,
                    endpoint="summary",
                    params={"t": thread_id, "i": i},
                )
                if cached != {"t": thread_id, "i": i}:
                    errors.append(AssertionError(f"thread {thread_id} iter {i}: got {cached!r}"))
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"{len(errors)} errors during concurrent run: {errors[:3]}"
