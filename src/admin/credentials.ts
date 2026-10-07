import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { ServiceError } from "../core/errors.js";
import { writePrivate } from "./files.js";

const derive = promisify(scrypt);
const schema = z.object({
  salt: z.string().regex(/^[a-f0-9]{32}$/), hash: z.string().regex(/^[a-f0-9]{128}$/),
  secret: z.string().min(64), version: z.string(),
});
export class AdminCredentials {
  private value!: z.infer<typeof schema>;
  private path: string;
  constructor(private config: Config) { this.path = join(config.ADMIN_DATA_DIR, "credentials.json"); }
  async initialize() {
    try { this.value = schema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ServiceError("admin_storage_error", 500, "Saved management credentials are invalid.");
      const password = this.config.ADMIN_PASSWORD ?? randomBytes(24).toString("base64url");
      const salt = randomBytes(16).toString("hex");
      this.value = {
        salt, hash: ((await derive(password, salt, 64)) as Buffer).toString("hex"),
        secret: randomBytes(48).toString("hex"), version: randomBytes(16).toString("hex"),
      };
      if (!this.config.ADMIN_PASSWORD)
        await writePrivate(join(this.config.ADMIN_DATA_DIR, "initial-password.txt"), password + "\n");
      await writePrivate(this.path, JSON.stringify(this.value));
    }
  }
  get secret() { return this.value.secret; }
  get version() { return this.value.version; }
  async verify(password: string) {
    const value = this.value;
    const hash = (await derive(password, value.salt, 64)) as Buffer;
    return timingSafeEqual(hash, Buffer.from(value.hash, "hex"));
  }
  async change(password: string) {
    const salt = randomBytes(16).toString("hex");
    const value = { ...this.value, salt,
      hash: ((await derive(password, salt, 64)) as Buffer).toString("hex"),
      version: randomBytes(16).toString("hex") };
    await writePrivate(this.path, JSON.stringify(value));
    this.value = value;
    await rm(join(this.config.ADMIN_DATA_DIR, "initial-password.txt"), { force: true });
  }
}
