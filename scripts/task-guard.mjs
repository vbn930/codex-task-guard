#!/usr/bin/env node

import {
  auditRegistry,
  clearCheckpointHeartbeat,
  completeTask,
  patchCheckpointResumeAutomation,
  readCheckpoint,
  repairCheckpointRegistry,
  resolveCheckpointPath,
  saveCheckpoint,
  setCheckpointHeartbeat,
  verifyCheckpoint,
} from "./lib/checkpoint.mjs";
import { notificationsEnabled, notifyDiscord } from "./lib/discord.mjs";
import { runDoctor } from "./lib/doctor.mjs";
import {
  generateNativePhasePlan,
  loadPhaseGenerationProvider,
} from "./lib/phase-generation.mjs";
import {
  completePhaseAndDecide,
  finalizeQuotaPause,
  preparePhase,
  prepareQuotaPause,
  prepareTaskResume,
} from "./lib/lifecycle.mjs";
import { quotaFromTestFixture } from "./lib/quota.mjs";
import { createQuotaSnapshotStore } from "./lib/quota-snapshot.mjs";
import {
  completePhase,
  evaluateBudget,
  readUsageHistory,
  startPhase,
} from "./lib/usage.mjs";
import { verifyAutomationTranscript } from "./lib/automation.mjs";
import {
  readRuntimeIdentity,
  resolvePhasesRuntimeIdentity,
} from "./lib/runtime-identity.mjs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function quotaCommand() {
  const snapshot = await refreshCurrentQuota();
  printJson(snapshot);
  return snapshot.freshness === "AUTHORITATIVE" ? 0 : 2;
}

async function runtimeCommand(args) {
  const [action] = args;
  if (action !== "identify") throw new Error("runtime action must be identify");
  const identity = await readRuntimeIdentity();
  printJson(identity);
  return identity.status === "VERIFIED" ? 0 : 4;
}

function currentQuotaStore() {
  const fixture = process.env.TASK_GUARD_TEST_QUOTA;
  return createQuotaSnapshotStore({
    ...(fixture ? { reader: async () => quotaFromTestFixture(fixture) } : {}),
  });
}

async function refreshCurrentQuota() {
  return currentQuotaStore().refresh();
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
  if (action === "automation") {
    const [automationAction, ...automationOptions] = options;
    if (automationAction !== "set") throw new Error("checkpoint automation action must be set");
    const resumeAutomation = await readJsonInput(optionValue(
      automationOptions,
      "--input",
      { required: true },
    ));
    const result = await patchCheckpointResumeAutomation({
      projectPath: optionValue(automationOptions, "--project") ?? process.cwd(),
      taskId: optionValue(automationOptions, "--task-id", { required: true }),
      resumeAutomation,
    });
    printJson(result);
    return result.recovery_required ? 4 : 0;
  }
  if (action === "heartbeat") {
    const [heartbeatAction, ...heartbeatOptions] = options;
    const common = {
      projectPath: optionValue(heartbeatOptions, "--project") ?? process.cwd(),
      taskId: optionValue(heartbeatOptions, "--task-id", { required: true }),
    };
    if (heartbeatAction === "set") {
      const result = await setCheckpointHeartbeat({
        ...common,
        automationId: optionValue(heartbeatOptions, "--automation-id", { required: true }),
      });
      printJson(result);
      return result.recovery_required ? 4 : 0;
    }
    if (heartbeatAction === "clear") {
      const result = await clearCheckpointHeartbeat(common);
      printJson(result);
      return result.recovery_required ? 4 : 0;
    }
    throw new Error("checkpoint heartbeat action must be set or clear");
  }
  if (action === "registry") {
    const [registryAction, ...registryOptions] = options;
    if (registryAction !== "repair") throw new Error("checkpoint registry action must be repair");
    printJson(await repairCheckpointRegistry({
      projectPath: optionValue(registryOptions, "--project") ?? process.cwd(),
      taskId: optionValue(registryOptions, "--task-id", { required: true }),
    }));
    return 0;
  }
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
  if (action === "complete") {
    const projectPath = optionValue(options, "--project") ?? process.cwd();
    const taskId = optionValue(options, "--task-id", { required: true });
    printJson(await completeTask({ projectPath, taskId }));
    return 0;
  }
  throw new Error(
    "checkpoint action must be automation, heartbeat, registry, save, show, verify, list, or complete",
  );
}

