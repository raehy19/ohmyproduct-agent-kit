// Contract test: the SDK must match the checked-in OpenAPI document
// (openapi.snapshot.json, refreshed with `npm run sync:openapi`).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { API_ERROR_CODES, OPERATIONS, OmpClient } from '../dist/index.js'

const spec = JSON.parse(readFileSync(new URL('../openapi.snapshot.json', import.meta.url), 'utf8'))
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']
const ORIGIN = new URL(spec.servers[0].url).origin

/** Full path of a document path key: its path-level server, else the first document server. */
function fullPath(key, item) {
  const server = (item.servers ?? spec.servers)[0].url
  const base = new URL(server).pathname.replace(/\/$/, '')
  return key === '/' ? base || '/' : `${base}${key}`
}

const specOperations = {}
for (const [key, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!HTTP_METHODS.includes(method)) continue
    specOperations[op.operationId] = { method: method.toUpperCase(), path: fullPath(key, item), op }
  }
}

test('the document has a production and a sandbox server on the same origin', () => {
  assert.deepEqual(spec.servers.map((s) => new URL(s.url).pathname), ['/api/v1', '/api/sandbox/v1'])
  assert.ok(spec.servers.every((s) => new URL(s.url).origin === ORIGIN))
})

test('every operationId in the OpenAPI document has an SDK operation, and vice versa', () => {
  assert.deepEqual(Object.keys(OPERATIONS).sort(), Object.keys(specOperations).sort())
})

test('SDK operation paths and HTTP methods match the document', () => {
  for (const [id, { method, path }] of Object.entries(specOperations)) {
    assert.deepEqual({ ...OPERATIONS[id] }, { method, path }, id)
  }
})

test('the base URL matches the origin of the document servers', () => {
  const client = new OmpClient({ fetch: async () => new Response('{}') })
  assert.equal(client.baseUrl, ORIGIN)
})

test('every error code the document mentions is in API_ERROR_CODES', () => {
  const mentioned = new Set()
  for (const { op } of Object.values(specOperations)) {
    for (const response of Object.values(op.responses)) {
      for (const match of response.description.matchAll(/`([a-z_]+)`:/g)) mentioned.add(match[1])
    }
  }
  assert.ok(mentioned.size > 15)
  for (const code of mentioned) assert.ok(API_ERROR_CODES.includes(code), `missing error code ${code}`)
})

// Sample arguments per SDK method, used to drive the real client.
const bodyInputs = {
  joinLaunchList: [{ email: 'a@example.com', source: 'contract-test' }],
  submitProduct: [{ name: 'Thing', url: 'https://thing.example.com', email: 'a@example.com' }],
  requestTestDrive: [{ email: 'a@example.com', consent: true }],
  registerAgentIdentity: [{ agentName: 'contract-test', scopes: ['docs:read', 'launch:write'] }],
  revokeAgentToken: ['some-token'],
}
const readInputs = {
  getApiRoot: [],
  getStatus: [],
  listDocs: [{ limit: 2, cursor: 'c1' }],
  getDoc: ['first-users'],
  searchDocs: ['beta testers', { limit: 5, cursor: 'c1' }],
  listProducts: [{ limit: 2, cursor: 'c1', category: 'dev-data', q: 'web scraping' }],
  getProduct: ['crawl4ai-434b6c'],
  listProductCategories: [],
  getAgentIdentity: [],
  getAgentAuth: [],
  describeAgentIdentityEndpoint: [],
}
const sampleArgs = { ...readInputs, ...bodyInputs }

