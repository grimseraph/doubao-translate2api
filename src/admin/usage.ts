import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { TranslationRequest } from "../core/translation-request.js";
import { writePrivate } from "./files.js";

const count = z.number().finite().nonnegative();
const daySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), requests: count, succeeded: count,
  failed: count, cancelled: count, inputChars: count, elapsedMs: count, queueMs: count,
  upstreamCalls: count, retries: count, switches: count, samples: z.array(count).max(256),
});
const failureSchema = z.object({
  time: count.max(8640000000000000), model: z.string().max(64), protocol: z.string().max(32),
  code: z.string().max(64), elapsedMs: count,
});
const schema = z.object({
  version: z.literal(1), days: z.array(daySchema).max(30), failures: z.array(failureSchema).max(50),
});
type Day = z.infer<typeof daySchema>;
export interface UsageTrace { upstreamCalls: number; retries: number; switches: number; queueMs: number }

export class UsageStore {
  private state: z.infer<typeof schema> = { version: 1, days: [], failures: [] };
  private revision = 0;
  private saved = 0;
  private pending: Promise<void> = Promise.resolve();
  private storageError = false;
  private readable = true;
  constructor(private directory: string, private warn: () => void) {}
  async initialize() {
    try { this.state = schema.parse(JSON.parse(await readFile(join(this.directory, "usage.json"), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.storageError = true; this.readable = false; this.warn();
      }
    }
    this.prune();
  }
  private prune() {
    const cutoff = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    this.state.days = this.state.days.filter(day => day.date >= cutoff).slice(-30);
    this.state.failures = this.state.failures.filter(item => new Date(item.time).toISOString().slice(0, 10) >= cutoff).slice(0, 50);
  }
  record(req: TranslationRequest, elapsedMs: number, trace: UsageTrace, code?: string) {
    this.prune();
    const date = new Date().toISOString().slice(0, 10);
    let day = this.state.days.find(item => item.date === date);
    if (!day) {
      day = { date, requests: 0, succeeded: 0, failed: 0, cancelled: 0, inputChars: 0,
        elapsedMs: 0, queueMs: 0, upstreamCalls: 0, retries: 0, switches: 0, samples: [] };
      this.state.days.push(day);
    }
    day.requests++;
    day[code === "client_cancelled" ? "cancelled" : code ? "failed" : "succeeded"]++;
    day.inputChars += Array.from(req.rawText).length;
    day.elapsedMs += elapsedMs; day.queueMs += trace.queueMs;
    day.upstreamCalls += trace.upstreamCalls; day.retries += trace.retries; day.switches += trace.switches;
    day.samples.push(Math.round(elapsedMs)); day.samples = day.samples.slice(-256);
    if (code && code !== "client_cancelled") {
      this.state.failures.unshift({ time: Date.now(), model: req.model, protocol: req.protocol, code, elapsedMs: Math.round(elapsedMs) });
      this.state.failures = this.state.failures.slice(0, 50);
    }
    this.revision++;
  }
  snapshot() {
    this.prune();
    const today = this.state.days.find(day => day.date === new Date().toISOString().slice(0, 10));
    const samples = [...(today?.samples ?? [])].sort((a, b) => a - b);
    return {
      ...structuredClone(this.state), today: today ?? null, timezone: "UTC",
      averageMs: today?.requests ? Math.round(today.elapsedMs / today.requests) : null,
      averageQueueMs: today?.requests ? Math.round(today.queueMs / today.requests) : null,
      p95Ms: samples.length ? samples[Math.ceil(samples.length * .95) - 1] : null,
      sampleCount: samples.length, persistence: this.storageError ? "error" : this.saved === this.revision ? "saved" : "pending",
    };
  }
  flush() {
    this.pending = this.pending.then(async () => {
      if (!this.readable || this.saved === this.revision) return;
      const revision = this.revision;
      try {
        await writePrivate(join(this.directory, "usage.json"), JSON.stringify(this.state));
        this.saved = revision;
        this.storageError = false;
      } catch { this.storageError = true; this.warn(); }
    });
    return this.pending;
  }
}
