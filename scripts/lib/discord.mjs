const EVENT_TITLES = {
  TASK_STARTED: "🚀 Codex Task Started",
  QUOTA_PAUSED: "⏸️ Codex Task Paused",
  TASK_RESUMED: "▶️ Codex Task Resumed",
  TASK_COMPLETED: "✅ Codex Task Completed",
  TASK_BLOCKED: "❌ Codex Task Blocked",
};

const FIELD_LABELS = [
  ["project", "Project"],
  ["task", "Task"],
  ["thread", "Thread"],
  ["reason", "Reason"],
  ["checkpoint", "Checkpoint"],
  ["reset", "Reset"],
  ["validation", "Validation"],
  ["action_required", "Action required"],
  ["status", "Status"],
];

function notificationsEnabled(env) {
  const value = env.TASK_GUARD_NOTIFICATION_ENABLED?.toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function buildMessage(event, payload) {
  const title = EVENT_TITLES[event];
  if (!title) throw new Error(`Unsupported Discord event: ${event}`);
  const lines = [title, ""];
  for (const [key, label] of FIELD_LABELS) {
    const value = payload[key];
    if (value !== undefined && value !== null && value !== "") {
      lines.push(`${label}: ${String(value).replaceAll("\n", " ")}`);
    }
  }
  return lines.join("\n").slice(0, 2_000);
}

export async function notifyDiscord(
  event,
  payload,
  { env = process.env, fetchImpl = globalThis.fetch } = {},
) {
  const webhookUrl = env.CODEX_DISCORD_WEBHOOK_URL;
  if (!notificationsEnabled(env) || !webhookUrl) {
    return { sent: false, reason: "DISABLED" };
  }
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return { sent: false, reason: "INVALID_WEBHOOK_URL" };
  }
  if (parsed.protocol !== "https:") {
    return { sent: false, reason: "INVALID_WEBHOOK_URL" };
  }

  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: buildMessage(event, payload),
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { sent: false, reason: `HTTP_${response.status}` };
    return { sent: true };
  } catch {
    return { sent: false, reason: "REQUEST_FAILED" };
  }
}
