import { z } from "zod";
import { invalid } from "../core/errors.js";
import { determineLanguage, extractSource } from "../core/prompt-parser.js";
import { resolveModel, type DoubaoScene } from "../core/models.js";
import type { Protocol, TranslationRequest } from "../core/translation-request.js";
import type { DoubaoLang } from "../doubao/languages.js";

const baseSchema = z.object({
  model: z.string().min(1),
  stream: z.boolean().default(false),
  target_lang: z.string().optional(),
  doubao_scene: z.number().int().min(1).max(6).optional(),
}).passthrough();
const messageSchema = z.object({
  role: z.string(),
  content: z.unknown(),
  type: z.string().optional(),
}).passthrough();
type Message = z.infer<typeof messageSchema>;

function hasValue(value: unknown): boolean {
  if (value == null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}
function unsupported(param: string): never {
  throw invalid("Requested capability is not supported by this translation service.", "unsupported_feature", param);
}
function checkCapabilities(body: Record<string, unknown>, protocol: Protocol) {
  for (const key of ["tools", "functions", "function_call", "previous_response_id", "conversation", "reasoning", "reasoning_effort",
    "background", "audio", "prediction", "prompt"]) {
    if (hasValue(body[key])) unsupported(key);
  }
  for (const key of ["tool_choice"]) if (hasValue(body[key]) && body[key] !== "none") unsupported(key);
  if (hasValue(body.thinking) && (body.thinking as { type?: unknown }).type !== "disabled") unsupported("thinking");
  if (body.n !== undefined && body.n !== 1) unsupported("n");
  if (hasValue(body.modalities) &&
    (!Array.isArray(body.modalities) || body.modalities.some(x => x !== "text"))) unsupported("modalities");
  if (hasValue(body.response_format) && (body.response_format as { type?: unknown }).type !== "text") unsupported("response_format");
  if (protocol === "openai-responses" && hasValue(body.text)) {
    const format = (body.text as { format?: { type?: string } }).format;
    if (hasValue(format) && format?.type !== "text") unsupported("text.format");
  }
}
function textContent(value: unknown, acceptedTypes: string[], nullable = false): string {
  if (typeof value === "string") return value;
  if (value == null && nullable) return "";
  if (!Array.isArray(value)) throw invalid("Expected text content.", "unsupported_input", "content");
  return value.map(part => {
    if (!part || typeof part !== "object" || !acceptedTypes.includes(part.type))
      throw invalid("Only text input is supported.", "unsupported_input", "content");
    if (typeof part.text !== "string") throw invalid("Text content must be a string.");
    return part.text;
  }).join("");
}
function messages(value: unknown): Message[] {
  const parsed = z.array(messageSchema).min(1).safeParse(value);
  if (!parsed.success) throw invalid("A nonempty message list is required.", "invalid_request", "messages");
  return parsed.data;
}
function fromMessages(items: Message[], protocol: Protocol, contexts: string[]) {
  let user: string | undefined;
  for (const message of items) {
    const roles = protocol === "anthropic" ? ["user", "assistant"] : ["system", "developer", "user", "assistant"];
    if (!roles.includes(message.role) || (message.type !== undefined && message.type !== "message"))
      throw invalid("Only text messages are supported.", "unsupported_input", "messages");
    for (const key of ["tool_calls", "function_call", "audio"]) if (hasValue(message[key])) unsupported(key);
    const types = protocol === "openai-responses" ? ["input_text", ...(message.role === "assistant" ? ["output_text"] : [])] : ["text"];
    const text = textContent(message.content, types, message.role === "assistant");
    if (message.role === "system" || message.role === "developer") contexts.push(text);
    if (message.role === "user") user = text;
  }
  if (user === undefined) throw invalid("A user text message is required.", "empty_translation_input");
  return user;
}
export interface AdaptedRequest {
  canonical: TranslationRequest;
  instructions: string | null;
  includeUsage: boolean;
}
export function adaptRequest(
  protocol: Protocol, input: unknown, headerLanguage: string | undefined, defaultScene: number, requestId: string,
  defaultLanguage?: DoubaoLang,
): AdaptedRequest {
  const parsed = baseSchema.safeParse(input);
  if (!parsed.success) {
    const param = parsed.error.issues[0]?.path.map(String).join(".") ?? null;
    throw invalid("Invalid request parameters.", "invalid_request", param);
  }
  const body = parsed.data;
  checkCapabilities(body, protocol);
  const contexts: string[] = [];
  let instructions: string | null = null;
  let user: string;
  if (protocol === "openai-responses") {
    if (body.instructions != null) {
      if (typeof body.instructions !== "string") throw invalid("Instructions must be text.", "invalid_request", "instructions");
      instructions = body.instructions;
      contexts.push(instructions);
    }
    user = typeof body.input === "string" ? body.input : fromMessages(messages(body.input), protocol, contexts);
  } else {
    if (protocol === "anthropic" && body.system != null) contexts.push(textContent(body.system, ["text"]));
    user = fromMessages(messages(body.messages), protocol, contexts);
  }
  const model = resolveModel(body.model);
  const targetLang = determineLanguage(body.target_lang, headerLanguage, contexts, user, defaultLanguage);
  return {
    canonical: {
      protocol, model, targetLang, rawText: extractSource(user), stream: body.stream,
      scene: (body.doubao_scene ?? defaultScene) as DoubaoScene, requestId,
    },
    instructions,
    includeUsage: (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true,
  };
}
