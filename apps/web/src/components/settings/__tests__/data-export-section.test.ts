/**
 * sub-0008-05 — regression test for the stand-alone button-state
 * milestone (AC (b) — "loading spinner per tombol, independen —
 * satu tombol in-flight tidak block tombol lain").
 *
 * The first hand-off of this section shipped an `isOtherBusy` flag
 * that disabled every sibling button while one was in-flight. QA
 * flagged it as FAIL on AC (b). The fix removes the flag so each
 * button's `disabled` reads only its own in-flight state.
 *
 * The `apps/web` package still has no Jest/Vitest runner, so this
 * file is a portable Node test that statically inspects the file
 * (mirror `progress-banner.test.tsx` pattern). Run with:
 *
 *   node --import tsx apps/web/src/components/settings/__tests__/data-export-section.test.ts
 *
 * Anything that re-introduces the cross-button disable will fail
 * this test, so the regression is caught at the same place the
 * original bug was reported.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface TestCase {
  name: string;
  run(): void;
}

const here = fileURLToPath(import.meta.url);
const componentPath = here
  .replace("/__tests__/data-export-section.test.ts", "/data-export-section.tsx")
  .replace("/data-export-section.test.ts", "/data-export-section.tsx");

const source = readFileSync(componentPath, "utf8");

const testCases: TestCase[] = [
  {
    name: "data-export-section — no `isOtherBusy` flag (AC b regression)",
    run(): void {
      // The old name `isOtherBusy` was the bug: it disabled every
      // sibling button while one was in-flight. The fix removes the
      // flag entirely — each button reads its own `isBusy` only.
      assert.equal(
        source.includes("isOtherBusy"),
        false,
        "isOtherBusy re-introduced — it disables sibling buttons and breaks AC (b)",
      );
    },
  },
  {
    name: "data-export-section — per-button disabled uses only `isBusy`",
    run(): void {
      // The button's `disabled` prop must be simple `isBusy`, not a
      // disjunction with `isOtherBusy`. Allow line wrap, so we
      // collapse whitespace before matching.
      const collapsed = source.replace(/\s+/g, " ");
      assert.match(
        collapsed,
        /disabled=\{isBusy\}/,
        "button `disabled` should be `isBusy` only (AC b independence)",
      );
    },
  },
  {
    name: "data-export-section — `aria-disabled` mirrors `disabled`",
    run(): void {
      const collapsed = source.replace(/\s+/g, " ");
      assert.match(
        collapsed,
        /aria-disabled=\{isBusy\}/,
        "aria-disabled should mirror `isBusy` for accessibility tree",
      );
    },
  },
  {
    name: "data-export-section — handleExport early-return scopes to same button",
    run(): void {
      // The double-click guard must compare against the clicked
      // action's kind, not against any-busy. Without that the
      // sibling-button click would be silently dropped.
      const collapsed = source.replace(/\s+/g, " ");
      assert.match(
        collapsed,
        /if \(busyKind === action\.kind\) return;/,
        "double-click guard must scope to the same button (AC b)",
      );
      // Negative assertion: the bug pattern `if (busyKind !== null) return;`
      // would re-block every other button while one is in-flight.
      assert.equal(
        /if \(busyKind !== null\) return;/.test(collapsed),
        false,
        "global busyKind !== null guard re-introduced — blocks sibling buttons",
      );
    },
  },
  {
    name: "data-export-section — in-page hint mentions independent state",
    run(): void {
      // The user-facing header text must remind that buttons are
      // independent — keeps the contract loud in the UI.
      const collapsed = source.replace(/\s+/g, " ");
      assert.match(
        collapsed,
        /tidak mengunci tombol lain/,
        "header copy should advertise per-button independence",
      );
    },
  },
];

function run(): void {
  let passed = 0;
  for (const testCase of testCases) {
    try {
      testCase.run();
      passed += 1;
      console.log(`  ok — ${testCase.name}`);
    } catch (error) {
      console.error(`  FAIL — ${testCase.name}`);
      console.error(error);
      process.exit(1);
    }
  }
  console.log(`\n${passed}/${testCases.length} tests passed`);
}

run();
