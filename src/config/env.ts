import { z } from "zod";
import { dirname, join } from "node:path";
import { normalizeLanguage } from "../doubao/languages.js";

const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const boolean = z.enum(["true", "false"]).default("false").transform(x => x === "true");
const defaultLanguage = z.preprocess(value => typeof value === "string" && !value.trim() ? undefined : value,
  z.string().refine(value => {
    try { normalizeLanguage(value); return true; } catch { return false; }
  }, "Unsupported default target language.").transform(normalizeLanguage).default("zh"));
const schema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: positive(8000).pipe(z.number().max(65535)),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  API_KEY: z.string().optional(),
  API_KEYS: z.string().optional(),
  ALLOW_NO_AUTH: boolean,
  DOUBAO_COOKIE_FILE: z.string().default("/data/cookie.txt"),
  DOUBAO_DEFAULT_SCENE: positive(2).pipe(z.number().max(6)),
  DOUBAO_DEFAULT_TARGET_LANG: defaultLanguage,
  DOUBAO_REQUEST_TIMEOUT_MS: positive(45000),
  DOUBAO_TOTAL_TIMEOUT_MS: positive(180000),
  DOUBAO_AUTH_TIMEOUT_MS: positive(10000),
  DOUBAO_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  DOUBAO_MAX_CONCURRENCY: positive(8),
  DOUBAO_QUEUE_MAX: z.coerce.number().int().min(0).default(100),
  DOUBAO_QUEUE_TIMEOUT_MS: positive(30000),
  DOUBAO_USER_AGENT: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  ADMIN_ENABLED: z.enum(["true", "false"]).default("true").transform(x => x === "true"),
  ADMIN_DATA_DIR: z.string().optional(),
  ADMIN_PASSWORD: z.string().min(12).max(256).optional(),
  ADMIN_COOKIE_SECURE: boolean,
  ADMIN_ORIGIN: z.url().optional(),
  TRUST_PROXY: z.string().optional(),
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error("Invalid environment configuration: " +
    parsed.error.issues.map(issue => issue.path.join(".")).join(", "));
  const config = parsed.data;
  const keys = (config.API_KEYS !== undefined ? config.API_KEYS : config.API_KEY ?? "")
    .split(",").map(x => x.trim()).filter(Boolean);
  if (!config.ALLOW_NO_AUTH && config.API_KEYS !== undefined && !keys.length)
    throw new Error("API_KEYS must contain at least one key.");
  return { ...config, keys, ADMIN_DATA_DIR: config.ADMIN_DATA_DIR ?? join(dirname(config.DOUBAO_COOKIE_FILE), "admin") };
}
export type Config = ReturnType<typeof loadConfig>;
