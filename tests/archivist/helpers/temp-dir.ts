import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

/** Creates an empty directory for one test and removes it when the test ends. */
export function makeTempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "archivist-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
