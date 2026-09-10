import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditRegistry,
  completeTask,
  listRegistry,
  patchCheckpointResumeAutomation,
  readCheckpoint,
  repairCheckpointRegistry,
  resumeTask,
  saveCheckpoint,
  setCheckpointHeartbeat,
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
  assert.equal(restored.repository.project_path, await realpath(projectPath));
});

test("save normalizes legacy task status casing before persistence", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-status-normalization",
      task_description: "Normalize task status",
      status: "paused_for_quota",
      exact_next_actions: ["Resume after reset"],
    },
  });

  assert.equal((await readCheckpoint(saved.checkpoint_path)).status, "PAUSED_FOR_QUOTA");
});

test("save rejects status values outside the durable task contract", async () => {
  const { projectPath, taskGuardHome } = await createProject();

  await assert.rejects(
    saveCheckpoint({
      projectPath,
      taskGuardHome,
      state: {
        task_id: "task-invalid-status",
        task_description: "Reject an invalid task status",
        status: "BLOCKED",
        exact_next_actions: ["Use a supported task status"],
      },
    }),
    /Invalid task status/,
  );
});

test("save rejects fields outside the durable checkpoint schema", async () => {
  const { projectPath, taskGuardHome } = await createProject();

  await assert.rejects(
    saveCheckpoint({
      projectPath,
      taskGuardHome,
      state: {
        task_id: "task-unknown-field",
        task_description: "Reject an undocumented checkpoint field",
        status: "PAUSED_FOR_QUOTA",
        exact_next_actions: ["Use documented checkpoint fields"],
        notes: ["This field is not part of the durable schema"],
      },
    }),
    /Unsupported checkpoint state field: notes/,
  );
});

test("save reports recoverable success when the derived registry write fails", async () => {
  const { projectPath, taskGuardHome } = await createProject();

  const result = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-save-recovery",
      task_description: "Keep the checkpoint authoritative",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Repair the registry"],
    },
    registryWriter: async () => {
      throw new Error("fault injection");
    },
  });

  assert.equal(result.checkpoint_updated, true);
  assert.equal(result.registry_updated, false);
  assert.equal(result.recovery_required, true);
  assert.equal(result.error.code, "REGISTRY_UPDATE_FAILED");
  assert.equal((await readCheckpoint(result.checkpoint_path)).task_id, "task-save-recovery");
});

test("save remains authoritative when the derived registry cannot be read", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-save-read-recovery",
      task_description: "Initial checkpoint state",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Replace this action"],
    },
  });
  await writeFile(path.join(taskGuardHome, "index.json"), "{corrupted}\n");

  const result = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-save-read-recovery",
      task_description: "Updated checkpoint state",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Repair the registry"],
    },
  });

  assert.equal(result.checkpoint_updated, true);
  assert.equal(result.registry_updated, false);
  assert.equal(result.recovery_required, true);
  assert.equal(result.error.code, "REGISTRY_UPDATE_FAILED");
  assert.equal((await readCheckpoint(saved.checkpoint_path)).task_description,
    "Updated checkpoint state");
});

test("generic checkpoint save rejects transient automation evidence", async () => {
  const { projectPath, taskGuardHome } = await createProject();

  await assert.rejects(
    saveCheckpoint({
      projectPath,
      taskGuardHome,
      state: {
        task_id: "task-raw-evidence",
        task_description: "Keep raw evidence transient",
        status: "PAUSED_FOR_QUOTA",
        exact_next_actions: ["Use the automation verifier"],
        diagnostics: {
          automation_transcript: { operations: [{ private: "do-not-store" }] },
        },
      },
    }),
    /Checkpoint state contains forbidden key: diagnostics\.automation_transcript/,
  );
});

