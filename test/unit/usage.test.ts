import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { UsageStore } from "../../src/admin/usage.js";
import type { TranslationRequest } from "../../src/core/translation-request.js";

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const req: TranslationRequest = { protocol: "openai-chat", model: "doubao-ai", targetLang: "zh",
  rawText: "private🙂", scene: 2, stream: false, requestId: "secret-id" };
const trace = { upstreamCalls: 1, retries: 0, switches: 0, queueMs: 5 };
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "usage-test-")); directories.push(dir);
  const warn = vi.fn(), usage = new UsageStore(dir, warn); await usage.initialize();
  return { dir, usage, warn };
}
it("bounds history and percentile samples, preserves unicode character counts and cancellation", async () => {
  const { usage } = await setup();
  vi.useFakeTimers();
  for (let day = 1; day <= 31; day++) {
    vi.setSystemTime(new Date(`2026-08-${String(day).padStart(2, "0")}T12:00:00Z`));
    usage.record(req, day, trace, "upstream_timeout");
  }
  for (let i = 0; i < 300; i++) usage.record(req, i, trace);
  usage.record(req, 10, trace, "client_cancelled");
  const snapshot = usage.snapshot();
  expect(snapshot.days).toHaveLength(30);
  expect(snapshot.sampleCount).toBe(256);
  expect(snapshot.today?.inputChars).toBe(302 * 8);
  expect(snapshot.today?.cancelled).toBe(1);
  expect(snapshot.failures).toHaveLength(30);
  expect(snapshot.p95Ms).toBeGreaterThan(280);
  for (let i = 0; i < 100; i++) usage.record(req, 10, trace, "queue_full");
  expect(usage.snapshot().failures).toHaveLength(50);
});
it("recovers from failed writes without blocking translation counters", async () => {
  const { dir, usage, warn } = await setup();
  await mkdir(join(dir, "usage.json"));
  usage.record(req, 12, trace);
  await usage.flush();
  expect(warn).toHaveBeenCalledOnce();
  expect(usage.snapshot().persistence).toBe("error");
  await rm(join(dir, "usage.json"), { recursive: true });
  await usage.flush();
  expect(usage.snapshot().persistence).toBe("saved");
  const stored = await readFile(join(dir, "usage.json"), "utf8");
  expect(stored).not.toContain("private");
  expect(stored).not.toContain("secret");
});
it("preserves corrupt statistics files and reports their state", async () => {
  const { dir, warn } = await setup();
  await writeFile(join(dir, "usage.json"), "invalid-statistics");
  const usage = new UsageStore(dir, warn); await usage.initialize();
  usage.record(req, 12, trace); await usage.flush();
  expect(usage.snapshot().persistence).toBe("error");
  expect(await readFile(join(dir, "usage.json"), "utf8")).toBe("invalid-statistics");
});
