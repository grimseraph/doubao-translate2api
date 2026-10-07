import { z } from "zod";
import { models } from "../core/models.js";
import { invalid } from "../core/errors.js";

const schema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  after_id: z.string().min(1).optional(),
  before_id: z.string().min(1).optional(),
});
export function listModels(query: unknown) {
  const parsed = schema.safeParse(query);
  if (!parsed.success) throw invalid("Invalid model list parameters.");
  const { limit = models.length, after_id, before_id } = parsed.data;
  if (after_id && before_id) throw invalid("Use only one model pagination cursor.");
  const cursorIndex = (id: string) => {
    const index = models.findIndex(model => model.id === id);
    if (index < 0) throw invalid("Unknown model pagination cursor.");
    return index;
  };
  const boundary = before_id ? cursorIndex(before_id) : models.length;
  const start = before_id ? Math.max(0, boundary - limit) : after_id ? cursorIndex(after_id) + 1 : 0;
  const end = before_id ? boundary : Math.min(boundary, start + limit);
  const data = models.slice(start, end);
  return {
    object: "list", data, has_more: before_id ? start > 0 : end < boundary,
    first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null,
  };
}
