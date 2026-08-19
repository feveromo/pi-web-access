import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const MAX_TRAVERSAL_ENTRIES = 100_000;

export function isManagedCacheRoot(candidate, managedRoot) {
  const expected = resolve(managedRoot);
  if (resolve(candidate) !== expected) return false;
  try {
    if (existsSync(candidate)) return realpathSync(candidate) === expected;
    let ancestor = dirname(expected);
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
    return realpathSync(ancestor) === ancestor;
  } catch {
    return false;
  }
}

export function isPathInside(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

/** Measures regular files without following symlinks and stops once the traversal budget is exhausted. */
export function measureDirectoryBounded(path, byteCutoff) {
  const pending = [path];
  let visited = 0;
  let bytes = 0;
  while (pending.length > 0) {
    if (++visited > MAX_TRAVERSAL_ENTRIES) return Math.max(bytes, byteCutoff + 1);
    const current = pending.pop();
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > byteCutoff) return bytes;
      continue;
    }
    if (!stat.isDirectory()) continue;
    try {
      for (const name of readdirSync(current)) pending.push(resolve(current, name));
    } catch {
      // An unreadable subtree is skipped; cache maintenance must fail open.
    }
  }
  return bytes;
}

/** Async production traversal equivalent; it yields at every filesystem operation. */
export async function measureDirectoryBoundedAsync(path, byteCutoff) {
  const pending = [path];
  let visited = 0;
  let bytes = 0;
  while (pending.length > 0) {
    if (++visited > MAX_TRAVERSAL_ENTRIES) return Math.max(bytes, byteCutoff + 1);
    const current = pending.pop();
    let itemStat;
    try {
      itemStat = await lstat(current);
    } catch {
      continue;
    }
    if (itemStat.isSymbolicLink()) continue;
    if (itemStat.isFile()) {
      bytes += itemStat.size;
      if (bytes > byteCutoff) return bytes;
      continue;
    }
    if (!itemStat.isDirectory()) continue;
    try {
      for (const name of await readdir(current)) pending.push(resolve(current, name));
    } catch {
      // An unreadable subtree is skipped; cache maintenance must fail open.
    }
  }
  return bytes;
}

export async function pruneManagedEntriesAsync(root, entries, limits, protectedPaths = new Set(), now = Date.now()) {
  let rootReal;
  try {
    rootReal = await realpath(root);
  } catch {
    return [];
  }
  const protectedResolved = new Set([...protectedPaths].map(path => resolve(path)));
  const eligible = [];
  for (const entry of entries) {
    if (protectedResolved.has(resolve(entry.path)) || !isPathInside(root, entry.path)) continue;
    try {
      const itemStat = await lstat(entry.path);
      if (!itemStat.isSymbolicLink() && isPathInside(rootReal, await realpath(entry.path))) eligible.push(entry);
    } catch {
      // Unsafe or vanished entries are not managed.
    }
  }
  const retained = new Set(entries);
  const removed = [];
  const remove = async entry => {
    try {
      await rm(entry.path, { recursive: true, force: true });
      retained.delete(entry);
      removed.push(entry.path);
    } catch {
      // Quota cleanup is best-effort and must never break extraction.
    }
  };

  for (const entry of eligible) {
    if (now - entry.mtimeMs > limits.maxAgeMs) await remove(entry);
  }
  const oldestFirst = eligible
    .filter(entry => retained.has(entry))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  let count = retained.size;
  let bytes = [...retained].reduce((sum, entry) => sum + entry.sizeBytes, 0);
  for (const entry of oldestFirst) {
    if (count <= limits.maxEntries && bytes <= limits.maxBytes) break;
    await remove(entry);
    if (!retained.has(entry)) {
      count--;
      bytes -= entry.sizeBytes;
    }
  }
  return removed;
}

export function pruneManagedEntries(root, entries, limits, protectedPaths = new Set(), now = Date.now()) {
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    return [];
  }
  const protectedResolved = new Set([...protectedPaths].map(path => resolve(path)));
  const eligible = entries.filter(entry => {
    if (protectedResolved.has(resolve(entry.path)) || !isPathInside(root, entry.path)) return false;
    try {
      const stat = lstatSync(entry.path);
      if (stat.isSymbolicLink()) return false;
      return isPathInside(rootReal, realpathSync(entry.path));
    } catch {
      return false;
    }
  });
  const retained = new Set(entries);
  const removed = [];
  const remove = entry => {
    try {
      rmSync(entry.path, { recursive: true, force: true });
      retained.delete(entry);
      removed.push(entry.path);
    } catch {
      // Quota cleanup is best-effort and must never break extraction.
    }
  };

  for (const entry of eligible) {
    if (now - entry.mtimeMs > limits.maxAgeMs) remove(entry);
  }
  const oldestFirst = eligible
    .filter(entry => retained.has(entry))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  let count = retained.size;
  let bytes = [...retained].reduce((sum, entry) => sum + entry.sizeBytes, 0);
  for (const entry of oldestFirst) {
    if (count <= limits.maxEntries && bytes <= limits.maxBytes) break;
    remove(entry);
    if (!retained.has(entry)) {
      count--;
      bytes -= entry.sizeBytes;
    }
  }
  return removed;
}
