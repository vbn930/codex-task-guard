#!/usr/bin/env node

import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const POLICY_START = "<!-- TASK-GUARD POLICY START -->";
const POLICY_END = "<!-- TASK-GUARD POLICY END -->";
const POLICY = `${POLICY_START}
For substantial tasks, use $task-guard before starting the task and before each substantial implementation phase.

Treat one task as one thread-level goal and decompose it into dependency-aware phases. Use JIT authoritative quota snapshots at critical boundaries; never present cached quota as current. Measure before/after snapshots, use measured history to select work that fits, and keep checkpoint, Discord, and automation reset scheduling on the same pause snapshot. A quota reset is a pause/resume boundary, not a task boundary. Finish only after the original acceptance criteria and required tests pass; start the next task in a new thread.
${POLICY_END}`;

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

function withPolicy(existing) {
  const start = existing.indexOf(POLICY_START);
  const end = existing.indexOf(POLICY_END, start + POLICY_START.length);
  if (start >= 0 && end >= 0) {
    return `${existing.slice(0, start)}${POLICY}${existing.slice(end + POLICY_END.length)}`;
  }
  const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${POLICY}\n`;
}

export async function installSkill({
  codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
} = {}) {
  const skillPath = path.join(codexHome, "skills", "task-guard");
  await mkdir(skillPath, { recursive: true });
  for (const entry of [
    "SKILL.md",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "agents",
    "scripts",
    "references",
    "docs",
  ]) {
    await cp(path.join(sourceRoot, entry), path.join(skillPath, entry), {
      recursive: true,
      force: true,
    });
  }

  const agentsPath = path.join(codexHome, "AGENTS.md");
  let existing = "";
  try {
    existing = await readFile(agentsPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWrite(agentsPath, withPolicy(existing));
  return { skill_path: skillPath, global_instructions: agentsPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await installSkill(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`task-guard install failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
