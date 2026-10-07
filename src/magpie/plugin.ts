import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { importCookie } from "../admin/accounts.js";
import { loadConfig } from "../config/env.js";
import { ServiceError, asServiceError, invalid } from "../core/errors.js";
import { models } from "../core/models.js";
import { Translator } from "../core/translator.js";
import type { Protocol } from "../core/translation-request.js";
import { DoubaoClient } from "../doubao/client.js";
import { normalizeLanguage } from "../doubao/languages.js";
import { adaptRequest } from "../protocols/adapter.js";
import { formatJSON, formatSSE } from "../protocols/format.js";

const PROVIDER = "doubao-translate";
// Requests end in the local fetch hook; this address is never contacted.
const BASE = "https://doubao-translate.invalid/v1";
const positive = z.number().int().positive();
const optionsSchema = z.object({
  targetLang: z.string().default("zh").refine(value => {
    try { normalizeLanguage(value); return true; } catch { return false; }
  }, "Unsupported target language.").transform(normalizeLanguage),
  scene: positive.max(6).default(2),
  maxConcurrency: positive.max(1000).default(4),
  requestTimeoutMs: positive.default(45000),
  totalTimeoutMs: positive.default(180000),
  authTimeoutMs: positive.default(10000),
  maxRetries: z.number().int().min(0).max(10).default(0),
  queueMax: z.number().int().min(0).default(100),
  queueTimeoutMs: positive.default(30000),
}).strict();

interface Auth {
  type: string;
  key?: string;
  metadata?: Record<string, unknown>;
}
type GetAuth = () => Promise<Auth | undefined>;
interface Provider {
  models: Record<string, unknown>;
}
interface OpenCodeConfig {
  provider?: Record<string, unknown>;
}

function cookieFor(auth: Auth | undefined) {
  if (auth?.type !== "api" || !auth.key)
    throw new ServiceError("cookie_missing", 401, "Sign in with your Doubao Cookie first.");
  try { return importCookie(auth.key); }
  catch {
    throw Object.assign(new ServiceError("cookie_invalid", 401, "Doubao Cookie is invalid. Sign in again."),
      { signIn: "expired" });
  }
}

function expired(error: ServiceError) {
  return ["cookie_missing", "cookie_invalid", "upstream_auth_error"].includes(error.code);
}

function failure(error: unknown, protocol?: Protocol) {
  const value = asServiceError(error);
  const isExpired = expired(value);
  const status = isExpired ? 401 : value.upstreamStatus === 429 ? 429 : value.status;
  const type = isExpired ? "authentication_error" : status === 429 ? "rate_limit_error" :
    status < 500 ? "invalid_request_error" : "api_error";
  return Response.json(protocol === "anthropic" ? { type: "error", error: { type, message: value.message } } :
    { error: { message: value.message, type, code: value.code, param: value.param } }, {
    status,
    headers: isExpired ? { "X-Magpie-Sign-In": "expired" } : {},
  });
}

