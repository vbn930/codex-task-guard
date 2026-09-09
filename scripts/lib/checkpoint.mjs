import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  AUTOMATION_STATUS,
  isTerminalAutomation,
  isVerifiedAutomation,
  sanitizeResumeAutomation,
} from "./automation-contract.mjs";

const execFileAsync = promisify(execFile);
const CHECKPOINT_RELATIVE_PATH = path.join(".codex", "task-guard-checkpoint.md");
const STATE_START = "<!-- TASK_GUARD_STATE_START";
const STATE_END = "TASK_GUARD_STATE_END -->";
const STATE_ENCODING = "base64:";

function defaultTaskGuardHome() {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return process.env.TASK_GUARD_HOME ?? path.join(codexHome, "task-guard");
}

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

async function withRegistryLock(taskGuardHome, operation) {
  await mkdir(taskGuardHome, { recursive: true });
  const lockPath = path.join(taskGuardHome, "index.lock");
  const deadline = Date.now() + 10_000;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
    } catch (error) {
      const windowsLockContention = process.platform === "win32"
        && ["EACCES", "EPERM"].includes(error.code);
      if (error.code !== "EEXIST" && !windowsLockContention) throw error;
      const metadata = await stat(lockPath).catch(() => null);
      if (metadata && Date.now() - metadata.mtimeMs > 60_000) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the task registry lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function git(projectPath, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd: projectPath,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(`Git command failed: git ${args.join(" ")}`);
  }
}

async function hashGitOutput(hash, projectPath, args) {
  await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: projectPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.on("data", (chunk) => hash.update(chunk));
    child.on("error", () => reject(new Error(`Git command failed: git ${args.join(" ")}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Git command failed: git ${args.join(" ")}`));
    });
  });
}

async function hashFile(hash, filePath, relativePath) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink()) {
    const target = await readlink(filePath);
    hash.update(`untracked-symlink:${relativePath}:${target}`);
    return;
  }
  hash.update(`untracked:${relativePath}:${metadata.size}:`);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
}

async function repositorySnapshot(projectPath) {
  const rootBuffer = await git(projectPath, ["rev-parse", "--show-toplevel"]);
  const root = path.resolve(rootBuffer.toString("utf8").trim());
  const hash = createHash("sha256");
  const head = await git(root, ["rev-parse", "HEAD"], { allowFailure: true });
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);

  hash.update(head ?? Buffer.from("UNBORN"));
  hash.update(status);
  await hashGitOutput(hash, root, ["diff", "--cached", "--binary", "--no-ext-diff"]);
  await hashGitOutput(hash, root, ["diff", "--binary", "--no-ext-diff"]);
  const untrackedPaths = untracked
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const relativePath of untrackedPaths) {
    await hashFile(hash, path.join(root, relativePath), relativePath);
  }

  return {
    project_path: root,
    head: head?.toString("utf8").trim() || null,
    fingerprint: hash.digest("hex"),
    status_porcelain: status.toString("utf8").replaceAll("\0", "\n").trim(),
  };
}

async function ensureLocalGitExclude(projectPath) {
  const excludeBuffer = await git(projectPath, ["rev-parse", "--git-path", "info/exclude"]);
  const excludeRaw = excludeBuffer.toString("utf8").trim();
  const excludePath = path.isAbsolute(excludeRaw)
    ? excludeRaw
    : path.resolve(projectPath, excludeRaw);
  await mkdir(path.dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const rule = "/.codex/task-guard-checkpoint.md";
  if (!existing.split(/\r?\n/).includes(rule)) {
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await atomicWrite(excludePath, `${existing}${separator}${rule}\n`);
  }
}

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

function registryKey(projectPath, taskId) {
  const prefix = createHash("sha256").update(projectPath.toLowerCase()).digest("hex").slice(0, 12);
  return `${prefix}:${taskId}`;
}

function registryEntryFromCheckpoint({ state, root, checkpointPath, updatedAt }) {
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
      audited.tasks[key] = {
        ...entry,
        stale: true,
        stale_reason: "CHECKPOINT_MISSING",
      };
    }
  }
  return audited;
}

