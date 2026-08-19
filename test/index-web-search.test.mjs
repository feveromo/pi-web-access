import assert from "node:assert/strict";
import { test } from "node:test";

import { createSearchScheduler, runSearchQueries } from "../web-search-runner.js";

function response(query) {
  return {
    answer: "",
    results: [{ title: `Result ${query}`, url: `https://example.test/${encodeURIComponent(query)}`, snippet: `Evidence for ${query}` }],
    metadata: { tookMs: 10, engines: ["mock"], unresponsiveEngines: 0 },
  };
}

test("search runner preserves partial successes on internal timeout and limits concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const results = await runSearchQueries({
    queries: ["one", "times out", "two", "three", "four"],
    schedule: createSearchScheduler(3),
    signal: new AbortController().signal,
    search: async query => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (query === "times out") {
          const error = new Error("Timed out after 30s");
          error.name = "TimeoutError";
          throw error;
        }
        return response(query);
      } finally {
        active--;
      }
    },
  });

  assert.equal(results.filter(result => !result.error).length, 4);
  assert.equal(results.find(result => result.query === "times out").error, "Timed out after 30s");
  assert.equal(maxActive, 3);
});

test("a canceled search is removed from the shared queue immediately", async () => {
  const schedule = createSearchScheduler(1);
  let release;
  let markStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });

  const first = runSearchQueries({
    queries: ["blocker"],
    schedule,
    search: async query => {
      markStarted();
      await gate;
      return response(query);
    },
  });
  await started;

  const controller = new AbortController();
  let queuedStarted = false;
  const queued = runSearchQueries({
    queries: ["queued"],
    schedule,
    signal: controller.signal,
    search: async query => {
      queuedStarted = true;
      return response(query);
    },
  });
  controller.abort(new Error("cancel queued search"));
  await assert.rejects(queued, /cancel queued search/);
  assert.equal(queuedStarted, false);

  release();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queuedStarted, false);
});
