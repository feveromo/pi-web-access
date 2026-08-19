import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

test("package stays lean and Pi-native", () => {
  assert.deepEqual(pkg.pi?.extensions, ["./index.ts"]);
  assert.equal(pkg.pi?.skills, undefined);

  assert.equal(pkg.scripts?.test, "node --test");
  assert.match(pkg.scripts?.syntax ?? "", /node --check/);
  assert.match(pkg.scripts?.syntax ?? "", /\*\.js/);
  assert.equal(pkg.scripts?.["pack:dry-run"], "npm pack --dry-run");
  assert.equal(pkg.scripts?.["scan:sensitive"], "node scripts/scan-sensitive.mjs");
  assert.equal(pkg.scripts?.check, "npm run syntax && npm test && npm run scan:sensitive -- --all && npm run pack:dry-run");

  assert.ok(pkg.files.includes("*.ts"));
  assert.ok(pkg.files.includes("*.js"));
  assert.ok(!pkg.files.includes("skills/"));
  assert.ok(pkg.files.includes("scripts/scan-sensitive.mjs"));
  assert.ok(pkg.files.includes("SECURITY.md"));
  assert.ok(!pkg.files.includes("banner.png"));
  assert.ok(!pkg.files.includes("eval/"));
  assert.ok(!pkg.files.includes("test/"));

  assert.match(pkg.description, /Keyless local-first web research via self-hosted SearXNG/);
  assert.match(pkg.repository?.url, /github\.com\/feveromo\/pi-web-access/);
  assert.match(pkg.homepage, /github\.com\/feveromo\/pi-web-access/);
  assert.match(pkg.bugs?.url, /github\.com\/feveromo\/pi-web-access/);

  assert.equal(pkg.engines?.node, ">=22.19.0");
  assert.deepEqual(pkg.dependencies, {
    "@mozilla/readability": "0.6.0",
    linkedom: "0.18.12",
    "p-limit": "7.3.0",
    turndown: "7.2.4",
    typebox: "^1.1.38",
    undici: "7.29.0",
    unpdf: "1.6.2",
  });

  for (const dep of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ]) {
    assert.equal(pkg.peerDependencies?.[dep], "*");
    assert.equal(pkg.dependencies?.[dep], undefined);
  }
});
