import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listRegistry,
  readCheckpoint,
  saveCheckpoint,
} from "../scripts/lib/checkpoint.mjs";
import {
  completePhaseAndDecide,
  finalizeQuotaPause,
  preparePhase,
  prepareQuotaPause,
  prepareTaskResume,
} from "../scripts/lib/lifecycle.mjs";
import { normalizeQuotaResponse } from "../scripts/lib/quota.mjs";
import { QuotaSnapshotStore } from "../scripts/lib/quota-snapshot.mjs";
import { startPhase } from "../scripts/lib/usage.mjs";
import { verifyAutomationTranscript } from "../scripts/lib/automation.mjs";

function snapshot(remaining, observedAt, resetAt = "2027-01-15T08:00:00.000Z") {
  return {
    snapshot_id: `${observedAt}-${remaining}`,
    source: "test_fixture",
    observed_at: observedAt,
    freshness: "AUTHORITATIVE",
    availability: "PARTIAL",
    five_hour: {
      available: true,
      used_percent: 100 - remaining,
      remaining_percent: remaining,
      window_duration_minutes: 300,
      reset_at: resetAt,
    },
    weekly: { available: false },
  };
}

test("phase completion history decision and Discord share the refreshed snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-decision-boundary-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  const before = snapshot(16, "2026-08-31T12:20:00.000Z");
  const refreshed = snapshot(10, "2026-08-31T12:24:00.000Z");
  await startPhase({
    projectPath,
    taskGuardHome,
    snapshot: before,
    metadata: {
      task_id: "freshness-flow",
      phase_id: "work",
      phase_type: "testing",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    },
  });
  let refreshReads = 0;
  const snapshotStore = new QuotaSnapshotStore({
    taskGuardHome,
    reader: async () => {
      refreshReads += 1;
      return refreshed;
    },
  });
  let discordBody;

  const result = await completePhaseAndDecide({
    projectPath,
    taskGuardHome,
    phaseId: "work",
    concurrentUsage: false,
    snapshotStore,
    phases: [{
      phase_id: "next-tests",
      phase_type: "testing",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      dependencies_met: true,
    }],
    safetyReservePercent: 5,
    notification: {
      event: "TASK_STARTED",
      payload: {
        project: "demo",
        task: "Fresh flow",
        thread: "Current thread",
        quota: "16% remaining",
        status: "Working",
      },
      options: {
        env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
        fetchImpl: async (_url, options) => {
          discordBody = JSON.parse(options.body);
          return { ok: true, status: 204 };
        },
      },
    },
  });

  const discordFields = Object.fromEntries(
    discordBody.embeds[0].fields.map(({ name, value }) => [name, value]),
  );
  assert.equal(result.measurement.quota_after, 10);
  assert.equal(result.measurement.quota_after_snapshot_id, result.snapshot.snapshot_id);
  assert.equal(result.decision.remaining_percent, 10);
  assert.equal(result.decision.quota_snapshot_id, result.snapshot.snapshot_id);
  assert.equal(discordFields["5h Quota"], "10% remaining");
  assert.equal(result.notification.quota_snapshot_id, result.snapshot.snapshot_id);
  assert.equal(refreshReads, 1);
});

test("phase prepare uses one authoritative snapshot for decision and phase start", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-phase-prepare-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  await mkdir(taskGuardHome);
  await writeFile(path.join(taskGuardHome, "usage-history.jsonl"), `${JSON.stringify({
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    phase_type: "implementation",
    plan: "plus",
    quota_delta: 7,
    measurement_confidence: "HIGH_CONFIDENCE",
    reset_occurred: false,
  })}\n`);
  let refreshReads = 0;
  const current = snapshot(18, "2026-08-31T12:24:00.000Z");
  const snapshotStore = {
    refresh: async () => {
      refreshReads += 1;
      return current;
    },
  };

  const result = await preparePhase({
    projectPath,
    taskGuardHome,
    snapshotStore,
    safetyReservePercent: 5,
    phases: [{
      task_id: "atomic-phase-task",
      phase_id: "implementation",
      phase_type: "implementation",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      plan: "plus",
      dependencies_met: true,
    }],
  });

  assert.equal(refreshReads, 1);
  assert.equal(result.snapshot.snapshot_id, current.snapshot_id);
  assert.equal(result.decision.selected_phase_id, "implementation");
  assert.equal(result.phase_start.quota_before, 18);
  assert.equal(result.decision.quota_snapshot_id, current.snapshot_id);
  assert.equal(result.phase_start.quota_before_snapshot_id, current.snapshot_id);
});

