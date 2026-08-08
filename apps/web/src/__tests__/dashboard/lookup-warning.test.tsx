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
 *   - `<Toast>` advertises the right `role="status"` + `aria-live` so
 *     a screen-reader user is notified without interrupting focus.
 *
 * Every assertion below corresponds 1:1 to an `it(...)` case so the
 * file is portable to `describe` / `it` once a Jest config lands.
 */

import assert from "node:assert/strict";

import {
  LookupWarning,
  Toast,
  scheduleToastDismiss,
} from "@/components/dashboard/states";

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