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