test("phase prepare does not create an active phase when no phase fits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-phase-no-fit-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  await mkdir(taskGuardHome);
  await writeFile(path.join(taskGuardHome, "usage-history.jsonl"), `${JSON.stringify({
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    phase_type: "implementation",
    quota_delta: 20,
    measurement_confidence: "HIGH_CONFIDENCE",
    reset_occurred: false,
  })}\n`);
  const current = snapshot(18, "2026-08-31T12:24:00.000Z");
  const phase = {
    task_id: "no-fit-task",
    phase_id: "too-large",
    phase_type: "implementation",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    dependencies_met: true,
  };

  const result = await preparePhase({
    projectPath,
    taskGuardHome,
    snapshotStore: { refresh: async () => current },
    safetyReservePercent: 5,
    phases: [phase],
  });

  assert.equal(result.decision.selected_phase_id, null);
  assert.equal(result.phase_start, null);
  const laterStart = await startPhase({
    projectPath,
    taskGuardHome,
    snapshot: current,
    metadata: { ...phase, phase_id: "manual-calibration" },
  });
  assert.equal(laterStart.phase_id, "manual-calibration");
});

test("quota pause defers Discord until a verified automation result is checkpointed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-pause-boundary-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  await writeFile(path.join(projectPath, "work.txt"), "work\n");
  const resetAt = "2027-01-15T08:00:00.000Z";
  const observedAt = "2026-08-31T12:24:00.000Z";
  let refreshReads = 0;
  const snapshotStore = new QuotaSnapshotStore({
    taskGuardHome,
    reader: async () => {
      refreshReads += 1;
      return normalizeQuotaResponse({
        rateLimits: {
          primary: { usedPercent: 94, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        },
      }, { source: "test_fixture", observedAt });
    },
  });
  let discordBody = null;
  let checkpointExistedBeforeDiscord = false;

  const result = await prepareQuotaPause({
    projectPath,
    taskGuardHome,
    snapshotStore,
    checkpointState: {
      task_id: "fresh-pause",
      task_description: "Implement authoritative quota snapshots",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Resume freshness integration tests"],
      thread_reference: "thread-fresh",
    },
    notificationPayload: {
      project: "codex-task-guard",
      task: "Implement authoritative quota snapshots",
      reason: "No measured phase fits",
      checkpoint: "Saved",
      status: "Waiting for quota reset",
    },
    notifyOptions: {
      env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
      fetchImpl: async (_url, options) => {
        checkpointExistedBeforeDiscord = Boolean(await readFile(
          path.join(projectPath, ".codex", "task-guard-checkpoint.md"),
          "utf8",
        ));
        discordBody = JSON.parse(options.body);
        return { ok: true, status: 204 };
      },
    },
  });

  assert.equal(discordBody, null);
  assert.equal(result.notification, null);
  assert.equal(result.automation_intent.kind, "heartbeat");
  assert.equal(result.automation_intent.destination, "thread");
  assert.equal(result.automation_intent.target_thread, "thread-fresh");

  const automationTranscript = {
    operations: [
      { operation: "create", result: { automation_id: "automation-verified" } },
      {
        operation: "view",
        id: "automation-verified",
        result: {
          id: "automation-verified",
          kind: "heartbeat",
          status: "ACTIVE",
          name: "fresh-pause quota resume",
          destination: "thread",
          targetThreadId: "thread-fresh",
          rrule: "DTSTART:20270115T080000Z\nRRULE:FREQ=DAILY;COUNT=1",
          prompt: result.automation_intent.prompt,
          private: "transient-only",
        },
      },
    ],
  };
  const sanitized = await verifyAutomationTranscript({
    expected: result.automation_intent,
    transcript: automationTranscript,
    delay: async () => {},
  });
  assert.equal(sanitized.status, "VERIFIED");
  assert.equal(sanitized.verification_source, "READBACK");
  assert.equal(JSON.stringify(sanitized).includes("transient-only"), false);

  const finalized = await finalizeQuotaPause({
    projectPath,
    taskGuardHome,
    taskId: "fresh-pause",
    automationTranscript,
    notificationPayload: {
      project: "codex-task-guard",
      task: "Implement authoritative quota snapshots",
      reason: "No measured phase fits",
      status: "Waiting for quota reset",
    },
    notifyOptions: {
      env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
      fetchImpl: async (_url, options) => {
        checkpointExistedBeforeDiscord = Boolean(await readFile(
          path.join(projectPath, ".codex", "task-guard-checkpoint.md"),
          "utf8",
        ));
        discordBody = JSON.parse(options.body);
        return { ok: true, status: 204 };
      },
    },
  });

  const checkpoint = await readCheckpoint(finalized.checkpoint.checkpoint_path);
  const [registryEntry] = Object.values((await listRegistry({ taskGuardHome })).tasks);
  const discordFields = Object.fromEntries(
    discordBody.embeds[0].fields.map(({ name, value }) => [name, value]),
  );

  assert.equal(checkpointExistedBeforeDiscord, true);
  assert.equal(checkpoint.schema_version, 2);
  assert.equal(checkpoint.quota_snapshot.snapshot_id, result.snapshot.snapshot_id);
  assert.equal(checkpoint.quota_snapshot.observed_at, observedAt);
  assert.equal(checkpoint.resume_after, resetAt);
  assert.equal(registryEntry.resume_after, resetAt);
  assert.equal(registryEntry.quota_snapshot_id, result.snapshot.snapshot_id);
  assert.equal(registryEntry.quota_observed_at, observedAt);
  assert.equal(discordFields["5h Remaining"], "**6%**");
  assert.equal(discordFields["Next Reset"], "<t:1800000000:t> · <t:1800000000:R>");
  assert.equal(discordFields.Resume, "✅ Same-thread automation verified");
  assert.equal(discordFields.Automation, "Verified · Attempt 1/2");
  assert.equal(finalized.notification.quota_snapshot_id, result.snapshot.snapshot_id);
  assert.equal(checkpoint.resume_automation.status, "VERIFIED");
  assert.equal(result.automation_schedule.resume_after, resetAt);
  assert.equal(result.automation_schedule.quota_snapshot_id, result.snapshot.snapshot_id);
  assert.equal(result.automation_schedule.quota_observed_at, observedAt);
  assert.equal(refreshReads, 1);
});

