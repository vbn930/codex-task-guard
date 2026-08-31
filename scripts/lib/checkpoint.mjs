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
}

function registryKey(projectPath, taskId) {
  const prefix = createHash("sha256").update(projectPath.toLowerCase()).digest("hex").slice(0, 12);
  return `${prefix}:${taskId}`;
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

export async function saveCheckpoint({
  projectPath,
  state,
  taskGuardHome = defaultTaskGuardHome(),
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

    const registry = await listRegistry({ taskGuardHome });
    const projectKey = repository.project_path.toLowerCase();
    for (const [key, entry] of Object.entries(registry.tasks)) {
      if (
        entry.task_id !== state.task_id
        && entry.project_path?.toLowerCase() === projectKey
      ) {
        delete registry.tasks[key];
      }
    }

    await atomicWrite(checkpointPath, renderCheckpoint(fullState));
    registry.tasks[registryKey(repository.project_path, state.task_id)] = {
      task_id: state.task_id,
      project_path: repository.project_path,
      checkpoint_path: checkpointPath,
      status: state.status.toLowerCase(),
      resume_after: state.resume_after ?? null,
      thread_reference: state.thread_reference ?? null,
      ...(fullState.quota_snapshot ? {
        quota_snapshot_id: fullState.quota_snapshot.snapshot_id ?? null,
        quota_observed_at: fullState.quota_snapshot.observed_at ?? null,
      } : {}),
      updated_at: now,
    };
    await writeRegistry(taskGuardHome, registry);
  });
  return { checkpoint_path: checkpointPath, registry_updated: true };
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
}) {
  const rootBuffer = await git(path.resolve(projectPath), ["rev-parse", "--show-toplevel"]);
  const root = path.resolve(rootBuffer.toString("utf8").trim());
  const checkpointPath = path.join(root, CHECKPOINT_RELATIVE_PATH);
  const state = await readCheckpoint(checkpointPath);
  if (state.task_id !== taskId) {
    throw new Error(`Checkpoint belongs to ${state.task_id}, not ${taskId}`);
  }

  const now = new Date().toISOString();
  const resumedState = {
    ...state,
    status: "WORKING",
    resumed_at: now,
    resume_after: null,
  };
  await withRegistryLock(taskGuardHome, async () => {
    const registry = await listRegistry({ taskGuardHome });
    const key = registryKey(root, taskId);
    if (!registry.tasks[key]) throw new Error("Task registry entry is missing");
    await atomicWrite(checkpointPath, renderCheckpoint(resumedState));
    registry.tasks[key] = {
      ...registry.tasks[key],
      status: "working",
      resume_after: null,
      updated_at: now,
    };
    await writeRegistry(taskGuardHome, registry);
  });

  return {
    checkpoint_path: checkpointPath,
    status: "working",
    heartbeat_automation_id: state.heartbeat_automation_id ?? null,
  };
}

export async function completeTask({
  projectPath,
  taskId,
  taskGuardHome = defaultTaskGuardHome(),
}) {
  const rootBuffer = await git(path.resolve(projectPath), ["rev-parse", "--show-toplevel"]);
  const root = path.resolve(rootBuffer.toString("utf8").trim());
  const checkpointPath = path.join(root, CHECKPOINT_RELATIVE_PATH);
  let checkpointRemoved = false;
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

  await withRegistryLock(taskGuardHome, async () => {
    const registry = await listRegistry({ taskGuardHome });
    delete registry.tasks[registryKey(root, taskId)];
    await writeRegistry(taskGuardHome, registry);
  });
  return { checkpoint_removed: checkpointRemoved, registry_updated: true };
}
