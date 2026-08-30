import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditRegistry,
  completeTask,
  listRegistry,
  readCheckpoint,
  resumeTask,
  saveCheckpoint,
  verifyCheckpoint,
} from "../scripts/lib/checkpoint.mjs";

async function createProject() {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-checkpoint-"));
  const projectPath = path.join(root, "project");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", projectPath]);
  await writeFile(path.join(projectPath, "work.txt"), "initial\n");
  return { projectPath, taskGuardHome };
}

test("saves a readable project checkpoint and minimal global registry entry", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-24",
      task_description: "Implement Discord integration",
      status: "PAUSED_FOR_QUOTA",
      completed: ["Webhook config loader implemented"],
      current_state: ["Resume notification is not connected"],
      decisions: ["Read the webhook only from the environment"],
      tests: [{ command: "npm test", result: "passed" }],
      known_issues: [],
      remaining_work: ["Connect the resume event"],
      exact_next_actions: ["Run the integration test"],
      quota: { five_hour: { available: true, remaining_percent: 5 } },
      resume_after: "2026-08-31T12:00:00.000Z",
      thread_reference: "current",
    },
  });

  const markdown = await readFile(saved.checkpoint_path, "utf8");
  assert.match(markdown, /# Task Guard Checkpoint/);
  assert.match(markdown, /Status: PAUSED_FOR_QUOTA/);
  assert.match(markdown, /Run the integration test/);

  const registry = await listRegistry({ taskGuardHome });
  const entries = Object.values(registry.tasks);
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0]).sort(), [
    "checkpoint_path",
    "project_path",
    "resume_after",
    "status",
    "task_id",
    "thread_reference",
    "updated_at",
  ]);

  const restored = await readCheckpoint(saved.checkpoint_path);
  assert.equal(restored.task_id, "task-24");
  assert.equal(restored.repository.project_path, projectPath);
});

test("detects repository changes made after the checkpoint", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-change",
      task_description: "Detect changes",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Continue"],
    },
  });

  assert.equal((await verifyCheckpoint(saved.checkpoint_path)).matches, true);
  await writeFile(path.join(projectPath, "work.txt"), "changed\n");
  const verification = await verifyCheckpoint(saved.checkpoint_path);
  assert.equal(verification.matches, false);
  assert.equal(verification.reason, "REPOSITORY_STATE_CHANGED");
});

test("completion removes the active checkpoint and registry entry", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-done",
      task_description: "Finish task",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Complete"],
    },
  });

  const result = await completeTask({
    projectPath,
    taskGuardHome,
    taskId: "task-done",
  });
  assert.equal(result.checkpoint_removed, true);
  assert.deepEqual((await listRegistry({ taskGuardHome })).tasks, {});
});

test("registry audit marks a missing project checkpoint as stale", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-stale",
      task_description: "Find stale checkpoints",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Restore or remove the registry entry"],
    },
  });
  await rm(saved.checkpoint_path);

  const audit = await auditRegistry({ taskGuardHome });
  const [entry] = Object.values(audit.tasks);
  assert.equal(entry.stale, true);
  assert.equal(entry.stale_reason, "CHECKPOINT_MISSING");
});

test("checkpoint remains valid immediately after saving in a linked worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-worktree-"));
  const repositoryPath = path.join(root, "repository");
  const projectPath = path.join(root, "worktree");
  const taskGuardHome = path.join(root, "global");
  execFileSync("git", ["init", "-q", repositoryPath]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.name", "Task Guard Test"]);
  await writeFile(path.join(repositoryPath, "tracked.txt"), "initial\n");
  execFileSync("git", ["-C", repositoryPath, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-qm", "initial"]);
  execFileSync("git", ["-C", repositoryPath, "worktree", "add", "-q", projectPath, "-b", "test-worktree"]);

  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-worktree",
      task_description: "Pause inside a linked worktree",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Continue in this worktree"],
    },
  });

  assert.equal((await verifyCheckpoint(saved.checkpoint_path)).matches, true);
});

