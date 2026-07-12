import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const utilsUrl = new URL("../utils.js", import.meta.url).href;

function resolveWith(env) {
  const childEnv = { ...process.env };
  delete childEnv.PI_CODING_AGENT_DIR;
  delete childEnv.XDG_CONFIG_HOME;
  Object.assign(childEnv, env);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { getWebSearchConfigPath } = await import(${JSON.stringify(utilsUrl)});
    console.log(getWebSearchConfigPath());
  `], { encoding: "utf8", env: childEnv });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}

test("web-search config path prefers PI_CODING_AGENT_DIR", () => {
  assert.equal(resolveWith({ PI_CODING_AGENT_DIR: "/tmp/pi-agent", XDG_CONFIG_HOME: "/tmp/xdg" }), "/tmp/pi-agent/web-search.json");
});

test("web-search config path falls back through XDG_CONFIG_HOME to home", () => {
  assert.equal(resolveWith({ XDG_CONFIG_HOME: "/tmp/xdg" }), "/tmp/xdg/pi/web-search.json");
  const output = resolveWith({ HOME: "/tmp/test-home", USERPROFILE: "/tmp/test-home" });
  assert.equal(output, "/tmp/test-home/.pi/web-search.json");
});

test("every web-search config consumer uses the shared resolver", () => {
  for (const file of ["index.ts", "ssrf-config.js", "github-extract.ts", "github-examples.ts"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /getWebSearchConfigPath/);
    assert.doesNotMatch(source, /join\(homedir\(\), "\.pi", "web-search\.json"\)/);
  }
});
