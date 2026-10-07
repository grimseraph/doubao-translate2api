import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { languages, normalizeLanguage, type DoubaoLang } from "../doubao/languages.js";
import { ServiceError } from "../core/errors.js";
import { writePrivate } from "./files.js";

const schema = z.object({ version: z.literal(1), defaultTargetLang: z.enum(languages) });
export class TranslationSettings {
  private language: DoubaoLang;
  private readonly path: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly config: Config) {
    this.language = config.DOUBAO_DEFAULT_TARGET_LANG;
    this.path = join(config.ADMIN_DATA_DIR, "settings.json");
  }
  get defaultTargetLang() { return this.language; }
  get metadata() { return { defaultTargetLang: this.language, supportedLanguages: [...languages] }; }
  async initialize() {
    if (!this.config.ADMIN_ENABLED) return;
    try { this.language = schema.parse(JSON.parse(await readFile(this.path, "utf8"))).defaultTargetLang; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ServiceError("admin_storage_error", 500, "Saved translation settings are invalid.");
      await this.save(this.language);
    }
  }
  async update(value: string) {
    const language = normalizeLanguage(value);
    const action = this.pending.then(() => this.save(language));
    this.pending = action.catch(() => {});
    await action;
    return this.metadata;
  }
  private async save(language: DoubaoLang) {
    await writePrivate(this.path, JSON.stringify({ version: 1, defaultTargetLang: language }));
    this.language = language;
  }
}
