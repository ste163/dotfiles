/**
 * Structure enforcement test.
 *
 * Hard rules for this repo (see AGENTS.md / README.md):
 * - Every extension is a directory directly under `extensions/`.
 * - No bare top-level `.ts` files directly in `extensions/` (pi auto-loads every
 *   top-level `.ts` file as its own extension, which would collide with a
 *   colocated `.spec.ts` file sitting next to it).
 * - Every extension directory must contain an `index.ts` entry point.
 * - Every extension directory must contain at least one colocated `*.spec.ts`
 *   file somewhere inside it (no untested extensions).
 *
 * This test lives outside extensions/ on purpose - it is not itself an
 * extension and must never be picked up by pi's auto-discovery.
 */

import { strict as assert } from "node:assert";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const EXTENSIONS_DIR = new URL("extensions/", import.meta.url).pathname;

function findSpecFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      found.push(...findSpecFiles(full));
    } else if (entry.endsWith(".spec.ts")) {
      found.push(full);
    }
  }
  return found;
}

test("extensions directory structure", async (t) => {
  const entries = readdirSync(EXTENSIONS_DIR);

  for (const entry of entries) {
    const full = join(EXTENSIONS_DIR, entry);
    const stat = statSync(full);

    if (!stat.isDirectory()) {
      assert.fail(
        `"${entry}" is a bare top-level file in extensions/. Every extension must be ` +
          `a directory with an index.ts entry point - bare top-level .ts files are not allowed.`,
      );
    }
  }

  // Each entry's structure check is independent of every other entry's, so
  // these run concurrently rather than sequentially awaiting one at a time.
  await Promise.all(
    entries.map((entry) =>
      t.test(`"${entry}" has required structure`, () => {
        const full = join(EXTENSIONS_DIR, entry);
        const indexPath = join(full, "index.ts");
        assert.ok(
          statSync(indexPath, { throwIfNoEntry: false })?.isFile(),
          `${entry}/index.ts is missing.`,
        );

        const specFiles = findSpecFiles(full);
        assert.ok(
          specFiles.length > 0,
          `${entry}/ has no colocated *.spec.ts file. Every extension must be tested.`,
        );
      }),
    ),
  );
});
