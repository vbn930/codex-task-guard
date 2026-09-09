import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteText, withFileLock } from "./fs-safe.mjs";
import { canonicalProjectIdentity } from "./repository-state.mjs";
import { defaultTaskGuardHome } from "./runtime-paths.mjs";

export function registryKey(projectPath, taskId) {
  const prefix = createHash("sha256")
    .update(canonicalProjectIdentity(projectPath))
    .digest("hex")
    .slice(0, 12);
  return `${prefix}:${taskId}`;
}

export function registryEntryFromCheckpoint({ state, root, checkpointPath, updatedAt }) {
  const entry = {
    task_id: state.task_id,
    project_path: root,
    checkpoint_path: checkpointPath,
    status: state.status.toLowerCase(),
    resume_after: state.resume_after ?? null,
    thread_reference: state.thread_reference ?? null,
    updated_at: updatedAt,
  };
  if (state.quota_snapshot) {
    entry.quota_snapshot_id = state.quota_snapshot.snapshot_id ?? null;
    entry.quota_observed_at = state.quota_snapshot.observed_at ?? null;
  }
  if (state.resume_automation) {
    entry.resume_mode = (state.resume_mode ?? "MANUAL").toLowerCase();
    entry.resume_automation_status = state.resume_automation.status.toLowerCase();
  }
  if (state.heartbeat_automation_id) {
    entry.heartbeat_automation_id = state.heartbeat_automation_id;
  }
  return entry;
}

export async function listRegistry({ taskGuardHome = defaultTaskGuardHome() } = {}) {
  const registryPath = path.join(taskGuardHome, "index.json");
  try {
    return JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { schema_version: 1, tasks: {} };
    throw error;
  }
}

export async function auditRegistry({ taskGuardHome = defaultTaskGuardHome() } = {}) {
  const registry = await listRegistry({ taskGuardHome });
  const audited = { ...registry, tasks: {} };
  for (const [key, entry] of Object.entries(registry.tasks)) {
    try {
      await access(entry.checkpoint_path);
      audited.tasks[key] = { ...entry, stale: false, stale_reason: null };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      audited.tasks[key] = { ...entry, stale: true, stale_reason: "CHECKPOINT_MISSING" };
    }
  }
  return audited;
}

export async function writeRegistry(taskGuardHome, registry) {
  const current = { ...registry, schema_version: 2 };
  await atomicWriteText(path.join(taskGuardHome, "index.json"), `${JSON.stringify(current, null, 2)}\n`);
}

export async function updateDerivedRegistry({
  taskGuardHome,
  registryWriter,
  mutate,
  failureMessage = "Checkpoint updated; derived registry repair is required",
}) {
  try {
    const registry = await listRegistry({ taskGuardHome });
    mutate(registry);
    await registryWriter(taskGuardHome, registry);
    return null;
  } catch {
    return { code: "REGISTRY_UPDATE_FAILED", message: failureMessage };
  }
}

export async function readRegistryForRepair(taskGuardHome) {
  try {
    const registry = await listRegistry({ taskGuardHome });
    if (!registry.tasks || typeof registry.tasks !== "object" || Array.isArray(registry.tasks)) {
      throw new SyntaxError("Task registry structure is invalid");
    }
    return registry;
  } catch (error) {
    if (error instanceof SyntaxError) return { schema_version: 2, tasks: {} };
    throw error;
  }
}

export async function repairRegistryEntry({
  taskGuardHome,
  state,
  root,
  checkpointPath,
  updatedAt = new Date().toISOString(),
  registryWriter = writeRegistry,
}) {
  const registry = await readRegistryForRepair(taskGuardHome);
  registry.tasks[registryKey(root, state.task_id)] = registryEntryFromCheckpoint({
    state,
    root,
    checkpointPath,
    updatedAt,
  });
  await registryWriter(taskGuardHome, registry);
}

export async function withRegistryLock(taskGuardHome, operation) {
  return withFileLock(path.join(taskGuardHome, "index.lock"), operation, {
    timeoutMs: 10_000,
    staleMs: 60_000,
    timeoutMessage: "Timed out waiting for the task registry lock",
    ownerText: `${process.pid}\n`,
  });
}
