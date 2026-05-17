import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

test("package stays lean and Pi-native", () => {
  assert.deepEqual(pkg.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(pkg.pi?.skills, ["./skills"]);

  assert.ok(pkg.files.includes("*.ts"));
  assert.ok(pkg.files.includes("skills/"));
  assert.ok(!pkg.files.includes("banner.png"));
  assert.ok(!pkg.files.includes("eval/"));
  assert.ok(!pkg.files.includes("test/"));

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
