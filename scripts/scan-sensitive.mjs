#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function gitLines(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" })
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const all = process.argv.includes("--all");
const files = all
  ? [...new Set([
      ...gitLines(["ls-files"]),
      ...gitLines(["ls-files", "--others", "--exclude-standard"]),
    ])]
  : [...new Set([
      ...gitLines(["diff", "--name-only"]),
      ...gitLines(["ls-files", "--others", "--exclude-standard"]),
    ])];

const home = process.env.HOME || "";
const homePattern = home ? new RegExp(`${escapeRegExp(home)}(?:/|$)`) : null;

const patterns = [
  ["github token", /github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+/],
  ["uuid-format key", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["secret assignment", /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9_./+\-]{24,}/i],
  ...(homePattern ? [["local home path", homePattern]] : []),
  ["macOS user path", /\/Users\/[^\s`"']+/],
];

const skipBinaryExt = /\.(png|jpg|jpeg|gif|webp|pdf|zip|gz|tgz|lock)$/i;
const findings = [];

for (const file of files) {
  if (!existsSync(file)) continue;
  let st;
  try { st = statSync(file); } catch { continue; }
  if (!st.isFile() || st.size > 2_000_000 || skipBinaryExt.test(file)) continue;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const [name, pattern] of patterns) {
    if (pattern.test(text)) findings.push({ file, pattern: name });
  }
}

if (findings.length > 0) {
  console.error("Sensitive-residue scan found possible issues:");
  for (const finding of findings) console.error(`- ${finding.file}: ${finding.pattern}`);
  process.exit(1);
}

console.log(`Sensitive-residue scan passed (${files.length} ${all ? "tracked/untracked" : "changed/untracked"} file(s) checked).`);
