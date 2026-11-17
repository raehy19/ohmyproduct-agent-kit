import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { OmpApiError } from '@ohmyproduct/sdk'
import { HELP, run, readVersion, formatError } from '../dist/cli.js'
import { formatDocList, formatLaunchList, formatStatus } from '../dist/format.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Runs the CLI with a stub client; `impl` maps method names to functions. */
async function exec(argv, impl = {}, env = {}) {
  const out = []
  const err = []
  const calls = []
  let clientOptions
  const client = new Proxy(
    {},
    {
      get: (_, method) => async (...args) => {
        calls.push([method, ...args])
        if (!impl[method]) throw new Error(`unexpected call ${String(method)}`)
        return impl[method](...args)
      },
    },
  )
  const code = await run(argv, {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env,
    makeClient: (options) => {
      clientOptions = options
      return client
    },
  })
  return { code, stdout: out.join(''), stderr: err.join(''), calls, clientOptions }
}

const status = { phase: 'closed_beta', participation_open: false, launch_date: null, counts: { discovered_products: 12, measured_at: '2026-11-15T09:00:00.000Z' } }
const docs = [
  { slug: 'guide', title: 'Guide', section: 'product', description: '', url: 'u', markdown_url: 'm', last_updated: '2026-11-01' },
  { slug: 'about', title: 'About', section: 'legal', description: '', url: 'u', markdown_url: 'm', last_updated: null },
]

test('--help and --version', async () => {
  const help = await exec(['--help'])
  assert.equal(help.code, 0)
  assert.equal(help.stdout, HELP)
  assert.match(help.stdout, /  status  /)
  for (const line of ['products list', 'products search <query>', 'products get <id>', 'products categories', '--category <slug>']) assert.ok(help.stdout.includes(line), line)
  assert.match(help.stdout, /discoveries by Omi, the Oh My Product scout: not user reviews,\ncustomers or maker participation/)
  const short = await exec(['-h'])
  assert.equal(short.code, 0)
  const version = await exec(['--version'])
  assert.equal(version.stdout, `${pkg.version}\n`)
  assert.equal(readVersion(), pkg.version)
  assert.equal((await exec(['-v'])).stdout, `${pkg.version}\n`)
})

test('no command prints help to stderr with usage exit code', async () => {
  const r = await exec([])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /Usage:/)
  assert.equal(r.stdout, '')
})

test('status: text and JSON output', async () => {
  const text = await exec(['status'], { getStatus: () => status })
  assert.equal(text.code, 0)
  assert.equal(
    text.stdout,
    'Phase: closed_beta\nParticipation open: no\nLaunch date: not announced\nDiscovered products: 12 (measured 2026-11-15T09:00:00.000Z)\n',
  )
  const json = await exec(['status', '--json'], { getStatus: () => status })
  assert.deepEqual(JSON.parse(json.stdout), status)
  assert.ok(json.stdout.endsWith('\n'))
})

