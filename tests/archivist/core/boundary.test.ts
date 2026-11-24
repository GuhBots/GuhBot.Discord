import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `src/archivist/` holds the archive rules and the website. It must not
 * depend on the Discord bot, so that it can move to its own service or
 * repository with the bot reaching it over HTTP. The bot's adapters live in
 * `src/lib/` and `src/commands/` and may import from here, never the reverse.
 */

const ROOT = fileURLToPath(new URL("../../../../src/archivist/", import.meta.url));

/** Packages the archive service may use. Anything Discord-specific belongs to the bot. */
const ALLOWED_PACKAGES = new Set([
  "@fastify/cookie",
  "@fastify/multipart",
  "@fastify/static",
  "archiver",
  "better-sqlite3",
  "exiftool-vendored",
  "fastify",
  "sharp",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g))
    found.push(match[1]!);
  return found;
}

test("the archive service does not depend on the Discord bot", () => {
  const files = sourceFiles(ROOT);
  assert.ok(files.length > 30, "found the source files");
  const problems: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const name = relative(ROOT, file);
    if (/\bprocess\.env\b/.test(source))
      problems.push(`${name} reads process.env; take settings as arguments`);
    for (const spec of specifiers(source)) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (!target.startsWith(ROOT.replace(/[\\/]$/, "") + sep))
          problems.push(`${name} imports ${spec} from outside src/archivist`);
      } else if (!spec.startsWith("node:") && !ALLOWED_PACKAGES.has(spec)) {
        problems.push(`${name} imports the package ${spec}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
