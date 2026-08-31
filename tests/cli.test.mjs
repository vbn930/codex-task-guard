import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("scripts", "task-guard.mjs");

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    windowsHide: true,
  });
}

test("quota command exposes deterministic low-quota JSON", () => {
  const result = run(["quota"], { env: { TASK_GUARD_TEST_QUOTA: "low" } });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.source, "test_fixture");
  assert.equal(output.five_hour.remaining_percent, 5);
});

test("checkpoint CLI saves, verifies, and reports a later repository conflict", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-cli-"));
  const project = path.join(root, "project");
  const home = path.join(root, "global");
  const input = path.join(root, "checkpoint-input.json");
  execFileSync("git", ["init", "-q", project]);
  await writeFile(path.join(project, "work.txt"), "initial\n");
  await writeFile(input, JSON.stringify({
    task_id: "cli-task",
    task_description: "Exercise the CLI",
    status: "PAUSED_FOR_QUOTA",
    exact_next_actions: ["Resume through the CLI"],
  }));
  const env = { TASK_GUARD_HOME: home };

  const saved = run(["checkpoint", "save", "--project", project, "--input", input], { env });
  assert.equal(saved.status, 0, saved.stderr);
  const checkpointPath = JSON.parse(saved.stdout).checkpoint_path;

  const verified = run(["checkpoint", "verify", "--checkpoint", checkpointPath], { env });
  assert.equal(verified.status, 0);
  assert.equal(JSON.parse(verified.stdout).matches, true);

  const resumed = run([
    "checkpoint", "resume", "--project", project, "--task-id", "cli-task",
  ], { env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, "working");
  const shown = run(["checkpoint", "show", "--checkpoint", checkpointPath], { env });
  assert.equal(JSON.parse(shown.stdout).status, "WORKING");

  await writeFile(path.join(project, "work.txt"), "changed\n");
  const conflict = run(["checkpoint", "verify", "--checkpoint", checkpointPath], { env });
  assert.equal(conflict.status, 3);
  assert.equal(JSON.parse(conflict.stdout).reason, "REPOSITORY_STATE_CHANGED");
});

test("checkpoint heartbeat CLI patches and clears only the automation id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-heartbeat-cli-"));
  const project = path.join(root, "project");
  const home = path.join(root, "global");
  const input = path.join(root, "checkpoint-input.json");
  execFileSync("git", ["init", "-q", project]);
  await writeFile(input, JSON.stringify({
    task_id: "heartbeat-cli-task",
    task_description: "Patch heartbeat through the CLI",
    status: "PAUSED_FOR_QUOTA",
    resume_after: "2026-08-31T16:32:00.000Z",
    exact_next_actions: ["Continue exactly here"],
  }));
  const env = { TASK_GUARD_HOME: home };
  const saved = run([
    "checkpoint", "save", "--project", project, "--input", input,
  ], { env });
  assert.equal(saved.status, 0, saved.stderr);

  const attached = run([
    "checkpoint", "heartbeat", "set", "--project", project,
    "--task-id", "heartbeat-cli-task", "--automation-id", "automation-123",
  ], { env });
  assert.equal(attached.status, 0, attached.stderr);
  assert.equal(JSON.parse(attached.stdout).heartbeat_automation_id, "automation-123");

  const cleared = run([
    "checkpoint", "heartbeat", "clear", "--project", project,
    "--task-id", "heartbeat-cli-task",
  ], { env });
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(JSON.parse(cleared.stdout).heartbeat_automation_id, null);
});

test("checkpoint automation CLI stores a verified sanitized result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-automation-cli-"));
  const project = path.join(root, "project");
  const home = path.join(root, "global");
  const checkpointInput = path.join(root, "checkpoint-input.json");
  const automationInput = path.join(root, "automation-input.json");
  execFileSync("git", ["init", "-q", project]);
  await writeFile(checkpointInput, JSON.stringify({
    task_id: "automation-cli-task",
    task_description: "Patch verified automation through the CLI",
    status: "PAUSED_FOR_QUOTA",
    quota_snapshot: { snapshot_id: "snapshot-cli" },
    resume_after: "2026-08-31T17:32:11.000Z",
    exact_next_actions: ["Continue exactly here"],
    thread_reference: "thread-cli",
  }));
  await writeFile(automationInput, JSON.stringify({
    purpose: "quota_resume",
    status: "VERIFIED",
    automation_id: "automation-cli",
    attempts: 1,
    target_thread: "thread-cli",
    resume_after: "2026-08-31T17:32:11.000Z",
    snapshot_id: "snapshot-cli",
    automation_fingerprint: "fingerprint-cli",
    verification: {
      persisted: true,
      identity_match: true,
      kind_match: true,
      thread_match: true,
      schedule_match: true,
      status_active: true,
    },
  }));
  const env = { TASK_GUARD_HOME: home };
  assert.equal(run([
    "checkpoint", "save", "--project", project, "--input", checkpointInput,
  ], { env }).status, 0);

  const patched = run([
    "checkpoint", "automation", "set", "--project", project,
    "--task-id", "automation-cli-task", "--input", automationInput,
  ], { env });

  assert.equal(patched.status, 0, patched.stderr);
  assert.equal(JSON.parse(patched.stdout).resume_mode, "AUTOMATION");
});

