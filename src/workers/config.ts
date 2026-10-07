import { z } from "zod";
import { parseCookie } from "../auth/cookie.js";
import { ServiceError } from "../core/errors.js";
import { normalizeLanguage } from "../doubao/languages.js";

export interface WorkerEnv {
  API_KEY?: string;
  DOUBAO_COOKIE?: string;
  DOUBAO_DEFAULT_TARGET_LANG?: string;
  DOUBAO_DEFAULT_SCENE?: string;
  DOUBAO_REQUEST_TIMEOUT_MS?: string;
  DOUBAO_TOTAL_TIMEOUT_MS?: string;
  DOUBAO_AUTH_TIMEOUT_MS?: string;
  DOUBAO_MAX_RETRIES?: string;
  DOUBAO_MAX_CONCURRENCY?: string;
  DOUBAO_QUEUE_MAX?: string;
  DOUBAO_QUEUE_TIMEOUT_MS?: string;
  CORS_ORIGINS?: string;
  TRANSLATION_PROFILE?: string;
}
const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const schema = z.object({
  API_KEY: z.string().min(16).max(256).regex(/^[\x21-\x7e]+$/),
  DOUBAO_COOKIE: z.string().min(1),
  DOUBAO_DEFAULT_TARGET_LANG: z.string().default("zh"),
  DOUBAO_DEFAULT_SCENE: integer(2, 1, 6),
  DOUBAO_REQUEST_TIMEOUT_MS: integer(45000, 100, 120000),
  DOUBAO_TOTAL_TIMEOUT_MS: integer(90000, 100, 180000),
  DOUBAO_AUTH_TIMEOUT_MS: integer(10000, 100, 30000),
  DOUBAO_MAX_RETRIES: integer(0, 0, 2),
  DOUBAO_MAX_CONCURRENCY: integer(2, 1, 4),
  DOUBAO_QUEUE_MAX: integer(10, 0, 50),
  DOUBAO_QUEUE_TIMEOUT_MS: integer(10000, 100, 30000),
  CORS_ORIGINS: z.string().default("*"),
  TRANSLATION_PROFILE: z.enum(["plain", "immersive-translate"]).default("plain"),
});
export function workerConfig(env: WorkerEnv) {
  try {
    const value = schema.parse(env);
    const cookie = parseCookie(value.DOUBAO_COOKIE);
    if (!cookie.complete) throw new Error("Incomplete Cookie.");
    const origins = value.CORS_ORIGINS.split(",").map(x => x.trim()).filter(Boolean);
    if (!origins.length || (origins.includes("*") && origins.length !== 1))
      throw new Error("Invalid origins.");
    for (const origin of origins) {
      if (origin === "*") continue;
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error("Invalid origin.");
    }
    return { ...value, DOUBAO_DEFAULT_TARGET_LANG: normalizeLanguage(value.DOUBAO_DEFAULT_TARGET_LANG), origins,
      DOUBAO_MAX_RESPONSE_BYTES: 1024 * 1024, DOUBAO_MAX_OUTPUT_BYTES: 256 * 1024 };
  } catch {
    throw new ServiceError("configuration_error", 503,
      "Worker configuration is invalid. Check DOUBAO_COOKIE, API_KEY and variables in Cloudflare settings.");
  }
}
export type WorkerConfig = ReturnType<typeof workerConfig>;
