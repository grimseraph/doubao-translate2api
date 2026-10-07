import Fastify, { LogController, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import type { Config } from "./config/env.js";
import { authenticate } from "./auth/api-key.js";
import { DoubaoClient, type Fetch } from "./doubao/client.js";
import { languages } from "./doubao/languages.js";
import { Translator } from "./core/translator.js";
import { asServiceError, ServiceError } from "./core/errors.js";
import { models } from "./core/models.js";
import type { Protocol } from "./core/translation-request.js";
import { adaptRequest } from "./protocols/adapter.js";
import { formatJSON, formatSSE } from "./protocols/format.js";
import { AccountPool } from "./admin/accounts.js";
import { registerAdmin } from "./admin/routes.js";
import { ApiKeyStore } from "./auth/api-key-store.js";
import { listModels } from "./protocols/model-list.js";
import { TranslationSettings } from "./admin/translation-settings.js";
import { UsageStore } from "./admin/usage.js";

export function createApp(config: Config, options: { fetcher?: Fetch; logger?: FastifyServerOptions["logger"] } = {}) {
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024, trustProxy: config.TRUST_PROXY?.split(",").map(x => x.trim()).filter(Boolean) ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-api-key"],
      serializers: { err: () => ({ type: "ServiceError", message: "Service error", stack: "" }) },
    },
  });
  const client = new DoubaoClient(config, options.fetcher,
    (code, fields) => app.log.warn({ code, ...fields }, "Upstream diagnostic"));
  const pool = config.ADMIN_ENABLED ? new AccountPool(config) : undefined;
  const apiKeys = new ApiKeyStore(config);
  const settings = new TranslationSettings(config);
  const usage = new UsageStore(config.ADMIN_DATA_DIR, () => app.log.warn({ code: "usage_storage_error" }, "Usage storage unavailable"));
  let storageTimer: ReturnType<typeof setInterval> | undefined;
  const flush = async () => {
    await usage.flush();
    await pool?.flush().catch(() => app.log.warn({ code: "account_state_storage_error" }, "Account runtime state could not be saved"));
  };
  app.addHook("onReady", async () => {
    await apiKeys.initialize(); await settings.initialize(); await usage.initialize();
    storageTimer = setInterval(() => { void flush(); }, 10000); storageTimer.unref();
  });
  app.addHook("onClose", async () => { clearInterval(storageTimer); await flush(); });
  const translator = new Translator(config, client, pool, usage);
  const controllers = new Map<string, AbortController>();
  if (config.ALLOW_NO_AUTH) app.log.warn("API authentication is disabled.");
  if (config.CORS_ORIGINS) app.register(cors, {
    origin: config.CORS_ORIGINS.split(",").map(x => x.trim()).filter(Boolean),
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "anthropic-version", "X-Doubao-Target-Lang"],
  });
  app.addHook("onRequest", async request => {
    const path = request.url.split("?")[0];
    const adminPath = config.ADMIN_ENABLED && (path === "/admin" || path?.startsWith("/admin/"));
    if (path !== "/" && path !== "/health" && !adminPath) authenticate(request.headers, apiKeys.keys, config.ALLOW_NO_AUTH);
  });
  app.setErrorHandler((error, request, reply) => {
    const fastifyStatus = (error as { statusCode?: number }).statusCode;
    const service = error instanceof ServiceError ? error :
      fastifyStatus === 413 ? new ServiceError("invalid_request", 413, "Request body exceeds 2 MB limit.") :
      fastifyStatus === 400 ? new ServiceError("invalid_request", 400, "Invalid JSON request body.") : asServiceError(error);
    const type = service.status === 401 ? "authentication_error" :
      service.status === 429 ? "rate_limit_error" : service.status < 500 ? "invalid_request_error" : "api_error";
    app.log.warn({ request_id: request.id, code: service.code, status_code: service.status, upstream_code: service.upstreamCode }, "Request failed");
    reply.code(service.status).send(request.url.split("?")[0] === "/v1/messages"
      ? { type: "error", error: { type, message: service.message } }
      : { error: { message: service.message, type, param: service.param, code: service.code } });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({
    ...(request.url.split("?")[0] === "/v1/messages" ? { type: "error" } : {}),
    error: { type: "invalid_request_error", message: "Route not found.", code: "not_found" },
  }));
  app.get("/", async () => ({ name: "doubao-translate2api", version: "0.1.3", status: "ok" }));
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/info", async () => ({
    name: "doubao-translate2api", version: "0.1.3",
    protocols: ["openai-chat", "openai-responses", "anthropic"],
    models: models.map(x => x.id), supported_languages: languages,
    default_target_lang: settings.defaultTargetLang,
  }));
  app.get("/v1/models", async request => listModels(request.query));
  app.get<{ Params: { model: string } }>("/v1/models/:model", async request => {
    const model = models.find(x => x.id === request.params.model);
    if (!model) throw new ServiceError("model_not_found", 404, "Model not found.", false, "model");
    return model;
  });
  // Keep cancellation active until the response closes, including after the body is read.
  app.addHook("preHandler", async (request, reply) => {
    const controller = new AbortController();
    controllers.set(request.id, controller);
    const abort = () => controller.abort(new Error("Client disconnected."));
    const onClose = () => {
      if (!reply.raw.writableFinished) abort();
      controllers.delete(request.id);
      request.raw.removeListener("aborted", abort);
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", onClose);
  });
  app.addHook("onResponse", async request => { controllers.delete(request.id); });
  app.addHook("preClose", async () => {
    controllers.forEach(controller => controller.abort(new Error("Server shutting down.")));
  });
  if (pool) registerAdmin(app, config, pool, translator, id => controllers.get(id)!.signal, apiKeys, settings, usage);
  app.get("/auth/status", async request => translator.authStatus(controllers.get(request.id)!.signal));
  for (const [path, protocol] of [
    ["/v1/chat/completions", "openai-chat"], ["/v1/responses", "openai-responses"], ["/v1/messages", "anthropic"],
  ] as Array<[string, Protocol]>) {
    app.post(path, async (request, reply) => {
      const language = request.headers["x-doubao-target-lang"];
      const adapted = adaptRequest(protocol, request.body, typeof language === "string" ? language : undefined,
        config.DOUBAO_DEFAULT_SCENE, request.id, settings.defaultTargetLang);
      const result = await translator.translate(adapted.canonical, controllers.get(request.id)!.signal);
      app.log.info({
        request_id: request.id, protocol, model: result.model, target_lang: adapted.canonical.targetLang,
        scene: adapted.canonical.scene, input_chars: adapted.canonical.rawText.length,
        batch_count: result.upstreamBatchCount, elapsed_ms: Math.round(result.elapsedMs), status_code: 200,
      }, "Translation completed");
      if (!adapted.canonical.stream) return formatJSON(protocol, result, adapted);
      return reply.header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache").header("Connection", "keep-alive")
        .header("X-Accel-Buffering", "no").send(formatSSE(protocol, result, adapted));
    });
  }
  return app;
}
