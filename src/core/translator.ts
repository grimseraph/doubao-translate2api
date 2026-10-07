import { delay } from "./delay.js";
import type { TranslationConfig } from "./translation-config.js";
import type { DoubaoTransport } from "../doubao/transport.js";
import { Semaphore } from "./concurrency.js";
import { ServiceError } from "./errors.js";
import { MODEL_ENGINE_MAP } from "./models.js";
import { buildBatches, segmentText } from "./segmenter.js";
import type { TranslationRequest, TranslationResult } from "./translation-request.js";
import { type AccountSource, isAccountFailure } from "./account-source.js";
import type { CookieProvider } from "../auth/cookie.js";
import type { UsageStore, UsageTrace } from "../admin/usage.js";

export class Translator {
  readonly semaphore: Semaphore;
  constructor(private config: TranslationConfig, readonly client: DoubaoTransport, private pool?: AccountSource, private usage?: UsageStore) {
    this.semaphore = new Semaphore(config.DOUBAO_MAX_CONCURRENCY, config.DOUBAO_QUEUE_MAX, config.DOUBAO_QUEUE_TIMEOUT_MS);
  }
  async translate(req: TranslationRequest, signal: AbortSignal, provider?: CookieProvider): Promise<TranslationResult> {
    const start = performance.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new ServiceError("translation_timeout", 504, "Translation exceeded its total time limit.")),
      this.config.DOUBAO_TOTAL_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, deadline.signal]);
    const trace: UsageTrace = { upstreamCalls: 0, retries: 0, switches: 0, queueMs: 0 };
    let code: string | undefined;
    try {
      return await this.run(req, combined, trace, provider);
    } catch (error) {
      const failure = combined.aborted ? combined.reason : error;
      code = signal.aborted ? "client_cancelled" : failure instanceof ServiceError ? failure.code : "internal_error";
      throw failure;
    } finally {
      clearTimeout(timer);
      this.usage?.record(req, performance.now() - start, trace, code);
    }
  }
  private async run(req: TranslationRequest, signal: AbortSignal, trace: UsageTrace, provider?: CookieProvider): Promise<TranslationResult> {
    const start = performance.now();
    const segments = segmentText(req.rawText, req.sourceFormat);
    const batches = buildBatches(segments.map(x => x.text));
    const output = segments.map(x => x.text);
    const detected = new Set<string>();
    let lease = this.pool && !provider ? await this.pool.choose() : undefined;
    const tried = new Set<string>(lease ? [lease.id] : []);
    let outputBytes = 0;
    for (const batch of batches) {
      let retries = 0;
      let attempts = 0;
      for (;;) {
        const queueStart = performance.now();
        let release: () => void;
        try { release = await this.semaphore.acquire(signal); }
        finally { trace.queueMs += performance.now() - queueStart; }
        let retry = false;
        let switched = false;
        try {
          if (attempts++ > 0) trace.retries++;
          trace.upstreamCalls++;
          const result = await this.client.translate({
            texts: batch.texts, targetLang: req.targetLang, scene: req.scene, engine: MODEL_ENGINE_MAP[req.model],
          }, signal, provider ?? lease?.provider);
          outputBytes += result.texts.reduce((sum, text) => sum + new TextEncoder().encode(text).byteLength, 0);
          if (outputBytes > (this.config.DOUBAO_MAX_OUTPUT_BYTES ?? 8 * 1024 * 1024))
            throw new ServiceError("upstream_stream_error", 502, "Translated output exceeds size limit.");
          batch.indexes.forEach((index, i) => { output[index] = result.texts[i]!; });
          result.detectedLanguages.forEach(x => detected.add(x));
          if (lease) await this.pool!.succeeded(lease.id, lease.revision);
        } catch (error) {
          if (signal.aborted) throw error;
          if (lease && isAccountFailure(error)) {
            await this.pool!.failed(lease.id, error, lease.revision);
            if (await this.pool!.allowsFailover()) {
              try {
                lease = await this.pool!.choose(tried); tried.add(lease.id);
                switched = true; retry = true; trace.switches++;
              } catch (selectionError) {
                if (!(selectionError instanceof ServiceError) || selectionError.code !== "no_available_cookie") throw selectionError;
              }
            }
          }
          if (!retry) {
            if (!(error instanceof ServiceError) || !error.retryable || retries >= this.config.DOUBAO_MAX_RETRIES) throw error;
            retry = true;
          }
        } finally { release(); }
        if (!retry) break;
        if (!switched) await delay(Math.min(250 * 3 ** retries++, 5000) + Math.random() * 100, signal);
      }
    }
    signal.throwIfAborted();
    return {
      model: req.model, text: segments.map((x, i) => output[i] + x.separator).join(""),
      detectedLanguages: [...detected], upstreamBatchCount: batches.length, elapsedMs: performance.now() - start,
    };
  }
  async authStatus(signal: AbortSignal, provider?: CookieProvider) {
    const release = await this.semaphore.acquire(signal);
    try {
      if (provider) return await this.client.authStatus(signal, provider);
      if (this.pool) {
        const { activeId } = await this.pool.list();
        return await this.client.authStatus(signal, () => this.pool!.getCookie(activeId));
      }
      return await this.client.authStatus(signal);
    } finally { release(); }
  }
}