test('each SDK method requests the documented method and path, with a body the schema accepts', async () => {
  assert.deepEqual(Object.keys(sampleArgs).sort(), Object.keys(specOperations).sort())
  for (const [id, args] of Object.entries(sampleArgs)) {
    const seen = []
    const client = new OmpClient({
      token: 'tok',
      fetch: async (url, init) => {
        seen.push({ url: new URL(url), init })
        // Paginated operations answer the {data, next_cursor} page; everything else an object.
        const body = specOperations[id].op['x-pagination'] ? { data: [], next_cursor: null } : {}
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    assert.equal(typeof client[id], 'function', `OmpClient.${id} is missing`)
    await client[id](...args)
    assert.equal(seen.length, 1, id)

    const { method, path, op } = specOperations[id]
    const expectedPath = path.replace('{slug}', encodeURIComponent('first-users')).replace('{id}', encodeURIComponent('crawl4ai-434b6c'))
    assert.equal(seen[0].url.origin, new URL(ORIGIN).origin, id)
    assert.equal(seen[0].url.pathname, expectedPath, id)
    assert.equal(seen[0].init.method, method, id)

    // Query parameters sent must be declared by the operation.
    const declared = new Set((op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name))
    for (const name of seen[0].url.searchParams.keys()) assert.ok(declared.has(name), `${id}: undeclared query ${name}`)
    for (const p of (op.parameters ?? []).filter((p) => p.in === 'query' && p.required)) {
      assert.ok(seen[0].url.searchParams.has(p.name), `${id}: missing required query ${p.name}`)
    }

    // Body keys must be declared by the request schema and cover its required keys.
    const media = op.requestBody?.content ?? {}
    if (Object.keys(media).length > 0) {
      assert.ok('application/json' in media, `${id}: SDK sends JSON but the document does not accept it`)
      const schema = media['application/json'].schema
      const body = JSON.parse(seen[0].init.body)
      for (const key of Object.keys(body)) assert.ok(key in schema.properties, `${id}: undeclared body field ${key}`)
      for (const key of schema.required ?? []) assert.ok(key in body, `${id}: missing required body field ${key}`)
    } else {
      assert.equal(seen[0].init.body, undefined, id)
    }
  }
})

test('the Product type is the field allowlist of the document, and every product response carries provenance', () => {
  const schemaOf = (id) => specOperations[id].op.responses['200'].content['application/json'].schema
  const PRODUCT_KEYS = ['category', 'discovered_on', 'id', 'name', 'tagline', 'tags', 'url']
  const item = schemaOf('listProducts').properties.data.items
  assert.deepEqual(Object.keys(item.properties).sort(), PRODUCT_KEYS)
  assert.equal(item.additionalProperties, false)
  assert.deepEqual(schemaOf('listProducts').required, ['data', 'next_cursor', 'total', 'provenance'])
  assert.deepEqual(Object.keys(schemaOf('getProduct').properties).sort(), [...PRODUCT_KEYS, 'provenance'].sort())
  assert.deepEqual(schemaOf('listProductCategories').required, ['data', 'total', 'provenance'])
  for (const id of ['listProducts', 'getProduct', 'listProductCategories']) {
    const provenance = schemaOf(id).properties.provenance
    assert.deepEqual(Object.keys(provenance.properties).sort(), ['as_of', 'note', 'source'], id)
    assert.equal(provenance.properties.source.const, 'omi_discovery', id)
  }
  // The query parameters the SDK's ListProductsOptions sends.
  const query = specOperations.listProducts.op.parameters.filter((p) => p.in === 'query')
  assert.deepEqual(query.map((p) => p.name).sort(), ['category', 'cursor', 'limit', 'q'])
  assert.equal(query.find((p) => p.name === 'limit').schema.maximum, 100)
  assert.ok(query.every((p) => p.required === false))
})

test('sandbox header is sent exactly on the operations the document marks x-sandbox', async () => {
  const sandboxHeader = spec.components.parameters.SandboxHeader.name
  for (const [id, args] of Object.entries(sampleArgs)) {
    let headers
    const client = new OmpClient({
      sandbox: true,
      fetch: async (_url, init) => {
        headers = init.headers
        const body = specOperations[id].op['x-pagination'] ? { data: [], next_cursor: null } : {}
        return new Response(JSON.stringify(body), { status: 200 })
      },
    })
    await client[id](...args)
    const expected = specOperations[id].op['x-sandbox'] === true
    assert.equal(headers[sandboxHeader] === 'true', expected, id)
  }
})

test('operations that take no token in the document send no Authorization header', async () => {
  for (const [id, args] of Object.entries(sampleArgs)) {
    const op = specOperations[id].op
    if (op.security.length !== 0) continue
    let headers
    const client = new OmpClient({
      token: 'tok',
      fetch: async (_url, init) => {
        headers = init.headers
        return new Response('{}', { status: 200 })
      },
    })
    await client[id](...args)
    assert.equal(headers.Authorization, undefined, id)
  }
})

test('Idempotency-Key is sent exactly on the operations that declare the IdempotencyKey parameter', async () => {
  const headerName = spec.components.parameters.IdempotencyKey.name
  assert.equal(headerName, 'Idempotency-Key')
  for (const [id, args] of Object.entries(sampleArgs)) {
    let headers
    const client = new OmpClient({
      fetch: async (_url, init) => {
        headers = init.headers
        const body = specOperations[id].op['x-pagination'] ? { data: [], next_cursor: null } : {}
        return new Response(JSON.stringify(body), { status: 200 })
      },
    })
    await client[id](...args)
    const declared = (specOperations[id].op.parameters ?? []).some((p) => p.$ref === '#/components/parameters/IdempotencyKey')
    assert.equal(typeof headers[headerName] === 'string' && headers[headerName].length > 0, declared, id)
  }
})

test('paginated operations declare limit and cursor, and the SDK returns their page unchanged', async () => {
  for (const [id, { op }] of Object.entries(specOperations)) {
    if (!op['x-pagination']) continue
    const names = (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name)
    assert.ok(names.includes('limit') && names.includes('cursor'), id)
    const page = { data: [{ slug: 'x' }], next_cursor: 'n' }
    const client = new OmpClient({ fetch: async () => new Response(JSON.stringify(page), { status: 200 }) })
    assert.deepEqual(await client[id](...sampleArgs[id]), page, id)
  }
})
