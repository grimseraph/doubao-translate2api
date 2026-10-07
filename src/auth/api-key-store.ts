import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/env.js";
import { writePrivate } from "../admin/files.js";
import { ServiceError } from "../core/errors.js";

export class ApiKeyStore {
  private generated = "";
  private pending: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  constructor(private readonly config: Config) {
    this.path = join(config.ADMIN_DATA_DIR, "api-key.txt");
  }
  get keys() { return this.config.keys.length ? this.config.keys : this.generated ? [this.generated] : []; }
  get metadata() {
    const source = this.config.ALLOW_NO_AUTH ? "disabled" : this.config.keys.length ? "environment" : "generated";
    return { source, count: source === "disabled" ? 0 : this.keys.length, canRotate: source === "generated" };
  }
  async initialize() {
    if (this.config.ALLOW_NO_AUTH || this.config.keys.length) return;
    try {
      const key = (await readFile(this.path, "utf8")).trim();
      if (!/^dbt_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("Invalid stored key.");
      this.generated = key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw this.storageError();
      await this.save();
    }
  }
  reveal() {
    if (this.metadata.source === "disabled")
      throw new ServiceError("api_auth_disabled", 409, "API authentication is disabled.");
    const key = this.keys[0];
    if (!key) throw this.storageError();
    return { key };
  }
  async rotate() {
    if (!this.metadata.canRotate)
      throw new ServiceError("api_key_managed_externally", 409, "API keys configured through environment variables cannot be changed here.");
    const action = this.pending.then(() => this.save());
    this.pending = action.catch(() => {});
    await action;
    return this.metadata;
  }
  private async save() {
    const key = "dbt_" + randomBytes(32).toString("base64url");
    try { await writePrivate(this.path, key + "\n"); }
    catch { throw this.storageError(); }
    this.generated = key;
  }
  private storageError() {
    return new ServiceError("api_key_storage_error", 500, "API key could not be loaded or saved. Check the data directory.");
  }
}
