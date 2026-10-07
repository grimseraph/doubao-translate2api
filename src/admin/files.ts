import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ServiceError } from "../core/errors.js";

export async function writePrivate(path: string, value: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch {
    throw new ServiceError("admin_storage_error", 500, "Management data could not be saved. Check directory permissions.");
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
