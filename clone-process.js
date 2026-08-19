import { execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";

const PROCESS_KILL_GRACE_MS = 3000;

/**
 * Terminate a clone command and its credential-helper descendants.
 * @param {import("node:child_process").ChildProcess} child
 * @returns {ReturnType<typeof setTimeout> | undefined}
 */
function terminateProcessTree(child) {
  const pid = child.pid;
  if (!pid) return undefined;

  if (process.platform === "win32") {
    const killer = execFile(
      "taskkill",
      ["/pid", String(pid), "/T", "/F"],
      { windowsHide: true },
      err => {
        if (err) child.kill();
      },
    );
    killer.unref();
    return undefined;
  }

  try {
    // Clone commands run in their own process group so git/gh helpers cannot
    // survive a timeout or cancellation and keep reading from the host TTY.
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill();
  }

  // Credential helpers may handle or ignore SIGTERM. Escalate against the
  // entire group so neither git nor any descendant can block indefinitely.
  const forceKill = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, PROCESS_KILL_GRACE_MS);
  forceKill.unref();
  return forceKill;
}

/**
 * Run a git/gh clone without inheriting terminal input and clean up failures.
 * @param {string[]} args
 * @param {string} localPath
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<string | null>}
 */
export function execClone(args, localPath, timeoutMs, signal) {
  return new Promise(resolve => {
    let settled = false;
    let timeout;
    let forceKill;
    let onAbort;

    const finish = success => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);

      if (!success) {
        try {
          rmSync(localPath, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; callers already handle a null clone result.
        }
        resolve(null);
        return;
      }
      resolve(localPath);
    };

    const child = spawn(args[0], args.slice(1), {
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GH_PROMPT_DISABLED: "1",
      },
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", () => finish(false));
    child.once("close", code => finish(code === 0));

    timeout = setTimeout(() => {
      forceKill = terminateProcessTree(child);
    }, timeoutMs);
    timeout.unref();

    if (signal) {
      onAbort = () => {
        if (timeout) clearTimeout(timeout);
        forceKill = terminateProcessTree(child);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
