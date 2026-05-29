import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

test("package stays lean and Pi-native", () => {
  assert.deepEqual(pkg.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(pkg.pi?.skills, ["./skills"]);

  assert.equal(pkg.scripts?.test, "node --test");
  assert.match(pkg.scripts?.syntax ?? "", /node --check/);
  assert.equal(pkg.scripts?.["pack:dry-run"], "npm pack --dry-run");
  assert.equal(pkg.scripts?.["scan:sensitive"], "node scripts/scan-sensitive.mjs");
  assert.equal(pkg.scripts?.check, "npm run syntax && npm test && npm run scan:sensitive && npm run pack:dry-run");

  assert.ok(pkg.files.includes("*.ts"));
  assert.ok(pkg.files.includes("skills/"));
  assert.ok(pkg.files.includes("scripts/scan-sensitive.mjs"));
  assert.ok(!pkg.files.includes("banner.png"));
  assert.ok(!pkg.files.includes("eval/"));
  assert.ok(!pkg.files.includes("test/"));

  assert.match(pkg.description, /Lean Exa-powered/);
  assert.match(pkg.repository?.url, /github\.com\/feveromo\/pi-web-access/);
  assert.match(pkg.homepage, /github\.com\/feveromo\/pi-web-access/);
  assert.match(pkg.bugs?.url, /github\.com\/feveromo\/pi-web-access/);

  for (const dep of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    assert.equal(pkg.peerDependencies?.[dep], "*");
    assert.equal(pkg.dependencies?.[dep], undefined);
  }
});