test("quota pause preserves its checkpoint and requires manual resume when refresh fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-pause-refresh-failure-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  const stale = snapshot(
    16,
    "2026-08-31T12:20:00.000Z",
    "2026-08-31T15:00:00.000Z",
  );
  let refreshReads = 0;
  const snapshotStore = {
    refresh: async () => {
      refreshReads += 1;
      throw new Error("quota reader failed");
    },
    latest: async () => ({ ...stale, freshness: "STALE" }),
  };
  let discordBody;

  const result = await prepareQuotaPause({
    projectPath,
    taskGuardHome,
    snapshotStore,
    checkpointState: {
      task_id: "failed-refresh-pause",
      task_description: "Preserve work after a rate-limit rejection",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Resume manually in this thread"],
      thread_reference: "current",
    },
    notificationPayload: {
      project: "codex-task-guard",
      task: "Preserve failed refresh pause",
      reason: "Codex rate-limit rejection",
      checkpoint: "Saved",
      resume: "Manual resume required",
      status: "Waiting for quota reset",
    },
    notifyOptions: {
      env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
      fetchImpl: async (_url, options) => {
        discordBody = JSON.parse(options.body);
        return { ok: true, status: 204 };
      },
    },
  });

  const checkpoint = await readCheckpoint(result.checkpoint.checkpoint_path);
  const fields = Object.fromEntries(
    discordBody.embeds[0].fields.map(({ name, value }) => [name, value]),
  );
  assert.equal(refreshReads, 1);
  assert.equal(result.checkpoint.saved, true);
  assert.equal(checkpoint.status, "PAUSED_FOR_QUOTA");
  assert.equal(checkpoint.quota_snapshot.freshness, "UNAVAILABLE");
  assert.equal(checkpoint.quota_snapshot.last_known_snapshot.freshness, "STALE");
  assert.equal(checkpoint.resume_after, null);
  assert.equal(result.automation_schedule, null);
  assert.equal(result.automation_schedule_error, "AUTHORITATIVE_QUOTA_REQUIRED");
  assert.equal(result.resume_mode, "MANUAL");
  assert.equal(fields["5h Remaining"], "**Unavailable (refresh failed)**");
  assert.equal("Next Reset" in fields, false);
  assert.equal(fields.Checkpoint, "✅ Saved");
  assert.equal(fields.Resume, "⚠️ Manual resume required");
});