test("pause finalize CLI patches the result before its final notification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-finalize-cli-"));
  const project = path.join(root, "project");
  const home = path.join(root, "global");
  const checkpointInput = path.join(root, "checkpoint.json");
  const finalInput = path.join(root, "final.json");
  execFileSync("git", ["init", "-q", project]);
  const snapshotId = "snapshot-final";
  const resumeAfter = "2026-08-31T17:32:11.000Z";
  await writeFile(checkpointInput, JSON.stringify({
    task_id: "finalize-cli-task",
    task_description: "Finalize automation result",
    status: "PAUSED_FOR_QUOTA",
    quota_snapshot: {
      snapshot_id: snapshotId,
      observed_at: "2026-08-31T12:24:00.000Z",
      freshness: "AUTHORITATIVE",
      five_hour: { available: true, remaining_percent: 5, reset_at: resumeAfter },
    },
    resume_after: resumeAfter,
    exact_next_actions: ["Continue"],
    thread_reference: "thread-final",
  }));
  await writeFile(finalInput, JSON.stringify({
    resume_automation: {
      purpose: "quota_resume",
      status: "FAILED",
      automation_id: null,
      attempts: 2,
      target_thread: "thread-final",
      resume_after: resumeAfter,
      snapshot_id: snapshotId,
      last_error: "PERSISTENCE_NOT_VERIFIED",
      resolution: "MANUAL_FALLBACK",
    },
    notification: { project: "demo", task: "Finalize automation result" },
  }));
  const env = { TASK_GUARD_HOME: home, CODEX_DISCORD_WEBHOOK_URL: "" };
  assert.equal(run([
    "checkpoint", "save", "--project", project, "--input", checkpointInput,
  ], { env }).status, 0);

  const finalized = run([
    "pause", "finalize", "--project", project, "--task-id", "finalize-cli-task",
    "--input", finalInput,
  ], { env });

  assert.equal(finalized.status, 0, finalized.stderr);
  const output = JSON.parse(finalized.stdout);
  assert.equal(output.resume_mode, "MANUAL");
  assert.equal(output.notification.reason, "DISABLED");
});

test("notify command succeeds as a disabled optional feature", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-notify-cli-"));
  const input = path.join(root, "event.json");
  await writeFile(input, JSON.stringify({ project: "demo", task: "Task 24" }));
  const result = run(["notify", "TASK_STARTED", "--input", input], {
    env: { CODEX_DISCORD_WEBHOOK_URL: "" },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { sent: false, reason: "DISABLED" });
});

test("doctor command reports a healthy deterministic preflight", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-doctor-cli-"));
  const project = path.join(root, "project");
  execFileSync("git", ["init", "-q", project]);

  const result = run(["doctor", "--project", project], {
    env: { TASK_GUARD_TEST_DOCTOR: "healthy" },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.checks.find(({ id }) => id === "codex_cli").status, "ok");
  assert.equal(output.checks.find(({ id }) => id === "checkpoint_path").status, "ok");
});

test("phase lifecycle records history and budget evaluate selects a measured phase", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-phase-cli-"));
  const project = path.join(root, "project");
  const home = path.join(root, "global");
  const phaseInput = path.join(root, "phase.json");
  const budgetInput = path.join(root, "budget.json");
  execFileSync("git", ["init", "-q", project]);
  await writeFile(phaseInput, JSON.stringify({
    task_id: "phase-cli-task",
    phase_id: "implementation",
    phase_type: "implementation",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    plan: "plus",
  }));
  const commonEnv = { TASK_GUARD_HOME: home };

  const started = run([
    "phase", "start", "--project", project, "--input", phaseInput,
  ], { env: { ...commonEnv, TASK_GUARD_TEST_QUOTA: "healthy" } });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).quota_before, 80);

  const completed = run([
    "phase", "complete", "--project", project,
    "--phase-id", "implementation", "--concurrent-usage", "false",
  ], { env: { ...commonEnv, TASK_GUARD_TEST_QUOTA: "low" } });
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).quota_delta, 75);

  const history = run(["history", "list"], { env: commonEnv });
  assert.equal(history.status, 0, history.stderr);
  const historyRecords = JSON.parse(history.stdout);
  assert.equal(historyRecords.length, 1);
  assert.equal(historyRecords[0].plan, "plus");
  assert.equal(historyRecords[0].confidence, "high");
  assert.equal(historyRecords[0].model, "gpt-5.6-sol");
  assert.equal(historyRecords[0].reasoning_effort, "high");
  assert.equal(historyRecords[0].phase_type, "implementation");
  assert.equal(historyRecords[0].reset_during_phase, false);

  await writeFile(budgetInput, JSON.stringify({
    safety_reserve_percent: 5,
    phases: [{
      phase_id: "implementation-next",
      phase_type: "implementation",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      plan: "plus",
      dependencies_met: true,
    }],
  }));
  const budget = run([
    "budget", "evaluate", "--input", budgetInput,
  ], { env: { ...commonEnv, TASK_GUARD_TEST_QUOTA: "healthy" } });
  assert.equal(budget.status, 0, budget.stderr);
  assert.equal(
    JSON.parse(budget.stdout).selected_phase_id,
    "implementation-next",
    budget.stdout,
  );
});

