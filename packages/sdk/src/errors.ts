/** Rate-limit state parsed from the `RateLimit-*` response headers. */
export interface RateLimitInfo {
  /** Requests allowed in the current window, or null when the header is absent. */
  limit: number | null
  /** Requests left in the current window, or null when absent. */
  remaining: number | null
  /** Seconds until the window resets, or null when absent. */
  reset: number | null
}

/** Error codes the server can return (`ERROR_CODES` in the API; see `/openapi.json`). */
export const API_ERROR_CODES = [
  'invalid_json',
  'invalid_body',
  'invalid_email',
  'invalid_name',
  'invalid_url',
  'consent_required',
  'invalid_query',
  'invalid_cursor',
  'invalid_idempotency_key',
  'invalid_token',
  'insufficient_scope',
  'not_found',
  'doc_not_found',
  'product_not_found',
  'version_not_found',
  'method_not_allowed',
  'launch_open',
  'idempotency_key_in_progress',
  'idempotency_key_reused',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'internal_error',
  'service_unavailable',
  'invalid_request',
  'invalid_scope',
  'service_auth_not_enabled',
  'issuer_not_enabled',
  'temporarily_unavailable',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/** Codes the SDK itself raises when no usable API answer exists (status 0 or a bad body). */
export type TransportErrorCode = 'network_error' | 'timeout' | 'aborted' | 'invalid_response'

/** `http_<status>` is used only when an error response is not in either documented error shape. */
export type OmpErrorCode = ApiErrorCode | TransportErrorCode | `http_${number}`

export interface OmpApiErrorInit {
  status: number
  code: OmpErrorCode
  message: string
  hint?: string | null
  docs?: string | null
  requestId?: string | null
  rateLimit?: RateLimitInfo | null
  retryAfterMs?: number | null
  cause?: unknown
}

/**
 * Thrown for every failed call. API errors carry the fields of the documented
 * error envelope. Transport failures use status 0 and one of the codes
 * `network_error`, `timeout`, `aborted` or `invalid_response`.
 */
export class OmpApiError extends Error {
  readonly status: number
  readonly code: OmpErrorCode
  readonly hint: string | null
  readonly docs: string | null
  readonly requestId: string | null
  readonly rateLimit: RateLimitInfo | null
  readonly retryAfterMs: number | null

  constructor(init: OmpApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'OmpApiError'
    this.status = init.status
    this.code = init.code
    this.hint = init.hint ?? null
    this.docs = init.docs ?? null
    this.requestId = init.requestId ?? null
    this.rateLimit = init.rateLimit ?? null
    this.retryAfterMs = init.retryAfterMs ?? null
  }

  /** True for HTTP errors worth retrying later (429 and 503). */
  get retryable(): boolean {
    return this.status === 429 || this.status === 503
  }

  toJSON(): Record<string, unknown> {
    return {
      status: this.status,
      code: this.code,
      message: this.message,
      hint: this.hint,
      docs: this.docs,
      request_id: this.requestId,
    }
  }
}

function toNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const limit = toNumber(headers.get('ratelimit-limit'))
  const remaining = toNumber(headers.get('ratelimit-remaining'))
  const reset = toNumber(headers.get('ratelimit-reset'))
  if (limit === null && remaining === null && reset === null) return null
  return { limit, remaining, reset }
}

/** Parses `Retry-After` (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000)
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return null
  return Math.max(0, date - now)
}