test('global flags map to client options; env fallbacks', async () => {
  const r = await exec(['status', '--sandbox', '--base-url', 'http://localhost:3010', '--token', 'abc'], { getStatus: () => status })
  assert.equal(r.clientOptions.baseUrl, 'http://localhost:3010')
  assert.equal(r.clientOptions.token, 'abc')
  assert.equal(r.clientOptions.sandbox, true)
  assert.match(r.clientOptions.userAgent, /^ohmyproduct-cli\//)

  const env = await exec(['status'], { getStatus: () => status }, { OMP_BASE_URL: 'http://x', OMP_TOKEN: 'envtok', OMP_SANDBOX: '1' })
  assert.equal(env.clientOptions.baseUrl, 'http://x')
  assert.equal(env.clientOptions.token, 'envtok')
  assert.equal(env.clientOptions.sandbox, true)

  const flagWins = await exec(['status', '--token', 'flag'], { getStatus: () => status }, { OMP_TOKEN: 'env' })
  assert.equal(flagWins.clientOptions.token, 'flag')

  const plain = await exec(['status'], { getStatus: () => status })
  assert.equal(plain.clientOptions.sandbox, undefined)
  assert.equal(plain.clientOptions.baseUrl, undefined)
})

const page = (data, next_cursor = null) => ({ data, next_cursor })

test('docs list / get / search', async () => {
  const list = await exec(['docs', 'list'], { listDocs: () => page(docs) })
  assert.equal(list.stdout, 'guide  Guide [product]\nabout  About [legal]\n')
  assert.deepEqual(JSON.parse((await exec(['docs', 'list', '--json'], { listDocs: () => page(docs) })).stdout), page(docs))

  const get = await exec(['docs', 'get', 'guide'], { getDoc: (slug) => ({ ...docs[0], slug, markdown: '# Guide\n\nBody\n' }) })
  assert.deepEqual(get.calls, [['getDoc', 'guide']])
  assert.equal(get.stdout, '# Guide\n\nBody\n')
  const getJson = await exec(['docs', 'get', 'guide', '--json'], { getDoc: () => ({ slug: 'guide', markdown: 'x' }) })
  assert.equal(JSON.parse(getJson.stdout).markdown, 'x')

  const results = [{ slug: 'guide', title: 'Guide', url: 'https://ohmyproduct.com/guide', snippet: 'a snippet', score: 1 }]
  const search = await exec(['docs', 'search', 'test', 'drive', '--limit', '3'], { searchDocs: () => page(results) })
  assert.deepEqual(search.calls, [['searchDocs', 'test drive', { limit: 3 }]])
  assert.equal(search.stdout, 'guide  Guide\n  https://ohmyproduct.com/guide\n  a snippet\n')
  const empty = await exec(['docs', 'search', 'zzz'], { searchDocs: () => page([]) })
  assert.equal(empty.stdout, 'No results.\n')
  assert.deepEqual(empty.calls, [['searchDocs', 'zzz', {}]])
})

test('docs list follows every cursor by default; --limit/--cursor fetch exactly one page', async () => {
  const pages = { undefined: page([docs[0]], 'c1'), c1: page([docs[1]], null) }
  const all = await exec(['docs', 'list', '--json'], { listDocs: (options) => pages[options.cursor] })
  assert.deepEqual(all.calls, [['listDocs', {}], ['listDocs', { cursor: 'c1' }]])
  assert.deepEqual(JSON.parse(all.stdout), page(docs))

  const one = await exec(['docs', 'list', '--limit', '1'], { listDocs: () => page([docs[0]], 'c1') })
  assert.deepEqual(one.calls, [['listDocs', { limit: 1 }]])
  assert.equal(one.stdout, 'guide  Guide [product]\nMore: repeat with --cursor c1\n')
  const next = await exec(['docs', 'list', '--limit', '1', '--cursor', 'c1', '--json'], { listDocs: () => page([docs[1]]) })
  assert.deepEqual(next.calls, [['listDocs', { limit: 1, cursor: 'c1' }]])
  assert.deepEqual(JSON.parse(next.stdout), page([docs[1]]))
})

test('docs search --all walks every page with the same query; --cursor fetches one page', async () => {
  const hit = (slug) => ({ slug, title: slug, url: `https://ohmyproduct.com/${slug}`, snippet: '', score: 1 })
  const pages = { undefined: page([hit('a')], 'n1'), n1: page([hit('b')]) }
  const all = await exec(['docs', 'search', 'beta', '--all', '--limit', '1', '--json'], { searchDocs: (_q, options) => pages[options.cursor] })
  assert.deepEqual(all.calls, [['searchDocs', 'beta', { limit: 1 }], ['searchDocs', 'beta', { limit: 1, cursor: 'n1' }]])
  assert.deepEqual(JSON.parse(all.stdout).data.map((r) => r.slug), ['a', 'b'])
  const one = await exec(['docs', 'search', 'beta', '--cursor', 'n1'], { searchDocs: () => page([hit('b')]) })
  assert.deepEqual(one.calls, [['searchDocs', 'beta', { cursor: 'n1' }]])
  assert.equal((await exec(['docs', 'search', 'beta', '--all', '--cursor', 'n1'])).code, 2)
})

// ---- Products discovered by Omi ---------------------------------------------

const PROVENANCE = {
  source: 'omi_discovery',
  note: 'Products discovered by Omi, the Oh My Product scout, from public sources. They are not user reviews, not customers of Oh My Product, and not maker participation or endorsement. Names and one-line descriptions are unverified third-party claims summarized by Omi. A maker can ask for removal or correction at hi@ohmyproduct.com.',
  as_of: '2026-11-16T03:00:00.000Z',
}
const PROVENANCE_TEXT = `Provenance: ${PROVENANCE.note}\nSnapshot: ${PROVENANCE.as_of}\n`
const crawlkit = { id: 'crawlkit-434b6c', name: 'CrawlKit', url: 'https://crawlkit.example.com', tagline: 'Open-source web crawler', category: 'dev-data', tags: ['crawler', 'open-source'], discovered_on: '2026-09-23' }
const listedOnly = { id: 'listed-only-5c6d7e', name: 'ListedOnly', url: null, tagline: null, category: 'dev-data', tags: [], discovered_on: '2026-07-16' }
const productPage = (data, next_cursor = null, total = data.length) => ({ data, next_cursor, total, provenance: PROVENANCE })

test('products list: one page by default, says "discovered by Omi" and prints the provenance note once', async () => {
  const list = await exec(['products', 'list'], { listProducts: () => productPage([crawlkit, listedOnly], 'c1', 12) })
  assert.equal(list.code, 0)
  assert.deepEqual(list.calls, [['listProducts', {}]])
  assert.equal(
    list.stdout,
    'Products discovered by Omi (showing 2 of 12):\n' +
      'crawlkit-434b6c  CrawlKit [dev-data]\n  https://crawlkit.example.com\n  Open-source web crawler\n' +
      'listed-only-5c6d7e  ListedOnly [dev-data]\n  (no product URL recorded)\n' +
      'More: repeat with --cursor c1\n\n' +
      PROVENANCE_TEXT,
  )
  assert.equal(list.stdout.split('Provenance:').length - 1, 1)

  const filtered = await exec(['products', 'list', '--category', 'dev-data', '--limit', '2', '--cursor', 'c1', '--json'], { listProducts: () => productPage([crawlkit]) })
  assert.deepEqual(filtered.calls, [['listProducts', { category: 'dev-data', limit: 2, cursor: 'c1' }]])
  // --json prints the API page unchanged, provenance included.
  assert.deepEqual(JSON.parse(filtered.stdout), productPage([crawlkit]))

  const empty = await exec(['products', 'list', '--category', 'no-such'], { listProducts: () => productPage([]) })
  assert.equal(empty.stdout, `No products discovered by Omi match.\n\n${PROVENANCE_TEXT}`)
})

test('products list --all follows every cursor and keeps total and provenance', async () => {
  const pages = { undefined: productPage([crawlkit], 'c1', 2), c1: productPage([listedOnly], null, 2) }
  const all = await exec(['products', 'list', '--all', '--limit', '1', '--json'], { listProducts: (options) => pages[options.cursor] })
  assert.deepEqual(all.calls, [['listProducts', { limit: 1 }], ['listProducts', { limit: 1, cursor: 'c1' }]])
  assert.deepEqual(JSON.parse(all.stdout), productPage([crawlkit, listedOnly], null, 2))
  const text = await exec(['products', 'list', '--all'], { listProducts: (options) => pages[options.cursor] })
  assert.match(text.stdout, /^Products discovered by Omi \(showing 2 of 2\):\n/)
  assert.equal(text.stdout.split('Provenance:').length - 1, 1)
  assert.equal((await exec(['products', 'list', '--all', '--cursor', 'c1'])).code, 2)
})

test('products search: the query, category and limit reach listProducts', async () => {
  const search = await exec(['products', 'search', 'web', 'scraping', '--category', 'dev-data', '--limit', '3'], { listProducts: () => productPage([crawlkit]) })
  assert.deepEqual(search.calls, [['listProducts', { q: 'web scraping', category: 'dev-data', limit: 3 }]])
  assert.match(search.stdout, /^Products discovered by Omi \(showing 1 of 1\):\ncrawlkit-434b6c  CrawlKit \[dev-data\]\n/)
  assert.ok(search.stdout.endsWith(PROVENANCE_TEXT))
  const pages = { undefined: productPage([crawlkit], 'n1', 2), n1: productPage([listedOnly], null, 2) }
  const all = await exec(['products', 'search', 'crawler', '--all', '--json'], { listProducts: (options) => pages[options.cursor] })
  assert.deepEqual(all.calls, [['listProducts', { q: 'crawler' }], ['listProducts', { q: 'crawler', cursor: 'n1' }]])
  assert.deepEqual(JSON.parse(all.stdout).data.map((p) => p.id), ['crawlkit-434b6c', 'listed-only-5c6d7e'])
})

test('products get and products categories', async () => {
  const get = await exec(['products', 'get', 'crawlkit-434b6c'], { getProduct: (id) => ({ ...crawlkit, id, provenance: PROVENANCE }) })
  assert.deepEqual(get.calls, [['getProduct', 'crawlkit-434b6c']])
  assert.equal(
    get.stdout,
    'CrawlKit (discovered by Omi on 2026-09-23)\n  id: crawlkit-434b6c\n  url: https://crawlkit.example.com\n  description: Open-source web crawler\n  category: dev-data\n  tags: crawler, open-source\n\n' +
      PROVENANCE_TEXT,
  )
  const bare = await exec(['products', 'get', 'listed-only-5c6d7e'], { getProduct: () => ({ ...listedOnly, provenance: PROVENANCE }) })
  assert.match(bare.stdout, /url: \(no product URL recorded\)\n  description: \(none\)\n  category: dev-data\n\nProvenance:/)
  const getJson = await exec(['products', 'get', 'crawlkit-434b6c', '--json'], { getProduct: () => ({ ...crawlkit, provenance: PROVENANCE }) })
  assert.deepEqual(JSON.parse(getJson.stdout), { ...crawlkit, provenance: PROVENANCE })

  const body = { data: [{ slug: 'ai-agents', name: 'AI agents & automation', count: 1 }, { slug: 'dev-data', name: 'Development & data', count: 11 }], total: 12, provenance: PROVENANCE }
  const categories = await exec(['products', 'categories'], { listProductCategories: () => body })
  assert.deepEqual(categories.calls, [['listProductCategories']])
  assert.equal(
    categories.stdout,
    'Categories of the products discovered by Omi (12 products):\nai-agents     1  AI agents & automation\ndev-data     11  Development & data\n\n' + PROVENANCE_TEXT,
  )
  assert.deepEqual(JSON.parse((await exec(['products', 'categories', '--json'], { listProductCategories: () => body })).stdout), body)
})

test('products: an unavailable list is an API error (exit 1), never an empty list; unknown ids too', async () => {
  const unavailable = new OmpApiError({ status: 503, code: 'service_unavailable', message: 'The product list is temporarily unavailable.', hint: 'Retry after the number of seconds in the Retry-After header.' })
  const down = await exec(['products', 'list'], { listProducts: () => { throw unavailable } })
  assert.equal(down.code, 1)
  assert.equal(down.stdout, '')
  assert.match(down.stderr, /^omp: error \[service_unavailable\] The product list is temporarily unavailable\./)
  const missing = await exec(['products', 'get', 'nope'], { getProduct: () => { throw new OmpApiError({ status: 404, code: 'product_not_found', message: 'No product exists with this id.' }) } })
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /\[product_not_found\]/)
})