test("failed automation verification is checkpointed before manual-resume Discord", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-pause-final-failure-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  const resetAt = "2027-01-15T08:00:00.000Z";
  const current = snapshot(5, "2026-08-31T12:24:00.000Z", resetAt);
  await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "failed-automation",
      task_description: "Fall back after verification failure",
      status: "PAUSED_FOR_QUOTA",
      quota_snapshot: current,
      resume_after: resetAt,
      exact_next_actions: ["Resume manually"],
      thread_reference: "thread-failed",
    },
  });
  let body;

  const result = await finalizeQuotaPause({
    projectPath,
    taskGuardHome,
    taskId: "failed-automation",
    automationTranscript: {
      operations: [{
        operation: "create",
        error: { code: "SCHEMA_UNSUPPORTED", message: "heartbeat schema unsupported" },
      }],
    },
    notificationPayload: {
      project: "codex-task-guard",
      task: "Fall back after verification failure",
      reason: "Quota pause",
      status: "Waiting for manual resume",
    },
    notifyOptions: {
      env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
      fetchImpl: async (_url, options) => {
        const checkpoint = await readCheckpoint(path.join(
          projectPath,
          ".codex",
          "task-guard-checkpoint.md",
        ));
        assert.equal(checkpoint.resume_automation.status, "FAILED");
        body = JSON.parse(options.body);
        return { ok: true, status: 204 };
      },
    },
  });

  const fields = Object.fromEntries(body.embeds[0].fields.map(({ name, value }) => [name, value]));
  assert.equal(result.resume_mode, "MANUAL");
  assert.equal(fields.Resume, "⚠️ Manual resume required");
  assert.equal(fields.Automation, "Registration could not be verified");
});

test("quota pause blocks automation but keeps the checkpoint when reset is unverified", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-pause-no-reset-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  const withoutReset = snapshot(6, "2026-08-31T12:24:00.000Z", null);

  const result = await prepareQuotaPause({
    projectPath,
    taskGuardHome,
    snapshotStore: { refresh: async () => withoutReset },
    checkpointState: {
      task_id: "pause-without-reset",
      task_description: "Preserve pause without guessing reset",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Resume manually"],
    },
    notificationPayload: { project: "demo", task: "No reset" },
    notifyOptions: { env: {} },
  });

  const checkpoint = await readCheckpoint(result.checkpoint.checkpoint_path);
  assert.equal(result.checkpoint.saved, true);
  assert.equal(checkpoint.resume_after, null);
  assert.equal(result.automation_schedule, null);
  assert.equal(result.automation_schedule_error, "VERIFIED_FIVE_HOUR_RESET_REQUIRED");
  assert.equal(result.resume_mode, "MANUAL");
});

test("quota pause does not invent a concrete ID for implicit current-thread binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-pause-current-thread-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  const current = snapshot(
    6,
    "2026-08-31T12:24:00.000Z",
    "2026-08-31T17:24:00.000Z",
  );

  const result = await prepareQuotaPause({
    projectPath,
    taskGuardHome,
    snapshotStore: { refresh: async () => current },
    checkpointState: {
      task_id: "pause-implicit-current",
      task_description: "Do not invent a target thread ID",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Resume manually"],
      thread_reference: "current",
    },
    notificationPayload: { project: "demo", task: "Implicit target" },
    notifyOptions: { env: {} },
  });

  const checkpoint = await readCheckpoint(result.checkpoint.checkpoint_path);
  assert.equal(result.automation_intent, null);
  assert.equal(result.automation_schedule_error, "CONCRETE_THREAD_ID_REQUIRED");
  assert.equal(result.resume_mode, "MANUAL");
  assert.equal(checkpoint.thread_reference, "current");
  assert.equal(checkpoint.resume_after, current.five_hour.reset_at);
});

