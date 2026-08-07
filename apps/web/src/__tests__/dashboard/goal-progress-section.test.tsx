/**
 * sub-0007-06 — unit tests for the `<GoalProgressSection>` helper
 * functions.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0007-02 / sub-0007-03). Until
 * a runner lands, this file runs as a plain Node test:
 *
 *   DASHBOARD_GOALS_PROGRESS_TEST_RUN=1 node --import tsx \
 *     apps/web/src/__tests__/dashboard/goal-progress-section.test.tsx
 *
 * We assert against the *pure* helpers exported from
 * `components/dashboard/widgets/goal-progress-section.tsx`:
 *
 *   - `isGoalsSectionEmpty(goals)` — true iff the goals array is empty
 *   - `countAchievedGoals(goals)` — counts goals whose `status` is
 *     `"achieved"` (the screen-reader summary clause)
 *   - `goalsCountBadgeLabel(goals)` — drives the badge text shown next
 *     to the section heading ("Kosong" vs "N target")
 *
 * The visual rendering (DOM) is covered by the smoke test sub-tasks
 * add later; here we pin the pure logic that drives the dashboard
 * widget. Every `assert` below corresponds 1:1 to an `it(...)` case
 * so the file is portable to `describe` / `it` once a Jest config
 * lands.
 */

import assert from "node:assert/strict";

import {
  countAchievedGoals,
  goalsCountBadgeLabel,
  isGoalsSectionEmpty,
} from "@/components/dashboard/widgets/goal-progress-section";
import type { DashboardGoalProgress } from "@/lib/dashboard/types";

interface TestCase {
  name: string;
  run(): void;
}

function makeGoal(
  overrides: Partial<DashboardGoalProgress> = {},
): DashboardGoalProgress {
  return {
    goalId: "00000000-0000-0000-0000-000000000001",
    name: "Dana Darurat",
    kind: "emergency_fund",
    currentCents: 1_000_000,
    targetCents: 5_000_000,
    pct: 20,
    status: "active",
    dueDate: null,
    ...overrides,
  };
}

const EMPTY_GOALS: DashboardGoalProgress[] = [];
const MIXED_GOALS: DashboardGoalProgress[] = [
  makeGoal({ goalId: "g-1", name: "Dana Darurat", status: "active", pct: 40 }),
  makeGoal({
    goalId: "g-2",
    name: "Liburan",
    kind: "saving",
    status: "achieved",
    pct: 100,
    currentCents: 5_000_000,
  }),
  makeGoal({
    goalId: "g-3",
    name: "Arisan",
    kind: "saving",
    status: "archived",
    pct: 0,
    currentCents: 0,
  }),
];

const testCases: TestCase[] = [
  {
    name: "isGoalsSectionEmpty([]) → true (drives the empty CTA branch)",
    run(): void {
      assert.equal(isGoalsSectionEmpty(EMPTY_GOALS), true);
    },
  },
  {
    name: "isGoalsSectionEmpty([goal]) → false (at least one goal → list)",
    run(): void {
      assert.equal(isGoalsSectionEmpty([makeGoal()]), false);
    },
  },
  {
    name: "countAchievedGoals — only counts `status === 'achieved'`, not archived",
    run(): void {
      // The screen-reader summary must not double-count archived goals
      // as "achieved" — the BE marks them archived once they're
      // retired, so the FE should treat them as inactive rather than
      // success-state. Only `g-2` has `status: 'achieved'`.
      assert.equal(countAchievedGoals(MIXED_GOALS), 1);
    },
  },
  {
    name: "countAchievedGoals([]) → 0 (defensive empty case)",
    run(): void {
      assert.equal(countAchievedGoals(EMPTY_GOALS), 0);
    },
  },
  {
    name: "goalsCountBadgeLabel([]) → 'Kosong' (mirrors placeholder copy)",
    run(): void {
      assert.equal(goalsCountBadgeLabel(EMPTY_GOALS), "Kosong");
    },
  },
  {
    name: "goalsCountBadgeLabel — singular '1 target' and plural '3 target'",
    run(): void {
      // The IDR copy is intentionally singular ("1 target") for
      // readability; we don't try to inflect to "1 target" vs "2
      // targets" — the spec calls for a flat "N target" string.
      assert.equal(goalsCountBadgeLabel([makeGoal()]), "1 target");
      assert.equal(goalsCountBadgeLabel(MIXED_GOALS), "3 target");
    },
  },
  {
    name: "isGoalsSectionEmpty — non-array input is rejected (defensive)",
    run(): void {
      // `null`/`undefined` callers should fail loud in TypeScript;
      // at runtime, the helper relies on `.length`, which throws on
      // `null`/`undefined` — that's fine because the widget guards
      // against non-array inputs at the React layer.
      assert.throws(() =>
        isGoalsSectionEmpty(null as unknown as DashboardGoalProgress[]),
      );
      assert.throws(() =>
        isGoalsSectionEmpty(
          undefined as unknown as DashboardGoalProgress[],
        ),
      );
    },
  },
];

export function runGoalProgressSectionTests(): {
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
  typeof process !== "undefined" &&
  process.env !== undefined &&
  process.env["DASHBOARD_GOALS_PROGRESS_TEST_RUN"] === "1"
) {
  const result = runGoalProgressSectionTests();
  if (result.failed > 0) {
    console.error(
      `[goal-progress-section.test] ${result.failed} of ${result.failed + result.passed} failed`,
    );
    for (const failure of result.failures) {
      console.error(`  - ${failure.name}`);
      console.error(`      ${(failure.error as Error)?.stack ?? failure.error}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `[goal-progress-section.test] ${result.passed} cases passed`,
    );
  }
}