test("concurrent checkpoint saves retain every registry entry", async () => {
  const taskGuardHome = await mkdtemp(path.join(tmpdir(), "task-guard-registry-"));
  const projects = await Promise.all(Array.from({ length: 8 }, () => createProject()));

  await Promise.all(projects.map(({ projectPath }, index) => saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: `task-concurrent-${index}`,
      task_description: `Concurrent pause ${index}`,
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Continue"],
    },
  })));

  assert.equal(Object.keys((await listRegistry({ taskGuardHome })).tasks).length, projects.length);
});

test("saves and verifies a checkpoint with a diff larger than the Git output buffer", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  execFileSync("git", ["-C", projectPath, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", projectPath, "config", "user.name", "Task Guard Test"]);
  const largePath = path.join(projectPath, "large.txt");
  const largeSize = 18 * 1024 * 1024;
  await writeFile(largePath, `${"a".repeat(largeSize)}\n`);
  execFileSync("git", ["-C", projectPath, "add", "large.txt"]);
  execFileSync("git", ["-C", projectPath, "commit", "-qm", "large baseline"]);
  await writeFile(largePath, `${"b".repeat(largeSize)}\n`);

  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-large-diff",
      task_description: "Pause a large task",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Continue the large edit"],
    },
  });

  assert.equal((await verifyCheckpoint(saved.checkpoint_path)).matches, true);
});

test("round-trips checkpoint state containing the machine-state marker", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const exactAction = "Inspect TASK_GUARD_STATE_END --> before continuing";
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-marker",
      task_description: "Preserve arbitrary task text",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: [exactAction],
    },
  });

  assert.deepEqual((await readCheckpoint(saved.checkpoint_path)).exact_next_actions, [exactAction]);
});

test("does not follow an untracked symlink outside the repository", async (context) => {
  const { projectPath, taskGuardHome } = await createProject();
  const outsidePath = path.join(path.dirname(projectPath), "outside.txt");
  const linkPath = path.join(projectPath, "outside-link.txt");
  await writeFile(outsidePath, "outside version one\n");
  try {
    await symlink(outsidePath, linkPath, "file");
  } catch (error) {
    if (error.code === "EPERM") {
      context.skip("Creating symlinks requires Windows Developer Mode");
      return;
    }
    throw error;
  }

  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-symlink",
      task_description: "Keep repository hashing inside the repository",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Continue"],
    },
  });
  await writeFile(outsidePath, "outside version two\n");

  assert.equal((await verifyCheckpoint(saved.checkpoint_path)).matches, true);
});

test("resuming a checkpoint marks both checkpoint and registry as working", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-resume",
      task_description: "Resume in the same task",
      status: "PAUSED_FOR_QUOTA",
      resume_after: "2026-08-31T12:00:00.000Z",
      heartbeat_automation_id: "automation-123",
      exact_next_actions: ["Continue"],
    },
  });

  const result = await resumeTask({ projectPath, taskGuardHome, taskId: "task-resume" });
  const checkpoint = await readCheckpoint(saved.checkpoint_path);
  const [registryEntry] = Object.values((await listRegistry({ taskGuardHome })).tasks);
  assert.equal(checkpoint.status, "WORKING");
  assert.equal(typeof checkpoint.resumed_at, "string");
  assert.equal(registryEntry.status, "working");
  assert.equal(registryEntry.resume_after, null);
  assert.equal(result.heartbeat_automation_id, "automation-123");
});

test("reads checkpoints written with the original JSON machine-state format", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "task-guard-legacy-"));
  const checkpointPath = path.join(root, "checkpoint.md");
  const state = {
    task_id: "legacy-task",
    status: "PAUSED_FOR_QUOTA",
    exact_next_actions: ["Continue"],
  };
  await writeFile(
    checkpointPath,
    `# Legacy checkpoint\n\n<!-- TASK_GUARD_STATE_START\n${JSON.stringify(state, null, 2)}\nTASK_GUARD_STATE_END -->\n`,
  );

  assert.deepEqual(await readCheckpoint(checkpointPath), state);
});
