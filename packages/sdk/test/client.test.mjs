import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { API_ERROR_CODES, OmpApiError, OmpClient, VERSION, createClient, parseRetryAfter } from '../dist/index.js'

const ORIGIN = 'https://ohmyproduct.com'
const BASE = `${ORIGIN}/api/v1`

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

/** Records calls and replies from a queue (functions or Responses). */
function mockFetch(...replies) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url, init, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined })
    const next = replies.length > 1 ? replies.shift() : replies[0]
    return typeof next === 'function' ? next(url, init) : next.clone()
  }
  fn.calls = calls
  return fn
}

const errorEnvelope = (code, extra = {}) => ({
  error: {
    code,
    message: `${code} message`,
    hint: `${code} hint`,
    docs: 'https://ohmyproduct.com/developers#errors',
    request_id: 'req_1',
    ...extra,
  },
})

test('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
})

test('getStatus: GET /status with default headers', async () => {
  const status = { phase: 'closed_beta', participation_open: false, launch_date: null, counts: { discovered_products: 3, measured_at: '2026-11-15T00:00:00.000Z' } }
  const f = mockFetch(json(status, { headers: { 'ratelimit-limit': '60', 'ratelimit-remaining': '59', 'ratelimit-reset': '30', 'x-request-id': 'abc' } }))
  const client = createClient({ fetch: f })
  assert.deepEqual(await client.getStatus(), status)
  const call = f.calls[0]
  assert.equal(call.url, `${BASE}/status`)
  assert.equal(call.init.method, 'GET')
  assert.equal(call.headers.Accept, 'application/json')
  assert.equal(call.headers['User-Agent'], `ohmyproduct-sdk/${VERSION}`)
  assert.equal(call.headers.Authorization, undefined)
  assert.equal(call.headers['X-OMP-Sandbox'], undefined)
  assert.deepEqual(client.lastRateLimit, { limit: 60, remaining: 59, reset: 30 })
  assert.equal(client.lastRequestId, 'abc')
})

test('options: baseUrl trailing slash, token, userAgent', async () => {
  const f = mockFetch(json({}))
  const client = new OmpClient({ fetch: f, baseUrl: 'http://localhost:3010/', token: 't0k', userAgent: 'my-agent/1' })
  await client.getStatus()
  assert.equal(f.calls[0].url, 'http://localhost:3010/api/v1/status')
  assert.equal(f.calls[0].headers.Authorization, 'Bearer t0k')
  assert.equal(f.calls[0].headers['User-Agent'], 'my-agent/1')
})

const doc = (slug) => ({ slug, title: slug, description: 'd', url: 'u', markdown_url: 'm', section: 'product', last_updated: null })

test('listDocs: returns the {data, next_cursor} page and sends limit and cursor', async () => {
  const page = { data: [doc('guide')], next_cursor: 'c1' }
  const f = mockFetch(json(page))
  const client = createClient({ fetch: f })
  assert.deepEqual(await client.listDocs({ limit: 1 }), page)
  assert.equal(new URL(f.calls[0].url).search, '?limit=1')
  await client.listDocs({ limit: 1, cursor: 'c1' })
  const url = new URL(f.calls[1].url)
  assert.equal(url.pathname, '/api/v1/docs')
  assert.equal(url.searchParams.get('cursor'), 'c1')
  await client.listDocs()
  assert.equal(new URL(f.calls[2].url).search, '')
  // A bare array (the old shape) or any other body is a broken response.
  for (const body of [[doc('guide')], { docs: [] }, { data: [], next_cursor: 5 }]) {
    const broken = createClient({ fetch: mockFetch(json(body)) })
    await assert.rejects(broken.listDocs(), (e) => e instanceof OmpApiError && e.code === 'invalid_response')
  }
})