test("generic checkpoint save recursively rejects credential-like fields", async () => {
  const { projectPath, taskGuardHome } = await createProject();

  for (const [key, expectedPath] of [
    ["accessToken", /context\.0\.integration\.accessToken/],
    ["discord_webhook", /context\.0\.integration\.discord_webhook/],
  ]) {
    await assert.rejects(
      saveCheckpoint({
        projectPath,
        taskGuardHome,
        state: {
          task_id: "task-secret-field",
          task_description: "Reject credential-like checkpoint fields",
          status: "PAUSED_FOR_QUOTA",
          exact_next_actions: ["Remove credential material"],
          context: [{ integration: { [key]: "do-not-store" } }],
        },
      }),
      expectedPath,
    );
  }
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

test("completion reports stale derived metadata and retries idempotently", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-complete-recovery",
      task_description: "Recover stale completion metadata",
      status: "WORKING",
      exact_next_actions: ["Prune the registry"],
    },
  });

  const partial = await completeTask({
    projectPath,
    taskGuardHome,
    taskId: "task-complete-recovery",
    registryWriter: async () => {
      throw new Error("fault injection");
    },
  });

  assert.equal(partial.checkpoint_removed, true);
  assert.equal(partial.registry_updated, false);
  assert.equal(partial.recovery_required, true);
  assert.equal(partial.recovery_action, "REGISTRY_PRUNE");
  await assert.rejects(readCheckpoint(saved.checkpoint_path), { code: "ENOENT" });
  assert.equal(Object.keys((await listRegistry({ taskGuardHome })).tasks).length, 1);

  const retried = await completeTask({
    projectPath,
    taskGuardHome,
    taskId: "task-complete-recovery",
  });
  assert.equal(retried.checkpoint_removed, false);
  assert.equal(retried.registry_updated, true);
  assert.equal(retried.recovery_required, false);
  assert.deepEqual((await listRegistry({ taskGuardHome })).tasks, {});
});

test("completion reports recoverable success when the registry cannot be read", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-complete-read-recovery",
      task_description: "Complete despite corrupt derived metadata",
      status: "WORKING",
      exact_next_actions: ["Repair the registry"],
    },
  });
  await writeFile(path.join(taskGuardHome, "index.json"), "{corrupted}\n");

  const result = await completeTask({
    projectPath,
    taskGuardHome,
    taskId: "task-complete-read-recovery",
  });

  assert.equal(result.checkpoint_removed, true);
  assert.equal(result.registry_updated, false);
  assert.equal(result.recovery_required, true);
  assert.equal(result.recovery_action, "REGISTRY_PRUNE");
  await assert.rejects(readCheckpoint(saved.checkpoint_path), { code: "ENOENT" });
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

  const result = await resumeTask({
    projectPath,
    taskGuardHome,
    taskId: "task-resume",
    repositoryVerification: await verifyCheckpoint(saved.checkpoint_path),
    heartbeatCleanupConfirmed: true,
  });
  const checkpoint = await readCheckpoint(saved.checkpoint_path);
  const [registryEntry] = Object.values((await listRegistry({ taskGuardHome })).tasks);
  assert.equal(checkpoint.status, "WORKING");
  assert.equal(typeof checkpoint.resumed_at, "string");
  assert.equal(registryEntry.status, "working");
  assert.equal(registryEntry.resume_after, null);
  assert.equal(result.heartbeat_automation_id, "automation-123");
  assert.equal(checkpoint.heartbeat_automation_id, undefined);
});

test("direct checkpoint resume rejects unverified repository and heartbeat cleanup", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-unsafe-resume",
      task_description: "Reject an unsafe low-level resume",
      status: "PAUSED_FOR_QUOTA",
      heartbeat_automation_id: "automation-unresolved",
      exact_next_actions: ["Resume through the lifecycle"],
    },
  });

  await assert.rejects(
    resumeTask({ projectPath, taskGuardHome, taskId: "task-unsafe-resume" }),
    /Repository verification is required/,
  );

  const checkpoint = await readCheckpoint(saved.checkpoint_path);
  assert.equal(checkpoint.status, "PAUSED_FOR_QUOTA");
  assert.equal(checkpoint.heartbeat_automation_id, "automation-unresolved");
});

