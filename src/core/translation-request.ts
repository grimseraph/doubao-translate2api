import type { CanonicalModel, DoubaoScene } from "./models.js";
import type { DoubaoLang } from "../doubao/languages.js";

export type Protocol = "openai-chat" | "openai-responses" | "anthropic";
export interface TranslationRequest {
  protocol: Protocol;
  model: CanonicalModel;
  rawText: string;
  targetLang: DoubaoLang;
  scene: DoubaoScene;
  stream: boolean;
  requestId: string;
  sourceFormat?: "immersive-translate";
}
export interface TranslationResult {
  model: CanonicalModel;
  text: string;
  detectedLanguages: string[];
  upstreamBatchCount: number;
  elapsedMs: number;
}