test('iterateDocs: follows next_cursor across pages and stops at null', async () => {
  const f = mockFetch(
    json({ data: [doc('a'), doc('b')], next_cursor: 'c1' }),
    json({ data: [doc('c')], next_cursor: 'c2' }),
    json({ data: [doc('d')], next_cursor: null }),
  )
  const slugs = []
  for await (const d of createClient({ fetch: f }).iterateDocs({ limit: 2 })) slugs.push(d.slug)
  assert.deepEqual(slugs, ['a', 'b', 'c', 'd'])
  assert.deepEqual(f.calls.map((c) => new URL(c.url).searchParams.get('cursor')), [null, 'c1', 'c2'])
  assert.ok(f.calls.every((c) => new URL(c.url).searchParams.get('limit') === '2'))
})

test('iterateDocs: a repeated cursor ends the walk instead of looping', async () => {
  const f = mockFetch(json({ data: [doc('a')], next_cursor: 'same' }))
  const slugs = []
  for await (const d of createClient({ fetch: f }).iterateDocs()) slugs.push(d.slug)
  assert.deepEqual(slugs, ['a', 'a'])
  assert.equal(f.calls.length, 2)
})

test('getApiRoot: GET /api/v1', async () => {
  const f = mockFetch(json({ name: 'Oh My Product API', links: {} }))
  await createClient({ fetch: f }).getApiRoot()
  assert.equal(f.calls[0].url, BASE)
})

test('getDoc: encodes the slug and validates input', async () => {
  const f = mockFetch(json({ slug: 'a-b', markdown: '# hi' }))
  const client = createClient({ fetch: f })
  await client.getDoc('a/b c')
  assert.equal(f.calls[0].url, `${BASE}/docs/a%2Fb%20c`)
  await assert.rejects(client.getDoc(''), TypeError)
})

test('searchDocs: q, limit and cursor query params; returns the page', async () => {
  const f = mockFetch(json({ data: [{ slug: 'guide', title: 'Guide', url: 'u', snippet: 's', score: 1 }], next_cursor: null }))
  const client = createClient({ fetch: f })
  const page = await client.searchDocs('test drive & more', { limit: 5 })
  assert.equal(page.data.length, 1)
  assert.equal(page.next_cursor, null)
  const url = new URL(f.calls[0].url)
  assert.equal(url.pathname, '/api/v1/search')
  assert.equal(url.searchParams.get('q'), 'test drive & more')
  assert.equal(url.searchParams.get('limit'), '5')
  await client.searchDocs('x', { cursor: 'abc' })
  assert.equal(new URL(f.calls[1].url).searchParams.has('limit'), false)
  assert.equal(new URL(f.calls[1].url).searchParams.get('cursor'), 'abc')
  await assert.rejects(client.searchDocs('  '), TypeError)
})

test('iterateSearch: keeps the same q on every page', async () => {
  const hit = (slug, score) => ({ slug, title: slug, url: 'u', snippet: 's', score })
  const f = mockFetch(json({ data: [hit('a', 3)], next_cursor: 'n1' }), json({ data: [hit('b', 2)], next_cursor: null }))
  const seen = []
  for await (const r of createClient({ fetch: f }).iterateSearch('beta testers', { limit: 1 })) seen.push(r.slug)
  assert.deepEqual(seen, ['a', 'b'])
  assert.deepEqual(f.calls.map((c) => new URL(c.url).searchParams.get('q')), ['beta testers', 'beta testers'])
})