async function writeRegistry(taskGuardHome, registry) {
  const current = { ...registry, schema_version: 2 };
  await atomicWrite(path.join(taskGuardHome, "index.json"), `${JSON.stringify(current, null, 2)}\n`);
}

async function updateDerivedRegistry({
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
    return {
      code: "REGISTRY_UPDATE_FAILED",
      message: failureMessage,
    };
  }
}

async function readRegistryForRepair(taskGuardHome) {
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

export async function saveCheckpoint({
  projectPath,
  state,
  taskGuardHome = defaultTaskGuardHome(),
  registryWriter = writeRegistry,
}) {
  validateState(state);
  const repository = await repositorySnapshot(path.resolve(projectPath));
  const checkpointPath = path.join(repository.project_path, CHECKPOINT_RELATIVE_PATH);
  const now = new Date().toISOString();
  const fullState = {
    ...state,
    schema_version: 2,
    paused_at: state.paused_at ?? now,
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
      && checkpointOwner.task_id !== state.task_id
      && ["working", "paused_for_quota"].includes(checkpointOwner.status?.toLowerCase())
    ) {
      throw new Error(
        `ACTIVE_CHECKPOINT_EXISTS: repository already has active task ${checkpointOwner.task_id}`,
      );
    }

    await atomicWrite(checkpointPath, renderCheckpoint(fullState));
    registryError = await updateDerivedRegistry({
      taskGuardHome,
      registryWriter,
      mutate: (registry) => {
        const projectKey = repository.project_path.toLowerCase();
        for (const [key, entry] of Object.entries(registry.tasks)) {
          if (
            entry.task_id !== state.task_id
            && entry.project_path?.toLowerCase() === projectKey
          ) {
            delete registry.tasks[key];
          }
        }
        registry.tasks[registryKey(repository.project_path, state.task_id)]
          = registryEntryFromCheckpoint({
            state: fullState,
            root: repository.project_path,
            checkpointPath,
            updatedAt: now,
          });
      },
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
  const rootBuffer = await git(path.resolve(projectPath), ["rev-parse", "--show-toplevel"]);
  return path.join(path.resolve(rootBuffer.toString("utf8").trim()), CHECKPOINT_RELATIVE_PATH);
}

async function patchCheckpointHeartbeat({
  projectPath,
  taskId,
  automationId,
  taskGuardHome = defaultTaskGuardHome(),
  registryWriter = writeRegistry,
}) {
  const rootBuffer = await git(path.resolve(projectPath), ["rev-parse", "--show-toplevel"]);
  const root = path.resolve(rootBuffer.toString("utf8").trim());
  const checkpointPath = path.join(root, CHECKPOINT_RELATIVE_PATH);
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
    await atomicWrite(checkpointPath, renderCheckpoint(patchedState));

    registryError = await updateDerivedRegistry({
      taskGuardHome,
      registryWriter,
      mutate: (registry) => {
        const key = registryKey(root, taskId);
        const patchedRegistryEntry = {
          ...(registry.tasks[key] ?? registryEntryFromCheckpoint({
            state: patchedState,
            root,
            checkpointPath,
            updatedAt: now,
          })),
          updated_at: now,
        };
        if (automationId === null) delete patchedRegistryEntry.heartbeat_automation_id;
        else patchedRegistryEntry.heartbeat_automation_id = automationId;
        registry.tasks[key] = patchedRegistryEntry;
      },
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
  const rootBuffer = await git(path.resolve(projectPath), ["rev-parse", "--show-toplevel"]);
  const root = path.resolve(rootBuffer.toString("utf8").trim());
  const checkpointPath = path.join(root, CHECKPOINT_RELATIVE_PATH);
  const automation = sanitizeResumeAutomation(resumeAutomation);
  if (isVerifiedAutomation(automation) && !allowVerified) {
    throw new Error("VERIFIED automation must be derived by pause finalize read-back verification");
  }
  const now = new Date().toISOString();
  let registryError = null;

  await withRegistryLock(taskGuardHome, async () => {
    const state = await readCheckpoint(checkpointPath);
    if (state.task_id !== taskId) {
      throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
    }
    if (state.status?.toUpperCase() !== "PAUSED_FOR_QUOTA") {
      throw new Error("resumeAutomation can only be finalized from PAUSED_FOR_QUOTA");
    }
    if (isTerminalAutomation(state.resume_automation)) {
      throw new Error("Cannot rewrite a terminal automation state");
    }
    if (automation.snapshot_id && automation.snapshot_id !== state.quota_snapshot?.snapshot_id) {
      throw new Error("resumeAutomation snapshot_id does not match the checkpoint");
    }
    if (automation.resume_after && automation.resume_after !== state.resume_after) {
      throw new Error("resumeAutomation resume_after does not match the checkpoint");
    }
    if (
      automation.automation_fingerprint
      && state.resume_automation?.automation_fingerprint
      && automation.automation_fingerprint !== state.resume_automation.automation_fingerprint
    ) {
      throw new Error("resumeAutomation fingerprint does not match the checkpoint intent");
    }
    if (
      isVerifiedAutomation(automation)
      && state.resume_automation?.automation_fingerprint !== automation.automation_fingerprint
    ) {
      throw new Error("VERIFIED resumeAutomation requires the checkpoint intent fingerprint");
    }
    if (
      automation.target_thread
      && state.thread_reference
      && automation.target_thread !== state.thread_reference
    ) {
      throw new Error("resumeAutomation target_thread does not match the checkpoint");
    }
    if (isVerifiedAutomation(automation) && automation.target_thread !== state.thread_reference) {
      throw new Error("VERIFIED resumeAutomation requires the checkpoint target thread");
    }
    const resumeMode = isVerifiedAutomation(automation) ? "AUTOMATION" : "MANUAL";
    const patchedState = {
      ...state,
      resume_automation: automation,
      resume_mode: resumeMode,
    };
    if (automation.automation_id) patchedState.heartbeat_automation_id = automation.automation_id;
    else delete patchedState.heartbeat_automation_id;
    await atomicWrite(checkpointPath, renderCheckpoint(patchedState));
    registryError = await updateDerivedRegistry({
      taskGuardHome,
      registryWriter,
      mutate: (registry) => {
        const key = registryKey(root, taskId);
        const patchedRegistryEntry = {
          ...(registry.tasks[key] ?? registryEntryFromCheckpoint({
            state: patchedState,
            root,
            checkpointPath,
            updatedAt: now,
          })),
          resume_mode: resumeMode.toLowerCase(),
          resume_automation_status: automation.status.toLowerCase(),
          updated_at: now,
        };
        if (automation.automation_id) {
          patchedRegistryEntry.heartbeat_automation_id = automation.automation_id;
        } else {
          delete patchedRegistryEntry.heartbeat_automation_id;
        }
        registry.tasks[key] = patchedRegistryEntry;
      },
    });
  });

  return {
    checkpoint_path: checkpointPath,
    checkpoint_updated: true,
    registry_updated: registryError === null,
    recovery_required: registryError !== null,
    ...(registryError ? { error: registryError } : {}),
    resume_mode: isVerifiedAutomation(automation) ? "AUTOMATION" : "MANUAL",
    resume_automation: automation,
  };
}

export async function repairCheckpointRegistry({
  projectPath,
  taskId,
  taskGuardHome = defaultTaskGuardHome(),
  registryWriter = writeRegistry,
}) {
  const rootBuffer = await git(path.resolve(projectPath), ["rev-parse", "--show-toplevel"]);
  const root = path.resolve(rootBuffer.toString("utf8").trim());
  const checkpointPath = path.join(root, CHECKPOINT_RELATIVE_PATH);
  await withRegistryLock(taskGuardHome, async () => {
    const state = await readCheckpoint(checkpointPath);
    if (state.task_id !== taskId) {
      throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
    }
    const now = new Date().toISOString();
    const registry = await readRegistryForRepair(taskGuardHome);
    const key = registryKey(root, taskId);
    registry.tasks[key] = registryEntryFromCheckpoint({
      state,
      root,
      checkpointPath,
      updatedAt: now,
    });
    await registryWriter(taskGuardHome, registry);
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
  const current = await repositorySnapshot(state.repository.project_path);
  if (current.fingerprint !== state.repository.fingerprint) {
    return {
      matches: false,
      reason: "REPOSITORY_STATE_CHANGED",
      checkpoint_fingerprint: state.repository.fingerprint,
      current_fingerprint: current.fingerprint,
      current_status: current.status_porcelain,
    };
  }
  return { matches: true, reason: null, state };
}

export async function resumeTask({
  projectPath,
  taskId,
  taskGuardHome = defaultTaskGuardHome(),
  repositoryVerification,
  heartbeatCleanupConfirmed = false,
  registryWriter = writeRegistry,
}) {
  const rootBuffer = await git(path.resolve(projectPath), ["rev-parse", "--show-toplevel"]);
  const root = path.resolve(rootBuffer.toString("utf8").trim());
  const checkpointPath = path.join(root, CHECKPOINT_RELATIVE_PATH);
  let result;
  await withRegistryLock(taskGuardHome, async () => {
    const state = await readCheckpoint(checkpointPath);
    if (state.task_id !== taskId) {
      throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
    }
    if (state.status?.toUpperCase() === "WORKING") {
      result = {
        checkpoint_path: checkpointPath,
        status: "already_resumed",
        heartbeat_automation_id: state.heartbeat_automation_id ?? null,
      };
      return;
    }
    if (state.status?.toUpperCase() !== "PAUSED_FOR_QUOTA") {
      throw new Error("Task can only resume from PAUSED_FOR_QUOTA");
    }
    if (repositoryVerification?.matches !== true) {
      throw new Error("Repository verification is required before resume");
    }
    const externalCleanupRequired = Boolean(state.heartbeat_automation_id)
      || (isVerifiedAutomation(state.resume_automation)
        && state.resume_automation.cleanup_required !== false);
    if (externalCleanupRequired && heartbeatCleanupConfirmed !== true) {
      throw new Error("Heartbeat cleanup confirmation is required before resume");
    }

    const now = new Date().toISOString();
    const resumedState = {
      ...state,
      status: "WORKING",
      resumed_at: now,
      resume_after: null,
      ...(isVerifiedAutomation(state.resume_automation) ? {
        resume_automation: {
          ...state.resume_automation,
          status: AUTOMATION_STATUS.EXECUTED,
          executed_at: now,
          cleanup_required: false,
        },
      } : {}),
    };
    delete resumedState.heartbeat_automation_id;
    await atomicWrite(checkpointPath, renderCheckpoint(resumedState));
    const registryError = await updateDerivedRegistry({
      taskGuardHome,
      registryWriter,
      mutate: (registry) => {
        const key = registryKey(root, taskId);
        const resumedRegistryEntry = {
          ...(registry.tasks[key] ?? registryEntryFromCheckpoint({
            state: resumedState,
            root,
            checkpointPath,
            updatedAt: now,
          })),
          status: "working",
          resume_after: null,
          ...(resumedState.resume_automation ? {
            resume_automation_status: resumedState.resume_automation.status.toLowerCase(),
          } : {}),
          updated_at: now,
        };
        delete resumedRegistryEntry.heartbeat_automation_id;
        registry.tasks[key] = resumedRegistryEntry;
      },
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
  const rootBuffer = await git(path.resolve(projectPath), ["rev-parse", "--show-toplevel"]);
  const root = path.resolve(rootBuffer.toString("utf8").trim());
  const checkpointPath = path.join(root, CHECKPOINT_RELATIVE_PATH);
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
  return {
    checkpoint_removed: checkpointRemoved,
    registry_updated: registryError === null,
    recovery_required: registryError !== null,
    ...(registryError ? {
      recovery_action: "REGISTRY_PRUNE",
      error: registryError,
    } : {}),
  };
}
