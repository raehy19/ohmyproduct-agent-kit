import { OmpApiError, parseRateLimit, parseRetryAfter, type OmpErrorCode, type RateLimitInfo } from './errors.js'
import { OPERATIONS, type OperationId } from './operations.js'
import type {
  AgentIdentity,
  AgentIdentityPointer,
  AgentIdentityToken,
  ApiRoot,
  ClientOptions,
  Doc,
  DocSummary,
  DocsPage,
  FetchLike,
  JoinLaunchListInput,
  LaunchListResult,
  ListDocsOptions,
  Page,
  ProductSubmissionResult,
  RegisterAgentIdentityInput,
  RequestOptions,
  RequestTestDriveInput,
  RevokeResult,
  SearchDocsOptions,
  SearchPage,
  SearchResult,
  Status,
  SubmitProductInput,
  TestDriveResult,
  WriteRequestOptions,
} from './types.js'
import { VERSION } from './version.js'

export const DEFAULT_BASE_URL = 'https://ohmyproduct.com'
const SANDBOX_HEADER = 'X-OMP-Sandbox'
const IDEMPOTENCY_HEADER = 'Idempotency-Key'
/** A client following its own cursors never needs this many pages; it guards against a loop. */
const MAX_PAGES = 1_000
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RETRY_DELAY_MS = 5_000
const DEFAULT_RETRY_DELAY_MS = 500

interface CallSpec {
  operation: OperationId
  /** Path parameters substituted into the operation path. */
  params?: Record<string, string>
  body?: unknown
  query?: Record<string, string | number | undefined>
  /** Writes may carry the sandbox header and carry an Idempotency-Key. */
  write?: boolean
  /** Identity endpoints take no bearer token and use OAuth-shaped errors. */
  anonymous?: boolean
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError(signal))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortedError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortedError(signal?: AbortSignal): OmpApiError {
  return new OmpApiError({
    status: 0,
    code: 'aborted',
    message: 'The request was aborted.',
    cause: signal?.reason,
  })
}

function randomKey(): string | undefined {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : undefined
}

function isPage(value: unknown): value is Page<unknown> {
  if (!value || typeof value !== 'object') return false
  const page = value as Record<string, unknown>
  return Array.isArray(page.data) && (page.next_cursor === null || typeof page.next_cursor === 'string')
}

function requireString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

export class OmpClient {
  readonly baseUrl: string
  /** Rate-limit headers from the most recent response, or null. */
  lastRateLimit: RateLimitInfo | null = null
  /** `X-Request-Id` of the most recent response, or null. */
  lastRequestId: string | null = null