test("task resume uses one authoritative snapshot for resume Discord and next decision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-resume-boundary-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "resume-boundary-task",
      task_description: "Resume with one snapshot",
      status: "PAUSED_FOR_QUOTA",
      heartbeat_automation_id: "automation-123",
      exact_next_actions: ["Continue the resume integration"],
      thread_reference: "current",
    },
  });
  await writeFile(path.join(taskGuardHome, "usage-history.jsonl"), `${JSON.stringify({
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    phase_type: "testing",
    quota_delta: 5,
    measurement_confidence: "HIGH_CONFIDENCE",
    reset_occurred: false,
  })}\n`);
  const current = snapshot(100, "2026-08-31T12:31:00.000Z");
  let refreshReads = 0;
  let cleanedAutomationId;
  let discordBody;

  const result = await prepareTaskResume({
    projectPath,
    taskGuardHome,
    taskId: "resume-boundary-task",
    snapshotStore: {
      refresh: async () => {
        refreshReads += 1;
        return current;
      },
    },
    cleanupHeartbeat: async ({ automationId }) => {
      cleanedAutomationId = automationId;
      return true;
    },
    notificationPayload: {
      project: "codex-task-guard",
      task: "Resume with one snapshot",
      checkpoint: "Verified",
      repository: "No external changes",
      status: "Working",
    },
    notifyOptions: {
      env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
      fetchImpl: async (_url, options) => {
        discordBody = JSON.parse(options.body);
        return { ok: true, status: 204 };
      },
    },
    phases: [{
      phase_id: "next-tests",
      phase_type: "testing",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      dependencies_met: true,
    }],
    safetyReservePercent: 5,
  });

  const checkpoint = await readCheckpoint(saved.checkpoint_path);
  const fields = Object.fromEntries(
    discordBody.embeds[0].fields.map(({ name, value }) => [name, value]),
  );
  assert.equal(refreshReads, 1);
  assert.equal(cleanedAutomationId, "automation-123");
  assert.equal(checkpoint.status, "WORKING");
  assert.equal(checkpoint.heartbeat_automation_id, undefined);
  assert.equal(result.snapshot.snapshot_id, current.snapshot_id);
  assert.equal(result.resume.quota_snapshot_id, current.snapshot_id);
  assert.equal(result.notification.quota_snapshot_id, current.snapshot_id);
  assert.equal(result.decision.quota_snapshot_id, current.snapshot_id);
  assert.equal(fields["5h Quota"], "100% remaining");
  assert.equal(fields["Resume Point"], "Continue the resume integration");
});

test("invalid optional budget input cannot partially resume or clean up", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-resume-prevalidation-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "resume-prevalidation-task",
      task_description: "Validate before resume side effects",
      status: "PAUSED_FOR_QUOTA",
      heartbeat_automation_id: "automation-prevalidation",
      exact_next_actions: ["Keep this paused on invalid input"],
    },
  });
  let cleanupCalls = 0;
  let notificationCalls = 0;

  await assert.rejects(
    prepareTaskResume({
      projectPath,
      taskGuardHome,
      taskId: "resume-prevalidation-task",
      snapshotStore: {
        refresh: async () => snapshot(100, "2026-08-31T12:31:00.000Z"),
      },
      cleanupHeartbeat: async () => {
        cleanupCalls += 1;
        return true;
      },
      notifyOptions: {
        env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
        fetchImpl: async () => {
          notificationCalls += 1;
          return { ok: true, status: 204 };
        },
      },
      phases: [{}],
      safetyReservePercent: 5,
    }),
    /phases\[0\]\.phase_id must be a non-empty string/,
  );

  const checkpoint = await readCheckpoint(saved.checkpoint_path);
  assert.equal(checkpoint.status, "PAUSED_FOR_QUOTA");
  assert.equal(checkpoint.heartbeat_automation_id, "automation-prevalidation");
  assert.equal(cleanupCalls, 0);
  assert.equal(notificationCalls, 0);
});