test("verified automation cannot become executed without cleanup confirmation", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-cleanup-proof",
      task_description: "Require external cleanup proof",
      status: "PAUSED_FOR_QUOTA",
      resume_automation: {
        purpose: "quota_resume",
        status: "VERIFIED",
        automation_id: "automation-cleanup-proof",
        cleanup_required: true,
      },
      exact_next_actions: ["Confirm cleanup before resume"],
    },
  });

  await assert.rejects(
    resumeTask({
      projectPath,
      taskGuardHome,
      taskId: "task-cleanup-proof",
      repositoryVerification: await verifyCheckpoint(saved.checkpoint_path),
    }),
    /Heartbeat cleanup confirmation is required/,
  );

  assert.equal((await readCheckpoint(saved.checkpoint_path)).resume_automation.status, "VERIFIED");
});

test("resume reports recoverable success when the derived registry write fails", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-resume-recovery",
      task_description: "Keep resumed state authoritative",
      status: "PAUSED_FOR_QUOTA",
      heartbeat_automation_id: "automation-cleaned",
      exact_next_actions: ["Repair the registry"],
    },
  });

  const result = await resumeTask({
    projectPath,
    taskGuardHome,
    taskId: "task-resume-recovery",
    repositoryVerification: await verifyCheckpoint(saved.checkpoint_path),
    heartbeatCleanupConfirmed: true,
    registryWriter: async () => {
      throw new Error("fault injection");
    },
  });

  const checkpoint = await readCheckpoint(saved.checkpoint_path);
  assert.equal(result.checkpoint_updated, true);
  assert.equal(result.registry_updated, false);
  assert.equal(result.recovery_required, true);
  assert.equal(result.error.code, "REGISTRY_UPDATE_FAILED");
  assert.equal(checkpoint.status, "WORKING");
  assert.equal(checkpoint.heartbeat_automation_id, undefined);
});

test("resume rebuilds a missing derived registry entry", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-resume-rebuild",
      task_description: "Rebuild derived resume metadata",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Continue safely"],
    },
  });
  await writeFile(
    path.join(taskGuardHome, "index.json"),
    `${JSON.stringify({ schema_version: 2, tasks: {} })}\n`,
  );

  const result = await resumeTask({
    projectPath,
    taskGuardHome,
    taskId: "task-resume-rebuild",
    repositoryVerification: await verifyCheckpoint(saved.checkpoint_path),
    heartbeatCleanupConfirmed: true,
  });

  const [entry] = Object.values((await listRegistry({ taskGuardHome })).tasks);
  assert.equal(result.registry_updated, true);
  assert.equal(entry.task_id, "task-resume-rebuild");
  assert.equal(entry.status, "working");
});

test("resume remains authoritative when the derived registry cannot be read", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-resume-read-recovery",
      task_description: "Keep resumed state authoritative",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Repair the registry"],
    },
  });
  const verification = await verifyCheckpoint(saved.checkpoint_path);
  await writeFile(path.join(taskGuardHome, "index.json"), "{corrupted}\n");

  const result = await resumeTask({
    projectPath,
    taskGuardHome,
    taskId: "task-resume-read-recovery",
    repositoryVerification: verification,
    heartbeatCleanupConfirmed: true,
  });

  assert.equal(result.checkpoint_updated, true);
  assert.equal(result.registry_updated, false);
  assert.equal(result.recovery_required, true);
  assert.equal((await readCheckpoint(saved.checkpoint_path)).status, "WORKING");
});

