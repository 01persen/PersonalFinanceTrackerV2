/**
 * sub-0005-05 — unit test for the progress banner helpers.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest
 * runner (verified during sub-0005-05 setup — see issue spec note
 * "scaffold-first, framework-second"). Until then this file lives as
 * a runnable Node test that exercises the *pure* helpers without
 * requiring a renderer:
 *
 *   node --import tsx apps/web/src/components/goals/__tests__/progress-banner.test.tsx
 *
 * It deliberately imports only the pure function — no React, no
 * localStorage, no DOM — so the assertions cover exactly the
 * threshold-crossing logic pinned by the issue's "AC" bullet.
 *
 * When a Jest config lands (sub-0005-05 follow-up — out of scope
 * here), the same file can be migrated to standard `describe` /
 * `it` blocks without changing the assertions: every assert
 * statement below corresponds 1:1 to a `it(...)` case.
 */

import assert from "node:assert/strict";

import {
  crossedThresholds,
  hasCrossedThreshold,
  HIGHEST_PROGRESS_THRESHOLD,
  highestThresholdReached,
  LOWEST_PROGRESS_THRESHOLD,
  PROGRESS_THRESHOLDS,
  progressBannerKey,
} from "@/components/goals/progress-banner-helpers";
import {
  clearBannerSession,
  dismissBanner,
  isBannerDismissed,
  PROGRESS_BANNER_DISMISSED_PREFIX,
  PROGRESS_LAST_SEEN_PREFIX,
  readLastSeenPercent,
  writeLastSeenPercent,
} from "@/components/goals/progress-banner-state";

interface TestCase {
  name: string;
  run(): void;
}

