import assert from "node:assert/strict";
import test from "node:test";

import { notifyDiscord } from "../scripts/lib/discord.mjs";

test("gracefully disables Discord when the webhook environment variable is absent", async () => {
  let called = false;
  const result = await notifyDiscord(
    "TASK_STARTED",
    { project: "demo", task: "Task 24" },
    { env: {}, fetchImpl: async () => { called = true; } },
  );
  assert.deepEqual(result, { sent: false, reason: "DISABLED" });
  assert.equal(called, false);
});

test("sends a task started embed with working context", async () => {
  let request;
  await notifyDiscord(
    "TASK_STARTED",
    {
      project: "codex-pet",
      task: "Implement Discord integration",
      thread: "Current thread",
      quota: "74% remaining",
      reset: "2026-08-31T12:00:00Z",
      status: "Working",
    },
    {
      env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
      fetchImpl: async (_url, options) => {
        request = options;
        return { ok: true, status: 204 };
      },
    },
  );

  const [embed] = JSON.parse(request.body).embeds;
  assert.equal(embed.title, "🚀 Codex Task Started");
  assert.equal(embed.color, 0x5865f2);
  assert.deepEqual(
    embed.fields.map(({ name, value }) => [name, value]),
    [
      ["Project", "`codex-pet`"],
      ["Task", "Implement Discord integration"],
      ["Thread", "Current thread"],
      ["5h Quota", "74% remaining"],
      ["Next Reset", "<t:1788177600:t> · <t:1788177600:R>"],
      ["Status", "Working"],
    ],
  );
  assert.deepEqual(embed.footer, { text: "Codex Task Guard" });
  assert.match(embed.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("sends a quota pause embed with local and relative reset time without exposing the webhook", async () => {
  let request;
  const result = await notifyDiscord(
    "QUOTA_PAUSED",
    {
      project: "demo",
      task: "Task 24",
      reason: "5-hour quota low",
      five_hour_remaining: "6%",
      reset: "2026-08-31T12:00:00Z",
      checkpoint: "Saved",
      resume: "Same-thread automation scheduled",
      status: "Waiting for quota reset",
    },
    {
      env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 204 };
      },
    },
  );

  assert.deepEqual(result, { sent: true });
  assert.equal(request.options.method, "POST");
  const body = JSON.parse(request.options.body);
  assert.equal(body.username, "Codex Task Guard");
  assert.equal(body.content, undefined);
  assert.equal(body.embeds.length, 1);
  assert.equal(body.embeds[0].title, "⏸️ Codex Task Paused");
  assert.equal(body.embeds[0].color, 16_705_372);
  assert.deepEqual(
    Object.fromEntries(body.embeds[0].fields.map(({ name, value }) => [name, value])),
    {
      Project: "`demo`",
      Task: "Task 24",
      Reason: "5-hour quota low",
      "5h Remaining": "**6%**",
      "Next Reset": "<t:1788177600:t> · <t:1788177600:R>",
      Checkpoint: "✅ Saved",
      Resume: "🔄 Same-thread automation scheduled",
      Status: "Waiting for quota reset",
    },
  );
  assert.doesNotMatch(JSON.stringify(body), /webhooks\/secret/);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

test("sends a task resumed embed with checkpoint and repository verification", async () => {
  let request;
  await notifyDiscord(
    "TASK_RESUMED",
    {
      project: "codex-pet",
      task: "Implement Discord integration",
      quota: "100% remaining",
      reset: "2026-08-31T12:00:00Z",
      checkpoint: "Verified",
      repository: "No external changes",
      resume_point: "Implement heartbeat cleanup and run integration tests",
      status: "Working",
    },
    {
      env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
      fetchImpl: async (_url, options) => {
        request = options;
        return { ok: true, status: 204 };
      },
    },
  );

  const [embed] = JSON.parse(request.body).embeds;
  assert.equal(embed.title, "▶️ Codex Task Resumed");
  assert.equal(embed.color, 0x3498db);
  assert.deepEqual(
    Object.fromEntries(embed.fields.map(({ name, value }) => [name, value])),
    {
      Project: "`codex-pet`",
      Task: "Implement Discord integration",
      "5h Quota": "100% remaining",
      "Next Reset": "<t:1788177600:t> · <t:1788177600:R>",
      Checkpoint: "✅ Verified",
      Repository: "✅ No external changes",
      "Resume Point": "Implement heartbeat cleanup and run integration tests",
      Status: "Working",
    },
  );
});

test("sends a green task completed embed with validation details", async () => {
  let request;
  await notifyDiscord(
    "TASK_COMPLETED",
    {
      project: "codex-pet",
      task: "Implement Discord integration",
      validation: "✅ Implementation complete\n✅ Tests passed\n✅ Acceptance criteria satisfied",
      quota_used: "1 × 5h window",
      checkpoint: "Cleared",
      status: "DONE",
    },
    {
      env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
      fetchImpl: async (_url, options) => {
        request = options;
        return { ok: true, status: 204 };
      },
    },
  );

  const [embed] = JSON.parse(request.body).embeds;
  assert.equal(embed.title, "✅ Codex Task Completed");
  assert.equal(embed.color, 0x57f287);
  assert.deepEqual(
    Object.fromEntries(embed.fields.map(({ name, value }) => [name, value])),
    {
      Project: "`codex-pet`",
      Task: "Implement Discord integration",
      Validation: "✅ Implementation complete\n✅ Tests passed\n✅ Acceptance criteria satisfied",
      "Quota Resets": "1 × 5h window",
      Checkpoint: "✅ Cleared",
      Status: "DONE",
    },
  );
});

test("sends a red task blocked embed with the required action", async () => {
  let request;
  await notifyDiscord(
    "TASK_BLOCKED",
    {
      project: "codex-pet",
      task: "Implement Discord integration",
      reason: "Repository state changed while task was paused",
      detected: "Git fingerprint mismatch",
      action_required: "Review external changes before continuing",
      checkpoint: "Preserved",
      status: "Blocked",
    },
    {
      env: { CODEX_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/secret" },
      fetchImpl: async (_url, options) => {
        request = options;
        return { ok: true, status: 204 };
      },
    },
  );

  const [embed] = JSON.parse(request.body).embeds;
  assert.equal(embed.title, "❌ Codex Task Blocked");
  assert.equal(embed.color, 0xed4245);
  assert.deepEqual(
    Object.fromEntries(embed.fields.map(({ name, value }) => [name, value])),
    {
      Project: "`codex-pet`",
      Task: "Implement Discord integration",
      Reason: "Repository state changed while task was paused",
      Detected: "⚠️ Git fingerprint mismatch",
      "Required Action": "Review external changes before continuing",
      Checkpoint: "✅ Preserved",
      Status: "Blocked",
    },
  );
});

test("reports notification failure without echoing the secret URL", async () => {
  const secret = "https://discord.com/api/webhooks/private-secret";
  const result = await notifyDiscord(
    "TASK_BLOCKED",
    { project: "demo", task: "Task 24", reason: "Needs input" },
    {
      env: { CODEX_DISCORD_WEBHOOK_URL: secret },
      fetchImpl: async () => ({ ok: false, status: 429 }),
    },
  );

  assert.equal(result.sent, false);
  assert.equal(result.reason, "HTTP_429");
  assert.doesNotMatch(JSON.stringify(result), /private-secret/);
});