test("heartbeat patch preserves every existing pause field", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-heartbeat-patch",
      task_description: "Attach a heartbeat without rebuilding pause state",
      status: "PAUSED_FOR_QUOTA",
      quota_snapshot: {
        snapshot_id: "snapshot-A",
        observed_at: "2026-08-31T12:24:00.000Z",
        freshness: "AUTHORITATIVE",
        five_hour: { available: true, remaining_percent: 6 },
      },
      resume_after: "2026-08-31T16:32:00.000Z",
      exact_next_actions: ["Resume the exact implementation step"],
      thread_reference: "current",
      pause_reason: "Quota exhausted",
    },
  });
  const before = await readCheckpoint(saved.checkpoint_path);

  const result = await setCheckpointHeartbeat({
    projectPath,
    taskGuardHome,
    taskId: "task-heartbeat-patch",
    automationId: "automation-123",
  });

  const after = await readCheckpoint(saved.checkpoint_path);
  const expected = structuredClone(before);
  expected.heartbeat_automation_id = "automation-123";
  assert.deepEqual(after, expected);
  assert.equal(result.heartbeat_automation_id, "automation-123");
  const [registryEntry] = Object.values((await listRegistry({ taskGuardHome })).tasks);
  assert.equal(registryEntry.heartbeat_automation_id, "automation-123");
});

test("heartbeat patch rebuilds a missing derived registry entry", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-heartbeat-rebuild",
      task_description: "Rebuild derived heartbeat metadata",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Continue after registry recovery"],
    },
  });
  await writeFile(
    path.join(taskGuardHome, "index.json"),
    `${JSON.stringify({ schema_version: 2, tasks: {} })}\n`,
  );

  const result = await setCheckpointHeartbeat({
    projectPath,
    taskGuardHome,
    taskId: "task-heartbeat-rebuild",
    automationId: "automation-rebuilt",
  });

  const [entry] = Object.values((await listRegistry({ taskGuardHome })).tasks);
  assert.equal(result.registry_updated, true);
  assert.equal(entry.task_id, "task-heartbeat-rebuild");
  assert.equal(entry.status, "paused_for_quota");
  assert.equal(entry.heartbeat_automation_id, "automation-rebuilt");
});

test("heartbeat patch reports a recoverable registry partial write", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-heartbeat-recovery",
      task_description: "Recover derived registry state",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Repair the registry"],
    },
  });

  const result = await setCheckpointHeartbeat({
    projectPath,
    taskGuardHome,
    taskId: "task-heartbeat-recovery",
    automationId: "automation-recovery",
    registryWriter: async () => {
      throw new Error("fault injection");
    },
  });

  assert.equal(result.checkpoint_updated, true);
  assert.equal(result.registry_updated, false);
  assert.equal(result.recovery_required, true);
  assert.equal(result.error.code, "REGISTRY_UPDATE_FAILED");
  assert.equal((await readCheckpoint(saved.checkpoint_path)).heartbeat_automation_id,
    "automation-recovery");
  assert.equal(Object.values((await listRegistry({ taskGuardHome })).tasks)[0]
    .heartbeat_automation_id, undefined);

  const repaired = await repairCheckpointRegistry({
    projectPath,
    taskGuardHome,
    taskId: "task-heartbeat-recovery",
  });
  assert.equal(repaired.registry_updated, true);
  assert.equal(Object.values((await listRegistry({ taskGuardHome })).tasks)[0]
    .heartbeat_automation_id, "automation-recovery");
});

test("registry repair rebuilds the index when its JSON is corrupted", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-corrupt-registry-repair",
      task_description: "Rebuild a corrupted derived index",
      status: "PAUSED_FOR_QUOTA",
      heartbeat_automation_id: "automation-repair",
      exact_next_actions: ["Repair the registry"],
    },
  });
  await writeFile(path.join(taskGuardHome, "index.json"), "{corrupted}\n");

  const repaired = await repairCheckpointRegistry({
    projectPath,
    taskGuardHome,
    taskId: "task-corrupt-registry-repair",
  });

  const [entry] = Object.values((await listRegistry({ taskGuardHome })).tasks);
  assert.equal(repaired.registry_updated, true);
  assert.equal(entry.task_id, "task-corrupt-registry-repair");
  assert.equal(entry.heartbeat_automation_id, "automation-repair");
});

