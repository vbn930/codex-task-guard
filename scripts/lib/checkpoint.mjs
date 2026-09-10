import { access, readFile, rm } from "node:fs/promises";

import {
  isVerifiedAutomation,
  sanitizeResumeAutomation,
} from "./automation-contract.mjs";
import { atomicWriteText } from "./fs-safe.mjs";
import {
  canonicalProjectIdentity,
  checkpointPathForRoot,
  ensureLocalGitExclude,
  repositorySnapshot,
  resolveProjectCheckpointPath,
  resolveProjectRoot,
  verifyRepositoryState,
} from "./repository-state.mjs";
import { defaultTaskGuardHome } from "./runtime-paths.mjs";
import { clearPhasePlan } from "./phase-planner.mjs";
import {
  repairRegistryEntry,
  registryEntryFromCheckpoint,
  registryKey,
  updateDerivedRegistry,
  withRegistryLock,
  writeRegistry,
} from "./task-registry.mjs";
import {
  TASK_STATUS,
  isActiveTaskStatus,
  isTaskStatus,
  normalizeTaskStatus,
  sanitizeTaskState,
  transitionTaskResumeAutomation,
  transitionTaskToWorking,
} from "./task-state-contract.mjs";

const STATE_START = "<!-- TASK_GUARD_STATE_START";
const STATE_END = "TASK_GUARD_STATE_END -->";
const STATE_ENCODING = "base64:";

export { auditRegistry, listRegistry } from "./task-registry.mjs";

function listSection(title, values) {
  const items = Array.isArray(values) ? values : [];
  return `## ${title}\n\n${items.length ? items.map((item) => `- ${item}`).join("\n") : "- None"}`;
}

function testsSection(tests) {
  const items = Array.isArray(tests) ? tests : [];
  return `## Tests\n\n${items.length ? items.map((item) => `- \`${item.command}\`: ${item.result}`).join("\n") : "- None recorded"}`;
}

function renderCheckpoint(state) {
  const repositoryStatus = state.repository.status_porcelain || "Clean";
  return `# Task Guard Checkpoint

Task: ${state.task_description}
Task ID: ${state.task_id}
Status: ${state.status}

${listSection("Completed", state.completed)}

${listSection("Current State", state.current_state)}

${listSection("Modified Files", repositoryStatus.split("\n"))}

${listSection("Important Decisions", state.decisions)}

${testsSection(state.tests)}

${listSection("Known Issues", state.known_issues)}

${listSection("Remaining Work", state.remaining_work)}

${listSection("Exact Next Actions", state.exact_next_actions)}

## Quota

\`\`\`json
${JSON.stringify(state.quota ?? {}, null, 2)}
\`\`\`

## Pause

- Paused at: ${state.paused_at}
- Resume after: ${state.resume_after ?? "Unknown"}

${STATE_START}
${STATE_ENCODING}${Buffer.from(JSON.stringify(state), "utf8").toString("base64")}
${STATE_END}
`;
}

function validateState(state) {
  if (!state || typeof state !== "object") throw new Error("Checkpoint state is required");
  if (!/^[A-Za-z0-9._-]+$/.test(state.task_id ?? "")) {
    throw new Error("task_id must contain only letters, numbers, dot, underscore, or hyphen");
  }
  if (!state.task_description?.trim()) throw new Error("task_description is required");
  if (!state.status?.trim()) throw new Error("status is required");
  if (!Array.isArray(state.exact_next_actions) || state.exact_next_actions.length === 0) {
    throw new Error("exact_next_actions must contain at least one action");
  }
  rejectSensitiveCheckpointKeys(state);
  return sanitizeTaskState(state);
}

function rejectSensitiveCheckpointKeys(value, currentPath = "", seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = key
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    const parts = normalized.split("_");
    const forbiddenPart = parts.some((part) => (
      ["password", "secret", "token", "authorization", "cookie", "webhook"].includes(part)
    ));
    const forbiddenKey = [
      "api_key",
      "raw_response",
      "raw_tool_response",
      "automation_transcript",
    ].includes(normalized);
    const fieldPath = currentPath ? `${currentPath}.${key}` : key;
    if (forbiddenPart || forbiddenKey) {
      throw new Error(`Checkpoint state contains forbidden key: ${fieldPath}`);
    }
    rejectSensitiveCheckpointKeys(child, fieldPath, seen);
  }
}

async function persistCheckpointState({
  checkpointPath,
  root,
  state,
  taskGuardHome,
  registryWriter,
  updatedAt,
  pruneOtherProjectTasks = false,
}) {
  await atomicWriteText(checkpointPath, renderCheckpoint(state));
  return updateDerivedRegistry({
    taskGuardHome,
    registryWriter,
    mutate: (registry) => {
      if (pruneOtherProjectTasks) {
        const projectKey = canonicalProjectIdentity(root);
        for (const [key, entry] of Object.entries(registry.tasks)) {
          if (
            entry.task_id !== state.task_id
            && entry.project_path
            && canonicalProjectIdentity(entry.project_path) === projectKey
          ) {
            delete registry.tasks[key];
          }
        }
      }
      registry.tasks[registryKey(root, state.task_id)] = registryEntryFromCheckpoint({
        state,
        root,
        checkpointPath,
        updatedAt,
      });
    },
  });
}

