import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listRegistry, readCheckpoint } from "../scripts/lib/checkpoint.mjs";
import {
  completePhaseAndDecide,
  prepareQuotaPause,
} from "../scripts/lib/lifecycle.mjs";
import { normalizeQuotaResponse } from "../scripts/lib/quota.mjs";
import { QuotaSnapshotStore } from "../scripts/lib/quota-snapshot.mjs";
import { startPhase } from "../scripts/lib/usage.mjs";

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
  const snapshotStore = new QuotaSnapshotStore({
    taskGuardHome,
    reader: async () => refreshed,
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
});

test("quota pause shares one authoritative reset across checkpoint registry Discord and scheduling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-guard-pause-boundary-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  await writeFile(path.join(projectPath, "work.txt"), "work\n");
  const resetAt = "2027-01-15T08:00:00.000Z";
  const observedAt = "2026-08-31T12:24:00.000Z";
  const snapshotStore = new QuotaSnapshotStore({
    taskGuardHome,
    reader: async () => normalizeQuotaResponse({
      rateLimits: {
        primary: { usedPercent: 94, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      },
    }, { source: "test_fixture", observedAt }),
  });
  let discordBody;
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
      thread_reference: "current",
    },
    notificationPayload: {
      project: "codex-task-guard",
      task: "Implement authoritative quota snapshots",
      reason: "No measured phase fits",
      checkpoint: "Saved",
      resume: "Same-thread automation scheduled",
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

  const checkpoint = await readCheckpoint(result.checkpoint.checkpoint_path);
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
  assert.equal(result.notification.quota_snapshot_id, result.snapshot.snapshot_id);
  assert.equal(result.automation_schedule.resume_after, resetAt);
  assert.equal(result.automation_schedule.quota_snapshot_id, result.snapshot.snapshot_id);
  assert.equal(result.automation_schedule.quota_observed_at, observedAt);
});
