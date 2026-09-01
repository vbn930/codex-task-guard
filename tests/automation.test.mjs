import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildResumeAutomationIntent,
  ensureResumeAutomation,
  reconcileLocalAutomationRegistry,
  verifyAutomationTranscript,
  verifyPersistedAutomation,
} from "../scripts/lib/automation.mjs";

function intent() {
  return buildResumeAutomationIntent({
    taskId: "TASK-0010",
    targetThread: "thread-123",
    resumeAfter: "2026-08-31T17:32:11.000Z",
    snapshotId: "snapshot-1",
    prompt: "Resume the exact next action in this thread",
  });
}

function persistedHeartbeat(overrides = {}) {
  return {
    id: "automation-123",
    kind: "heartbeat",
    status: "ACTIVE",
    name: "TASK-0010 quota resume",
    destination: "thread",
    targetThreadId: "thread-123",
    rrule: "DTSTART:20260831T173211Z\nRRULE:FREQ=DAILY;COUNT=1",
    prompt: "Resume the exact next action in this thread",
    ...overrides,
  };
}

test("logical current-thread intent cannot masquerade as a concrete target ID", () => {
  assert.throws(
    () => buildResumeAutomationIntent({
      taskId: "TASK-0010",
      targetThread: "current",
      resumeAfter: "2026-08-31T17:32:11.000Z",
    }),
    /concrete runtime thread ID/,
  );
});

test("create ID and matching view read-back verifies a same-thread heartbeat", async () => {
  const expected = intent();

  const result = await ensureResumeAutomation({
    expected,
    adapter: {
      create: async () => ({ automationId: "automation-123" }),
      view: async ({ id }) => persistedHeartbeat({ id }),
    },
    delay: async () => {},
  });

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.resume_mode, "AUTOMATION");
  assert.equal(result.automation_id, "automation-123");
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.verification, {
    persisted: true,
    id_match: true,
    identity_match: true,
    kind_match: true,
    thread_match: true,
    schedule_match: true,
    status_active: true,
    prompt_match: true,
  });
});

test("read-back requires the requested automation ID", () => {
  const expected = intent();
  const matching = verifyPersistedAutomation(
    persistedHeartbeat({ id: "automation-123" }),
    expected,
    "automation-123",
  );
  const wrong = verifyPersistedAutomation(
    persistedHeartbeat({ id: "automation-other" }),
    expected,
    "automation-123",
  );
  const missing = verifyPersistedAutomation(
    persistedHeartbeat({ id: undefined }),
    expected,
    "automation-123",
  );

  assert.equal(matching.verified, true);
  assert.equal(matching.verification.id_match, true);
  assert.equal(wrong.verified, false);
  assert.equal(wrong.reason, "ID_MISMATCH");
  assert.equal(wrong.verification.id_match, false);
  assert.equal(missing.verified, false);
  assert.equal(missing.reason, "ID_UNVERIFIED");
  assert.equal(missing.verification.id_match, null);
});

for (const [label, rrule] of [
  ["daily without a count", "DTSTART:20260831T173211Z\nRRULE:FREQ=DAILY"],
  ["hourly recurrence", "DTSTART:20260831T173211Z\nRRULE:FREQ=HOURLY"],
  ["weekly recurrence", "DTSTART:20260831T173211Z\nRRULE:FREQ=WEEKLY"],
  ["a count greater than one", "DTSTART:20260831T173211Z\nRRULE:FREQ=DAILY;COUNT=2"],
  ["a second unbounded recurrence", "DTSTART:20260831T173211Z\nRRULE:FREQ=DAILY;COUNT=1\nRRULE:FREQ=HOURLY"],
  ["a wake before reset", "DTSTART:20260831T173210Z\nRRULE:FREQ=DAILY;COUNT=1"],
  ["a wake over five minutes late", "DTSTART:20260831T173712Z\nRRULE:FREQ=DAILY;COUNT=1"],
]) {
  test(`${label} is not a valid one-shot quota wake`, () => {
    const checked = verifyPersistedAutomation(
      persistedHeartbeat({ rrule }),
      intent(),
      "automation-123",
    );
    assert.equal(checked.verified, false);
    assert.equal(checked.verification.schedule_match, false);
  });
}

test("a single-occurrence schedule inside the five-minute window is accepted", () => {
  const checked = verifyPersistedAutomation(
    persistedHeartbeat({
      rrule: "DTSTART:20260831T173411Z\nRRULE:FREQ=DAILY;COUNT=1",
    }),
    intent(),
    "automation-123",
  );
  assert.equal(checked.verified, true);
  assert.equal(checked.verification.schedule_match, true);
});