export async function saveCheckpoint({
  projectPath,
  state,
  taskGuardHome = defaultTaskGuardHome(),
  registryWriter = writeRegistry,
}) {
  const normalizedState = validateState(state);
  const repository = await repositorySnapshot(projectPath);
  const checkpointPath = checkpointPathForRoot(repository.project_path);
  const now = new Date().toISOString();
  const fullState = {
    ...normalizedState,
    schema_version: 2,
    paused_at: normalizedState.paused_at ?? now,
    repository,
  };

  await ensureLocalGitExclude(repository.project_path);

  let registryError = null;
  await withRegistryLock(taskGuardHome, async () => {
    let checkpointOwner = null;
    try {
      checkpointOwner = await readCheckpoint(checkpointPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      checkpointOwner
      && checkpointOwner.task_id !== normalizedState.task_id
      && isActiveTaskStatus(checkpointOwner.status)
    ) {
      throw new Error(
        `ACTIVE_CHECKPOINT_EXISTS: repository already has active task ${checkpointOwner.task_id}`,
      );
    }

    registryError = await persistCheckpointState({
      checkpointPath,
      root: repository.project_path,
      state: fullState,
      taskGuardHome,
      registryWriter,
      updatedAt: now,
      pruneOtherProjectTasks: true,
    });
  });
  return {
    checkpoint_path: checkpointPath,
    checkpoint_updated: true,
    registry_updated: registryError === null,
    recovery_required: registryError !== null,
    ...(registryError ? { error: registryError } : {}),
  };
}

export async function readCheckpoint(checkpointPath) {
  const markdown = await readFile(checkpointPath, "utf8");
  const end = markdown.lastIndexOf(STATE_END);
  if (end < 0) throw new Error("Checkpoint machine state is missing");

  const starts = [];
  for (let start = markdown.indexOf(STATE_START); start >= 0 && start < end;) {
    starts.push(start);
    start = markdown.indexOf(STATE_START, start + STATE_START.length);
  }
  for (const start of starts.reverse()) {
    const encoded = markdown.slice(start + STATE_START.length, end).trim();
    try {
      const json = encoded.startsWith(STATE_ENCODING)
        ? Buffer.from(encoded.slice(STATE_ENCODING.length), "base64").toString("utf8")
        : encoded;
      return JSON.parse(json);
    } catch {
      // Try an earlier marker in case task text contained the marker itself.
    }
  }
  throw new Error("Checkpoint machine state is invalid");
}

export async function resolveCheckpointPath(projectPath) {
  return resolveProjectCheckpointPath(projectPath);
}

async function patchCheckpointHeartbeat({
  projectPath,
  taskId,
  automationId,
  taskGuardHome = defaultTaskGuardHome(),
  registryWriter = writeRegistry,
}) {
  const root = await resolveProjectRoot(projectPath);
  const checkpointPath = checkpointPathForRoot(root);
  const now = new Date().toISOString();
  let heartbeatAutomationId = null;
  let registryError = null;

  await withRegistryLock(taskGuardHome, async () => {
    const state = await readCheckpoint(checkpointPath);
    if (state.task_id !== taskId) {
      throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
    }
    const patchedState = { ...state };
    if (automationId === null) delete patchedState.heartbeat_automation_id;
    else patchedState.heartbeat_automation_id = automationId;
    registryError = await persistCheckpointState({
      checkpointPath,
      root,
      state: patchedState,
      taskGuardHome,
      registryWriter,
      updatedAt: now,
    });
    heartbeatAutomationId = patchedState.heartbeat_automation_id ?? null;
  });

  return {
    checkpoint_path: checkpointPath,
    checkpoint_updated: true,
    registry_updated: registryError === null,
    recovery_required: registryError !== null,
    ...(registryError ? { error: registryError } : {}),
    heartbeat_automation_id: heartbeatAutomationId,
  };
}

export async function setCheckpointHeartbeat(options) {
  if (typeof options?.automationId !== "string" || options.automationId.trim() === "") {
    throw new Error("automationId is required");
  }
  return patchCheckpointHeartbeat(options);
}

export async function clearCheckpointHeartbeat(options) {
  return patchCheckpointHeartbeat({ ...options, automationId: null });
}

export async function patchCheckpointResumeAutomation({
  projectPath,
  taskId,
  resumeAutomation,
  taskGuardHome = defaultTaskGuardHome(),
  allowVerified = false,
  registryWriter = writeRegistry,
}) {
  const root = await resolveProjectRoot(projectPath);
  const checkpointPath = checkpointPathForRoot(root);
  const automation = sanitizeResumeAutomation(resumeAutomation);
  if (isVerifiedAutomation(automation) && !allowVerified) {
    throw new Error("VERIFIED automation must be derived by pause finalize read-back verification");
  }
  const now = new Date().toISOString();
  let registryError = null;
  let resumeMode = null;

  await withRegistryLock(taskGuardHome, async () => {
    const state = await readCheckpoint(checkpointPath);
    if (state.task_id !== taskId) {
      throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
    }
    const patchedState = transitionTaskResumeAutomation(state, automation);
    resumeMode = patchedState.resume_mode;
    registryError = await persistCheckpointState({
      checkpointPath,
      root,
      state: patchedState,
      taskGuardHome,
      registryWriter,
      updatedAt: now,
    });
  });

  return {
    checkpoint_path: checkpointPath,
    checkpoint_updated: true,
    registry_updated: registryError === null,
    recovery_required: registryError !== null,
    ...(registryError ? { error: registryError } : {}),
    resume_mode: resumeMode,
    resume_automation: automation,
  };
}

export async function repairCheckpointRegistry({
  projectPath,
  taskId,
  taskGuardHome = defaultTaskGuardHome(),
  registryWriter = writeRegistry,
}) {
  const root = await resolveProjectRoot(projectPath);
  const checkpointPath = checkpointPathForRoot(root);
  await withRegistryLock(taskGuardHome, async () => {
    const state = await readCheckpoint(checkpointPath);
    if (state.task_id !== taskId) {
      throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
    }
    await repairRegistryEntry({
      taskGuardHome,
      state,
      root,
      checkpointPath,
      registryWriter,
    });
  });
  return {
    checkpoint_path: checkpointPath,
    checkpoint_updated: false,
    registry_updated: true,
    recovery_required: false,
  };
}

export async function verifyCheckpoint(checkpointPath) {
  const state = await readCheckpoint(checkpointPath);
  const verification = await verifyRepositoryState(state.repository);
  return verification.matches ? { ...verification, state } : verification;
}

export async function resumeTask({
  projectPath,
  taskId,
  taskGuardHome = defaultTaskGuardHome(),
  repositoryVerification,
  heartbeatCleanupConfirmed = false,
  registryWriter = writeRegistry,
}) {
  const root = await resolveProjectRoot(projectPath);
  const checkpointPath = checkpointPathForRoot(root);
  let result;
  await withRegistryLock(taskGuardHome, async () => {
    const state = await readCheckpoint(checkpointPath);
    if (state.task_id !== taskId) {
      throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
    }
    if (isTaskStatus(state.status, TASK_STATUS.WORKING)) {
      result = {
        checkpoint_path: checkpointPath,
        status: "already_resumed",
        heartbeat_automation_id: state.heartbeat_automation_id ?? null,
      };
      return;
    }
    if (!isTaskStatus(state.status, TASK_STATUS.PAUSED_FOR_QUOTA)) {
      throw new Error("Task can only resume from PAUSED_FOR_QUOTA");
    }
    if (repositoryVerification?.matches !== true) {
      throw new Error("Repository verification is required before resume");
    }
    const now = new Date().toISOString();
    const resumedState = transitionTaskToWorking(state, {
      resumedAt: now,
      heartbeatCleanupConfirmed,
    });
    const registryError = await persistCheckpointState({
      checkpointPath,
      root,
      state: resumedState,
      taskGuardHome,
      registryWriter,
      updatedAt: now,
    });
    result = {
      checkpoint_path: checkpointPath,
      status: "working",
      checkpoint_updated: true,
      registry_updated: registryError === null,
      recovery_required: registryError !== null,
      ...(registryError ? { error: registryError } : {}),
      heartbeat_automation_id: state.heartbeat_automation_id ?? null,
    };
  });
  return result;
}

export async function completeTask({
  projectPath,
  taskId,
  taskGuardHome = defaultTaskGuardHome(),
  registryWriter = writeRegistry,
}) {
  const root = await resolveProjectRoot(projectPath);
  const checkpointPath = checkpointPathForRoot(root);
  let checkpointRemoved = false;
  let registryError = null;

  await withRegistryLock(taskGuardHome, async () => {
    try {
      await access(checkpointPath);
      const state = await readCheckpoint(checkpointPath);
      if (state.task_id !== taskId) {
        throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
      }
      await rm(checkpointPath);
      checkpointRemoved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    registryError = await updateDerivedRegistry({
      taskGuardHome,
      registryWriter,
      mutate: (registry) => {
        delete registry.tasks[registryKey(root, taskId)];
      },
      failureMessage: "Checkpoint removed; derived registry prune is required",
    });
  });
  const phasePlanRemoved = await clearPhasePlan({ projectPath: root, taskId, taskGuardHome });
  return {
    checkpoint_removed: checkpointRemoved,
    phase_plan_removed: phasePlanRemoved,
    registry_updated: registryError === null,
    recovery_required: registryError !== null,
    ...(registryError ? {
      recovery_action: "REGISTRY_PRUNE",
      error: registryError,
    } : {}),
  };
}
