import { ServiceError } from "./errors.js";

export const MODEL_ENGINE_MAP = {
  "doubao-ai": "1",
  "volcengine-translate": "0",
  "microsoft-translator": "3",
} as const;
export type CanonicalModel = keyof typeof MODEL_ENGINE_MAP;
export type DoubaoEngine = typeof MODEL_ENGINE_MAP[CanonicalModel];
export type DoubaoScene = 1 | 2 | 3 | 4 | 5 | 6;
export const models = Object.keys(MODEL_ENGINE_MAP).map((id, i) => ({
  id, object: "model", created: 0, owned_by: ["doubao", "volcengine", "microsoft"][i],
  type: "model", created_at: "1970-01-01T00:00:00Z",
  display_name: ["Doubao AI Translation", "Volcengine Translation", "Microsoft Translator"][i],
}));
export function resolveModel(value: string): CanonicalModel {
  if (!Object.hasOwn(MODEL_ENGINE_MAP, value))
    throw new ServiceError("model_not_found", 404, "Model not found.", false, "model");
  return value as CanonicalModel;
}
