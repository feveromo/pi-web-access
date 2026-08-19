import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isManagedCacheRoot,
  measureDirectoryBounded,
  measureDirectoryBoundedAsync,
  pruneManagedEntries,
  pruneManagedEntriesAsync,
} from "../managed-cache.js";
import { prunePDFCache } from "../pdf-extract.ts";

function pruneCloneFixture(root, limits, protectedPaths = new Set()) {
  const entries = readdirSync(join(root, "owner"), { withFileTypes: true })
    .filter(item => item.isDirectory() && !item.isSymbolicLink())
    .map(item => {
      const path = join(root, "owner", item.name);
      const stat = lstatSync(path);
      return { path, mtimeMs: stat.mtimeMs, sizeBytes: measureDirectoryBounded(path, limits.maxBytes) };
    });
  return pruneManagedEntries(root, entries, {
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    maxEntries: limits.maxEntries,
    maxBytes: limits.maxBytes,
  }, protectedPaths);
}

function makeRepo(root, name, bytes, ageMs = 0) {
  const path = join(root, "owner", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "data"), "x".repeat(bytes));
  const time = new Date(Date.now() - ageMs);
  utimesSync(path, time, time);
  return path;
}

function withTemp(prefix, fn) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("GitHub custom clone paths are not classified as the managed cache", () => withTemp("pi-gh-custom-", root => {
  const custom = join(root, "user-clones");
  mkdirSync(custom);
  writeFileSync(join(custom, "owned"), "keep");
  assert.equal(isManagedCacheRoot(custom, "/tmp/pi-github-repos"), false);
  assert.equal(readdirSync(custom).includes("owned"), true);
}));

test("GitHub managed clone cache evicts expired repositories", () => withTemp("pi-gh-age-", root => {
  const old = makeRepo(root, "old", 4, 8 * 24 * 60 * 60 * 1000);
  const fresh = makeRepo(root, "fresh", 4);
  const removed = pruneCloneFixture(root, { maxEntries: 10, maxBytes: 1024 * 1024 });
  assert.deepEqual(removed, [old]);
  assert.deepEqual(readdirSync(join(root, "owner")), ["fresh"]);
  assert.ok(fresh);
}));

test("async GitHub quota helpers measure and prune without following symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-gh-async-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-gh-async-outside-"));
  try {
    const old = makeRepo(root, "old", 10, 3000);
    const fresh = makeRepo(root, "fresh", 10, 1000);
    writeFileSync(join(outside, "owned"), "external");
    symlinkSync(outside, join(old, "outside-link"), "dir");
    utimesSync(old, new Date(Date.now() - 3000), new Date(Date.now() - 3000));
    const entries = [];
    for (const path of [old, fresh]) {
      const itemStat = lstatSync(path);
      entries.push({ path, mtimeMs: itemStat.mtimeMs, sizeBytes: await measureDirectoryBoundedAsync(path, 1024) });
    }
    const removed = await pruneManagedEntriesAsync(root, entries, {
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      maxEntries: 1,
      maxBytes: 1024,
    });
    assert.deepEqual(removed, [old]);
    assert.deepEqual(readdirSync(join(root, "owner")), ["fresh"]);
    assert.equal(readFileSync(join(outside, "owned"), "utf8"), "external");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("GitHub managed clone cache enforces count and byte ceilings oldest-first", () => withTemp("pi-gh-quota-", root => {
  makeRepo(root, "one", 10, 3000);
  makeRepo(root, "two", 10, 2000);
  makeRepo(root, "three", 10, 1000);
  pruneCloneFixture(root, { maxEntries: 2, maxBytes: 1024 * 1024 });
  assert.deepEqual(readdirSync(join(root, "owner")).sort(), ["three", "two"]);
  pruneCloneFixture(root, { maxEntries: 2, maxBytes: 15 });
  assert.deepEqual(readdirSync(join(root, "owner")), ["three"]);
}));

test("GitHub cache protects active paths and never follows symlinks", () => withTemp("pi-gh-safe-", root => withTemp("pi-gh-outside-", outside => {
  const active = makeRepo(root, "active", 4, 8 * 24 * 60 * 60 * 1000);
  const linkedRepo = join(root, "owner", "linked");
  writeFileSync(join(outside, "owned"), "user-owned");
  symlinkSync(outside, linkedRepo, "dir");
  symlinkSync(join(outside, "owned"), join(active, "outside-link"));
  pruneCloneFixture(root, { maxEntries: 1, maxBytes: 10 }, new Set([active]));
  assert.equal(readdirSync(outside).includes("owned"), true);
  assert.deepEqual(readdirSync(join(root, "owner")).sort(), ["active", "linked"]);
})));

test("PDF cache evicts by age, count, and bytes while protecting current output", () => withTemp("pi-pdf-quota-", root => {
  const expired = join(root, "expired.md");
  const old = join(root, "old.md");
  const middle = join(root, "middle.md");
  const current = join(root, "current.md");
  for (const path of [expired, old, middle, current]) writeFileSync(path, "x".repeat(10));
  utimesSync(expired, new Date(0), new Date(0));
  utimesSync(old, new Date(1000), new Date(1000));
  utimesSync(middle, new Date(2000), new Date(2000));
  utimesSync(current, new Date(3000), new Date(3000));
  prunePDFCache(root, new Set([current]), { maxAgeMs: 2500, maxFiles: 2, maxBytes: 15 }, 3000);
  assert.deepEqual(readdirSync(root), ["current.md"]);
}));

test("PDF cache refuses a managed root symlink and leaves the external victim untouched", () => withTemp("pi-pdf-root-link-", root => {
  const victim = join(root, "victim");
  const managedLink = join(root, "pdf-cache");
  mkdirSync(victim);
  writeFileSync(join(victim, "owned.md"), "external victim");
  symlinkSync(victim, managedLink, "dir");

  const removed = prunePDFCache(managedLink, new Set(), { maxAgeMs: 0, maxFiles: 0, maxBytes: 0 }, Date.now());
  assert.deepEqual(removed, []);
  assert.equal(readFileSync(join(victim, "owned.md"), "utf8"), "external victim");
}));

test("PDF cache leaves symlinks outside its root alone", () => withTemp("pi-pdf-custom-", root => {
  const outside = join(root, "outside.md");
  const custom = join(root, "custom");
  mkdirSync(custom);
  writeFileSync(outside, "owned");
  symlinkSync(outside, join(custom, "link.md"));
  prunePDFCache(custom, new Set(), { maxAgeMs: 0, maxFiles: 0, maxBytes: 0 }, Date.now());
  assert.equal(readdirSync(custom).includes("link.md"), true);
  assert.equal(readdirSync(root).includes("outside.md"), true);
}));