test("a rendered automation card without an ID is never verified", async () => {
  let viewCalls = 0;
  const result = await ensureResumeAutomation({
    expected: intent(),
    adapter: {
      create: async () => "Rendered automation card in the app.",
      view: async () => {
        viewCalls += 1;
        return persistedHeartbeat();
      },
    },
    delay: async () => {},
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.resume_mode, "MANUAL");
  assert.equal(viewCalls, 0);
  assert.ok(result.state_trace.includes("UI_RENDERED"));
});

test("a transient first view miss retries read-back without recreating", async () => {
  let createCalls = 0;
  let viewCalls = 0;
  const result = await ensureResumeAutomation({
    expected: intent(),
    adapter: {
      create: async () => {
        createCalls += 1;
        return { automation_id: "automation-123" };
      },
      view: async () => {
        viewCalls += 1;
        if (viewCalls === 1) throw new Error("NOT_FOUND");
        return persistedHeartbeat();
      },
    },
    delay: async () => {},
  });

  assert.equal(result.status, "VERIFIED");
  assert.equal(createCalls, 1);
  assert.equal(viewCalls, 2);
});

test("confirmed absence after read-back retries create once and verifies the second ID", async () => {
  let createCalls = 0;
  let viewCalls = 0;
  let reconcileCalls = 0;
  const result = await ensureResumeAutomation({
    expected: intent(),
    maxViewAttempts: 2,
    adapter: {
      create: async () => {
        createCalls += 1;
        return { automation_id: `automation-${createCalls}` };
      },
      view: async ({ id }) => {
        viewCalls += 1;
        if (id === "automation-1") throw new Error("NOT_FOUND");
        return persistedHeartbeat({ id });
      },
      reconcile: async () => {
        reconcileCalls += 1;
        return { outcome: "ABSENT", candidates: [] };
      },
    },
    delay: async () => {},
  });

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.automation_id, "automation-2");
  assert.equal(result.attempts, 2);
  assert.equal(createCalls, 2);
  assert.equal(viewCalls, 3);
  assert.equal(reconcileCalls, 1);
});

test("two confirmed persistence failures stop at the create-attempt limit", async () => {
  let createCalls = 0;
  const result = await ensureResumeAutomation({
    expected: intent(),
    maxViewAttempts: 1,
    adapter: {
      create: async () => ({ automation_id: `automation-${++createCalls}` }),
      view: async () => {
        throw new Error("NOT_FOUND");
      },
      reconcile: async () => ({ outcome: "ABSENT", candidates: [] }),
    },
    delay: async () => {},
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.resume_mode, "MANUAL");
  assert.equal(result.attempts, 2);
  assert.equal(createCalls, 2);
  assert.equal(result.resolution, "MANUAL_FALLBACK");
});

test("one filesystem candidate still requires view read-back before verification", async () => {
  let viewCalls = 0;
  const result = await ensureResumeAutomation({
    expected: intent(),
    adapter: {
      create: async () => "Rendered automation card in the app.",
      reconcile: async () => ({
        outcome: "SINGLE",
        automation_id: "filesystem-candidate",
      }),
      view: async ({ id }) => {
        viewCalls += 1;
        return persistedHeartbeat({ id });
      },
    },
    delay: async () => {},
  });

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.automation_id, "filesystem-candidate");
  assert.equal(viewCalls, 1);
});