test('launch-list join: shows the share link', async () => {
  const joined = { status: 'joined', share_code: 'abc123', share_url: 'https://ohmyproduct.com/launch?ref=abc123', referral_count: 0 }
  const r = await exec(['launch-list', 'join', 'a@example.com', '--source', 'cli'], { joinLaunchList: () => joined })
  assert.deepEqual(r.calls, [['joinLaunchList', { email: 'a@example.com', source: 'cli' }]])
  assert.equal(r.stdout, 'Launch list: joined\nShare link: https://ohmyproduct.com/launch?ref=abc123\nReferrals so far: 0\n')
  const noSource = await exec(['launch-list', 'join', 'a@example.com', '--json'], { joinLaunchList: () => joined })
  assert.deepEqual(noSource.calls, [['joinLaunchList', { email: 'a@example.com' }]])
  assert.deepEqual(JSON.parse(noSource.stdout), joined)
  const again = await exec(['launch-list', 'join', 'a@example.com'], {
    joinLaunchList: () => ({ status: 'already_joined', share_code: null, share_url: null, referral_count: null }),
  })
  assert.match(again.stdout, /^Launch list: already on the list/)
  assert.doesNotMatch(again.stdout, /Share link/)
})

test('launch-list join --sandbox notes that nothing was stored', async () => {
  const r = await exec(['launch-list', 'join', 'a@example.com', '--sandbox'], {
    joinLaunchList: () => ({ status: 'joined', share_code: null, share_url: null, referral_count: 0, sandbox: true }),
  })
  assert.equal(r.clientOptions.sandbox, true)
  assert.equal(r.stdout, 'Launch list: joined\nReferrals so far: 0\nSandbox request: validated only; nothing was stored or sent.\n')
})

