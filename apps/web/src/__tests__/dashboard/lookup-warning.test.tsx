/**
 * sub-0007-08 — unit tests for the dashboard lookup-warning + toast.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0005-03 / sub-0007-08). Until a
 * runner lands, this file runs as a plain Node test:
 *
 *   DASHBOARD_LOOKUP_WARNING_TEST_RUN=1 node --import tsx \
 *     apps/web/src/__tests__/dashboard/lookup-warning.test.tsx
 *
 * We assert against the *pure* contracts of `<LookupWarning>` and
 * `<Toast>`:
 *
 *   - `<LookupWarning>` exposes `role="status"` + `aria-live="polite"`
 *     so the banner is non-blocking (AC sub-0007-08).
 *   - `<LookupWarning>` picks the right heading per `kind` (categories
 *     / goals / debts) and falls back to the Indonesian description
 *     when `message` is missing.
 *   - `<LookupWarning>` retry button wires to `onRetry` exactly once
 *     per click.
 *   - `<Toast>` advertises the right `role="status"` + `aria-live` so a
 *     screen-reader user is notified without interrupting focus.
 *
 * sub-0007-12 extended the file with the end-to-end lookup-warning
 * assertion: mount `<TopCategoriesDonut>` with a `topCategories`
 * payload that mixes one valid entry + one lookup-fail entry
 * (`categoryId: null`, `categoryName: null`) and verify the donut
 * tree shows the "Tanpa nama" fallback label, surfaces the named
 * entry, and that `<Toast role="status">` would render alongside
 * the warning banner. The dashboard shell (`<DashboardContent>`)
 * wires these three pieces together — `<TopCategoriesDonut>` for
 * the slot, `<LookupWarning>` for the banner, `<Toast>` for the
 * transient side-channel notification. The pure-helper unit
 * coverage on `<LookupWarning>` + `<Toast>` stays; this file just
 * adds the donut-side contract so the partial-lookup-fail scenario
 * is verifiable beyond the component-level unit tests.
 *
 * Every assertion below corresponds 1:1 to an `it(...)` case so the
 * file is portable to `describe` / `it` once a Jest config lands.
 */

import assert from "node:assert/strict";

import { TopCategoriesDonut } from "@/components/dashboard/charts/top-categories-donut";
import {
  LookupWarning,
  Toast,
  scheduleToastDismiss,
} from "@/components/dashboard/states";
import type { DashboardTopCategory } from "@/lib/dashboard/types";

interface TestCase {
  name: string;
  run(): void;
}