test("multiple filesystem candidates never select one or recreate blindly", async () => {
  let createCalls = 0;
  let viewCalls = 0;
  const result = await ensureResumeAutomation({
    expected: intent(),
    adapter: {
      create: async () => {
        createCalls += 1;
        return "Rendered automation card in the app.";
      },
      reconcile: async () => ({
        outcome: "AMBIGUOUS",
        candidates: ["automation-a", "automation-b"],
      }),
      view: async () => {
        viewCalls += 1;
      },
    },
    delay: async () => {},
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.resume_mode, "MANUAL");
  assert.equal(result.attempts, 1);
  assert.equal(createCalls, 1);
  assert.equal(viewCalls, 0);
});

for (const [label, override, error] of [
  ["cron kind", { kind: "cron" }, "KIND_MISMATCH"],
  ["daily recurring schedule", {
    rrule: "DTSTART:20260831T173211Z\nRRULE:FREQ=DAILY",
  }, "SCHEDULE_MISMATCH"],
  ["wrong target thread", { targetThreadId: "thread-other" }, "THREAD_MISMATCH"],
  ["paused status", { status: "PAUSED" }, "STATUS_NOT_ACTIVE"],
]) {
  test(`${label} is persisted but never verified`, async () => {
    const result = await ensureResumeAutomation({
      expected: intent(),
      adapter: {
        create: async () => ({ id: "automation-123", kind: "automation" }),
        view: async () => persistedHeartbeat(override),
      },
      delay: async () => {},
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.resume_mode, "MANUAL");
    assert.equal(result.automation_id, "automation-123");
    assert.equal(result.last_error, error);
    assert.equal(result.cleanup_required, true);
  });
}

test("filesystem reconciliation reads matching TOML without modifying it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-automation-registry-"));
  const candidateDir = path.join(root, "automation-local");
  await mkdir(candidateDir);
  const tomlPath = path.join(candidateDir, "automation.toml");
  const content = [
    'name = "TASK-0010 quota resume"',
    'kind = "heartbeat"',
    'status = "ACTIVE"',
    'destination = "thread"',
    'targetThreadId = "thread-123"',
    'rrule = "DTSTART:20260831T173211Z\\nRRULE:FREQ=DAILY;COUNT=1"',
    'prompt = "Resume the exact next action in this thread"',
    "",
  ].join("\n");
  await writeFile(tomlPath, content);

  const result = await reconcileLocalAutomationRegistry({
    automationRoot: root,
    expected: intent(),
    requestStartedAt: new Date(Date.now() - 5_000).toISOString(),
  });

  assert.deepEqual(result, {
    outcome: "SINGLE",
    automation_id: "automation-local",
    candidates: ["automation-local"],
  });
  assert.equal(await readFile(tomlPath, "utf8"), content);
});

test("an ambiguous create timeout reconciles before any possible retry", async () => {
  const events = [];
  const result = await ensureResumeAutomation({
    expected: intent(),
    adapter: {
      create: async () => {
        events.push("create");
        throw new Error("request timeout");
      },
      reconcile: async () => {
        events.push("reconcile");
        return { outcome: "AMBIGUOUS", candidates: ["a", "b"] };
      },
      view: async () => persistedHeartbeat(),
    },
    delay: async () => {},
  });

  assert.equal(result.status, "FAILED");
  assert.deepEqual(events, ["create", "reconcile"]);
  assert.equal(result.attempts, 1);
});

test("a structural heartbeat capability failure uses manual fallback without retry", async () => {
  let createCalls = 0;
  let reconcileCalls = 0;
  const result = await ensureResumeAutomation({
    expected: intent(),
    adapter: {
      create: async () => {
        createCalls += 1;
        throw new Error("heartbeat schema unsupported");
      },
      reconcile: async () => {
        reconcileCalls += 1;
        return { outcome: "ABSENT", candidates: [] };
      },
      view: async () => persistedHeartbeat(),
    },
    delay: async () => {},
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.last_error, "STRUCTURAL_FAILURE");
  assert.equal(createCalls, 1);
  assert.equal(reconcileCalls, 0);
});

test("a labeled text view response is normalized and verified", async () => {
  const result = await ensureResumeAutomation({
    expected: intent(),
    adapter: {
      create: async () => ({ id: "automation-text", kind: "heartbeat" }),
      view: async () => ({
        content: [{
          type: "text",
          text: [
            "Automation ID: automation-text",
            "Kind: heartbeat",
            "Status: ACTIVE",
            "Name: TASK-0010 quota resume",
            "Destination: thread",
            "Target Thread: thread-123",
            "Schedule: DTSTART:20260831T173211Z RRULE:FREQ=DAILY;COUNT=1",
            "Prompt: Resume the exact next action in this thread",
          ].join("\n"),
        }],
      }),
    },
    delay: async () => {},
  });

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.automation_id, "automation-text");
});

test("a filesystem candidate without successful view remains unverified", async () => {
  const result = await ensureResumeAutomation({
    expected: intent(),
    maxViewAttempts: 1,
    adapter: {
      create: async () => "Rendered automation card in the app.",
      reconcile: async () => ({ outcome: "SINGLE", automation_id: "filesystem-only" }),
      view: async () => {
        throw new Error("NOT_FOUND");
      },
    },
    delay: async () => {},
  });

  assert.equal(result.status, "FAILED");
  assert.notEqual(result.resume_mode, "AUTOMATION");
});

