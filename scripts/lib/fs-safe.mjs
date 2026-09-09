import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function withFileLock(lockPath, operation, {
  timeoutMs = 5_000,
  staleMs = 30_000,
  retryMs = 25,
  timeoutMessage = "Timed out waiting for the file lock",
  ownerText = null,
} = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
      if (ownerText !== null) await handle.writeFile(ownerText, "utf8");
    } catch (error) {
      const windowsLockContention = process.platform === "win32"
        && ["EACCES", "EPERM"].includes(error.code);
      if (error.code !== "EEXIST" && !windowsLockContention) throw error;
      const metadata = await stat(lockPath).catch(() => null);
      if (metadata && Date.now() - metadata.mtimeMs > staleMs) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}