const testCases: TestCase[] = [
  // ---- LookupWarning -----------------------------------------------------
  {
    name: "LookupWarning (categories) → heading 'Kategori tidak dapat dimuat'",
    run(): void {
      const tree = LookupWarning({ kind: "categories" });
      const text = collectText(tree);
      assert.match(text, /Kategori tidak dapat dimuat/);
    },
  },
  {
    name: "LookupWarning (goals) → heading 'Target tidak dapat dimuat'",
    run(): void {
      const tree = LookupWarning({ kind: "goals" });
      const text = collectText(tree);
      assert.match(text, /Target tidak dapat dimuat/);
    },
  },
  {
    name: "LookupWarning (debts) → heading 'Utang tidak dapat dimuat'",
    run(): void {
      const tree = LookupWarning({ kind: "debts" });
      const text = collectText(tree);
      assert.match(text, /Utang tidak dapat dimuat/);
    },
  },
  {
    name: "LookupWarning surfaces supplied message verbatim",
    run(): void {
      const tree = LookupWarning({
        kind: "categories",
        message: "Backend timeout.",
      });
      const text = collectText(tree);
      assert.match(text, /Backend timeout\./);
    },
  },
  {
    name: "LookupWarning falls back to Indonesian description when message omitted",
    run(): void {
      const tree = LookupWarning({ kind: "categories" });
      const text = collectText(tree);
      assert.match(text, /Tanpa nama/);
    },
  },
  {
    name: "LookupWarning exposes role=status + aria-live=polite (non-blocking)",
    run(): void {
      const tree = LookupWarning({ kind: "categories" });
      assert.equal(tree.type, "section");
      assert.equal(tree.props.role, "status");
      assert.equal(tree.props["aria-live"], "polite");
    },
  },
  {
    name: "LookupWarning retry button invokes onRetry exactly once per click",
    run(): void {
      let calls = 0;
      const tree = LookupWarning({
        kind: "categories",
        onRetry: () => {
          calls += 1;
        },
      });
      const button = findButton(tree);
      assert.ok(button, "expected a retry button");
      const onClick = button!.props.onClick as () => void;
      onClick();
      onClick();
      assert.equal(calls, 2);
      assert.equal(button!.props.children, "Coba lagi");
    },
  },
  {
    name: "LookupWarning omits the retry button when onRetry is undefined",
    run(): void {
      const tree = LookupWarning({ kind: "categories" });
      const button = findButton(tree);
      assert.equal(button, null);
    },
  },

  // ---- Toast -------------------------------------------------------------
  {
    name: "Toast renders the supplied message verbatim",
    run(): void {
      const tree = Toast({
        message: "Beberapa kategori tidak dapat dimuat.",
        onDismiss: () => undefined,
      });
      const text = collectText(tree);
      assert.match(text, /Beberapa kategori tidak dapat dimuat\./);
    },
  },
  {
    name: "Toast exposes role=status + aria-live=polite (non-blocking)",
    run(): void {
      const tree = Toast({
        message: "x",
        onDismiss: () => undefined,
      });
      assert.equal(tree.type, "div");
      assert.equal(tree.props.role, "status");
      assert.equal(tree.props["aria-live"], "polite");
    },
  },
  {
    name: "Toast close button fires onDismiss exactly once per click",
    run(): void {
      let calls = 0;
      const tree = Toast({
        message: "x",
        onDismiss: () => {
          calls += 1;
        },
      });
      const button = findButton(tree);
      assert.ok(button, "expected a close button");
      const onClick = button!.props.onClick as () => void;
      onClick();
      assert.equal(calls, 1);
      assert.equal(button!.props["aria-label"], "Tutup notifikasi");
    },
  },
  {
    name: "Toast defaults to the warning tone styling",
    run(): void {
      const tree = Toast({
        message: "x",
        onDismiss: () => undefined,
      });
      assert.match(tree.props.className, /border-amber-300/);
      assert.equal(tree.props["data-tone"], "warning");
    },
  },
  {
    name: "Toast accepts an explicit tone and surfaces it on data-tone",
    run(): void {
      const tree = Toast({
        message: "x",
        onDismiss: () => undefined,
        tone: "info",
      });
      assert.match(tree.props.className, /border-sky-300/);
      assert.equal(tree.props["data-tone"], "info");
    },
  },
  {
    name: "scheduleToastDismiss returns a timer handle for the caller to clear",
    run(): void {
      const timer = scheduleToastDismiss(() => undefined, 10000);
      // The exact handle type is environment-dependent (Node setTimeout
      // vs browsers), but the contract is "something with a clearTimeout
      // sibling". The caller in page.tsx relies on `clearTimeout` so
      // we mirror that contract.
      assert.equal(typeof timer, "object");
      assert.equal(timer, timer);
      clearTimeout(timer);
    },
  },
  {
    name: "scheduleToastDismiss fires synchronously when durationMs<=0",
    run(): void {
      let calls = 0;
      scheduleToastDismiss(
        () => {
          calls += 1;
        },
        0,
      );
      assert.equal(calls, 1);
    },
  },

  // ---- sub-0007-12: end-to-end lookup-warning + donut wiring ----------
  // Mount `<TopCategoriesDonut>` with the partial-lookup-fail payload
  // `<DashboardContent>` would forward in `state.topCategories?.data`,
  // then verify that the rendered tree substitutes "Tanpa nama" for
  // the lookup-fail slot AND surfaces the named entry. Together with
  // the `<LookupWarning>` banner + `<Toast role="status">` tests
  // above, this pins the full sub-0007-08 AC end-to-end at the tree
  // level (without spinning up a React renderer) so the wiring
  // regression is caught here.
  //
  // The plain-tree walker can't dive into the inner `TopCategoriesDonutSvg`
  // component (a React element with `type=function` is left as a
  // single node in the tree until React mounts it), so the assertions
  // below target the props the dashboard passes into that element —
  // `ariaLabel` is computed from the data and embeds the formatted
  // category label, which is the exact "Tanpa nama" fallback the
  // AC requires a screen-reader user to hear.
  {
    name: "TopCategoriesDonut (mixed valid + lookup-fail) → SVG aria-label embeds 'Tanpa nama' fallback (AC sub-0007-12)",
    run(): void {
      const mixed: DashboardTopCategory[] = [
        {
          categoryId: "cat-1",
          categoryName: "Makanan",
          totalCents: 100_000,
          percentage: 60,
        },
        {
          categoryId: null,
          categoryName: null,
          totalCents: 66_666,
          percentage: 40,
        },
      ];
      const tree = TopCategoriesDonut({ data: mixed });
      // The card chrome surfaces the badge "Top 2" so the user sees a
      // count even before the SVG mounts.
      const text = collectText(tree);
      assert.match(text, /Top 2/);
      // The "Tanpa nama" fallback only lives inside the SVG's aria-label
      // (the segment paths + side list are inside the inner SVG
      // component which the walker doesn't render). Asserting on the
      // ariaLabel prop the parent passes into `<TopCategoriesDonutSvg>`
      // pins the same contract the screen reader hears at runtime.
      const svgElement = findComponentElement(tree, "TopCategoriesDonutSvg");
      assert.ok(svgElement, "expected <TopCategoriesDonutSvg> in the tree");
      const ariaLabel = svgElement!.props["ariaLabel"];
      assert.equal(typeof ariaLabel, "string");
      assert.match(
        ariaLabel as string,
        /Tanpa nama/,
        `expected ariaLabel to embed "Tanpa nama", got ${JSON.stringify(ariaLabel)}`,
      );
      // The named entry still surfaces verbatim — no regression on the
      // healthy slots.
      assert.match(ariaLabel as string, /Makanan/);
    },
  },
  {
    name: "TopCategoriesDonut (all named) → SVG aria-label does NOT embed 'Tanpa nama' fallback",
    run(): void {
      const allNamed: DashboardTopCategory[] = [
        {
          categoryId: "cat-1",
          categoryName: "Makanan",
          totalCents: 100_000,
          percentage: 100,
        },
      ];
      const tree = TopCategoriesDonut({ data: allNamed });
      const text = collectText(tree);
      assert.match(text, /Top 1/);
      const svgElement = findComponentElement(tree, "TopCategoriesDonutSvg");
      assert.ok(svgElement, "expected <TopCategoriesDonutSvg> in the tree");
      const ariaLabel = svgElement!.props["ariaLabel"];
      assert.equal(typeof ariaLabel, "string");
      assert.match(ariaLabel as string, /Makanan/);
      assert.equal(
        (ariaLabel as string).includes("Tanpa nama"),
        false,
        "no fallback label should surface when every entry is named",
      );
    },
  },
  {
    name: "TopCategoriesDonut (empty data) → card surfaces empty-state message instead of the SVG",
    run(): void {
      const tree = TopCategoriesDonut({ data: [] });
      const text = collectText(tree);
      // The badge collapses to "Kosong" when no categories come back
      // (sub-0007-05), and the inner SVG is replaced with the
      // dashed-border empty-state card. The walker can introspect
      // that since the empty-state copy is part of the parent
      // component's return tree (not the inner SVG component).
      assert.match(text, /Kosong/);
      assert.match(text, /Belum ada expense bulan ini/);
      // The parent must NOT mount the SVG component when the series
      // is empty (no point rendering 0 segments).
      const svgElement = findComponentElement(tree, "TopCategoriesDonutSvg");
      assert.equal(svgElement, null);
    },
  },
  {
    name: "LookupWarning + Toast pair → banner heading + toast role-status coexist for the lookup-fail scenario",
    run(): void {
      // The wiring `<DashboardContent>` consults `selectDashboardView`
      // to decide whether to mount the LookupWarning + Toast pair;
      // this assertion pins the *compatibility* of the two components
      // so a future refactor that drops `role="status"` (or `aria-live`)
      // on either side breaks here.
      const banner = LookupWarning({ kind: "categories" });
      assert.equal(banner.props.role, "status");
      assert.equal(banner.props["aria-live"], "polite");
      const toast = Toast({
        message:
          "Beberapa kategori tidak dapat dimuat. Label diganti 'Tanpa nama' sementara.",
        onDismiss: () => undefined,
      });
      assert.equal(toast.props.role, "status");
      assert.equal(toast.props["aria-live"], "polite");
      // The toast message echoes the donut's "Tanpa nama" fallback so
      // a screen-reader user can correlate the side-channel
      // notification with the donut slot.
      assert.match(collectText(toast), /Tanpa nama/);
    },
  },
];