async function notifyCommand(args) {
  const [event, ...options] = args;
  if (!event) throw new Error("notification event is required");
  const payload = await readJsonInput(optionValue(options, "--input", { required: true }));
  const quotaEvent = ["TASK_STARTED", "QUOTA_PAUSED", "TASK_RESUMED"].includes(event);
  const notificationConfigured = notificationsEnabled(process.env)
    && Boolean(process.env.CODEX_DISCORD_WEBHOOK_URL);
  const snapshot = quotaEvent && notificationConfigured
    ? await refreshCurrentQuota()
    : undefined;
  printJson(await notifyDiscord(event, payload, { snapshot }));
  return 0;
}

async function doctorCommand(args) {
  const projectPath = optionValue(args, "--project") ?? process.cwd();
  const testFixture = process.env.TASK_GUARD_TEST_DOCTOR;
  const options = { projectPath };
  if (testFixture === "healthy") {
    options.nodeVersion = "20.0.0";
    options.commandRunner = async (command) => `${command} test fixture`;
    options.quotaReader = async () => quotaFromTestFixture("healthy");
  }
  const result = await runDoctor(options);
  printJson(result);
  return result.ok ? 0 : 4;
}

function parseConcurrentUsage(value) {
  if (value === undefined || value === "unknown") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("--concurrent-usage must be true, false, or unknown");
}

async function phaseCommand(args) {
  const [action, ...options] = args;
  const projectPath = optionValue(options, "--project") ?? process.cwd();
  if (action === "generate") {
    const input = await readJsonInput(optionValue(options, "--input", { required: true }));
    const provider = await loadPhaseGenerationProvider(optionValue(
      options,
      "--provider",
      { required: true },
    ));
    printJson(await generateNativePhasePlan({
      taskId: input.task_id,
      taskDescription: input.task_description,
      safetyReservePercent: input.safety_reserve_percent,
      provider,
    }));
    return 0;
  }
  if (action === "prepare") {
    const input = await readJsonInput(optionValue(options, "--input", { required: true }));
    printJson(await preparePhase({
      projectPath,
      taskId: input.task_id,
      phases: input.phases,
      completedPhaseIds: input.completed_phase_ids,
      safetyReservePercent: input.safety_reserve_percent,
      snapshotStore: currentQuotaStore(),
    }));
    return 0;
  }
  if (action === "start") {
    const metadata = await readJsonInput(optionValue(options, "--input", { required: true }));
    const [resolvedMetadata] = await resolvePhasesRuntimeIdentity([metadata]);
    printJson(await startPhase({
      projectPath,
      metadata: resolvedMetadata,
      snapshot: await refreshCurrentQuota(),
    }));
    return 0;
  }
  if (action === "complete") {
    printJson(await completePhase({
      projectPath,
      phaseId: optionValue(options, "--phase-id", { required: true }),
      concurrentUsage: parseConcurrentUsage(optionValue(options, "--concurrent-usage")),
      snapshot: await refreshCurrentQuota(),
    }));
    return 0;
  }
  if (action === "finish") {
    const input = await readJsonInput(optionValue(options, "--input", { required: true }));
    printJson(await completePhaseAndDecide({
      projectPath,
      phaseId: optionValue(options, "--phase-id", { required: true }),
      concurrentUsage: parseConcurrentUsage(input.concurrent_usage),
      phases: input.phases,
      safetyReservePercent: input.safety_reserve_percent,
      snapshotStore: currentQuotaStore(),
      ...(input.notification ? {
        notification: {
          event: input.notification.event,
          payload: input.notification.payload,
        },
      } : {}),
    }));
    return 0;
  }
  throw new Error("phase action must be generate, prepare, start, complete, or finish");
}

async function historyCommand(args) {
  const [action, ...options] = args;
  if (action !== "list") throw new Error("history action must be list");
  const rawLimit = optionValue(options, "--limit");
  const limit = rawLimit === undefined ? 500 : Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  printJson(await readUsageHistory({ limit }));
  return 0;
}

