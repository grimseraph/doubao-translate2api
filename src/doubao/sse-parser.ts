export interface SSEEvent { event: string; data: string }

export class SSEParser {
  private decoder = new TextDecoder();
  private buffer = "";
  private event = "message";
  private data: string[] = [];
  constructor(private emit: (event: SSEEvent) => void) {}
  push(bytes: Uint8Array) { this.consume(this.decoder.decode(bytes, { stream: true }), false); }
  finish() { this.consume(this.decoder.decode(), true); }
  private consume(text: string, final: boolean) {
    this.buffer += text;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const char = this.buffer[i];
      if (char !== "\n" && char !== "\r") continue;
      if (char === "\r" && i === this.buffer.length - 1 && !final) break;
      this.line(this.buffer.slice(start, i));
      if (char === "\r" && this.buffer[i + 1] === "\n") i++;
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > 8 * 1024 * 1024) throw new Error("SSE line limit exceeded.");
    if (final) {
      if (this.buffer) this.line(this.buffer);
      this.buffer = "";
      this.dispatch();
    }
  }
  private line(line: string) {
    if (!line) { this.dispatch(); return; }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    if (field === "data") this.data.push(value);
  }
  private dispatch() {
    if (this.data.length || this.event !== "message") this.emit({ event: this.event, data: this.data.join("\n") });
    this.data = [];
    this.event = "message";
  }
}
