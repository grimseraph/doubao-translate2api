import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { Fetch } from "../../src/doubao/client.js";

export type Scenario = "ok" | "out-of-order" | "duplicate-index" | "partial-items" | "invalid-index" |
  "invalid-result" | "err-event" | "err-event-after-items" | "done-only" | "no-done" | "empty" |
  "json-login-error" | "json-scene-error" | "json-plugin-error" | "json-unknown-error" |
  "http-500" | "slow-response" | "chunk-one-byte" | "no-content-type-json" | "no-content-type-sse" |
  "redirect" | "slow-body" | "unknown-event" | "empty-result" | "no-content-type-byte-sse" | "no-content-type-byte-json";
async function writeBytes(res: ServerResponse, content: string) {
  for (const byte of Buffer.from(content)) {
    if (res.destroyed) break;
    res.write(Buffer.from([byte]));
    await delay(1);
  }
  res.end();
}
export async function startMock(scenario: Scenario = "ok") {
  const requests: Array<{ path: string; cookie?: string; authorization?: string; body: any }> = [];
  const state = { scenario, authCode: 0 };
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      requests.push({ path: req.url!, cookie: req.headers.cookie, authorization: req.headers.authorization, body });
      if (req.url?.includes("user_settings")) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ code: state.authCode })); return;
      }
      const mode = state.scenario;
      if (mode === "http-500") { res.writeHead(500); res.end("secret upstream body"); return; }
      if (mode === "redirect") { res.writeHead(302, { Location: "/unexpected" }); res.end(); return; }
      if (mode === "slow-response" || mode === "slow-body") {
        if (mode === "slow-body") {
          res.setHeader("Content-Type", "text/event-stream"); res.flushHeaders();
        }
        await delay(150); if (!res.destroyed) res.end(""); return;
      }
      const codes: Record<string, number> = {
        "json-login-error": 710012001, "no-content-type-json": 710012001, "no-content-type-byte-json": 710012001,
        "json-scene-error": 710010202, "json-plugin-error": 710020202, "json-unknown-error": 999,
      };
      if (codes[mode]) {
        if (!mode.startsWith("no-content-type")) res.setHeader("Content-Type", "application/json");
        const content = JSON.stringify({ code: codes[mode], msg: "sensitive upstream message" });
        if (mode === "no-content-type-byte-json") await writeBytes(res, content);
        else res.end(content);
        return;
      }
      if (!mode.startsWith("no-content-type")) res.setHeader("Content-Type", "text/event-stream");
      let items = body.raw_text.map((text: string, index: number) => ({ index, res: `译:${text}`, detect_lang: "en" }));
      if (mode === "out-of-order") items.reverse();
      if (mode === "duplicate-index") items.push({ index: 0, res: "duplicate", detect_lang: "en" });
      if (mode === "partial-items") items.pop();
      if (mode === "invalid-index") items[0].index = "0";
      if (mode === "invalid-result") items[0].res = 7;
      if (mode === "empty-result") items[0].res = "";
      const json = `event: json\ndata: ${JSON.stringify({ code: 0, data: { items } })}\n\n`;
      const err = `event: err\ndata: ${JSON.stringify({ code: 710020702 })}\n\n`;
      const done = "event: done\ndata: {}\n\n";
      const content = mode === "err-event" ? err : mode === "err-event-after-items" ? json + err :
        mode === "done-only" ? done : mode === "empty" ? "" : mode === "no-done" ? json : json + done;
      const withUnknown = mode === "unknown-event" ? "event: new-event\ndata: {\"unexpected\":true}\n\n" + content : content;
      if (mode === "chunk-one-byte" || mode === "no-content-type-byte-sse") await writeBytes(res, withUnknown);
      else res.end(withUnknown);
    } catch {
      if (!res.destroyed) res.destroy();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fetcher: Fetch = (input, init) => {
    const path = new URL(String(input));
    return fetch(url + path.pathname + path.search, init);
  };
  return {
    url, fetcher, state, requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