export const DoubaoTranslatePlugin = async (_input: unknown, rawOptions?: unknown) => {
  const parsed = optionsSchema.safeParse(rawOptions ?? {});
  if (!parsed.success) throw new Error("Invalid Doubao plugin options: " +
    parsed.error.issues.map(issue => issue.path.join(".") || "options").join(", "));
  const options = parsed.data;
  const config = loadConfig({
    ADMIN_ENABLED: "false",
    ALLOW_NO_AUTH: "true",
    DOUBAO_DEFAULT_TARGET_LANG: options.targetLang,
    DOUBAO_DEFAULT_SCENE: String(options.scene),
    DOUBAO_MAX_CONCURRENCY: String(options.maxConcurrency),
    DOUBAO_REQUEST_TIMEOUT_MS: String(options.requestTimeoutMs),
    DOUBAO_TOTAL_TIMEOUT_MS: String(options.totalTimeoutMs),
    DOUBAO_AUTH_TIMEOUT_MS: String(options.authTimeoutMs),
    DOUBAO_MAX_RETRIES: String(options.maxRetries),
    DOUBAO_QUEUE_MAX: String(options.queueMax),
    DOUBAO_QUEUE_TIMEOUT_MS: String(options.queueTimeoutMs),
  });
  const client = new DoubaoClient(config);
  const translator = new Translator(config, client);
  const defaultModels = Object.fromEntries(models.map(model => [model.id, {
    name: model.display_name,
    // Conservative gateway budgets, not a claimed upstream token allowance.
    limit: { context: 32000, output: 32000 },
    tool_call: false,
    reasoning: false,
    modalities: { input: ["text"], output: ["text"] },
  }]));

  async function inspect(getAuth: GetAuth) {
    const cookie = cookieFor(await getAuth());
    const status = await translator.authStatus(new AbortController().signal, async () => cookie);
    if (!status.authenticated) {
      const refused = status.reason === "cookie_expired" || status.reason === "cookie_invalid" ||
        (status.reason === "upstream_auth_error" && status.upstream_code === undefined);
      const error = new ServiceError(status.reason ?? "upstream_auth_error", 502,
        refused ? "Doubao login has expired. Sign in again with a new Cookie." : "Could not verify Doubao login. Try again later.");
      if (refused) throw Object.assign(error, { signIn: "expired" });
      throw error;
    }
    return cookie;
  }

  return {
    config: async (cfg: OpenCodeConfig) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "Doubao Translation",
        npm: "@ai-sdk/openai-compatible",
        api: BASE,
        models: defaultModels,
      };
    },
    auth: {
      provider: PROVIDER,
      maxConcurrency: options.maxConcurrency,
      methods: [{
        // The host's custom login flow can save a key without asking for a second API key.
        type: "oauth" as const,
        label: "Import Doubao Cookie",
        prompts: [
          {
            type: "text" as const, key: "cookie", message: "Doubao Cookie Header or exported JSON",
            validate: (value: string) => {
              try { importCookie(value); }
              catch { return "Cookie must include sessionid, sid_tt and uid_tt."; }
              return undefined;
            },
          },
          { type: "text" as const, key: "name", message: "Account name (optional)" },
        ],
        async authorize(inputs?: Record<string, string>) {
          return {
            url: "",
            instructions: "Checking your Doubao Cookie.",
            method: "auto" as const,
            async callback() {
              try {
                const cookie = importCookie(inputs?.cookie ?? "");
                await inspect(async () => ({ type: "api", key: cookie.cookie }));
                const uid = cookie.cookie.split(";").map(value => value.trim()).find(value => value.startsWith("uid_tt="))!;
                const fingerprint = createHash("sha256").update(uid).digest("hex").slice(0, 12);
                return {
                  type: "success" as const,
                  key: cookie.cookie,
                  metadata: { email: `${inputs?.name?.trim().slice(0, 64) || "Doubao"} (${fingerprint})` },
                };
              } catch (error) {
                return { type: "failed" as const, error: asServiceError(error).message };
              }
            },
          };
        },
      }],
      async loader(getAuth: GetAuth) {
        return {
          baseURL: BASE,
          // Never put the saved Cookie in the gateway's Authorization header.
          apiKey: "doubao-translate-local",
          async fetch(input: string | URL | Request, init?: RequestInit) {
            const request = new Request(input, init);
            const url = new URL(request.url);
            const protocol: Protocol | undefined = {
              "/v1/chat/completions": "openai-chat",
              "/v1/responses": "openai-responses",
              "/v1/messages": "anthropic",
            }[url.pathname] as Protocol | undefined;
            try {
              request.signal.throwIfAborted();
              if (url.origin !== new URL(BASE).origin || request.method !== "POST" || !protocol)
                throw invalid("Unsupported translation endpoint.");
              const text = await request.text();
              if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new ServiceError("request_too_large", 413, "Translation request is too large.");
              let body: unknown;
              try { body = JSON.parse(text); }
              catch { throw invalid("Invalid request JSON."); }
              const adapted = adaptRequest(protocol, body, request.headers.get("x-doubao-target-lang") ?? undefined,
                options.scene, randomUUID(), options.targetLang);
              const cookie = cookieFor(await getAuth());
              const result = await translator.translate(adapted.canonical, request.signal, async () => cookie);
              if (adapted.canonical.stream) return new Response(formatSSE(protocol, result, adapted), {
                headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
              });
              return Response.json(formatJSON(protocol, result, adapted));
            } catch (error) {
              if (request.signal.aborted) throw request.signal.reason;
              return failure(error, protocol);
            }
          },
        };
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider: Provider, { auth }: { auth?: Auth } = {}) {
        if (auth?.type === "api") await inspect(async () => auth);
        return provider.models;
      },
    },
  };
};