test("heartbeat patch remains authoritative when the derived registry cannot be read", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-heartbeat-read-recovery",
      task_description: "Keep heartbeat state authoritative",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Repair the registry"],
    },
  });
  await writeFile(path.join(taskGuardHome, "index.json"), "{corrupted}\n");

  const result = await setCheckpointHeartbeat({
    projectPath,
    taskGuardHome,
    taskId: "task-heartbeat-read-recovery",
    automationId: "automation-read-recovery",
  });

  assert.equal(result.checkpoint_updated, true);
  assert.equal(result.registry_updated, false);
  assert.equal(result.recovery_required, true);
  assert.equal((await readCheckpoint(saved.checkpoint_path)).heartbeat_automation_id,
    "automation-read-recovery");
});

test("resume automation narrow patch preserves authoritative pause state and drops private fields", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-automation-state",
      task_description: "Verify resume automation persistence",
      status: "PAUSED_FOR_QUOTA",
      quota_snapshot: {
        snapshot_id: "snapshot-A",
        observed_at: "2026-08-31T12:24:00.000Z",
        freshness: "AUTHORITATIVE",
      },
      resume_after: "2026-08-31T17:32:11.000Z",
      exact_next_actions: ["Continue exact action"],
      thread_reference: "thread-123",
      resume_mode: "AUTOMATION_ELIGIBLE",
      resume_automation: {
        purpose: "quota_resume",
        status: "ELIGIBLE",
        automation_id: null,
        attempts: 0,
        target_thread: "thread-123",
        resume_after: "2026-08-31T17:32:11.000Z",
        snapshot_id: "snapshot-A",
        automation_fingerprint: "fingerprint-1",
      },
    },
  });
  const before = await readCheckpoint(saved.checkpoint_path);

  await patchCheckpointResumeAutomation({
    projectPath,
    taskGuardHome,
    taskId: "task-automation-state",
    allowVerified: true,
    resumeAutomation: {
      purpose: "quota_resume",
      status: "VERIFIED",
      automation_id: "automation-123",
      attempts: 1,
      verified_at: "2026-08-31T13:00:00.000Z",
      target_thread: "thread-123",
      resume_after: "2026-08-31T17:32:11.000Z",
      snapshot_id: "snapshot-A",
      automation_fingerprint: "fingerprint-1",
      verification_source: "READBACK",
      verification: {
        persisted: true,
        id_match: true,
        identity_match: true,
        kind_match: true,
        thread_match: true,
        schedule_match: true,
        status_active: true,
        prompt_match: true,
      },
      prompt: "must not be persisted",
      raw_tool_response: { secret: "must not be persisted" },
    },
  });

  const after = await readCheckpoint(saved.checkpoint_path);
  const preserved = structuredClone(after);
  const expectedPreserved = structuredClone(before);
  delete preserved.resume_automation;
  delete preserved.resume_mode;
  delete preserved.heartbeat_automation_id;
  delete expectedPreserved.resume_automation;
  delete expectedPreserved.resume_mode;
  delete expectedPreserved.heartbeat_automation_id;
  assert.deepEqual(preserved, expectedPreserved);
  assert.equal(after.resume_mode, "AUTOMATION");
  assert.equal(after.heartbeat_automation_id, "automation-123");
  assert.equal(after.resume_automation.status, "VERIFIED");
  assert.equal("prompt" in after.resume_automation, false);
  assert.equal("raw_tool_response" in after.resume_automation, false);
  assert.equal(after.quota_snapshot.snapshot_id, "snapshot-A");
  assert.equal(after.resume_after, "2026-08-31T17:32:11.000Z");
  assert.deepEqual(after.exact_next_actions, ["Continue exact action"]);
  assert.equal(after.task_id, "task-automation-state");
  assert.equal(after.thread_reference, "thread-123");

  await assert.rejects(
    patchCheckpointResumeAutomation({
      projectPath,
      taskGuardHome,
      taskId: "task-automation-state",
      resumeAutomation: {
        purpose: "quota_resume",
        status: "FAILED",
        automation_id: null,
        attempts: 1,
        last_error: "LATE_REWRITE",
        resolution: "MANUAL_FALLBACK",
      },
    }),
    /terminal automation state/i,
  );
});

