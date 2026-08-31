const PAUSED_FIELDS = [
  ["project", "Project", true, inlineCode],
  ["task", "Task", true],
  ["reason", "Reason", false],
  ["five_hour_remaining", "5h Remaining", true, boldPercent],
  ["reset", "Next Reset", true, timestampSummary],
  ["checkpoint", "Checkpoint", true, (value) => withPrefix(value, "✅")],
  ["resume", "Resume", true, resumeSummary],
  ["automation", "Automation", true],
  ["next_wake", "Next Wake", true, timestampSummary],
  ["status", "Status", false],
];

const STARTED_FIELDS = [
  ["project", "Project", true, inlineCode],
  ["task", "Task", true],
  ["thread", "Thread", true],
  ["quota", "5h Quota", true],
  ["reset", "Next Reset", true, timestampSummary],
  ["status", "Status", false],
];

const RESUMED_FIELDS = [
  ["project", "Project", true, inlineCode],
  ["task", "Task", true],
  ["quota", "5h Quota", true],
  ["reset", "Next Reset", true, timestampSummary],
  ["checkpoint", "Checkpoint", true, (value) => withPrefix(value, "✅")],
  ["repository", "Repository", true, (value) => withPrefix(value, "✅")],
  ["resume_point", "Resume Point", false],
  ["status", "Status", false],
];

const COMPLETED_FIELDS = [
  ["project", "Project", true, inlineCode],
  ["task", "Task", true],
  ["validation", "Validation", false],
  ["quota_used", "Quota Resets", true],
  ["checkpoint", "Checkpoint", true, (value) => withPrefix(value, "✅")],
  ["status", "Status", false],
];

const BLOCKED_FIELDS = [
  ["project", "Project", true, inlineCode],
  ["task", "Task", true],
  ["reason", "Reason", false],
  ["detected", "Detected", false, (value) => withPrefix(value, "⚠️")],
  ["action_required", "Required Action", false],
  ["checkpoint", "Checkpoint", true, (value) => withPrefix(value, "✅")],
  ["status", "Status", false],
];

const EVENT_CONFIG = {
  TASK_STARTED: {
    title: "🚀 Codex Task Started",
    description: "Task started and is ready for work.",
    color: 0x5865f2,
    fields: STARTED_FIELDS,
  },
  QUOTA_PAUSED: {
    title: "⏸️ Codex Task Paused",
    description: "Task paused safely before starting the next substantial implementation phase.",
    color: 0xfee75c,
    fields: PAUSED_FIELDS,
  },
  TASK_RESUMED: {
    title: "▶️ Codex Task Resumed",
    description: "Task resumed after checkpoint and repository verification.",
    color: 0x3498db,
    fields: RESUMED_FIELDS,
  },
  TASK_COMPLETED: {
    title: "✅ Codex Task Completed",
    description: "Task completed and passed its required validation.",
    color: 0x57f287,
    fields: COMPLETED_FIELDS,
  },
  TASK_BLOCKED: {
    title: "❌ Codex Task Blocked",
    description: "Task is blocked and requires attention before it can continue.",
    color: 0xed4245,
    fields: BLOCKED_FIELDS,
  },
};

const QUOTA_EVENTS = new Set(["TASK_STARTED", "QUOTA_PAUSED", "TASK_RESUMED"]);

export function notificationsEnabled(env) {
  const value = env.TASK_GUARD_NOTIFICATION_ENABLED?.toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function clean(value, limit = 1_024) {
  return String(value).replaceAll("\u0000", "").slice(0, limit);
}

function inlineCode(value) {
  return `\`${clean(value).replaceAll("`", "'")}\``;
}

function boldPercent(value) {
  const text = clean(value).trim();
  return text.startsWith("**") && text.endsWith("**") ? text : `**${text}**`;
}

function timestampSummary(value) {
  const text = clean(value).trim();
  const milliseconds = Date.parse(text);
  if (Number.isNaN(milliseconds)) return text;
  const seconds = Math.floor(milliseconds / 1_000);
  return `<t:${seconds}:t> · <t:${seconds}:R>`;
}

function withPrefix(value, prefix) {
  const text = clean(value).trim();
  return text.startsWith(prefix) ? text : `${prefix} ${text}`;
}

function resumeSummary(value) {
  const text = clean(value).trim();
  if (/verified/i.test(text) && !/not persisted|could not/i.test(text)) {
    return withPrefix(text, "✅");
  }
  if (/manual|required|not persisted|unverified/i.test(text)) return withPrefix(text, "⚠️");
  return withPrefix(text, "🔄");
}

function buildFields(definitions, payload) {
  return definitions.flatMap(([key, name, inline, formatter = clean]) => {
    const value = payload[key];
    if (value === undefined || value === null || value === "") return [];
    return [{ name, value: formatter(value), inline }];
  });
}

function payloadFromSnapshot(event, payload, snapshot) {
  if (!QUOTA_EVENTS.has(event)) return payload;
  if (!snapshot) throw new Error("QUOTA_SNAPSHOT_REQUIRED");

  const next = { ...payload };
  const quotaKey = event === "QUOTA_PAUSED" ? "five_hour_remaining" : "quota";
  if (snapshot.freshness === "AUTHORITATIVE" && snapshot.five_hour?.available) {
    const remaining = snapshot.five_hour.remaining_percent;
    next[quotaKey] = event === "QUOTA_PAUSED" ? `${remaining}%` : `${remaining}% remaining`;
    if (snapshot.five_hour.reset_at) next.reset = snapshot.five_hour.reset_at;
    else delete next.reset;
  } else {
    next[quotaKey] = snapshot.freshness === "STALE"
      ? "Unavailable (stale snapshot)"
      : "Unavailable (refresh failed)";
    delete next.reset;
  }
  return next;
}

function buildEmbed(event, payload, snapshot) {
  const config = EVENT_CONFIG[event];
  if (!config) throw new Error(`Unsupported Discord event: ${event}`);
  const authoritativePayload = payloadFromSnapshot(event, payload, snapshot);
  return {
    title: config.title,
    description: config.description,
    color: config.color,
    fields: buildFields(config.fields, authoritativePayload),
    footer: { text: "Codex Task Guard" },
    timestamp: new Date().toISOString(),
  };
}

export async function notifyDiscord(
  event,
  payload,
  { env = process.env, fetchImpl = globalThis.fetch, snapshot } = {},
) {
  const quotaMetadata = QUOTA_EVENTS.has(event) && snapshot
    ? {
      quota_snapshot_id: snapshot.snapshot_id ?? null,
      quota_observed_at: snapshot.observed_at ?? null,
    }
    : {};
  const webhookUrl = env.CODEX_DISCORD_WEBHOOK_URL;
  if (!notificationsEnabled(env) || !webhookUrl) {
    return { sent: false, reason: "DISABLED", ...quotaMetadata };
  }
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return { sent: false, reason: "INVALID_WEBHOOK_URL", ...quotaMetadata };
  }
  if (parsed.protocol !== "https:") {
    return { sent: false, reason: "INVALID_WEBHOOK_URL", ...quotaMetadata };
  }

  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Codex Task Guard",
        embeds: [buildEmbed(event, payload, snapshot)],
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { sent: false, reason: `HTTP_${response.status}`, ...quotaMetadata };
    return { sent: true, ...quotaMetadata };
  } catch {
    return { sent: false, reason: "REQUEST_FAILED", ...quotaMetadata };
  }
}