async function budgetCommand(args) {
  const [action, ...options] = args;
  if (action !== "evaluate") throw new Error("budget action must be evaluate");
  const input = await readJsonInput(optionValue(options, "--input", { required: true }));
  const phases = await resolvePhasesRuntimeIdentity(input.phases);
  const snapshot = await refreshCurrentQuota();
  printJson(evaluateBudget({
    history: await readUsageHistory(),
    phases,
    snapshot,
    safetyReservePercent: input.safety_reserve_percent,
  }));
  return 0;
}

async function pauseCommand(args) {
  const [action, ...options] = args;
  const projectPath = optionValue(options, "--project") ?? process.cwd();
  const input = await readJsonInput(optionValue(options, "--input", { required: true }));
  if (action === "finalize") {
    const result = await finalizeQuotaPause({
      projectPath,
      taskId: optionValue(options, "--task-id", { required: true }),
      automationTranscript: input.automation_transcript,
      notificationPayload: input.notification,
    });
    printJson(result);
    return result.checkpoint.recovery_required ? 4 : 0;
  }
  if (action !== "prepare") throw new Error("pause action must be prepare or finalize");
  printJson(await prepareQuotaPause({
    projectPath,
    checkpointState: input.checkpoint,
    notificationPayload: input.notification,
    snapshotStore: currentQuotaStore(),
  }));
  return 0;
}

async function automationCommand(args) {
  const [action, ...options] = args;
  if (action !== "verify") throw new Error("automation action must be verify");
  const input = await readJsonInput(optionValue(options, "--input", { required: true }));
  printJson(await verifyAutomationTranscript({
    expected: input.expected,
    transcript: input.transcript,
  }));
  return 0;
}

async function resumeCommand(args) {
  const [action, ...options] = args;
  if (action !== "prepare") throw new Error("resume action must be prepare");
  const projectPath = optionValue(options, "--project") ?? process.cwd();
  const taskId = optionValue(options, "--task-id", { required: true });
  const input = await readJsonInput(optionValue(options, "--input", { required: true }));
  const result = await prepareTaskResume({
    projectPath,
    taskId,
    snapshotStore: currentQuotaStore(),
    ...(input.heartbeat_cleanup_confirmed === true
      ? { cleanupHeartbeat: async () => true }
      : {}),
    notificationPayload: input.notification,
    blockedNotificationPayload: input.blocked_notification,
    phases: input.phases,
    safetyReservePercent: input.safety_reserve_percent,
  });
  printJson(result);
  return result.status === "TASK_RESUMED" ? 0 : 5;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/task-guard.mjs <command>\n\nCommands:\n  quota\n  runtime identify\n  doctor [--project PATH]\n  automation verify --input FILE| -\n  phase generate --provider MODULE --input FILE| -\n  phase prepare --project PATH --input FILE| -\n  phase start --project PATH --input FILE| -\n  phase complete --project PATH --phase-id ID [--concurrent-usage true|false|unknown]\n  phase finish --project PATH --phase-id ID --input FILE| -\n  history list [--limit N]\n  budget evaluate --input FILE| -\n  pause prepare --project PATH --input FILE| -\n  pause finalize --project PATH --task-id ID --input FILE| -\n  resume prepare --project PATH --task-id ID --input FILE| -\n  checkpoint automation set --project PATH --task-id ID --input FILE| -\n  checkpoint heartbeat set --project PATH --task-id ID --automation-id ID\n  checkpoint heartbeat clear --project PATH --task-id ID\n  checkpoint registry repair --project PATH --task-id ID\n  checkpoint save --project PATH --input FILE| -\n  checkpoint show --project PATH | --checkpoint FILE\n  checkpoint verify --project PATH | --checkpoint FILE\n  checkpoint list\n  checkpoint complete --project PATH --task-id ID\n  notify EVENT --input FILE| -\n`);
  process.stdout.write("Native phase plans: pass top-level task_id and phases[].depends_on; phases[].estimated_files enables size-aware estimation.\n");
}

export async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  if (command === "quota") return quotaCommand();
  if (command === "runtime") return runtimeCommand(argv.slice(1));
  if (command === "automation") return automationCommand(argv.slice(1));
  if (command === "doctor") return doctorCommand(argv.slice(1));
  if (command === "phase") return phaseCommand(argv.slice(1));
  if (command === "history") return historyCommand(argv.slice(1));
  if (command === "budget") return budgetCommand(argv.slice(1));
  if (command === "pause") return pauseCommand(argv.slice(1));
  if (command === "resume") return resumeCommand(argv.slice(1));
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