test("resume automation patch rebuilds a missing derived registry entry", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-automation-rebuild",
      task_description: "Rebuild derived automation metadata",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Resume manually"],
      thread_reference: "thread-rebuild",
    },
  });
  await writeFile(
    path.join(taskGuardHome, "index.json"),
    `${JSON.stringify({ schema_version: 2, tasks: {} })}\n`,
  );

  const result = await patchCheckpointResumeAutomation({
    projectPath,
    taskGuardHome,
    taskId: "task-automation-rebuild",
    resumeAutomation: {
      purpose: "quota_resume",
      status: "FAILED",
      automation_id: null,
      attempts: 1,
      last_error: "NOT_FOUND",
      resolution: "MANUAL_FALLBACK",
    },
  });

  const [entry] = Object.values((await listRegistry({ taskGuardHome })).tasks);
  assert.equal(result.registry_updated, true);
  assert.equal(entry.task_id, "task-automation-rebuild");
  assert.equal(entry.resume_mode, "manual");
  assert.equal(entry.resume_automation_status, "failed");
});

test("verified checkpoint automation requires every read-back invariant", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-verified-invariants",
      task_description: "Reject incomplete verification",
      status: "PAUSED_FOR_QUOTA",
      quota_snapshot: { snapshot_id: "snapshot-invariants" },
      resume_after: "2026-08-31T17:32:11.000Z",
      exact_next_actions: ["Keep the checkpoint paused"],
      thread_reference: "thread-invariants",
      resume_automation: {
        purpose: "quota_resume",
        status: "ELIGIBLE",
        automation_fingerprint: "fingerprint-invariants",
      },
    },
  });
  const incomplete = {
    purpose: "quota_resume",
    status: "VERIFIED",
    automation_id: "automation-invariants",
    attempts: 1,
    verified_at: "2026-08-31T13:00:00.000Z",
    verification_source: "READBACK",
    target_thread: "thread-invariants",
    resume_after: "2026-08-31T17:32:11.000Z",
    snapshot_id: "snapshot-invariants",
    automation_fingerprint: "fingerprint-invariants",
    verification: {
      persisted: true,
      identity_match: true,
      kind_match: true,
      thread_match: true,
      schedule_match: true,
      status_active: true,
    },
  };

  await assert.rejects(
    patchCheckpointResumeAutomation({
      projectPath,
      taskGuardHome,
      taskId: "task-verified-invariants",
      resumeAutomation: incomplete,
      allowVerified: true,
    }),
    /read-back verification/i,
  );
});

test("resume automation patch keeps checkpoint authoritative on registry failure", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-automation-recovery",
      task_description: "Recover automation registry metadata",
      status: "PAUSED_FOR_QUOTA",
      quota_snapshot: { snapshot_id: "snapshot-recovery" },
      resume_after: "2026-08-31T17:32:11.000Z",
      exact_next_actions: ["Repair derived metadata"],
      thread_reference: "thread-recovery",
    },
  });

  const result = await patchCheckpointResumeAutomation({
    projectPath,
    taskGuardHome,
    taskId: "task-automation-recovery",
    resumeAutomation: {
      purpose: "quota_resume",
      status: "FAILED",
      automation_id: null,
      attempts: 1,
      target_thread: "thread-recovery",
      resume_after: "2026-08-31T17:32:11.000Z",
      snapshot_id: "snapshot-recovery",
      last_error: "NOT_FOUND",
      resolution: "MANUAL_FALLBACK",
    },
    registryWriter: async () => {
      throw new Error("fault injection");
    },
  });

  assert.equal(result.checkpoint_updated, true);
  assert.equal(result.registry_updated, false);
  assert.equal(result.recovery_required, true);
  assert.equal((await readCheckpoint(saved.checkpoint_path)).resume_automation.status, "FAILED");

  await repairCheckpointRegistry({
    projectPath,
    taskGuardHome,
    taskId: "task-automation-recovery",
  });
  const entry = Object.values((await listRegistry({ taskGuardHome })).tasks)[0];
  assert.equal(entry.resume_mode, "manual");
  assert.equal(entry.resume_automation_status, "failed");
});