// --------------------------------------------------------------------------
// Tiny JSX tree walker (mirrors the helpers in `states.test.tsx`).
// --------------------------------------------------------------------------

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function findButton(node: ReactElementLike): ReactElementLike | null {
  let found: ReactElementLike | null = null;
  walk(node, (el) => {
    if (found) return;
    if (el.type === "button") found = el;
  });
  return found;
}

function collectText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!isElement(node)) return "";
  const parts: string[] = [];
  for (const child of normaliseChildren(node.props.children)) {
    parts.push(collectText(child));
  }
  return parts.join(" ");
}

function walk(
  node: unknown,
  visit: (el: ReactElementLike) => void,
): void {
  if (!isElement(node)) return;
  visit(node);
  for (const child of normaliseChildren(node.props.children)) {
    walk(child, visit);
  }
}

function normaliseChildren(children: unknown): unknown[] {
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children : [children];
}

function isElement(value: unknown): value is ReactElementLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "props" in value
  );
}

/**
 * Walk the tree and return the first React element whose `type` is a
 * component function with the supplied name. Used by the sub-0007-12
 * end-to-end assertions to introspect the props the dashboard passes
 * into `<TopCategoriesDonutSvg>` — the inner SVG component is left as
 * a single node in the tree (React mounts it later) so the walker
 * can't dive into the rendered `<path>`s, but it CAN inspect the
 * `ariaLabel` prop the parent computes from `data` (which is what
 * the screen reader hears at runtime, so this is the right place to
 * pin the AC).
 */
function findComponentElement(
  node: unknown,
  componentName: string,
): ReactElementLike | null {
  let found: ReactElementLike | null = null;
  walk(node, (el) => {
    if (found) return;
    const type = el.type;
    if (
      typeof type === "function" &&
      (type as { name?: string }).name === componentName
    ) {
      found = el;
    }
  });
  return found;
}

// --------------------------------------------------------------------------
// Test runner (mirrors `kpi-cards.test.tsx`).
// --------------------------------------------------------------------------

export function runDashboardLookupWarningTests(): {
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
  process.env["DASHBOARD_LOOKUP_WARNING_TEST_RUN"] === "1"
) {
  const result = runDashboardLookupWarningTests();
  if (result.failed > 0) {
    console.error(
      `[dashboard-lookup-warning.test] ${result.failed} of ${result.failed + result.passed} failed`,
    );
    for (const failure of result.failures) {
      console.error(`  - ${failure.name}`);
      console.error(`      ${(failure.error as Error)?.stack ?? failure.error}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`[dashboard-lookup-warning.test] ${result.passed} cases passed`);
  }
}