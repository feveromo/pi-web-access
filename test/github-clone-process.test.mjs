import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { execClone } from "../clone-process.js";

async function writeFakeExecutable(binDir, name, source) {
  const executable = join(binDir, name);
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return executable;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    try {
      const state = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[0];
      if (state === "Z") return false;
    } catch {
      // Non-Linux platforms do not expose /proc; kill(0) remains the check.
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !processIsAlive(pid);
}

test("GitHub clones disable interactive credential prompts", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-noninteractive-"));
  const binDir = join(root, "bin");
  const clonePath = join(root, "repo");
  const envFile = join(root, "clone-env.json");
  await mkdir(binDir, { recursive: true });
  const fakeGit = await writeFakeExecutable(
    binDir,
    "git",
    `
      const { mkdirSync, writeFileSync } = require("node:fs");
      const destination = process.argv.at(-1);
      mkdirSync(destination, { recursive: true });
      writeFileSync(process.env.CLONE_ENV_FILE, JSON.stringify({
        gitTerminalPrompt: process.env.GIT_TERMINAL_PROMPT,
        gcmInteractive: process.env.GCM_INTERACTIVE,
        ghPromptDisabled: process.env.GH_PROMPT_DISABLED,
      }));
    `,
  );

  const previousEnvFile = process.env.CLONE_ENV_FILE;
  process.env.CLONE_ENV_FILE = envFile;
  try {
    assert.equal(await execClone([fakeGit, "clone", "fixture", clonePath], clonePath, 1000), clonePath);
  } finally {
    if (previousEnvFile === undefined) delete process.env.CLONE_ENV_FILE;
    else process.env.CLONE_ENV_FILE = previousEnvFile;
  }

  assert.deepEqual(JSON.parse(await readFile(envFile, "utf8")), {
    gitTerminalPrompt: "0",
    gcmInteractive: "Never",
    ghPromptDisabled: "1",
  });
});

test("GitHub clone timeout force-kills the process group", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-timeout-tree-"));
  const binDir = join(root, "bin");
  const clonePath = join(root, "repo");
  const processPidFile = join(root, "processes.json");
  await mkdir(binDir, { recursive: true });
  const fakeGit = await writeFakeExecutable(
    binDir,
    "git",
    `
      const { spawn } = require("node:child_process");
      process.on("SIGTERM", () => {});
      const helperSource = ${JSON.stringify(`
        const { writeFileSync } = require("node:fs");
        process.on("SIGTERM", () => {});
        writeFileSync(process.env.CLONE_PROCESS_PID_FILE, JSON.stringify({
          rootPid: process.ppid,
          helperPid: process.pid,
        }));
        setInterval(() => {}, 1000);
      `)};
      spawn(process.execPath, ["-e", helperSource], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    `,
  );

  const previousPidFile = process.env.CLONE_PROCESS_PID_FILE;
  process.env.CLONE_PROCESS_PID_FILE = processPidFile;
  try {
    assert.equal(await execClone([fakeGit, "clone", "fixture", clonePath], clonePath, 500), null);
  } finally {
    if (previousPidFile === undefined) delete process.env.CLONE_PROCESS_PID_FILE;
    else process.env.CLONE_PROCESS_PID_FILE = previousPidFile;
  }

  const { rootPid, helperPid } = JSON.parse(await readFile(processPidFile, "utf8"));
  try {
    assert.equal(await waitForProcessExit(rootPid), true, `clone process ${rootPid} survived SIGKILL fallback`);
    assert.equal(await waitForProcessExit(helperPid), true, `clone helper ${helperPid} survived SIGKILL fallback`);
  } finally {
    if (processIsAlive(rootPid)) process.kill(rootPid, "SIGKILL");
    if (processIsAlive(helperPid)) process.kill(helperPid, "SIGKILL");
  }
});
