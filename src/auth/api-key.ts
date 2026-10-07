import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { ServiceError } from "../core/errors.js";

const digest = (value: string) => createHash("sha256").update(value).digest();
export function authenticate(headers: IncomingHttpHeaders, keys: string[], allowNoAuth: boolean) {
  if (allowNoAuth) return;
  const authorization = headers.authorization;
  const candidate = authorization !== undefined
    ? authorization.match(/^Bearer\s+(\S+)$/i)?.[1]
    : typeof headers["x-api-key"] === "string" ? headers["x-api-key"] : undefined;
  const hash = digest(candidate ?? "");
  let accepted = false;
  for (const key of keys) accepted = timingSafeEqual(hash, digest(key)) || accepted;
  if (!candidate || !accepted) throw new ServiceError("invalid_api_key", 401, "Invalid or missing API key.");
}
