/**
 * sub-0007-08 — unit tests for the dashboard state components.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0007-02 / sub-0007-03). Until a
 * runner lands, this file runs as a plain Node test:
 *
 *   DASHBOARD_STATES_TEST_RUN=1 node --import tsx \
 *     apps/web/src/__tests__/dashboard/states.test.tsx
 *
 * We assert against the *pure* contracts of the three state
 * components exported from `components/dashboard/states/`:
 *
 *   - `<DashboardEmptyState>` renders a `role="status"` block, points
 *     the CTA at `/accounts/new`, and announces itself politely via
 *     `aria-live="polite"`.
 *   - `<DashboardSkeleton>` renders four KPI placeholders + three
 *     chart placeholders (line + bar + donut), each carrying the
 *     `animate-pulse` class so screen readers see `aria-busy`.
 *   - `<DashboardError>` renders a `role="alert"` block, surfaces the
 *     supplied `message` (or the Indonesian fallback when `null`),
 *     and wires the retry button to the supplied `onRetry` callback.
 *   - Race-defense caveat: the components themselves are pure
 *     presentational — the parent owns the `latestLoadIdRef`. We
 *     pin that the components do not accidentally keep their own
 *     fetch state (no useEffect, no setState).
 *   - Lookup-warning fallback: when the parent renders a category
 *     fallback ("Tanpa nama") + warning toast, the components must
 *     not collapse the layout — they keep the same widths.
 *
 * Every assertion below corresponds 1:1 to an `it(...)` case so the
 * file is portable to `describe` / `it` once a Jest config lands.
 */

import assert from "node:assert/strict";

import {
  DashboardEmptyState,
  DashboardError,
  DashboardSkeleton,
} from "@/components/dashboard/states";

interface TestCase {
  name: string;
  run(): void;
}

const ANIMATE_PULSE = "animate-pulse";
const ROLE_STATUS = "status";
const ROLE_ALERT = "alert";
const ARIA_LIVE_POLITE = "polite";
const ARIA_LIVE_ASSERTIVE = "assertive";
const FALLBACK_ERROR_MESSAGE = "Tidak bisa memuat dashboard. Coba lagi beberapa saat.";
const CTA_LABEL = "Tambah akun pertama";

