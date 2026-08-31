import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readRateLimits } from "./app-server.mjs";
import { resolveCheckpointPath } from "./checkpoint.mjs";
import { notificationsEnabled } from "./discord.mjs";
import { normalizeQuotaResponse } from "./quota.mjs";

const execFileAsync = promisify(execFile);

async function defaultCommandRunner(command, args) {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function defaultQuotaReader() {
  return normalizeQuotaResponse(await readRateLimits());
}

function check(id, status, detail) {
  return detail ? { id, status, detail } : { id, status };
}

export async function runDoctor({
  projectPath = process.cwd(),
  env = process.env,
  nodeVersion = process.versions.node,
  commandRunner = defaultCommandRunner,
  quotaReader = defaultQuotaReader,
  checkpointResolver = resolveCheckpointPath,
} = {}) {
  const checks = [];
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0], 10);
  checks.push(check(
    "node",
    nodeMajor >= 20 ? "ok" : "error",
    `v${nodeVersion}; requires >=20`,
  ));

  let gitAvailable = true;
  try {
    checks.push(check("git", "ok", await commandRunner("git", ["--version"])));
  } catch {
    gitAvailable = false;
    checks.push(check("git", "error", "Git command is unavailable"));
  }

  let codexAvailable = true;
  try {
    checks.push(check("codex_cli", "ok", await commandRunner("codex", ["--version"])));
  } catch {
    codexAvailable = false;
    checks.push(check("codex_cli", "error", "Codex CLI is unavailable on PATH"));
  }

  if (codexAvailable) {
    try {
      const quota = await quotaReader();
      checks.push(check("codex_authenticated", "ok", "rate-limit request succeeded"));
      checks.push(check(
        "five_hour_quota",
        quota.five_hour?.available ? "ok" : "error",
        quota.five_hour?.available
          ? `${quota.five_hour.remaining_percent}% remaining`
          : "300-minute window unavailable",
      ));
      checks.push(check(
        "weekly_quota",
        quota.weekly?.available ? "ok" : "error",
        quota.weekly?.available
          ? `${quota.weekly.remaining_percent}% remaining`
          : "10080-minute window unavailable",
      ));
    } catch (error) {
      checks.push(check("codex_authenticated", "error", error.message));
      checks.push(check("five_hour_quota", "error", "quota read failed"));
      checks.push(check("weekly_quota", "error", "quota read failed"));
    }
  } else {
    checks.push(check("codex_authenticated", "error", "Codex CLI check failed"));
    checks.push(check("five_hour_quota", "error", "Codex CLI check failed"));
    checks.push(check("weekly_quota", "error", "Codex CLI check failed"));
  }

  const webhook = env.CODEX_DISCORD_WEBHOOK_URL;
  if (!notificationsEnabled(env)) {
    checks.push(check("discord_webhook", "warning", "optional; disabled"));
  } else if (!webhook) {
    checks.push(check("discord_webhook", "warning", "optional; not configured"));
  } else {
    let valid = false;
    try {
      valid = new URL(webhook).protocol === "https:";
    } catch {
      // Invalid URL.
    }
    checks.push(check(
      "discord_webhook",
      valid ? "ok" : "error",
      valid ? "configured" : "must be a valid HTTPS URL",
    ));
  }

  if (!gitAvailable) {
    checks.push(check("checkpoint_path", "error", "Git check failed"));
  } else {
    try {
      checks.push(check("checkpoint_path", "ok", await checkpointResolver(projectPath)));
    } catch (error) {
      checks.push(check("checkpoint_path", "error", error.message));
    }
  }

  return {
    ok: checks.every(({ status }) => status !== "error"),
    observed_at: new Date().toISOString(),
    checks,
  };
}