test('submit requires its options', async () => {
  const ok = await exec(['submit', '--name', 'Thing', '--url', 'https://t.example.com', '--email', 'a@example.com', '--json'], {
    submitProduct: () => ({ status: 'received' }),
  })
  assert.deepEqual(ok.calls, [['submitProduct', { name: 'Thing', url: 'https://t.example.com', email: 'a@example.com' }]])
  assert.deepEqual(JSON.parse(ok.stdout), { status: 'received' })
  const text = await exec(['submit', '--name', 'Thing', '--url', 'https://t.example.com', '--email', 'a@example.com'], {
    submitProduct: () => ({ status: 'received' }),
  })
  assert.match(text.stdout, /^Product submission: accepted for review \(HTTP 202\)\. Nothing is published until a person reviews it\.\n$/)
  const missing = await exec(['submit', '--name', 'Thing'])
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /Missing required option --url/)
  assert.equal(missing.calls.length, 0)
})

test('test-drive request requires consent', async () => {
  const no = await exec(['test-drive', 'request', '--email', 'a@example.com'])
  assert.equal(no.code, 2)
  assert.match(no.stderr, /--consent is required/)
  assert.equal(no.calls.length, 0)
  const yes = await exec(['test-drive', 'request', '--email', 'a@example.com', '--consent'], { requestTestDrive: () => ({ status: 'check_email' }) })
  assert.deepEqual(yes.calls, [['requestTestDrive', { email: 'a@example.com', consent: true }]])
  assert.match(yes.stdout, /^Test Drive request: check the inbox for the confirmation link \(HTTP 202\)/)
})