test("a persisted heartbeat with no readable target is not same-thread verified", async () => {
  const result = await ensureResumeAutomation({
    expected: intent(),
    adapter: {
      create: async () => ({ automation_id: "automation-123" }),
      view: async () => persistedHeartbeat({ targetThreadId: undefined }),
    },
    delay: async () => {},
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.last_error, "TARGET_UNVERIFIED");
  assert.equal(result.verification.thread_match, null);
});

test("repeated unparseable views stay ambiguous and never trigger a second create", async () => {
  let createCalls = 0;
  let reconcileCalls = 0;
  const result = await ensureResumeAutomation({
    expected: intent(),
    maxViewAttempts: 2,
    adapter: {
      create: async () => ({ automation_id: `automation-${++createCalls}` }),
      view: async () => ({ content: [{ type: "text", text: "Rendered a detail card" }] }),
      reconcile: async () => {
        reconcileCalls += 1;
        return { outcome: "ABSENT", candidates: [] };
      },
    },
    delay: async () => {},
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.last_error, "UNPARSEABLE_VIEW");
  assert.equal(createCalls, 1);
  assert.equal(reconcileCalls, 1);
});

test("transient view failures are bounded and never authorize a blind recreate", async () => {
  let createCalls = 0;
  let viewCalls = 0;
  const result = await ensureResumeAutomation({
    expected: intent(),
    maxViewAttempts: 2,
    adapter: {
      create: async () => ({ automation_id: `automation-${++createCalls}` }),
      view: async () => {
        viewCalls += 1;
        const error = new Error("request timeout");
        error.code = "ETIMEDOUT";
        throw error;
      },
      reconcile: async () => ({ outcome: "ABSENT", candidates: [] }),
    },
    delay: async () => {},
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.last_error, "VIEW_TRANSIENT_FAILURE");
  assert.equal(createCalls, 1);
  assert.equal(viewCalls, 2);
});

test("a structural view rejection returns manual fallback without reconciliation", async () => {
  let reconcileCalls = 0;
  const result = await ensureResumeAutomation({
    expected: intent(),
    adapter: {
      create: async () => ({ automation_id: "automation-123" }),
      view: async () => {
        throw new Error("handler missing for mode view");
      },
      reconcile: async () => {
        reconcileCalls += 1;
        return { outcome: "ABSENT", candidates: [] };
      },
    },
    delay: async () => {},
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.last_error, "STRUCTURAL_FAILURE");
  assert.equal(reconcileCalls, 0);
});

test("a reconciliation I/O error returns a structured manual result", async () => {
  const result = await ensureResumeAutomation({
    expected: intent(),
    maxViewAttempts: 1,
    adapter: {
      create: async () => ({ automation_id: "automation-123" }),
      view: async () => {
        throw new Error("NOT_FOUND");
      },
      reconcile: async () => {
        const error = new Error("access denied");
        error.code = "EACCES";
        throw error;
      },
    },
    delay: async () => {},
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.last_error, "RECONCILIATION_FAILED");
  assert.equal(result.attempts, 1);
});

test("an ambiguous create plus filesystem absence still does not recreate", async () => {
  let createCalls = 0;
  const result = await ensureResumeAutomation({
    expected: intent(),
    adapter: {
      create: async () => {
        createCalls += 1;
        throw new Error("request timeout");
      },
      view: async () => persistedHeartbeat(),
      reconcile: async () => ({ outcome: "ABSENT", candidates: [] }),
    },
    delay: async () => {},
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.last_error, "AMBIGUOUS_CREATE");
  assert.equal(createCalls, 1);
});

test("the Node transcript verifier derives VERIFIED from raw create and view evidence", async () => {
  const result = await verifyAutomationTranscript({
    expected: intent(),
    transcript: {
      operations: [
        { operation: "create", result: { automation_id: "automation-123" } },
        { operation: "view", id: "automation-123", result: persistedHeartbeat() },
      ],
    },
    delay: async () => {},
  });

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.verification_source, "READBACK");
  assert.equal("operations" in result, false);
});

test("the Node transcript verifier rejects hand-authored VERIFIED booleans", async () => {
  await assert.rejects(
    verifyAutomationTranscript({
      expected: intent(),
      transcript: {
        status: "VERIFIED",
        verification: {
          persisted: true,
          id_match: true,
          identity_match: true,
          kind_match: true,
          thread_match: true,
          schedule_match: true,
          status_active: true,
        },
      },
    }),
    /operations/i,
  );
});