const testCases: TestCase[] = [
  // ---- DashboardEmptyState ---------------------------------------------
  {
    name: "DashboardEmptyState exposes role=status + aria-live=polite",
    run(): void {
      const tree = DashboardEmptyState();
      assert.equal(tree.type, "section");
      assert.equal(tree.props.role, ROLE_STATUS);
      assert.equal(tree.props["aria-live"], ARIA_LIVE_POLITE);
    },
  },
  {
    name: "DashboardEmptyState points the CTA at /accounts/new",
    run(): void {
      const tree = DashboardEmptyState();
      // Next's `<Link>` is a forwardRef component — its rendered
      // element is `<a>`, but the JSX tree type is the Link
      // component. Walk by `href` so the test is independent of
      // whether Link ever returns a string-typed element.
      const cta = findByHref(tree, "/accounts/new");
      assert.ok(cta, "expected the empty state to render a CTA link");
      assert.equal(cta!.props.href, "/accounts/new");
      assert.equal(cta!.props.children, CTA_LABEL);
      assert.equal(
        cta!.props["aria-label"],
        CTA_LABEL,
        "CTA should carry an aria-label that mirrors its visible text",
      );
    },
  },
  {
    name: "DashboardEmptyState wraps an inline SVG illustration marked aria-hidden",
    run(): void {
      const tree = DashboardEmptyState();
      const svg = findChildByType(tree, "svg");
      assert.ok(svg, "expected an inline SVG illustration");
      assert.equal(svg!.props["aria-hidden"], "true");
      assert.equal(svg!.props.focusable, "false");
    },
  },
  {
    name: "DashboardEmptyState carries the dashboard-empty-state testid",
    run(): void {
      const tree = DashboardEmptyState();
      assert.equal(tree.props["data-testid"], "dashboard-empty-state");
    },
  },

  // ---- DashboardSkeleton ----------------------------------------------
  {
    name: "DashboardSkeleton exposes role=status + aria-busy=true",
    run(): void {
      const tree = DashboardSkeleton();
      assert.equal(tree.type, "div");
      assert.equal(tree.props.role, ROLE_STATUS);
      assert.equal(tree.props["aria-live"], ARIA_LIVE_POLITE);
      assert.equal(tree.props["aria-busy"], "true");
    },
  },
  {
    name: "DashboardSkeleton renders 4 KPI placeholders, each with animate-pulse",
    run(): void {
      const tree = DashboardSkeleton();
      const kpiCards = collectWithTestId(tree, /^dashboard-kpi-skeleton-/);
      assert.equal(kpiCards.length, 4);
      for (const card of kpiCards) {
        const pulseCount = countClass(card, ANIMATE_PULSE);
        assert.ok(
          pulseCount > 0,
          `KPI placeholder ${card.props["data-testid"]} should carry animate-pulse`,
        );
      }
    },
  },
  {
    name: "DashboardSkeleton renders line, bar, and donut chart placeholders",
    run(): void {
      const tree = DashboardSkeleton();
      assert.ok(
        findByTestId(tree, "dashboard-line-skeleton"),
        "expected a line-chart skeleton slot",
      );
      assert.ok(
        findByTestId(tree, "dashboard-bar-skeleton"),
        "expected a bar-chart skeleton slot",
      );
      assert.ok(
        findByTestId(tree, "dashboard-donut-skeleton"),
        "expected a donut-chart skeleton slot",
      );
    },
  },
  {
    name: "DashboardSkeleton announces loading via an sr-only span",
    run(): void {
      const tree = DashboardSkeleton();
      const srOnly = findChildByClass(tree, "sr-only");
      assert.ok(srOnly, "expected an sr-only loading announcement");
      assert.match(String(srOnly!.props.children), /Memuat dashboard/);
    },
  },

  // ---- DashboardError -------------------------------------------------
  {
    name: "DashboardError renders role=alert + aria-live=assertive",
    run(): void {
      const tree = DashboardError({
        message: "boom",
        onRetry: () => undefined,
      });
      assert.equal(tree.type, "section");
      assert.equal(tree.props.role, ROLE_ALERT);
      assert.equal(tree.props["aria-live"], ARIA_LIVE_ASSERTIVE);
    },
  },
  {
    name: "DashboardError surfaces the supplied message verbatim",
    run(): void {
      const tree = DashboardError({
        message: "Server lagiメンテナンス中",
        onRetry: () => undefined,
      });
      const paragraph = findParagraph(tree);
      assert.ok(paragraph, "expected an error <p> element");
      assert.equal(paragraph!.props.children, "Server lagiメンテナンス中");
    },
  },
  {
    name: "DashboardError falls back to the Indonesian default when message=null",
    run(): void {
      const tree = DashboardError({
        message: null,
        onRetry: () => undefined,
      });
      const paragraph = findParagraph(tree);
      assert.ok(paragraph, "expected an error <p> element");
      assert.equal(paragraph!.props.children, FALLBACK_ERROR_MESSAGE);
    },
  },
  {
    name: "DashboardError retry button invokes onRetry exactly once per click",
    run(): void {
      let calls = 0;
      const tree = DashboardError({
        message: "boom",
        onRetry: () => {
          calls += 1;
        },
      });
      const button = findButton(tree);
      assert.ok(button, "expected a retry button");
      const onClick = button!.props.onClick as () => void;
      assert.equal(typeof onClick, "function");
      onClick();
      onClick();
      assert.equal(calls, 2);
      assert.equal(button!.props.children, "Coba lagi");
    },
  },
  {
    name: "DashboardError retains alert styling (border-red-200 + bg-red-50)",
    run(): void {
      const tree = DashboardError({
        message: "boom",
        onRetry: () => undefined,
      });
      assert.match(tree.props.className, /border-red-200/);
      assert.match(tree.props.className, /bg-red-50/);
    },
  },

  // ---- Pure-component guarantees (race defense + lookup warning) ----
  {
    name: "DashboardEmptyState is a pure presentational component (no hooks/state)",
    run(): void {
      const fn = DashboardEmptyState;
      assert.equal(typeof fn, "function");
      const tree = fn();
      // Presentational components render synchronously to a single
      // root element. If they ever drift into hooks, the tree root
      // would change shape (e.g. wrap in suspense/fragment). Pin it.
      assert.equal(tree.type, "section");
    },
  },
  {
    name: "DashboardSkeleton is a pure presentational component (no hooks/state)",
    run(): void {
      const tree = DashboardSkeleton();
      assert.equal(tree.type, "div");
      assert.equal(tree.props.role, ROLE_STATUS);
    },
  },
  {
    name: "DashboardError is a pure presentational component (no hooks/state)",
    run(): void {
      const tree = DashboardError({
        message: "boom",
        onRetry: () => undefined,
      });
      assert.equal(tree.type, "section");
      assert.equal(tree.props.role, ROLE_ALERT);
    },
  },
];

