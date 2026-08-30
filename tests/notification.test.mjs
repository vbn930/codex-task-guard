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

test("sends a concise quota pause message without exposing the webhook", async () => {
  let request;
  const result = await notifyDiscord(
    "QUOTA_PAUSED",
    {
      project: "demo",
      task: "Task 24",
      reason: "5-hour quota low",
      checkpoint: "Saved",
      reset: "2026-08-31T12:00:00Z",
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
  assert.match(body.content, /Codex Task Paused/);
  assert.match(body.content, /Task 24/);
  assert.doesNotMatch(body.content, /webhooks\/secret/);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
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
