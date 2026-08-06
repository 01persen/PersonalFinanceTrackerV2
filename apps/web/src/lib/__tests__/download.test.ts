/**
 * sub-0008-05 — unit tests for the download helper.
 *
 * Mirrors the portable Node-`assert` pattern used by
 * `src/components/debts/__tests__/debt-helpers.test.ts` so the file
 * runs without a Jest/Vitest setup:
 *
 *   node --import tsx src/lib/__tests__/download.test.ts
 *
 * The assertions cover the AC contract pinned in the issue body:
 *
 *   - filename extraction from `Content-Disposition` (quoted, unquoted,
 *     RFC 5987, and the regression case where the header is missing).
 *   - bare-invalid headers (no filename, malformed) return `null`
 *     so the caller can fall back to the static template.
 */

import assert from "node:assert/strict";

import { extractFilenameFromDisposition } from "@/lib/download";

interface TestCase {
  name: string;
  run(): void;
}

const cases: TestCase[] = [
  {
    name: "extractFilenameFromDisposition — quoted form (BE contract)",
    run(): void {
      const header = 'attachment; filename="transactions-2026-08-06.csv"';
      assert.equal(
        extractFilenameFromDisposition(header),
        "transactions-2026-08-06.csv",
      );
    },
  },
  {
    name: "extractFilenameFromDisposition — unquoted form (defensive)",
    run(): void {
      const header = "attachment; filename=transactions-2026-08-06.json";
      assert.equal(
        extractFilenameFromDisposition(header),
        "transactions-2026-08-06.json",
      );
    },
  },
  {
    name: "extractFilenameFromDisposition — RFC 5987 percent-encoded",
    run(): void {
      const header = "attachment; filename*=UTF-8''backup-2026-08-06.zip";
      assert.equal(
        extractFilenameFromDisposition(header),
        "backup-2026-08-06.zip",
      );
    },
  },
  {
    name: "extractFilenameFromDisposition — RFC 5987 with spaces",
    run(): void {
      const header = "attachment; filename*=UTF-8''laporan%20bulan%20ini.csv";
      assert.equal(
        extractFilenameFromDisposition(header),
        "laporan bulan ini.csv",
      );
    },
  },
  {
    name: "extractFilenameFromDisposition — missing header returns null",
    run(): void {
      assert.equal(extractFilenameFromDisposition(null), null);
      assert.equal(extractFilenameFromDisposition(undefined), null);
    },
  },
  {
    name: "extractFilenameFromDisposition — header without filename returns null",
    run(): void {
      assert.equal(extractFilenameFromDisposition("attachment"), null);
      assert.equal(extractFilenameFromDisposition("inline"), null);
    },
  },
  {
    name: "extractFilenameFromDisposition — empty filename returns null",
    run(): void {
      assert.equal(extractFilenameFromDisposition('attachment; filename=""'), null);
      assert.equal(extractFilenameFromDisposition("attachment; filename="), null);
    },
  },
  {
    name: "extractFilenameFromDisposition — case-insensitive directive",
    run(): void {
      const header = 'attachment; FILENAME="transactions-2026-08-06.csv"';
      assert.equal(
        extractFilenameFromDisposition(header),
        "transactions-2026-08-06.csv",
      );
    },
  },
];

function run(): void {
  let passed = 0;
  for (const testCase of cases) {
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
  console.log(`\n${passed}/${cases.length} tests passed`);
}

run();