test("resume automation patch remains authoritative when the registry cannot be read", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const saved = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-automation-read-recovery",
      task_description: "Keep automation state authoritative",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Repair derived metadata"],
    },
  });
  await writeFile(path.join(taskGuardHome, "index.json"), "{corrupted}\n");

  const result = await patchCheckpointResumeAutomation({
    projectPath,
    taskGuardHome,
    taskId: "task-automation-read-recovery",
    resumeAutomation: {
      purpose: "quota_resume",
      status: "FAILED",
      automation_id: null,
      attempts: 1,
      last_error: "NOT_FOUND",
      resolution: "MANUAL_FALLBACK",
    },
  });

  assert.equal(result.checkpoint_updated, true);
  assert.equal(result.registry_updated, false);
  assert.equal(result.recovery_required, true);
  assert.equal((await readCheckpoint(saved.checkpoint_path)).resume_automation.status, "FAILED");
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

test("rejects a second active task in the same repository without overwriting the first", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const first = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-first",
      task_description: "Keep the first task active",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Resume the first task"],
    },
  });

  await assert.rejects(
    saveCheckpoint({
      projectPath,
      taskGuardHome,
      state: {
        task_id: "task-second",
        task_description: "Do not overwrite the first task",
        status: "PAUSED_FOR_QUOTA",
        exact_next_actions: ["Resume the second task"],
      },
    }),
    /ACTIVE_CHECKPOINT_EXISTS.*task-first/,
  );

  assert.equal((await readCheckpoint(first.checkpoint_path)).task_id, "task-first");
  assert.equal(Object.keys((await listRegistry({ taskGuardHome })).tasks).length, 1);

  await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-first",
      task_description: "Keep the first task active",
      status: "PAUSED_FOR_QUOTA",
      heartbeat_automation_id: "heartbeat-1",
      exact_next_actions: ["Resume the first task"],
    },
  });
  assert.equal(
    (await readCheckpoint(first.checkpoint_path)).heartbeat_automation_id,
    "heartbeat-1",
  );
});

test("rejects a second active task even when the global registry entry is missing", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const first = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-file-owner",
      task_description: "Preserve checkpoint ownership",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Resume the owner"],
    },
  });
  await rm(path.join(taskGuardHome, "index.json"));

  await assert.rejects(
    saveCheckpoint({
      projectPath,
      taskGuardHome,
      state: {
        task_id: "task-file-contender",
        task_description: "Do not replace an orphaned active checkpoint",
        status: "PAUSED_FOR_QUOTA",
        exact_next_actions: ["Continue"],
      },
    }),
    /ACTIVE_CHECKPOINT_EXISTS.*task-file-owner/,
  );

  assert.equal((await readCheckpoint(first.checkpoint_path)).task_id, "task-file-owner");
});

test("replaces a stale registry entry when its checkpoint file is missing", async () => {
  const { projectPath, taskGuardHome } = await createProject();
  const first = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-stale-owner",
      task_description: "Lose the old checkpoint",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Resume"],
    },
  });
  await rm(first.checkpoint_path);

  const second = await saveCheckpoint({
    projectPath,
    taskGuardHome,
    state: {
      task_id: "task-replacement",
      task_description: "Replace stale ownership",
      status: "PAUSED_FOR_QUOTA",
      exact_next_actions: ["Continue"],
    },
  });

  assert.equal((await readCheckpoint(second.checkpoint_path)).task_id, "task-replacement");
  const entries = Object.values((await listRegistry({ taskGuardHome })).tasks);
  assert.deepEqual(entries.map(({ task_id }) => task_id), ["task-replacement"]);
});
