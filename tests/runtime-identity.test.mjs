import assert from "node:assert/strict";
import test from "node:test";

import {
  readRuntimeIdentity,
  resolvePhasesRuntimeIdentity,
} from "../scripts/lib/runtime-identity.mjs";

test("reads model and reasoning effort only from the matching current Codex thread", async () => {
  const calls = [];
  let stopped = false;
  const identity = await readRuntimeIdentity({
    env: {
      CODEX_THREAD_ID: "thread-current",
      CODEX_SESSION_ID: "session-current",
    },
    clientFactory: () => ({
      start: async () => calls.push("start"),
      request: async (method, params) => {
        calls.push({ method, params });
        return {
          thread: {
            id: "thread-current",
            sessionId: "session-current",
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
          },
        };
      },
      stop: () => { stopped = true; },
    }),
  });

  assert.deepEqual(identity, {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    source: "codex_app_server_thread",
    status: "VERIFIED",
    reason: null,
  });
  assert.deepEqual(calls, [
    "start",
    {
      method: "thread/read",
      params: { threadId: "thread-current", includeTurns: false },
    },
  ]);
  assert.equal(stopped, true);
});

test("fails closed without querying when the current thread id is unavailable", async () => {
  let clientCreated = false;
  const identity = await readRuntimeIdentity({
    env: {},
    clientFactory: () => {
      clientCreated = true;
      throw new Error("must not create a client");
    },
  });

  assert.equal(clientCreated, false);
  assert.deepEqual(identity, {
    model: "unknown",
    reasoning_effort: "unknown",
    source: "unavailable",
    status: "UNAVAILABLE",
    reason: "CURRENT_THREAD_ID_UNAVAILABLE",
  });
});

test("fails closed when the app-server client cannot be created", async () => {
  const identity = await readRuntimeIdentity({
    env: { CODEX_THREAD_ID: "thread-current" },
    clientFactory: () => { throw new Error("spawn failed"); },
  });

  assert.deepEqual(identity, {
    model: "unknown",
    reasoning_effort: "unknown",
    source: "unavailable",
    status: "UNAVAILABLE",
    reason: "APP_SERVER_READ_FAILED",
  });
});

test("fails closed when app-server returns a different thread or session", async () => {
  for (const thread of [
    {
      id: "thread-other",
      sessionId: "session-current",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    },
    {
      id: "thread-current",
      sessionId: "session-other",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    },
  ]) {
    const identity = await readRuntimeIdentity({
      env: {
        CODEX_THREAD_ID: "thread-current",
        CODEX_SESSION_ID: "session-current",
      },
      clientFactory: () => ({
        start: async () => {},
        request: async () => ({ thread }),
        stop: () => {},
      }),
    });

    assert.equal(identity.model, "unknown");
    assert.equal(identity.reasoning_effort, "unknown");
    assert.equal(identity.source, "unavailable");
    assert.equal(identity.status, "UNAVAILABLE");
    assert.match(identity.reason, /_ID_MISMATCH$/);
  }
});

test("resolves omitted, auto, and unknown phase fields from one runtime read", async () => {
  let reads = 0;
  const phases = await resolvePhasesRuntimeIdentity([
    { phase_id: "one", phase_type: "implementation" },
    {
      phase_id: "two",
      phase_type: "testing",
      model: "auto",
      reasoning_effort: "unknown",
    },
  ], {
    reader: async () => {
      reads += 1;
      return {
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        source: "codex_app_server_thread",
        status: "VERIFIED",
        reason: null,
      };
    },
  });

  assert.equal(reads, 1);
  for (const phase of phases) {
    assert.equal(phase.model, "gpt-5.6-sol");
    assert.equal(phase.reasoning_effort, "high");
    assert.equal(phase.model_source, "codex_app_server_thread");
    assert.equal(phase.reasoning_effort_source, "codex_app_server_thread");
  }
});

test("preserves explicit runtime fields without querying app-server", async () => {
  let reads = 0;
  const [phase] = await resolvePhasesRuntimeIdentity([{
    phase_id: "explicit",
    phase_type: "implementation",
    model: "gpt-5.6-terra",
    reasoning_effort: "medium",
  }], {
    reader: async () => {
      reads += 1;
      throw new Error("must not read");
    },
  });

  assert.equal(reads, 0);
  assert.equal(phase.model, "gpt-5.6-terra");
  assert.equal(phase.reasoning_effort, "medium");
  assert.equal(phase.model_source, "caller");
  assert.equal(phase.reasoning_effort_source, "caller");
});

test("keeps unresolved automatic values as unknown with unavailable provenance", async () => {
  const [phase] = await resolvePhasesRuntimeIdentity([{
    phase_id: "offline",
    phase_type: "implementation",
  }], {
    reader: async () => ({
      model: "unknown",
      reasoning_effort: "unknown",
      source: "unavailable",
      status: "UNAVAILABLE",
      reason: "APP_SERVER_READ_FAILED",
    }),
  });

  assert.equal(phase.model, "unknown");
  assert.equal(phase.reasoning_effort, "unknown");
  assert.equal(phase.model_source, "unavailable");
  assert.equal(phase.reasoning_effort_source, "unavailable");
});

test("preserves a partially available runtime identity without overstating provenance", async () => {
  const [phase] = await resolvePhasesRuntimeIdentity([{
    phase_id: "partial",
    phase_type: "implementation",
  }], {
    reader: async () => ({
      model: "gpt-5.6-sol",
      reasoning_effort: "unknown",
      source: "codex_app_server_thread",
      status: "PARTIAL",
      reason: "RUNTIME_FIELDS_UNAVAILABLE",
    }),
  });

  assert.equal(phase.model, "gpt-5.6-sol");
  assert.equal(phase.model_source, "codex_app_server_thread");
  assert.equal(phase.reasoning_effort, "unknown");
  assert.equal(phase.reasoning_effort_source, "unavailable");
});

test("rejects a missing phase list before attempting runtime discovery", async () => {
  let reads = 0;
  await assert.rejects(
    resolvePhasesRuntimeIdentity(null, {
      reader: async () => { reads += 1; },
    }),
    /phases must be a non-empty array/,
  );
  assert.equal(reads, 0);
});