test('auth token: prints only the token on stdout', async () => {
  const token = { access_token: 'tok123', token_type: 'Bearer', expires_in: 3600, scope: 'docs:read', registration_id: 'agt_1', registration_type: 'anonymous' }
  const r = await exec(['auth', 'token', '--agent-name', 'bot', '--scopes', 'docs:read,launch:write'], { registerAgentIdentity: () => token })
  assert.deepEqual(r.calls, [['registerAgentIdentity', { agentName: 'bot', scopes: ['docs:read', 'launch:write'] }]])
  assert.equal(r.stdout, 'tok123\n')
  assert.match(r.stderr, /expires in 3600s, registration id: agt_1/)
  const json = await exec(['auth', 'token', '--json'], { registerAgentIdentity: () => token })
  assert.deepEqual(json.calls, [['registerAgentIdentity', { agentName: 'omp-cli' }]])
  assert.deepEqual(JSON.parse(json.stdout), token)
  assert.equal(json.stderr, '')
  const bad = await exec(['auth', 'token', '--scopes', 'admin'])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /Unknown scope: admin/)
})

test('auth revoke: positional, --token or OMP_TOKEN; 200 either way', async () => {
  const positional = await exec(['auth', 'revoke', 'tok1'], { revokeAgentToken: () => ({ revoked: true }) })
  assert.deepEqual(positional.calls, [['revokeAgentToken', 'tok1']])
  assert.equal(positional.stdout, 'Token revoked.\n')
  const fromEnv = await exec(['auth', 'revoke', '--json'], { revokeAgentToken: () => ({ revoked: false }) }, { OMP_TOKEN: 'envtok' })
  assert.deepEqual(fromEnv.calls, [['revokeAgentToken', 'envtok']])
  assert.deepEqual(JSON.parse(fromEnv.stdout), { revoked: false })
  const none = await exec(['auth', 'revoke'])
  assert.equal(none.code, 2)
  assert.equal(none.calls.length, 0)
})