const testCases: TestCase[] = [
  {
    name: "hasCrossedThreshold(null, 0) — first observation at 0%, no crossing",
    run(): void {
      assert.equal(hasCrossedThreshold(null, 0, 25), false);
      assert.equal(hasCrossedThreshold(null, 0, 50), false);
      assert.equal(hasCrossedThreshold(null, 0, 75), false);
      assert.equal(hasCrossedThreshold(null, 0, 100), false);
    },
  },
  {
    name: "hasCrossedThreshold(null, 24) — first observation below ladder",
    run(): void {
      assert.equal(hasCrossedThreshold(null, 24, 25), false);
    },
  },
  {
    name: "hasCrossedThreshold(null, 25) — first observation at 25% crosses it",
    run(): void {
      assert.equal(hasCrossedThreshold(null, 25, 25), true);
      assert.equal(hasCrossedThreshold(null, 25, 50), false);
      assert.equal(hasCrossedThreshold(null, 25, 75), false);
      assert.equal(hasCrossedThreshold(null, 25, 100), false);
    },
  },
  {
    name: "hasCrossedThreshold(null, 100) — first observation at 100% (achieved)",
    run(): void {
      assert.equal(hasCrossedThreshold(null, 100, 25), true);
      assert.equal(hasCrossedThreshold(null, 100, 50), true);
      assert.equal(hasCrossedThreshold(null, 100, 75), true);
      assert.equal(hasCrossedThreshold(null, 100, 100), true);
    },
  },
  {
    name: "hasCrossedThreshold(0, 24) — still below ladder",
    run(): void {
      assert.equal(hasCrossedThreshold(0, 24, 25), false);
    },
  },
  {
    name: "hasCrossedThreshold(24, 25) — just crossed 25%",
    run(): void {
      assert.equal(hasCrossedThreshold(24, 25, 25), true);
    },
  },
  {
    name: "hasCrossedThreshold(25, 25) — at boundary, no new crossing",
    run(): void {
      assert.equal(hasCrossedThreshold(25, 25, 25), false);
    },
  },
  {
    name: "hasCrossedThreshold(75, 100) — jumps across the 100% line",
    run(): void {
      assert.equal(hasCrossedThreshold(75, 100, 25), false);
      assert.equal(hasCrossedThreshold(75, 100, 50), false);
      assert.equal(hasCrossedThreshold(75, 100, 75), false);
      assert.equal(hasCrossedThreshold(75, 100, 100), true);
    },
  },
  {
    name: "hasCrossedThreshold(100, 90) — never goes backwards",
    run(): void {
      assert.equal(hasCrossedThreshold(100, 90, 25), false);
      assert.equal(hasCrossedThreshold(100, 90, 100), false);
    },
  },
  {
    name: "hasCrossedThreshold — defensive null/negative sanitises to 0",
    run(): void {
      // `null` and `undefined` collapse to 0 in the helper.
      assert.equal(hasCrossedThreshold(undefined, 25, 25), true);
      // Negative prev clamps to 0 in the helper, so any crossing off
      // 0 still reads as "first time past".
      assert.equal(hasCrossedThreshold(-10, 25, 25), true);
    },
  },
  {
    name: "crossedThresholds(0, 80) — three thresholds crossed in one jump",
    run(): void {
      assert.deepEqual(crossedThresholds(0, 80), [25, 50, 75]);
    },
  },
  {
    name: "crossedThresholds(80, 100) — single threshold crossed",
    run(): void {
      assert.deepEqual(crossedThresholds(80, 100), [100]);
    },
  },
  {
    name: "crossedThresholds(50, 50) — no movement, no crossing",
    run(): void {
      assert.deepEqual(crossedThresholds(50, 50), []);
    },
  },
  {
    name: "crossedThresholds(null, 100) — first observation at 100% cross all",
    run(): void {
      assert.deepEqual(crossedThresholds(null, 100), [25, 50, 75, 100]);
    },
  },
  {
    name: "crossedThresholds(null, 5) — first observation below ladder",
    run(): void {
      assert.deepEqual(crossedThresholds(null, 5), []);
    },
  },
  {
    name: "crossedThresholds(75, 75) — same value, no crossing",
    run(): void {
      assert.deepEqual(crossedThresholds(75, 75), []);
    },
  },
  {
    name: "crossedThresholds(120, 120) — defensive: BE clamps to 100",
    run(): void {
      // The helper accepts any number but only those `<= curr` so
      // over-100 values still produce the full ladder once.
      const crossed = crossedThresholds(120, 120);
      assert.deepEqual(crossed, []);
    },
  },
  {
    name: "highestThresholdReached ladder",
    run(): void {
      assert.equal(highestThresholdReached(0), null);
      assert.equal(highestThresholdReached(24), null);
      assert.equal(highestThresholdReached(25), 25);
      assert.equal(highestThresholdReached(49), 25);
      assert.equal(highestThresholdReached(50), 50);
      assert.equal(highestThresholdReached(80), 75);
      assert.equal(highestThresholdReached(99), 75);
      assert.equal(highestThresholdReached(100), 100);
    },
  },
  {
    name: "highestThresholdReached — defensive numbers",
    run(): void {
      // NaN is sanitized to 0 via `Number.isFinite(value)` short-circuit,
      // so the helper treats it as "no progress yet".
      assert.equal(highestThresholdReached(NaN), null);
      // Negative numbers clamp to 0 in the helper.
      assert.equal(highestThresholdReached(-1), null);
      // Infinity is also not finite; the helper sanitises it to 0
      // rather than trusting it as "all thresholds crossed". The BE
      // clamps `percentage` to 100 before it ever reaches the FE.
      assert.equal(highestThresholdReached(Infinity), null);
    },
  },
  {
    name: "PROGRESS_THRESHOLDS ladder is [25, 50, 75, 100]",
    run(): void {
      assert.deepEqual(
        [...PROGRESS_THRESHOLDS],
        [25, 50, 75, 100],
      );
      assert.equal(LOWEST_PROGRESS_THRESHOLD, 25);
      assert.equal(HIGHEST_PROGRESS_THRESHOLD, 100);
    },
  },
  {
    name: "progressBannerKey — stable id for test-id + key props",
    run(): void {
      assert.equal(progressBannerKey("abc", 25), "progress-banner-abc-25");
      assert.equal(progressBannerKey("abc", 100), "progress-banner-abc-100");
    },
  },
  // ----------------------------------------------------------------
  // Storage helpers — guarded by a `window` stub so the tests stay
  // runnable via plain `node` without jsdom.
  // ----------------------------------------------------------------
  {
    name: "storage helpers — happy path (with stubbed window.localStorage)",
    run(): void {
      const fakeStorage = (() => {
        const map = new Map<string, string>();
        return {
          getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
          setItem: (k: string, v: string) => {
            map.set(k, v);
          },
          removeItem: (k: string) => {
            map.delete(k);
          },
          key: (i: number) => Array.from(map.keys())[i] ?? null,
          get length() {
            return map.size;
          },
          clear: () => map.clear(),
        };
      })();
      const savedWindow = (globalThis as { window?: unknown }).window;
      Object.defineProperty(globalThis, "window", {
        value: { localStorage: fakeStorage },
        configurable: true,
        writable: true,
      });

      try {
        // Round-trip the last-seen percentage.
        assert.equal(readLastSeenPercent("goal-1"), null);
        writeLastSeenPercent("goal-1", 47);
        assert.equal(readLastSeenPercent("goal-1"), 47);
        assert.equal(
          fakeStorage.getItem(`${PROGRESS_LAST_SEEN_PREFIX}goal-1`),
          "47",
        );

        // Clamping — BE clamps `percentage` to 0..100; the helper
        // mirrors that defensively.
        writeLastSeenPercent("goal-2", 150);
        assert.equal(readLastSeenPercent("goal-2"), 100);
        writeLastSeenPercent("goal-3", -3);
        assert.equal(readLastSeenPercent("goal-3"), 0);

        // Dismissal + read.
        assert.equal(isBannerDismissed("goal-1", 50), false);
        dismissBanner("goal-1", 50);
        assert.equal(isBannerDismissed("goal-1", 50), true);
        assert.equal(
          fakeStorage.getItem(`${PROGRESS_BANNER_DISMISSED_PREFIX}goal-1-50`),
          "1",
        );

        // Per-threshold isolation — dismissing 50% does not silence
        // the 25% banner for the same goal.
        assert.equal(isBannerDismissed("goal-1", 25), false);

        // `clearBannerSession` scrubs every banner-related key but
        // leaves unrelated keys alone.
        fakeStorage.setItem("untouched", "stay");
        clearBannerSession();
        assert.equal(readLastSeenPercent("goal-1"), null);
        assert.equal(isBannerDismissed("goal-1", 50), false);
        assert.equal(fakeStorage.getItem("untouched"), "stay");
      } finally {
        // Restore the saved window so subsequent tests don't see the stub.
        if (savedWindow === undefined) {
          delete (globalThis as { window?: unknown }).window;
        } else {
          Object.defineProperty(globalThis, "window", {
            value: savedWindow,
            configurable: true,
            writable: true,
          });
        }
      }
    },
  },
  {
    name: "storage helpers — no-op when window is undefined (SSR safety)",
    run(): void {
      const savedWindow = (globalThis as { window?: unknown }).window;
      delete (globalThis as { window?: unknown }).window;
      try {
        // None of these should throw.
        assert.equal(readLastSeenPercent("goal-1"), null);
        writeLastSeenPercent("goal-1", 50);
        assert.equal(isBannerDismissed("goal-1", 25), false);
        dismissBanner("goal-1", 25);
        clearBannerSession();
      } finally {
        Object.defineProperty(globalThis, "window", {
          value: savedWindow,
          configurable: true,
          writable: true,
        });
      }
    },
  },
  {
    name: "storage helpers — malformed payload returns null",
    run(): void {
      const fakeStorage = (() => {
        const map = new Map<string, string>();
        return {
          getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
          setItem: (k: string, v: string) => {
            map.set(k, v);
          },
          removeItem: (k: string) => {
            map.delete(k);
          },
          key: (i: number) => Array.from(map.keys())[i] ?? null,
          get length() {
            return map.size;
          },
          clear: () => map.clear(),
        };
      })();
      const savedWindow = (globalThis as { window?: unknown }).window;
      Object.defineProperty(globalThis, "window", {
        value: { localStorage: fakeStorage },
        configurable: true,
        writable: true,
      });

      try {
        // Empty / corrupted values resolve to `null` so the consumer
        // never sees a NaN downstream.
        fakeStorage.setItem(`${PROGRESS_LAST_SEEN_PREFIX}g-x`, "");
        fakeStorage.setItem(`${PROGRESS_LAST_SEEN_PREFIX}g-y`, "abc");
        assert.equal(readLastSeenPercent("g-x"), null);
        assert.equal(readLastSeenPercent("g-y"), null);
      } finally {
        if (savedWindow === undefined) {
          delete (globalThis as { window?: unknown }).window;
        } else {
          Object.defineProperty(globalThis, "window", {
            value: savedWindow,
            configurable: true,
            writable: true,
          });
        }
      }
    },
  },
];

export function runProgressBannerTests(): {
  passed: number;
  failed: number;
  failures: { name: string; error: unknown }[];
} {
  let passed = 0;
  let failed = 0;
  const failures: { name: string; error: unknown }[] = [];
  for (const tc of testCases) {
    try {
      tc.run();
      passed += 1;
    } catch (error) {
      failed += 1;
      failures.push({ name: tc.name, error });
    }
  }
  return { passed, failed, failures };
}

if (
  // Loaded by `node --test` (or `ts-node` runners) — guard with the
  // import.meta URL check so importing the module from other files
  // doesn't auto-run the assertions.
  typeof process !== "undefined" &&
  process.env !== undefined &&
  process.env["PROGRESS_BANNER_TEST_RUN"] === "1"
) {
  const result = runProgressBannerTests();
  if (result.failed > 0) {

    console.error(
      `[progress-banner.test] ${result.failed} of ${result.failed + result.passed} failed`,
    );
    for (const failure of result.failures) {

      console.error(`  - ${failure.name}`);

      console.error(`      ${(failure.error as Error)?.stack ?? failure.error}`);
    }
    process.exitCode = 1;
  } else {

    console.log(
      `[progress-banner.test] ${result.passed} cases passed`,
    );
  }
}
