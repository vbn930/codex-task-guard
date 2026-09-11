import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("scripts", "task-guard.mjs");
const provider = path.resolve("tests", "fixtures", "deterministic-phase-provider.mjs");

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    windowsHide: true,
  });
}

test("phase generate emits a provider graph accepted by native phase prepare", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-semantic-cli-"));
  const project = path.join(root, "project");
  const home = path.join(root, "task-guard-home");
  const requestPath = path.join(root, "request.json");
  const planPath = path.join(root, "plan.json");
  execFileSync("git", ["init", "-q", project]);
  await writeFile(requestPath, JSON.stringify({
    task_id: "semantic-cli-task",
    task_description: "Add semantic phase generation through a provider.",
    safety_reserve_percent: 10,
  }));

  const generated = run([
    "phase", "generate", "--provider", provider, "--input", requestPath,
  ]);
  assert.equal(generated.status, 0, generated.stderr);
  const plan = JSON.parse(generated.stdout);
  assert.equal(plan.safety_reserve_percent, 10);
  assert.equal(plan.generation.provider_id, "deterministic-test-provider");
  assert.deepEqual(plan.phases.map(({ phase_id: id, depends_on: dependencies }) => (
    [id, dependencies]
  )), [
    ["implementation", []],
    ["verification", ["implementation"]],
  ]);

  await writeFile(planPath, generated.stdout);
  const prepared = run([
    "phase", "prepare", "--project", project, "--input", planPath,
  ], {
    env: {
      TASK_GUARD_HOME: home,
      TASK_GUARD_TEST_QUOTA: "healthy",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
    },
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const preparedOutput = JSON.parse(prepared.stdout);
  assert.deepEqual(preparedOutput.plan.phases, plan.phases);
  assert.deepEqual(preparedOutput.decision.ready_phase_ids, ["implementation"]);
});

test("phase prepare generates and persists a provider plan in one command", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-semantic-prepare-cli-"));
  const project = path.join(root, "project");
  const home = path.join(root, "task-guard-home");
  const requestPath = path.join(root, "request.json");
  execFileSync("git", ["init", "-q", project]);
  await writeFile(requestPath, JSON.stringify({
    task_id: "semantic-prepare-task",
    task_description: "Add semantic phase generation through a provider.",
    safety_reserve_percent: 10,
  }));

  const prepared = run([
    "phase", "prepare", "--provider", provider,
    "--project", project, "--input", requestPath,
  ], {
    env: {
      TASK_GUARD_HOME: home,
      TASK_GUARD_TEST_QUOTA: "healthy",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
    },
  });

  assert.equal(prepared.status, 0, prepared.stderr);
  const output = JSON.parse(prepared.stdout);
  assert.deepEqual(output.plan.generation, {
    mode: "provider",
    provider_id: "deterministic-test-provider",
    contract_version: 1,
  });
  assert.deepEqual(output.decision.ready_phase_ids, ["implementation"]);
});

test("phase prepare rejects provider and explicit phase inputs together", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-ambiguous-prepare-cli-"));
  const project = path.join(root, "project");
  const requestPath = path.join(root, "request.json");
  execFileSync("git", ["init", "-q", project]);
  await writeFile(requestPath, JSON.stringify({
    task_id: "ambiguous-semantic-task",
    task_description: "Add semantic phase generation through a provider.",
    safety_reserve_percent: 10,
    phases: [{
      task_id: "ambiguous-semantic-task",
      phase_id: "caller-phase",
      phase_type: "implementation",
      depends_on: [],
    }],
  }));

  const prepared = run([
    "phase", "prepare", "--provider", provider,
    "--project", project, "--input", requestPath,
  ], {
    env: { TASK_GUARD_TEST_QUOTA: "healthy" },
  });

  assert.equal(prepared.status, 2);
  assert.match(
    JSON.parse(prepared.stdout).error.message,
    /--provider cannot be combined with phases or generation/,
  );
});