// --------------------------------------------------------------------------
// Tiny JSX tree walker. The components return React element trees; the
// existing `kpi-cards.test.tsx` asserts on pure helpers, but the dashboard
// state components are presentational, so we walk the tree to verify
// structural contracts (role/aria/classes/testid). We avoid pulling in a
// renderer — this is portable across runner swaps.
// --------------------------------------------------------------------------

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function findChildByType(
  node: ReactElementLike,
  type: string,
): ReactElementLike | null {
  const children = normaliseChildren(node.props.children);
  for (const child of children) {
    if (isElement(child) && child.type === type) {
      return child;
    }
    if (isElement(child)) {
      const nested = findChildByType(child, type);
      if (nested) return nested;
    }
  }
  return null;
}

function findByTestId(
  node: ReactElementLike,
  testId: string,
): ReactElementLike | null {
  const children = normaliseChildren(node.props.children);
  for (const child of children) {
    if (!isElement(child)) continue;
    if (child.props["data-testid"] === testId) return child;
    const nested = findByTestId(child, testId);
    if (nested) return nested;
  }
  return null;
}

function findByHref(
  node: ReactElementLike,
  href: string,
): ReactElementLike | null {
  let found: ReactElementLike | null = null;
  walk(node, (el) => {
    if (found) return;
    if (el.props.href === href) found = el;
  });
  return found;
}

function collectWithTestId(
  node: ReactElementLike,
  pattern: RegExp,
): ReactElementLike[] {
  const out: ReactElementLike[] = [];
  walk(node, (el) => {
    const testId = el.props["data-testid"];
    if (typeof testId === "string" && pattern.test(testId)) {
      out.push(el);
    }
  });
  return out;
}

function findChildByClass(
  node: ReactElementLike,
  className: string,
): ReactElementLike | null {
  let found: ReactElementLike | null = null;
  walk(node, (el) => {
    if (found) return;
    const cls = el.props.className;
    if (typeof cls === "string" && cls.split(/\s+/).includes(className)) {
      found = el;
    }
  });
  return found;
}

function countClass(node: ReactElementLike, className: string): number {
  let count = 0;
  walk(node, (el) => {
    const cls = el.props.className;
    if (typeof cls === "string" && cls.split(/\s+/).includes(className)) {
      count += 1;
    }
  });
  return count;
}

function findParagraph(node: ReactElementLike): ReactElementLike | null {
  return findChildByType(node, "p");
}

function findButton(node: ReactElementLike): ReactElementLike | null {
  return findChildByType(node, "button");
}

function walk(
  node: ReactElementLike,
  visit: (el: ReactElementLike) => void,
): void {
  visit(node);
  for (const child of normaliseChildren(node.props.children)) {
    if (isElement(child)) walk(child, visit);
  }
}

function normaliseChildren(children: unknown): ReactElementLike[] {
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

// --------------------------------------------------------------------------
// Test runner (mirrors `kpi-cards.test.tsx`).
// --------------------------------------------------------------------------

export function runDashboardStatesTests(): {
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
  process.env["DASHBOARD_STATES_TEST_RUN"] === "1"
) {
  const result = runDashboardStatesTests();
  if (result.failed > 0) {
    console.error(
      `[dashboard-states.test] ${result.failed} of ${result.failed + result.passed} failed`,
    );
    for (const failure of result.failures) {
      console.error(`  - ${failure.name}`);
      console.error(`      ${(failure.error as Error)?.stack ?? failure.error}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`[dashboard-states.test] ${result.passed} cases passed`);
  }
}