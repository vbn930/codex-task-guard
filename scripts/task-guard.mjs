#!/usr/bin/env node

import { readRateLimits } from "./lib/app-server.mjs";
import {
  auditRegistry,
  completeTask,
  readCheckpoint,
  resolveCheckpointPath,
  resumeTask,
  saveCheckpoint,
  verifyCheckpoint,
} from "./lib/checkpoint.mjs";
import { notifyDiscord } from "./lib/discord.mjs";
import { normalizeQuotaResponse, quotaFromTestFixture } from "./lib/quota.mjs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function quotaCommand() {
  const fixture = process.env.TASK_GUARD_TEST_QUOTA;
  if (fixture) {
    printJson(quotaFromTestFixture(fixture));
    return 0;
  }

  try {
    printJson(normalizeQuotaResponse(await readRateLimits()));
    return 0;
  } catch (error) {
    printJson({
      source: "codex_app_server",
      observed_at: new Date().toISOString(),
      five_hour: { available: false },
      weekly: { available: false },
      error: { code: "RATE_LIMIT_READ_FAILED", message: error.message },
    });
    return 2;
  }
}

function optionValue(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && (!value || value.startsWith("--"))) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonInput(inputPath) {
  if (!inputPath) throw new Error("--input is required");
  const content = inputPath === "-" ? await readStdin() : await readFile(inputPath, "utf8");
  return JSON.parse(content);
}

async function checkpointPathFromArgs(args) {
  const explicit = optionValue(args, "--checkpoint");
  if (explicit) return explicit;
  return resolveCheckpointPath(optionValue(args, "--project") ?? process.cwd());
}

async function checkpointCommand(args) {
  const [action, ...options] = args;
  if (action === "save") {
    const projectPath = optionValue(options, "--project") ?? process.cwd();
    const state = await readJsonInput(optionValue(options, "--input", { required: true }));
    printJson(await saveCheckpoint({ projectPath, state }));
    return 0;
  }
  if (action === "show") {
    printJson(await readCheckpoint(await checkpointPathFromArgs(options)));
    return 0;
  }
  if (action === "verify") {
    const verification = await verifyCheckpoint(await checkpointPathFromArgs(options));
    printJson(verification);
    return verification.matches ? 0 : 3;
  }
  if (action === "list") {
    printJson(await auditRegistry());
    return 0;
  }
  if (action === "resume") {
    const projectPath = optionValue(options, "--project") ?? process.cwd();
    const taskId = optionValue(options, "--task-id", { required: true });
    printJson(await resumeTask({ projectPath, taskId }));
    return 0;
  }
  if (action === "complete") {
    const projectPath = optionValue(options, "--project") ?? process.cwd();
    const taskId = optionValue(options, "--task-id", { required: true });
    printJson(await completeTask({ projectPath, taskId }));
    return 0;
  }
  throw new Error("checkpoint action must be save, show, verify, list, resume, or complete");
}

async function notifyCommand(args) {
  const [event, ...options] = args;
  if (!event) throw new Error("notification event is required");
  const payload = await readJsonInput(optionValue(options, "--input", { required: true }));
  printJson(await notifyDiscord(event, payload));
  return 0;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/task-guard.mjs <command>\n\nCommands:\n  quota\n  checkpoint save --project PATH --input FILE| -\n  checkpoint show --project PATH | --checkpoint FILE\n  checkpoint verify --project PATH | --checkpoint FILE\n  checkpoint list\n  checkpoint resume --project PATH --task-id ID\n  checkpoint complete --project PATH --task-id ID\n  notify EVENT --input FILE| -\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  if (command === "quota") return quotaCommand();
  if (command === "checkpoint") return checkpointCommand(argv.slice(1));
  if (command === "notify") return notifyCommand(argv.slice(1));
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  printHelp();
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    printJson({ ok: false, error: { code: "COMMAND_FAILED", message: error.message } });
    process.exitCode = 2;
  }
}