test("phase prepare CLI atomically selects and starts a phase with one snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-phase-prepare-cli-"));
  const project = path.join(root, "project");
  const home = path.join(root, "global");
  const input = path.join(root, "phase-prepare.json");
  execFileSync("git", ["init", "-q", project]);
  await mkdir(home);
  await writeFile(path.join(home, "usage-history.jsonl"), `${JSON.stringify({
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    phase_type: "implementation",
    plan: "plus",
    quota_delta: 7,
    measurement_confidence: "HIGH_CONFIDENCE",
    reset_occurred: false,
  })}\n`);
  await writeFile(input, JSON.stringify({
    safety_reserve_percent: 5,
    phases: [{
      task_id: "phase-prepare-cli-task",
      phase_id: "implementation",
      phase_type: "implementation",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      plan: "plus",
      dependencies_met: true,
    }],
  }));

  const prepared = run([
    "phase", "prepare", "--project", project, "--input", input,
  ], {
    env: { TASK_GUARD_HOME: home, TASK_GUARD_TEST_QUOTA: "healthy" },
  });

  assert.equal(prepared.status, 0, prepared.stderr);
  const output = JSON.parse(prepared.stdout);
  assert.equal(output.decision.selected_phase_id, "implementation");
  assert.equal(output.snapshot.snapshot_id, output.decision.quota_snapshot_id);
  assert.equal(output.snapshot.snapshot_id, output.phase_start.quota_before_snapshot_id);
});

test("pause prepare persists one refreshed snapshot for resume scheduling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-pause-cli-"));
  const project = path.join(root, "project");
  const home = path.join(root, "global");
  const input = path.join(root, "pause.json");
  execFileSync("git", ["init", "-q", project]);
  await writeFile(input, JSON.stringify({
    checkpoint: {
      task_id: "pause-cli-task",
      task_description: "Pause with one quota snapshot",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Resume tests"],
    },
    notification: {
      project: "demo",
      task: "Pause with one quota snapshot",
      reason: "Quota low",
      checkpoint: "Saved",
      status: "Waiting for quota reset",
    },
  }));

  const prepared = run([
    "pause", "prepare", "--project", project, "--input", input,
  ], {
    env: {
      TASK_GUARD_HOME: home,
      TASK_GUARD_TEST_QUOTA: "low",
      TASK_GUARD_NOTIFICATION_ENABLED: "false",
    },
  });

  assert.equal(prepared.status, 0, prepared.stderr);
  const output = JSON.parse(prepared.stdout);
  assert.equal(output.snapshot.freshness, "AUTHORITATIVE");
  assert.equal(output.snapshot.snapshot_id, output.automation_schedule.quota_snapshot_id);
  assert.equal(output.snapshot.five_hour.reset_at, output.automation_schedule.resume_after);
  assert.equal(output.notification, null);
  assert.equal(output.automation_intent.kind, "heartbeat");
  assert.equal(output.automation_intent.destination, "thread");
});

test("resume prepare CLI reuses one snapshot after confirmed heartbeat cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-resume-cli-"));
  const project = path.join(root, "project");
  const home = path.join(root, "global");
  const checkpointInput = path.join(root, "checkpoint.json");
  const resumeInput = path.join(root, "resume.json");
  execFileSync("git", ["init", "-q", project]);
  await writeFile(checkpointInput, JSON.stringify({
    task_id: "resume-cli-task",
    task_description: "Resume through one lifecycle command",
    status: "PAUSED_FOR_QUOTA",
    heartbeat_automation_id: "automation-123",
    exact_next_actions: ["Continue CLI integration tests"],
  }));
  await writeFile(resumeInput, JSON.stringify({
    heartbeat_cleanup_confirmed: true,
    notification: {
      project: "demo",
      task: "Resume through one lifecycle command",
      checkpoint: "Verified",
      repository: "No external changes",
      status: "Working",
    },
  }));
  const commonEnv = {
    TASK_GUARD_HOME: home,
    TASK_GUARD_TEST_QUOTA: "healthy",
    TASK_GUARD_NOTIFICATION_ENABLED: "false",
  };
  const saved = run([
    "checkpoint", "save", "--project", project, "--input", checkpointInput,
  ], { env: commonEnv });
  assert.equal(saved.status, 0, saved.stderr);

  const prepared = run([
    "resume", "prepare", "--project", project,
    "--task-id", "resume-cli-task", "--input", resumeInput,
  ], { env: commonEnv });

  assert.equal(prepared.status, 0, prepared.stderr);
  const output = JSON.parse(prepared.stdout);
  assert.equal(output.status, "TASK_RESUMED");
  assert.equal(output.snapshot.snapshot_id, output.resume.quota_snapshot_id);
  assert.equal(output.heartbeat_cleanup.completed, true);
  assert.equal(output.notification.sent, false);
});