test("duplicate resume wake is idempotent and emits no second side effects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-resume-idempotent-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "resume-idempotent-task",
      task_description: "Ignore a duplicate scheduled wake",
      status: "PAUSED_FOR_QUOTA",
      heartbeat_automation_id: "automation-idempotent",
      resume_automation: {
        purpose: "quota_resume",
        status: "VERIFIED",
        automation_id: "automation-idempotent",
      },
      exact_next_actions: ["Continue once"],
    },
  });
  let cleanupCalls = 0;
  let notificationCalls = 0;
  const options = {
    projectPath,
    taskGuardHome,
    taskId: "resume-idempotent-task",
    snapshotStore: {
      refresh: async () => snapshot(100, "2026-08-31T12:31:00.000Z"),
    },
    cleanupHeartbeat: async () => {
      cleanupCalls += 1;
      return true;
    },
    notificationPayload: { project: "demo", task: "Resume once" },
    notifyOptions: {
      env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
      fetchImpl: async () => {
        notificationCalls += 1;
        return { ok: true, status: 204 };
      },
    },
  };

  const first = await prepareTaskResume(options);
  const afterFirst = await readCheckpoint(saved.checkpoint_path);
  const second = await prepareTaskResume(options);
  const afterSecond = await readCheckpoint(saved.checkpoint_path);

  assert.equal(first.status, "TASK_RESUMED");
  assert.equal(second.status, "ALREADY_RESUMED");
  assert.equal(second.resume, null);
  assert.equal(second.notification, null);
  assert.equal(cleanupCalls, 1);
  assert.equal(notificationCalls, 1);
  assert.equal(afterFirst.resume_automation.status, "EXECUTED");
  assert.deepEqual(afterSecond, afterFirst);
});

test("task resume blocks without a working transition when repository verification fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-resume-blocked-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  await writeFile(path.join(projectPath, "work.txt"), "before\n");
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "blocked-resume-task",
      task_description: "Do not resume over repository changes",
      status: "PAUSED_FOR_QUOTA",
      heartbeat_automation_id: "automation-blocked",
      exact_next_actions: ["Inspect the external repository change"],
    },
  });
  await writeFile(path.join(projectPath, "work.txt"), "after\n");
  const current = snapshot(100, "2026-08-31T12:31:00.000Z");
  let refreshReads = 0;
  let cleaned = false;
  let discordBody;

  const result = await prepareTaskResume({
    projectPath,
    taskGuardHome,
    taskId: "blocked-resume-task",
    snapshotStore: {
      refresh: async () => {
        refreshReads += 1;
        return current;
      },
    },
    cleanupHeartbeat: async ({ automationId }) => {
      assert.equal(automationId, "automation-blocked");
      cleaned = true;
      return true;
    },
    blockedNotificationPayload: {
      project: "codex-task-guard",
      task: "Blocked resume",
      action_required: "Review repository changes",
      checkpoint: "Preserved",
      status: "Blocked",
    },
    notifyOptions: {
      env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
      fetchImpl: async (_url, options) => {
        discordBody = JSON.parse(options.body);
        return { ok: true, status: 204 };
      },
    },
  });

  const checkpoint = await readCheckpoint(saved.checkpoint_path);
  const [registryEntry] = Object.values((await listRegistry({ taskGuardHome })).tasks);
  assert.equal(refreshReads, 1);
  assert.equal(cleaned, false);
  assert.equal(result.status, "TASK_BLOCKED");
  assert.equal(result.resume, null);
  assert.equal(result.verification.reason, "REPOSITORY_STATE_CHANGED");
  assert.equal(checkpoint.status, "PAUSED_FOR_QUOTA");
  assert.equal(checkpoint.heartbeat_automation_id, "automation-blocked");
  assert.equal(registryEntry.status, "paused_for_quota");
  assert.equal(discordBody.embeds[0].title, "❌ Codex Task Blocked");
});