test('usage errors exit 2', async () => {
  for (const argv of [['nope'], ['--bogus'], ['docs'], ['docs', 'get'], ['docs', 'search'], ['launch-list'], ['status', 'extra'], ['auth'], ['docs', 'search', 'q', '--limit', 'abc'], ['auth', 'token', 'extra'], ['products'], ['products', 'nope'], ['products', 'list', 'extra'], ['products', 'search'], ['products', 'get'], ['products', 'get', 'a', 'b'], ['products', 'categories', 'extra'], ['products', 'list', '--limit', '0']]) {
    const r = await exec(argv)
    assert.equal(r.code, 2, argv.join(' '))
    assert.match(r.stderr, /omp:/)
    assert.equal(r.calls.length, 0)
  }
})

test('API errors exit 1 and print the code, hint, docs and request id', async () => {
  const error = new OmpApiError({
    status: 400,
    code: 'invalid_email',
    message: 'Email is not valid.',
    hint: 'Use name@host.tld.',
    docs: 'https://ohmyproduct.com/developers#errors',
    requestId: 'req_9',
  })
  const r = await exec(['launch-list', 'join', 'bad'], { joinLaunchList: () => { throw error } })
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.equal(
    r.stderr,
    'omp: error [invalid_email] Email is not valid.\n  hint: Use name@host.tld.\n  docs: https://ohmyproduct.com/developers#errors\n  request id: req_9\n',
  )
  const json = await exec(['launch-list', 'join', 'bad', '--json'], { joinLaunchList: () => { throw error } })
  assert.equal(json.code, 1)
  assert.deepEqual(JSON.parse(json.stderr), {
    error: { status: 400, code: 'invalid_email', message: 'Email is not valid.', hint: 'Use name@host.tld.', docs: 'https://ohmyproduct.com/developers#errors', request_id: 'req_9' },
  })
  assert.equal(formatError(new OmpApiError({ status: 0, code: 'timeout', message: 'slow' }), false), 'omp: error [timeout] slow')
})

test('unexpected errors exit 1', async () => {
  const r = await exec(['status'], { getStatus: () => { throw new Error('boom') } })
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'omp: boom\n')
})

test('formatters', () => {
  assert.equal(formatDocList({ data: [], next_cursor: null }), 'No documents.')
  assert.equal(formatStatus({ ...status, participation_open: true, launch_date: '2027-01-01' }).includes('Participation open: yes'), true)
  assert.equal(formatLaunchList({ status: 'joined', share_code: null, share_url: null, referral_count: 0 }), 'Launch list: joined\nReferrals so far: 0')
})

test('built binary runs --help and --version', () => {
  const bin = new URL('../dist/bin.js', import.meta.url).pathname
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /omp - command line client/)
  const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
  assert.equal(version.stdout.trim(), pkg.version)
  const bad = spawnSync(process.execPath, [bin, 'nope'], { encoding: 'utf8' })
  assert.equal(bad.status, 2)
  // An unreachable base URL surfaces as a network error with exit code 1.
  const net = spawnSync(process.execPath, [bin, 'status', '--base-url', 'http://127.0.0.1:1', '--json'], { encoding: 'utf8' })
  assert.equal(net.status, 1)
  assert.equal(JSON.parse(net.stderr).error.code, 'network_error')
})
