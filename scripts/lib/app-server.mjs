import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_TIMEOUT_MS = 45_000;

export class AppServerClient {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, command = "codex", commandArgs = [] } = {}) {
    this.timeoutMs = timeoutMs;
    this.command = command;
    this.commandArgs = commandArgs;
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
    this.stderr = "";
  }

  async start() {
    this.process = spawn(this.command, [
      ...this.commandArgs,
      "app-server",
      "--listen",
      "stdio://",
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.once("error", (error) => this.#rejectAll(error));
    this.process.once("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      this.#rejectAll(new Error(`Codex app-server stopped with ${reason}`));
    });
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      this.#handleLine(line);
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "task_guard",
        title: "Task Guard",
        version: "0.3.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  request(method, params) {
    if (!this.process?.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method, params) {
    if (this.process?.stdin.writable) {
      this.process.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
      );
    }
  }

  stop() {
    if (this.process && !this.process.killed) this.process.kill();
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "Codex app-server error"));
    } else {
      pending.resolve(message.result);
    }
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function readRateLimits(options) {
  const client = new AppServerClient(options);
  try {
    await client.start();
    return await client.request("account/rateLimits/read", {});
  } finally {
    client.stop();
  }
}