test('getAgentAuth: GET /agent/auth with the bearer token', async () => {
  const identity = { subject: 'agt_x', identity_type: 'anonymous', agent_name: null, scopes: ['docs:read'], issued_at: 'a', expires_at: 'b' }
  const f = mockFetch(json(identity))
  assert.deepEqual(await createClient({ fetch: f, token: 'tok' }).getAgentAuth(), identity)
  assert.equal(f.calls[0].url, `${ORIGIN}/agent/auth`)
  assert.equal(f.calls[0].headers.Authorization, 'Bearer tok')
  const unauthenticated = mockFetch(json(errorEnvelope('invalid_token'), { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="x"' } }))
  const err = await createClient({ fetch: unauthenticated }).getAgentAuth().catch((e) => e)
  assert.equal(err.status, 401)
  assert.equal(err.code, 'invalid_token')
})

test('writes send an Idempotency-Key: a fresh UUID per call, or the one given, never on reads', async () => {
  const f = mockFetch(json({ status: 'received' }, { status: 202 }))
  const client = createClient({ fetch: f })
  const input = { name: 'Thing', url: 'https://thing.example.com', email: 'a@example.com' }
  await client.submitProduct(input)
  await client.submitProduct(input)
  await client.submitProduct(input, { idempotencyKey: 'my-key-1' })
  await client.getStatus()
  const keys = f.calls.map((c) => c.headers['Idempotency-Key'])
  assert.match(keys[0], /^[0-9a-f-]{36}$/)
  assert.notEqual(keys[0], keys[1])
  assert.equal(keys[2], 'my-key-1')
  assert.equal(keys[3], undefined)
})

test('the automatic retry of a write reuses its Idempotency-Key (a retry is a replay)', async () => {
  const f = mockFetch(
    json(errorEnvelope('service_unavailable'), { status: 503, headers: { 'retry-after': '0' } }),
    json({ status: 'joined', share_code: 'x', share_url: 'u', referral_count: 0 }, { headers: { 'idempotent-replayed': 'true' } }),
  )
  await createClient({ fetch: f }).joinLaunchList({ email: 'a@example.com' })
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0].headers['Idempotency-Key'], f.calls[1].headers['Idempotency-Key'])
})

test('a 409 idempotency_key_in_progress is retried once with the same key', async () => {
  const f = mockFetch(
    json(errorEnvelope('idempotency_key_in_progress'), { status: 409, headers: { 'retry-after': '0' } }),
    json({ status: 'check_email' }, { status: 202 }),
  )
  assert.deepEqual(await createClient({ fetch: f }).requestTestDrive({ email: 'a@example.com', consent: true }, { idempotencyKey: 'k' }), { status: 'check_email' })
  assert.deepEqual(f.calls.map((c) => c.headers['Idempotency-Key']), ['k', 'k'])
  // Other 409s (launch_open) are not retried.
  const open = mockFetch(json(errorEnvelope('launch_open'), { status: 409 }))
  await assert.rejects(createClient({ fetch: open }).joinLaunchList({ email: 'a@example.com' }), (e) => e.code === 'launch_open')
  assert.equal(open.calls.length, 1)
})

test('joinLaunchList: POST body, content type and the real result shape', async () => {
  const result = { status: 'joined', share_code: 'abc123', share_url: 'https://ohmyproduct.com/launch?ref=abc123', referral_count: 0 }
  const f = mockFetch(json(result))
  const client = createClient({ fetch: f })
  assert.deepEqual(await client.joinLaunchList({ email: 'a@example.com', source: 'sdk' }), result)
  const call = f.calls[0]
  assert.equal(call.url, `${BASE}/launch-list`)
  assert.equal(call.init.method, 'POST')
  assert.equal(call.headers['Content-Type'], 'application/json')
  assert.deepEqual(call.body, { email: 'a@example.com', source: 'sdk' })
})

test('submitProduct (202) and requestTestDrive (202) request shapes', async () => {
  const f = mockFetch(json({ status: 'received' }, { status: 202 }), json({ status: 'check_email' }, { status: 202 }))
  const client = createClient({ fetch: f })
  assert.deepEqual(await client.submitProduct({ name: 'Thing', url: 'https://thing.example.com', email: 'a@example.com' }), { status: 'received' })
  assert.deepEqual(await client.requestTestDrive({ email: 'a@example.com', consent: true }), { status: 'check_email' })
  assert.equal(f.calls[0].url, `${BASE}/product-submissions`)
  assert.deepEqual(f.calls[0].body, { name: 'Thing', url: 'https://thing.example.com', email: 'a@example.com' })
  assert.equal(f.calls[1].url, `${BASE}/test-drive-requests`)
  assert.deepEqual(f.calls[1].body, { email: 'a@example.com', consent: true })
  await assert.rejects(client.submitProduct({ name: '', url: 'u', email: 'e' }), TypeError)
  await assert.rejects(client.requestTestDrive({ email: 'a@example.com', consent: false }), /consent must be true/)
  assert.equal(f.calls.length, 2)
})

test('sandbox: header only on writes, client-level and per-call', async () => {
  const f = mockFetch(json({ status: 'joined', share_code: null, share_url: null, referral_count: 0, sandbox: true }))
  const client = createClient({ fetch: f, sandbox: true })
  const result = await client.joinLaunchList({ email: 'a@example.com' })
  assert.equal(result.sandbox, true)
  assert.equal(f.calls[0].headers['X-OMP-Sandbox'], 'true')
  await client.getStatus()
  assert.equal(f.calls[1].headers['X-OMP-Sandbox'], undefined)
  await client.joinLaunchList({ email: 'a@example.com' }, { sandbox: false })
  assert.equal(f.calls[2].headers['X-OMP-Sandbox'], undefined)

  const live = createClient({ fetch: f })
  await live.requestTestDrive({ email: 'a@example.com', consent: true }, { sandbox: true })
  assert.equal(f.calls[3].headers['X-OMP-Sandbox'], 'true')
})

test('getAgentIdentity: 401 invalid_token without a token, real shape with one', async () => {
  const me = {
    subject: 'agt_1',
    identity_type: 'anonymous',
    agent_name: null,
    scopes: ['docs:read'],
    issued_at: '2026-11-16T00:00:00.000Z',
    expires_at: '2026-11-16T01:00:00.000Z',
  }
  const f = mockFetch(
    json(errorEnvelope('invalid_token'), { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="x"' } }),
    json(me),
  )
  const client = createClient({ fetch: f })
  await assert.rejects(client.getAgentIdentity(), (e) => e.status === 401 && e.code === 'invalid_token')
  client.setToken('abc')
  assert.deepEqual(await client.getAgentIdentity(), me)
  assert.equal(f.calls[1].url, `${BASE}/agent/me`)
  assert.equal(f.calls[1].headers.Authorization, 'Bearer abc')
})

test('registerAgentIdentity: posts {type} to the origin, no bearer, no sandbox header', async () => {
  const token = { access_token: 'tok', token_type: 'Bearer', expires_in: 3600, scope: 'docs:read launch:write', registration_id: 'agt_1', registration_type: 'anonymous' }
  const f = mockFetch(json(token))
  const client = createClient({ fetch: f, sandbox: true, token: 'stale' })
  assert.deepEqual(await client.registerAgentIdentity({ agentName: 'my-agent', scopes: ['docs:read', 'launch:write'] }), token)
  assert.equal(f.calls[0].url, `${ORIGIN}/agent/identity`)
  assert.deepEqual(f.calls[0].body, { type: 'anonymous', agent_name: 'my-agent', scopes: ['docs:read', 'launch:write'] })
  assert.equal(f.calls[0].headers['X-OMP-Sandbox'], undefined)
  assert.equal(f.calls[0].headers.Authorization, undefined)
  await client.registerAgentIdentity()
  assert.deepEqual(f.calls[1].body, { type: 'anonymous' })
})

test('describeAgentIdentityEndpoint: GET /agent/identity', async () => {
  const pointer = { identity_endpoint: `${ORIGIN}/agent/identity`, method: 'POST', identity_types_supported: ['anonymous'], example_request: { type: 'anonymous' }, skill: `${ORIGIN}/auth.md`, revocation_endpoint: `${ORIGIN}/agent/identity/revoke` }
  const f = mockFetch(json(pointer))
  assert.deepEqual(await createClient({ fetch: f }).describeAgentIdentityEndpoint(), pointer)
  assert.equal(f.calls[0].url, `${ORIGIN}/agent/identity`)
  assert.equal(f.calls[0].init.method, 'GET')
})

test('authenticate stores the token; revokeAgentToken sends {token} and clears it', async () => {
  const f = mockFetch(
    json({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600, scope: 'docs:read', registration_id: 'agt_1', registration_type: 'anonymous' }),
    json({}),
    json({ revoked: true }),
    json({ revoked: false }),
  )
  const client = createClient({ fetch: f })
  await client.authenticate({ agentName: 'a' })
  await client.getStatus()
  assert.equal(f.calls[1].headers.Authorization, 'Bearer tok')
  assert.deepEqual(await client.revokeAgentToken(), { revoked: true })
  assert.equal(f.calls[2].url, `${ORIGIN}/agent/identity/revoke`)
  assert.equal(f.calls[2].init.method, 'POST')
  assert.equal(f.calls[2].headers['Content-Type'], 'application/json')
  assert.deepEqual(f.calls[2].body, { token: 'tok' })
  assert.equal(f.calls[2].headers.Authorization, undefined)
  await assert.rejects(client.revokeAgentToken(), TypeError)
  // An unknown token still answers 200; revoked is false.
  assert.deepEqual(await client.revokeAgentToken('other'), { revoked: false })
})

test('a stale bearer token gets 401 invalid_token on a public endpoint', async () => {
  const f = mockFetch(json(errorEnvelope('invalid_token'), { status: 401 }))
  const err = await createClient({ fetch: f, token: 'expired' }).getStatus().catch((e) => e)
  assert.equal(err.status, 401)
  assert.equal(err.code, 'invalid_token')
  assert.equal(f.calls[0].headers.Authorization, 'Bearer expired')
})

test('error envelope maps to OmpApiError fields', async () => {
  const f = mockFetch(json(errorEnvelope('invalid_email'), { status: 400, headers: { 'x-request-id': 'hdr', 'ratelimit-remaining': '4' } }))
  const client = createClient({ fetch: f })
  const err = await client.joinLaunchList({ email: 'nope' }).catch((e) => e)
  assert.ok(err instanceof OmpApiError)
  assert.ok(err instanceof Error)
  assert.equal(err.name, 'OmpApiError')
  assert.equal(err.status, 400)
  assert.equal(err.code, 'invalid_email')
  assert.equal(err.message, 'invalid_email message')
  assert.equal(err.hint, 'invalid_email hint')
  assert.equal(err.docs, 'https://ohmyproduct.com/developers#errors')
  assert.equal(err.requestId, 'req_1')
  assert.deepEqual(err.rateLimit, { limit: null, remaining: 4, reset: null })
  assert.equal(err.retryable, false)
  assert.equal(err.toJSON().request_id, 'req_1')
})

test('error mapping falls back to the header request id and generic code', async () => {
  const f = mockFetch(new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway', headers: { 'x-request-id': 'hdr' } }))
  const err = await createClient({ fetch: f }).getStatus().catch((e) => e)
  assert.equal(err.code, 'http_502')
  assert.equal(err.requestId, 'hdr')
  assert.equal(err.message, 'Bad Gateway')
})

test('OAuth-style error bodies from the identity endpoints', async () => {
  const f = mockFetch(
    json({ error: 'invalid_scope', error_description: 'A requested scope is unknown.', error_uri: 'https://ohmyproduct.com/auth.md#errors', request_id: 'req_7' }, { status: 400 }),
  )
  const err = await createClient({ fetch: f }).registerAgentIdentity({ scopes: ['admin'] }).catch((e) => e)
  assert.equal(err.status, 400)
  assert.equal(err.code, 'invalid_scope')
  assert.equal(err.message, 'A requested scope is unknown.')
  assert.equal(err.docs, 'https://ohmyproduct.com/auth.md#errors')
  assert.equal(err.requestId, 'req_7')
})

test('API_ERROR_CODES lists every server error code once', () => {
  assert.equal(new Set(API_ERROR_CODES).size, API_ERROR_CODES.length)
  assert.ok(API_ERROR_CODES.includes('launch_open'))
})

test('empty success body is an invalid_response error', async () => {
  const f = mockFetch(new Response(null, { status: 200 }))
  const err = await createClient({ fetch: f }).getStatus().catch((e) => e)
  assert.equal(err.code, 'invalid_response')
})

test('non-JSON success body is an invalid_response error', async () => {
  const f = mockFetch(new Response('ok', { status: 200 }))
  const err = await createClient({ fetch: f }).getStatus().catch((e) => e)
  assert.equal(err.code, 'invalid_response')
})

test('network failure maps to network_error', async () => {
  const f = async () => {
    throw new TypeError('fetch failed')
  }
  const err = await createClient({ fetch: f }).getStatus().catch((e) => e)
  assert.equal(err.code, 'network_error')
  assert.equal(err.status, 0)
  assert.equal(err.message, 'fetch failed')
})

test('retry: one retry on 429 honoring Retry-After, then success', async () => {
  const started = Date.now()
  const f = mockFetch(
    json(errorEnvelope('rate_limited'), { status: 429, headers: { 'retry-after': '0.05' } }),
    json({ phase: 'closed_beta' }),
  )
  const result = await createClient({ fetch: f }).getStatus()
  assert.equal(result.phase, 'closed_beta')
  assert.equal(f.calls.length, 2)
  assert.ok(Date.now() - started >= 40)
})

test('retry: 503 retried once, second failure is thrown', async () => {
  const f = mockFetch(json(errorEnvelope('service_unavailable'), { status: 503, headers: { 'retry-after': '0' } }))
  const err = await createClient({ fetch: f }).getStatus().catch((e) => e)
  assert.equal(f.calls.length, 2)
  assert.equal(err.status, 503)
  assert.equal(err.retryable, true)
})

test('retry: not attempted when Retry-After exceeds the bound or retry is off', async () => {
  const slow = mockFetch(json(errorEnvelope('rate_limited'), { status: 429, headers: { 'retry-after': '120' } }))
  const err = await createClient({ fetch: slow }).getStatus().catch((e) => e)
  assert.equal(slow.calls.length, 1)
  assert.equal(err.retryAfterMs, 120_000)

  const off = mockFetch(json(errorEnvelope('rate_limited'), { status: 429, headers: { 'retry-after': '0' } }))
  await createClient({ fetch: off, retry: false }).getStatus().catch(() => {})
  assert.equal(off.calls.length, 1)

  const other = mockFetch(json(errorEnvelope('internal_error'), { status: 500 }))
  await createClient({ fetch: other }).getStatus().catch(() => {})
  assert.equal(other.calls.length, 1)
})

test('retry: falls back to RateLimit-Reset when Retry-After is absent', async () => {
  const f = mockFetch(
    json(errorEnvelope('rate_limited'), { status: 429, headers: { 'ratelimit-reset': '0' } }),
    json({ ok: true }),
  )
  await createClient({ fetch: f }).getStatus()
  assert.equal(f.calls.length, 2)
})

test('timeout: aborts the request and reports code timeout', async () => {
  const hang = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  const err = await createClient({ fetch: hang, timeoutMs: 30 }).getStatus().catch((e) => e)
  assert.equal(err.code, 'timeout')
  assert.equal(err.status, 0)
})

test('abort: caller signal rejects with code aborted', async () => {
  const hang = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  const controller = new AbortController()
  const pending = createClient({ fetch: hang, timeoutMs: 0 }).getStatus({ signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  const err = await pending.catch((e) => e)
  assert.equal(err.code, 'aborted')

  const already = new AbortController()
  already.abort()
  const err2 = await createClient({ fetch: hang, timeoutMs: 0 }).getStatus({ signal: already.signal }).catch((e) => e)
  assert.equal(err2.code, 'aborted')
})

test('abort during the retry wait stops the retry', async () => {
  const f = mockFetch(json(errorEnvelope('rate_limited'), { status: 429, headers: { 'retry-after': '3' } }))
  const controller = new AbortController()
  const pending = createClient({ fetch: f }).getStatus({ signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  const err = await pending.catch((e) => e)
  assert.equal(err.code, 'aborted')
  assert.equal(f.calls.length, 1)
})

test('parseRetryAfter handles seconds, dates and garbage', () => {
  assert.equal(parseRetryAfter('2'), 2000)
  assert.equal(parseRetryAfter('1.5'), 1500)
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:05 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')), 5000)
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:27:00 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')), 0)
  assert.equal(parseRetryAfter('soon'), null)
  assert.equal(parseRetryAfter(null), null)
})