  private token: string | undefined
  private readonly sandbox: boolean
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly userAgent: string
  private readonly retry: boolean
  private readonly maxRetryDelayMs: number

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.token = options.token
    this.sandbox = options.sandbox ?? false
    const impl = options.fetch ?? (globalThis.fetch as FetchLike | undefined)
    if (!impl) throw new Error('No fetch implementation found. Use Node 20+ or pass options.fetch.')
    this.fetchImpl = impl
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.userAgent = options.userAgent ?? `ohmyproduct-sdk/${VERSION}`
    this.retry = options.retry ?? true
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS
  }

  /** Replace the bearer token used on later calls. Pass undefined to clear it. */
  setToken(token: string | undefined): void {
    this.token = token
  }

  // ---- Read operations ------------------------------------------------------

  /** `getApiRoot`: links to the OpenAPI document, docs, search and auth. */
  async getApiRoot(options: RequestOptions = {}): Promise<ApiRoot> {
    return this.call<ApiRoot>({ operation: 'getApiRoot' }, options)
  }

  /** `getStatus`: launch phase, participation state and the discovered-products count. */
  async getStatus(options: RequestOptions = {}): Promise<Status> {
    return this.call<Status>({ operation: 'getStatus' }, options)
  }

  /**
   * `listDocs`: one page of public documents (`{ data, next_cursor }`), in the
   * fixed order of the docs index. Pass `next_cursor` back as `cursor` for the
   * next page, or use `iterateDocs()` to walk every page.
   */
  async listDocs(options: ListDocsOptions = {}): Promise<DocsPage> {
    return this.callPage<DocSummary>(
      { operation: 'listDocs', query: { limit: options.limit, cursor: options.cursor } },
      options,
    )
  }

  /** Every public document, following `next_cursor` across pages. */
  async *iterateDocs(options: Omit<ListDocsOptions, 'cursor'> = {}): AsyncGenerator<DocSummary, void, undefined> {
    yield* this.paginate((cursor) => this.listDocs({ ...options, cursor }))
  }

  /** `getDoc`: one document including its markdown body. Unknown slug: `doc_not_found`. */
  async getDoc(slug: string, options: RequestOptions = {}): Promise<Doc> {
    requireString('slug', slug)
    return this.call<Doc>({ operation: 'getDoc', params: { slug } }, options)
  }

  /**
   * `searchDocs`: one page of lexical matches, best first. `data` is empty when
   * nothing matches. Pass `next_cursor` back as `cursor` (with the same query)
   * for the next page, or use `iterateSearch()`.
   */
  async searchDocs(query: string, options: SearchDocsOptions = {}): Promise<SearchPage> {
    requireString('query', query)
    return this.callPage<SearchResult>(
      { operation: 'searchDocs', query: { q: query, limit: options.limit, cursor: options.cursor } },
      options,
    )
  }

  /** Every match for a query, best first, following `next_cursor` across pages. */
  async *iterateSearch(query: string, options: Omit<SearchDocsOptions, 'cursor'> = {}): AsyncGenerator<SearchResult, void, undefined> {
    requireString('query', query)
    yield* this.paginate((cursor) => this.searchDocs(query, { ...options, cursor }))
  }

  /** `getAgentIdentity`: the token's subject, scopes and expiry. Requires a token (else 401 `invalid_token`). */
  async getAgentIdentity(options: RequestOptions = {}): Promise<AgentIdentity> {
    return this.call<AgentIdentity>({ operation: 'getAgentIdentity' }, options)
  }

  /** `getAgentAuth`: the agent auth entry point (`GET /agent/auth`); the same answer as `getAgentIdentity`. */
  async getAgentAuth(options: RequestOptions = {}): Promise<AgentIdentity> {
    return this.call<AgentIdentity>({ operation: 'getAgentAuth' }, options)
  }

  // ---- Write operations -----------------------------------------------------

  /** `joinLaunchList`: add an email to the launch list. Only submit an address whose owner asked you to. */
  async joinLaunchList(input: JoinLaunchListInput, options: WriteRequestOptions = {}): Promise<LaunchListResult> {
    requireString('email', input?.email)
    return this.call<LaunchListResult>(
      { operation: 'joinLaunchList', body: input, write: true },
      options,
    )
  }

  /** `submitProduct`: submit a product for private review (HTTP 202, status `received`). */
  async submitProduct(input: SubmitProductInput, options: WriteRequestOptions = {}): Promise<ProductSubmissionResult> {
    requireString('name', input?.name)
    requireString('url', input?.url)
    requireString('email', input?.email)
    return this.call<ProductSubmissionResult>(
      { operation: 'submitProduct', body: input, write: true },
      options,
    )
  }

  /** `requestTestDrive`: send a Test Drive confirmation email (HTTP 202, status `check_email`). */
  async requestTestDrive(input: RequestTestDriveInput, options: WriteRequestOptions = {}): Promise<TestDriveResult> {
    requireString('email', input?.email)
    if (input.consent !== true) throw new TypeError('consent must be true')
    return this.call<TestDriveResult>(
      { operation: 'requestTestDrive', body: input, write: true },
      options,
    )
  }

  // ---- Agent identity (served from the site origin, outside /api/v1) -------

  /** `describeAgentIdentityEndpoint`: how to register (method, supported types, example request). */
  async describeAgentIdentityEndpoint(options: RequestOptions = {}): Promise<AgentIdentityPointer> {
    return this.call<AgentIdentityPointer>({ operation: 'describeAgentIdentityEndpoint', anonymous: true }, options)
  }

  /**
   * `registerAgentIdentity`: mint an anonymous agent token (one hour). The
   * token is returned but not stored; call `setToken` or use `authenticate`.
   * Errors use the OAuth shape, mapped onto `OmpApiError` (`invalid_request`,
   * `invalid_scope`, `temporarily_unavailable`, `rate_limited`, ...).
   */
  async registerAgentIdentity(
    input: RegisterAgentIdentityInput = {},
    options: RequestOptions = {},
  ): Promise<AgentIdentityToken> {
    const body: Record<string, unknown> = { type: 'anonymous' }
    if (input.agentName !== undefined) body.agent_name = input.agentName
    if (input.scopes) body.scopes = input.scopes
    return this.call<AgentIdentityToken>(
      { operation: 'registerAgentIdentity', body, anonymous: true },
      options,
    )
  }

  /** Register an identity and use its token for later calls on this client. */
  async authenticate(
    input: RegisterAgentIdentityInput = {},
    options: RequestOptions = {},
  ): Promise<AgentIdentityToken> {
    const identity = await this.registerAgentIdentity(input, options)
    this.setToken(identity.access_token)
    return identity
  }

  /**
   * `revokeAgentToken`: revoke a token (RFC 7009). Always HTTP 200 for a
   * well-formed request: `revoked` is false for unknown or expired tokens.
   * Defaults to this client's token, which is then cleared. Revocation is held
   * per server instance, so treat it as best-effort; tokens live one hour.
   */
  async revokeAgentToken(token?: string, options: RequestOptions = {}): Promise<RevokeResult> {
    const target = token ?? this.token
    requireString('token', target)
    const result = await this.call<RevokeResult>(
      { operation: 'revokeAgentToken', body: { token: target }, anonymous: true },
      options,
    )
    if (target === this.token) this.token = undefined
    return result
  }

  // ---- Internals ------------------------------------------------------------

  private url(spec: CallSpec): string {
    let path: string = OPERATIONS[spec.operation].path
    for (const [name, value] of Object.entries(spec.params ?? {})) {
      path = path.replace(`{${name}}`, encodeURIComponent(value))
    }
    return `${this.baseUrl}${path}`
  }

  private async callPage<T>(spec: CallSpec, options: RequestOptions): Promise<Page<T>> {
    const body = await this.call<unknown>(spec, options)
    if (isPage(body)) return body as Page<T>
    throw new OmpApiError({
      status: 0,
      code: 'invalid_response',
      message: `${spec.operation} did not return a {data, next_cursor} page.`,
    })
  }

  private async *paginate<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>): AsyncGenerator<T, void, undefined> {
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const page = await fetchPage(cursor)
      yield* page.data
      if (page.next_cursor === null || seen.has(page.next_cursor)) return
      seen.add(page.next_cursor)
      cursor = page.next_cursor
    }
  }

  private async call<T>(spec: CallSpec, options: WriteRequestOptions): Promise<T> {
    // One key per logical write, reused by the retry below, so a retry is a replay.
    const idempotencyKey = spec.write ? (options.idempotencyKey ?? randomKey()) : undefined
    let attempt = 0
    for (;;) {
      try {
        return await this.attempt<T>(spec, options, idempotencyKey)
      } catch (error) {
        const retryable =
          error instanceof OmpApiError &&
          (error.status === 429 || error.status === 503 || (error.status === 409 && error.code === 'idempotency_key_in_progress'))
        if (!(error instanceof OmpApiError) || !this.retry || attempt >= 1 || !retryable) {
          throw error
        }
        const delay = error.retryAfterMs ?? this.resetDelay(error.rateLimit) ?? DEFAULT_RETRY_DELAY_MS
        if (delay > this.maxRetryDelayMs) throw error
        attempt += 1
        await sleep(delay, options.signal)
      }
    }
  }

  private resetDelay(rateLimit: RateLimitInfo | null): number | null {
    return rateLimit?.reset != null && rateLimit.reset >= 0 ? rateLimit.reset * 1000 : null
  }

  private async attempt<T>(spec: CallSpec, options: WriteRequestOptions, idempotencyKey?: string): Promise<T> {
    const url = new URL(this.url(spec))
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    }
    const token = spec.anonymous ? undefined : this.token
    if (token) headers.Authorization = `Bearer ${token}`
    let body: string | undefined
    if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(spec.body)
    }
    if (spec.write && (options.sandbox ?? this.sandbox)) headers[SANDBOX_HEADER] = 'true'
    if (spec.write && idempotencyKey) headers[IDEMPOTENCY_HEADER] = idempotencyKey

    if (options.signal?.aborted) throw abortedError(options.signal)
    const controller = new AbortController()
    let timedOut = false
    const timer =
      this.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, this.timeoutMs)
        : undefined
    const external = options.signal
    const onExternalAbort = () => controller.abort()
    if (external) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      let response: Response
      try {
        response = await this.fetchImpl(url.toString(), {
          method: OPERATIONS[spec.operation].method,
          headers,
          body,
          signal: controller.signal,
        })
      } catch (cause) {
        if (timedOut) {
          throw new OmpApiError({
            status: 0,
            code: 'timeout',
            message: `The request timed out after ${this.timeoutMs} ms.`,
            cause,
          })
        }
        if (controller.signal.aborted) throw abortedError(external)
        throw new OmpApiError({
          status: 0,
          code: 'network_error',
          message: cause instanceof Error ? cause.message : 'Network request failed.',
          cause,
        })
      }
      return await this.read<T>(response)
    } finally {
      if (timer) clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
    }
  }

  private async read<T>(response: Response): Promise<T> {
    const rateLimit = parseRateLimit(response.headers)
    const requestId = response.headers.get('x-request-id')
    this.lastRateLimit = rateLimit
    this.lastRequestId = requestId

    const text = await response.text()
    let parsed: unknown = undefined
    let parseFailed = false
    if (text !== '') {
      try {
        parsed = JSON.parse(text)
      } catch {
        parseFailed = true
      }
    }

    if (response.ok) {
      if (parseFailed) {
        throw new OmpApiError({
          status: response.status,
          code: 'invalid_response',
          message: 'The server returned a non-JSON body.',
          requestId,
          rateLimit,
        })
      }
      if (parsed === undefined) {
        throw new OmpApiError({
          status: response.status,
          code: 'invalid_response',
          message: 'The server returned an empty body.',
          requestId,
          rateLimit,
        })
      }
      return parsed as T
    }

    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    const envelope = (parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}) as Record<string, unknown>
    const inner = envelope.error
    if (inner && typeof inner === 'object') {
      const e = inner as Record<string, unknown>
      throw new OmpApiError({
        status: response.status,
        code: (typeof e.code === 'string' ? e.code : `http_${response.status}`) as OmpErrorCode,
        message: typeof e.message === 'string' ? e.message : response.statusText || `HTTP ${response.status}`,
        hint: typeof e.hint === 'string' ? e.hint : null,
        docs: typeof e.docs === 'string' ? e.docs : null,
        requestId: typeof e.request_id === 'string' ? e.request_id : requestId,
        rateLimit,
        retryAfterMs,
      })
    }
    // OAuth-style bodies from the agent identity endpoints: {error, error_description}.
    if (typeof inner === 'string') {
      throw new OmpApiError({
        status: response.status,
        code: inner as OmpErrorCode,
        message: typeof envelope.error_description === 'string' ? envelope.error_description : inner,
        docs: typeof envelope.error_uri === 'string' ? envelope.error_uri : null,
        requestId: typeof envelope.request_id === 'string' ? envelope.request_id : requestId,
        rateLimit,
        retryAfterMs,
      })
    }
    throw new OmpApiError({
      status: response.status,
      code: `http_${response.status}`,
      message: response.statusText || `HTTP ${response.status}`,
      requestId,
      rateLimit,
      retryAfterMs,
    })
  }
}

/** Create a client. Equivalent to `new OmpClient(options)`. */
export function createClient(options: ClientOptions = {}): OmpClient {
  return new OmpClient(options)
}
