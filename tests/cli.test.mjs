import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
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
      resume: "Same-thread automation scheduled",
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
  assert.equal(output.notification.sent, false);
});
