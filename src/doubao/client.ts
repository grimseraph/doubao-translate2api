import type { Config } from "../config/env.js";
import { loadCookie } from "../auth/cookie-store.js";
import { DoubaoTransport, type Fetch, type Warn } from "./transport.js";

export { buildRequestBody, type BatchRequest, type Fetch, type Warn } from "./transport.js";
export class DoubaoClient extends DoubaoTransport {
  constructor(config: Config, fetcher?: Fetch, warn?: Warn) {
    super(config, fetcher, warn, () => loadCookie(config.DOUBAO_COOKIE_FILE));
  }
}
