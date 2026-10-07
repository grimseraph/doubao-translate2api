import type { UpstreamConfig } from "../core/translation-config.js";
import type { CookieProvider, CookieValue } from "../auth/cookie.js";
import { concatBytes } from "../core/bytes.js";
import { ServiceError } from "../core/errors.js";
import type { DoubaoEngine, DoubaoScene } from "../core/models.js";
import type { DoubaoLang } from "./languages.js";
import { SSEParser } from "./sse-parser.js";

export type Fetch = typeof fetch;
export type Warn = (code: string, fields?: Record<string, number>) => void;
const ORIGIN = "https://www.doubao.com";
const MAX_BODY = 8 * 1024 * 1024;
const knownCodes: Record<number, string> = {
  710012001: "upstream_auth_error",
  710010202: "upstream_bad_request",
  710020202: "upstream_bad_request",
  710020702: "upstream_stream_error",
};
function businessError(code: number) {
  return new ServiceError(knownCodes[code] ?? "upstream_stream_error", 502,
    code === 710012001 ? "Upstream login has expired." : "Upstream translation failed.",
    !Object.hasOwn(knownCodes, code), null, code);
}
function parseJSON(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Only a sanitized error leaves this boundary. */ }
  throw new ServiceError("upstream_stream_error", 502, "Invalid upstream response.");
}
function checkCode(value: Record<string, unknown>) {
  if (typeof value.code === "number" && value.code !== 0) throw businessError(value.code);
}
export interface BatchRequest {
  texts: string[];
  targetLang: DoubaoLang;
  engine: DoubaoEngine;
  scene: DoubaoScene;
}
export function buildRequestBody(req: BatchRequest) {
  return {
    raw_text: req.texts, target_lang: req.targetLang, translate_service: req.engine,
    scene: req.scene, frontend_source: 1,
  };
}
export class DoubaoTransport {
  constructor(private config: UpstreamConfig, private fetcher: Fetch = fetch, private warn: Warn = () => {},
    private defaultCookie?: CookieProvider) {}
  private cookie(provider?: CookieProvider) {
    const selected = provider ?? this.defaultCookie;
    if (!selected) throw new ServiceError("cookie_missing", 502, "No Cookie provider is configured.");
    return selected();
  }
  private async request(path: string, signal: AbortSignal, init: RequestInit, timeout: number, suppliedCookie?: CookieValue) {
    const { cookie, complete } = suppliedCookie ?? await this.cookie();
    if (!complete) throw new ServiceError("cookie_invalid", 502, "Required login cookies are missing.");
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    const headers = new Headers(init.headers);
    headers.set("Cookie", cookie);
    if (this.config.DOUBAO_USER_AGENT) headers.set("User-Agent", this.config.DOUBAO_USER_AGENT);
    try {
      const response = await this.fetcher.call(globalThis, ORIGIN + path, { ...init, headers, signal: combined, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ServiceError("upstream_network_error", 502, "Upstream redirects are not allowed.", true);
      }
      if (!response.ok) {
        await response.body?.cancel();
        const authError = response.status === 401 || response.status === 403;
        throw new ServiceError(authError ? "upstream_auth_error" : "upstream_http_error", 502,
          "Upstream HTTP request failed.", response.status >= 500 || response.status === 429, null, undefined, response.status);
      }
      return { response, combined };
    } catch (error) { throw this.transportError(error, signal, combined); }
  }
  private transportError(error: unknown, signal: AbortSignal, combined: AbortSignal): unknown {
    if (signal.aborted) return signal.reason;
    if (error instanceof ServiceError) return error;
    if (combined.aborted) return new ServiceError("upstream_timeout", 504, "Upstream request timed out.", true);
    return new ServiceError("upstream_network_error", 502, "Upstream connection failed.", true);
  }
  async translate(req: BatchRequest, signal: AbortSignal, provider?: CookieProvider) {
    const { response, combined } = await this.request("/samantha/plugin/stream_article_translate", signal, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "*/*" },
      body: JSON.stringify(buildRequestBody(req)),
    }, this.config.DOUBAO_REQUEST_TIMEOUT_MS, provider ? await provider() : undefined);
    const reader = response.body?.getReader();
    if (!reader) throw new ServiceError("upstream_stream_error", 502, "Upstream response body is missing.", true);
    const results = new Map<number, string>();
    const detected = new Set<string>();
    let done = false;
    const parser = new SSEParser(event => {
      if (event.event === "done") { done = true; return; }
      if (event.event !== "json" && event.event !== "err" && event.event !== "message") return;
      const value = parseJSON(event.data);
      checkCode(value);
      if (event.event === "err") throw new ServiceError("upstream_stream_error", 502, "Upstream stream reported an error.");
      const data = value.data as { items?: unknown } | undefined;
      if (!Array.isArray(data?.items)) return;
      for (const item of data.items) {
        if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= req.texts.length) {
          this.warn("invalid_item_index"); continue;
        }
        if (typeof item.res !== "string" || (req.texts[item.index]?.trim() && !item.res.trim())) {
          this.warn("invalid_item_result"); continue;
        }
        if (results.has(item.index)) { this.warn("duplicate_item_index", { index: item.index }); continue; }
        results.set(item.index, item.res);
        if (typeof item.detect_lang === "string") detected.add(item.detect_lang);
      }
    });
    const type = response.headers.get("content-type")?.toLowerCase() ?? "";
    let mode: "sse" | "json" | undefined = type.includes("text/event-stream") ? "sse" :
      type.includes("application/json") ? "json" : undefined;
    let bytes = 0;
    let pending: Uint8Array[] = [];
    let pendingLength = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > (this.config.DOUBAO_MAX_RESPONSE_BYTES ?? MAX_BODY))
          throw new ServiceError("upstream_stream_error", 502, "Upstream response exceeds size limit.");
        if (mode === "sse") { parser.push(chunk.value); continue; }
        pending.push(chunk.value); pendingLength += chunk.value.byteLength;
        if (!mode) {
          const probe = new TextDecoder().decode(concatBytes(pending).subarray(0, 64)).trimStart();
          if (probe.startsWith("{")) mode = "json";
          else if (/^(?:event:|data:|id:|retry:|:)/.test(probe)) {
            mode = "sse";
            pending.forEach(x => parser.push(x)); pending = [];
          } else if (pendingLength >= 64)
            throw new ServiceError("upstream_stream_error", 502, "Unrecognized upstream response.");
        }
      }
      if (mode !== "sse") {
        const value = parseJSON(new TextDecoder().decode(concatBytes(pending)));
        checkCode(value);
        throw new ServiceError("upstream_incomplete_result", 502, "Upstream returned no translation items.");
      }
      parser.finish();
      if (results.size !== req.texts.length)
        throw new ServiceError("upstream_incomplete_result", 502, "Upstream translation is incomplete.", results.size === 0 && !done);
      if (!done) this.warn("missing_done_event");
      return { texts: req.texts.map((_, i) => results.get(i)!), detectedLanguages: [...detected] };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw this.transportError(error, signal, combined);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async authStatus(signal: AbortSignal, provider?: CookieProvider) {
    let loaded = false, complete = false;
    try {
      const stored = await this.cookie(provider);
      loaded = true; complete = stored.complete;
      if (!complete) return { authenticated: false, cookie_loaded: true, required_login_cookies_present: false, reason: "cookie_invalid" };
      const { response, combined } = await this.request("/samantha/plugin/user_settings/get?frontend_source=1", signal,
        { method: "GET" }, this.config.DOUBAO_AUTH_TIMEOUT_MS, stored);
      let value: Record<string, unknown>;
      try {
        const reader = response.body?.getReader();
        if (!reader) throw new ServiceError("upstream_stream_error", 502, "Upstream response body is missing.");
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.length;
            if (length > (this.config.DOUBAO_MAX_RESPONSE_BYTES ?? MAX_BODY))
              throw new ServiceError("upstream_stream_error", 502, "Upstream response exceeds size limit.");
            chunks.push(chunk.value);
          }
          value = parseJSON(new TextDecoder().decode(concatBytes(chunks)));
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch (error) { throw this.transportError(error, signal, combined); }
      return {
        authenticated: value.code === 0, cookie_loaded: true, required_login_cookies_present: true,
        ...(typeof value.code === "number" ? { upstream_code: value.code } : {}),
        ...(value.code === 0 ? {} : { reason: value.code === 710012001 ? "cookie_expired" : "upstream_auth_error" }),
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return { authenticated: false, cookie_loaded: loaded, required_login_cookies_present: complete,
        reason: error instanceof ServiceError ? error.code : "upstream_network_error" };
    }
  }
}
