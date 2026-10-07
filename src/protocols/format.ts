import type { TranslationResult, Protocol } from "../core/translation-request.js";
import type { AdaptedRequest } from "./adapter.js";

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const usageChat = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
const usageResponses = {
  input_tokens: 0, input_tokens_details: { cached_tokens: 0 },
  output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0,
};
const textPart = (text: string) => ({ type: "output_text", text, annotations: [], logprobs: [] });
export function formatJSON(protocol: Protocol, result: TranslationResult, adapted: AdaptedRequest) {
  const created = Math.floor(Date.now() / 1000);
  if (protocol === "openai-chat") return {
    id: id("chatcmpl"), object: "chat.completion", created, model: result.model,
    choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
    usage: usageChat,
  };
  if (protocol === "anthropic") return {
    id: id("msg"), type: "message", role: "assistant", model: result.model,
    content: [{ type: "text", text: result.text }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  return {
    id: id("resp"), object: "response", created_at: created, completed_at: created, status: "completed",
    error: null, incomplete_details: null, instructions: adapted.instructions, model: result.model,
    output: [{
      id: id("msg"), type: "message", status: "completed", role: "assistant", content: [textPart(result.text)],
    }],
    usage: usageResponses, tools: [], tool_choice: "none", parallel_tool_calls: false,
    previous_response_id: null, max_output_tokens: null, temperature: null, top_p: null,
    reasoning: null, text: { format: { type: "text" } }, truncation: "disabled", metadata: {},
    store: false,
  };
}

type WireObject = Record<string, any>;
export function formatSSE(protocol: Protocol, result: TranslationResult, adapted: AdaptedRequest): string {
  const complete = formatJSON(protocol, result, adapted) as WireObject;
  const frames: string[] = [];
  const emit = (value: unknown, event?: string) => {
    frames.push(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(value)}\n\n`);
  };
  if (protocol === "openai-chat") {
    const chunk = (delta: unknown, finish: string | null) => ({
      id: complete.id, object: "chat.completion.chunk", created: complete.created, model: result.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    emit(chunk({ role: "assistant", content: "" }, null));
    emit(chunk({ content: result.text }, null));
    emit(chunk({}, "stop"));
    if (adapted.includeUsage) emit({
      id: complete.id, object: "chat.completion.chunk", created: complete.created, model: result.model,
      choices: [], usage: usageChat,
    });
    frames.push("data: [DONE]\n\n");
  } else if (protocol === "anthropic") {
    emit({ type: "message_start", message: { ...complete, content: [], stop_reason: null } }, "message_start");
    emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start");
    emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: result.text } }, "content_block_delta");
    emit({ type: "content_block_stop", index: 0 }, "content_block_stop");
    emit({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } }, "message_delta");
    emit({ type: "message_stop" }, "message_stop");
  } else {
    let sequence = 0;
    const event = (type: string, fields: WireObject) => emit({ type, ...fields, sequence_number: sequence++ }, type);
    const outputItem = complete.output[0];
    const part = outputItem.content[0];
    const indexes = { item_id: outputItem.id, output_index: 0, content_index: 0 };
    const initial = { ...complete, status: "in_progress", completed_at: null, output: [], usage: null };
    event("response.created", { response: initial });
    event("response.in_progress", { response: initial });
    event("response.output_item.added", { output_index: 0, item: { ...outputItem, status: "in_progress", content: [] } });
    event("response.content_part.added", { ...indexes, part: textPart("") });
    event("response.output_text.delta", { ...indexes, delta: result.text, logprobs: [] });
    event("response.output_text.done", { ...indexes, text: result.text, logprobs: [] });
    event("response.content_part.done", { ...indexes, part });
    event("response.output_item.done", { output_index: 0, item: outputItem });
    event("response.completed", { response: complete });
  }
  return frames.join("");
}
