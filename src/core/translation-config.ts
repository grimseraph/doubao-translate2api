export interface UpstreamConfig {
  DOUBAO_REQUEST_TIMEOUT_MS: number;
  DOUBAO_AUTH_TIMEOUT_MS: number;
  DOUBAO_USER_AGENT?: string;
  DOUBAO_MAX_RESPONSE_BYTES?: number;
}
export interface TranslationConfig extends UpstreamConfig {
  DOUBAO_TOTAL_TIMEOUT_MS: number;
  DOUBAO_MAX_RETRIES: number;
  DOUBAO_MAX_CONCURRENCY: number;
  DOUBAO_QUEUE_MAX: number;
  DOUBAO_QUEUE_TIMEOUT_MS: number;
  DOUBAO_MAX_OUTPUT_BYTES?: number;
}
