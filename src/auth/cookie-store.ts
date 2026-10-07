import { readFile } from "node:fs/promises";
import { ServiceError } from "../core/errors.js";
import { parseCookie } from "./cookie.js";
export { parseCookie, type CookieProvider, type CookieValue } from "./cookie.js";
export async function loadCookie(path: string) {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new ServiceError(missing ? "cookie_missing" : "cookie_invalid", 502,
      missing ? "Cookie file is missing." : "Cookie file cannot be read.");
  }
  return parseCookie(text);
}
