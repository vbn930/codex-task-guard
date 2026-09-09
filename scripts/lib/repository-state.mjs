import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { atomicWriteText } from "./fs-safe.mjs";

const execFileAsync = promisify(execFile);
export const CHECKPOINT_RELATIVE_PATH = path.join(".codex", "task-guard-checkpoint.md");

async function git(projectPath, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd: projectPath,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch {
    if (allowFailure) return null;
    throw new Error(`Git command failed: git ${args.join(" ")}`);
  }
}

export function canonicalProjectIdentity(projectRoot) {
  const resolved = path.resolve(projectRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function resolveProjectRoot(projectPath, { allowNonGit = false } = {}) {
  const resolved = path.resolve(projectPath);
  const rootBuffer = await git(resolved, ["rev-parse", "--show-toplevel"], {
    allowFailure: allowNonGit,
  });
  return rootBuffer ? path.resolve(rootBuffer.toString("utf8").trim()) : resolved;
}

export function checkpointPathForRoot(projectRoot) {
  return path.join(projectRoot, CHECKPOINT_RELATIVE_PATH);
}

export async function resolveProjectCheckpointPath(projectPath) {
  return checkpointPathForRoot(await resolveProjectRoot(projectPath));
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

export async function repositorySnapshot(projectPath) {
  const root = await resolveProjectRoot(projectPath);
  const hash = createHash("sha256");
  const head = await git(root, ["rev-parse", "HEAD"], { allowFailure: true });
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);

  hash.update(head ?? Buffer.from("UNBORN"));
  hash.update(status);
  await hashGitOutput(hash, root, ["diff", "--cached", "--binary", "--no-ext-diff"]);
  await hashGitOutput(hash, root, ["diff", "--binary", "--no-ext-diff"]);
  const untrackedPaths = untracked.toString("utf8").split("\0").filter(Boolean).sort();
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

export async function verifyRepositoryState(repository) {
  const current = await repositorySnapshot(repository.project_path);
  if (current.fingerprint !== repository.fingerprint) {
    return {
      matches: false,
      reason: "REPOSITORY_STATE_CHANGED",
      checkpoint_fingerprint: repository.fingerprint,
      current_fingerprint: current.fingerprint,
      current_status: current.status_porcelain,
    };
  }
  return { matches: true, reason: null };
}

export async function ensureLocalGitExclude(projectPath) {
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
    await atomicWriteText(excludePath, `${existing}${separator}${rule}\n`);
  }
}
