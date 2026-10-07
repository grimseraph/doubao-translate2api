import { ServiceError } from "../core/errors.js";

export interface CookieValue { cookie: string; complete: boolean }
export type CookieProvider = () => Promise<CookieValue>;
export function parseCookie(text: string): CookieValue {
  const cookie = text.trim().replace(/^Cookie:\s*/i, "");
  if (!cookie || cookie.length > 32768 || /[^\x20-\x7e]/.test(cookie))
    throw new ServiceError("cookie_invalid", 502, "Cookie is empty or contains unsafe header characters.");
  const entries = cookie.split(";").map(item => item.trim());
  const complete = ["sessionid", "sid_tt", "uid_tt"].every(name =>
    entries.some(item => item.startsWith(`${name}=`) && item.length > name.length + 1));
  return { cookie, complete };
}
