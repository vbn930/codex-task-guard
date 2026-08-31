import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runDoctor } from "../scripts/lib/doctor.mjs";

test("doctor reports a healthy required environment and optional Discord warning", async () => {
  const projectPath = path.resolve("project");
  const result = await runDoctor({
    projectPath,
    env: {},
    nodeVersion: "20.18.0",
    commandRunner: async (command) => `${command} version`,
    quotaReader: async () => ({
      five_hour: { available: true, remaining_percent: 80 },
      weekly: { available: true, remaining_percent: 70 },
    }),
    checkpointResolver: async () => path.join(projectPath, ".codex", "task-guard-checkpoint.md"),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    Object.fromEntries(result.checks.map((check) => [check.id, check.status])),
    {
      node: "ok",
      git: "ok",
      codex_cli: "ok",
      codex_authenticated: "ok",
      five_hour_quota: "ok",
      weekly_quota: "ok",
      discord_webhook: "warning",
      checkpoint_path: "ok",
    },
  );
});

test("doctor fails without Codex CLI and never exposes an invalid webhook", async () => {
  let quotaRead = false;
  const result = await runDoctor({
    projectPath: path.resolve("project"),
    env: { CODEX_DISCORD_WEBHOOK_URL: "http://discord.example/secret-token" },
    nodeVersion: "20.18.0",
    commandRunner: async (command) => {
      if (command === "codex") throw new Error("not found");
      return "git version";
    },
    quotaReader: async () => {
      quotaRead = true;
      return {};
    },
    checkpointResolver: async () => path.resolve("project", ".codex", "task-guard-checkpoint.md"),
  });

  assert.equal(result.ok, false);
  assert.equal(quotaRead, false);
  assert.equal(result.checks.find(({ id }) => id === "codex_cli").status, "error");
  assert.equal(result.checks.find(({ id }) => id === "discord_webhook").status, "error");
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
});

test("doctor ignores webhook validation when notifications are explicitly disabled", async () => {
  const result = await runDoctor({
    projectPath: path.resolve("project"),
    env: {
      TASK_GUARD_NOTIFICATION_ENABLED: "false",
      CODEX_DISCORD_WEBHOOK_URL: "http://discord.example/secret-token",
    },
    nodeVersion: "20.18.0",
    commandRunner: async (command) => `${command} version`,
    quotaReader: async () => ({
      five_hour: { available: true, remaining_percent: 80 },
      weekly: { available: true, remaining_percent: 70 },
    }),
    checkpointResolver: async () => path.resolve("project", ".codex", "task-guard-checkpoint.md"),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.checks.find(({ id }) => id === "discord_webhook"),
    { id: "discord_webhook", status: "warning", detail: "optional; disabled" },
  );
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
});
