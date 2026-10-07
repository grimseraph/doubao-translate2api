import type { CookieProvider, CookieValue } from "../auth/cookie.js";
import { ServiceError } from "./errors.js";

interface Lease { id: string; revision: string; provider: CookieProvider }
export interface AccountSource {
  choose(excluded?: Set<string>): Promise<Lease>;
  succeeded(id: string, revision?: string): Promise<void>;
  failed(id: string, error: ServiceError, revision?: string): Promise<void>;
  allowsFailover(): Promise<boolean>;
  list(): Promise<{ activeId: string }>;
  getCookie(id: string): Promise<CookieValue>;
}
export function isAccountFailure(error: unknown): error is ServiceError {
  return error instanceof ServiceError && (["cookie_missing", "cookie_invalid", "upstream_auth_error",
    "upstream_timeout", "upstream_network_error"].includes(error.code) ||
    (["upstream_http_error", "upstream_incomplete_result"].includes(error.code) && error.retryable));
}
