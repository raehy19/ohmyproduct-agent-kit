import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  OmpApiError,
  createClient,
  type AgentScope,
  type ClientOptions,
  type OmpClient,
  type Page,
} from '@ohmyproduct/sdk'
import {
  formatDoc,
  formatDocList,
  formatSearch,
  formatStatus,
  formatToken,
  formatTokenDetails,
  formatLaunchList,
  formatRevoke,
  formatSubmission,
  formatTestDrive,
} from './format.js'

export const EXIT_OK = 0
export const EXIT_API_ERROR = 1
export const EXIT_USAGE = 2

/** The subset of OmpClient the CLI calls. Tests stub this. */
export type CliClient = Pick<
  OmpClient,
  | 'getStatus'
  | 'listDocs'
  | 'getDoc'
  | 'searchDocs'
  | 'joinLaunchList'
  | 'submitProduct'
  | 'requestTestDrive'
  | 'registerAgentIdentity'
  | 'revokeAgentToken'
>

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Record<string, string | undefined>
  makeClient: (options: ClientOptions) => CliClient
}

export function readVersion(): string {
  const url = new URL('../package.json', import.meta.url)
  return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version
}

export const HELP = `omp - command line client for the Oh My Product public API

Usage:
  omp <command> [options]

Commands:
  status                              Show launch phase and public counts
  docs list                           List every public document (all pages)
  docs get <slug>                     Print one document as markdown
  docs search <query>                 Search the documents (first page; --all for every page)
  launch-list join <email>            Join the launch list
  submit --name N --url U --email E   Submit a product for private review
  test-drive request --email E --consent
                                      Request a closed-beta Test Drive email
  auth token                          Mint an anonymous agent token (one hour)
  auth revoke [token]                 Revoke a token (default: --token / OMP_TOKEN)

Global options:
  --json              Print stable JSON instead of text
  --sandbox           Validate writes without storing or sending anything
  --base-url <url>    Site origin (default https://ohmyproduct.com)
  --token <token>     Agent bearer token (or set OMP_TOKEN)
  --limit <n>         Page size for docs list / docs search (one page only)
  --cursor <c>        next_cursor from a previous page (one page only)
  --all               docs search: follow next_cursor through every page
  --source <label>    Attribution label for launch-list join
  --agent-name <n>    Agent name for auth token (default omp-cli)
  --scopes <list>     Comma-separated scopes for auth token (docs:read always;
                      add launch:write to write with the token)
  -h, --help          Show this help
  -v, --version       Show the version

Environment: OMP_BASE_URL, OMP_TOKEN, OMP_SANDBOX=1

Exit codes: 0 success, 1 API or network error, 2 usage error.
Errors print the API error code, for example: omp: error [invalid_email] ...
Docs: https://ohmyproduct.com/developers
`

class UsageError extends Error {}

const OPTIONS = {
  json: { type: 'boolean' },
  sandbox: { type: 'boolean' },
  'base-url': { type: 'string' },
  token: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  name: { type: 'string' },
  url: { type: 'string' },
  email: { type: 'string' },
  source: { type: 'string' },
  consent: { type: 'boolean' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  all: { type: 'boolean' },
  'agent-name': { type: 'string' },
  scopes: { type: 'string' },
} as const

type Parsed = ReturnType<typeof parse>

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
}

function need(value: string | undefined, flag: string): string {
  if (!value) throw new UsageError(`Missing required option --${flag}.`)
  return value
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer.')
  return limit
}

/** Follows next_cursor until the last page; returns one page holding every item. */
async function collectPages<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>): Promise<Page<T>> {
  const data: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await fetchPage(cursor)
    data.push(...page.data)
    if (page.next_cursor === null || seen.has(page.next_cursor)) return { data, next_cursor: null }
    seen.add(page.next_cursor)
    cursor = page.next_cursor
  }
}

function exactlyOne(positionals: string[], what: string): string {
  if (positionals.length !== 1) throw new UsageError(`Expected exactly one ${what}.`)
  return positionals[0] as string
}

export function buildClientOptions(values: Parsed['values'], env: CliIo['env']): ClientOptions {
  const options: ClientOptions = {}
  const baseUrl = values['base-url'] ?? env.OMP_BASE_URL
  if (baseUrl) options.baseUrl = baseUrl
  const token = values.token ?? env.OMP_TOKEN
  if (token) options.token = token
  const envSandbox = env.OMP_SANDBOX === '1' || env.OMP_SANDBOX === 'true'
  if (values.sandbox || envSandbox) options.sandbox = true
  options.userAgent = `ohmyproduct-cli/${readVersion()}`
  return options
}

function parseScopes(raw: string | undefined): AgentScope[] | undefined {
  if (!raw) return undefined
  const allowed = ['docs:read', 'launch:write']
  const scopes = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const bad = scopes.filter((s) => !allowed.includes(s))
  if (bad.length > 0) throw new UsageError(`Unknown scope: ${bad.join(', ')}. Allowed: ${allowed.join(', ')}.`)
  return scopes as AgentScope[]
}

export function formatError(error: OmpApiError, json: boolean): string {
  if (json) {
    return JSON.stringify({ error: error.toJSON() }, null, 2)
  }
  const lines = [`omp: error [${error.code}] ${error.message}`]
  if (error.hint) lines.push(`  hint: ${error.hint}`)
  if (error.docs) lines.push(`  docs: ${error.docs}`)
  if (error.requestId) lines.push(`  request id: ${error.requestId}`)
  return lines.join('\n')
}

/** Runs the CLI and returns the process exit code. Never calls process.exit. */
export async function run(argv: string[], io: CliIo): Promise<number> {
  let parsed: Parsed
  try {
    parsed = parse(argv)
  } catch (error) {
    io.stderr(`omp: ${(error as Error).message}\nRun "omp --help" for usage.\n`)
    return EXIT_USAGE
  }
  const { values, positionals } = parsed
  const json = values.json === true
  const out = (value: unknown, text: string) =>
    io.stdout((json ? JSON.stringify(value, null, 2) : text) + '\n')

  if (values.help || positionals[0] === 'help') {
    io.stdout(HELP)
    return EXIT_OK
  }
  if (values.version) {
    io.stdout(`${readVersion()}\n`)
    return EXIT_OK
  }
  if (positionals.length === 0) {
    io.stderr(HELP)
    return EXIT_USAGE
  }

  try {
    const [command, ...rest] = positionals as [string, ...string[]]
    const client = io.makeClient(buildClientOptions(values, io.env))

    switch (command) {
      case 'status': {
        if (rest.length > 0) throw new UsageError('"status" takes no arguments.')
        const status = await client.getStatus()
        out(status, formatStatus(status))
        return EXIT_OK
      }
      case 'docs': {
        const [sub, ...args] = rest
        const limit = parseLimit(values.limit)
        const cursor = values.cursor
        const pageOptions = { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) }
        if (sub === 'list') {
          if (args.length > 0) throw new UsageError('"docs list" takes no arguments.')
          // Without --limit/--cursor, every page; with them, exactly that page.
          const page = limit === undefined && cursor === undefined
            ? await collectPages((next) => client.listDocs(next === undefined ? {} : { cursor: next }))
            : await client.listDocs(pageOptions)
          out(page, formatDocList(page))
        } else if (sub === 'get') {
          const doc = await client.getDoc(exactlyOne(args, 'document slug'))
          out(doc, formatDoc(doc))
        } else if (sub === 'search') {
          if (args.length === 0) throw new UsageError('Expected a search query.')
          const query = args.join(' ')
          if (values.all && cursor !== undefined) throw new UsageError('--all and --cursor cannot be combined.')
          const page = values.all
            ? await collectPages((next) => client.searchDocs(query, { ...(limit === undefined ? {} : { limit }), ...(next === undefined ? {} : { cursor: next }) }))
            : await client.searchDocs(query, pageOptions)
          out(page, formatSearch(page))
        } else {
          throw new UsageError('Usage: omp docs list | get <slug> | search <query>')
        }
        return EXIT_OK
      }
      case 'launch-list': {
        const [sub, ...args] = rest
        if (sub !== 'join') throw new UsageError('Usage: omp launch-list join <email>')
        const email = exactlyOne(args, 'email address')
        const input = values.source ? { email, source: values.source } : { email }
        const result = await client.joinLaunchList(input)
        out(result, formatLaunchList(result))
        return EXIT_OK
      }
      case 'submit': {
        if (rest.length > 0) throw new UsageError('"submit" takes options only: --name --url --email.')
        const result = await client.submitProduct({
          name: need(values.name, 'name'),
          url: need(values.url, 'url'),
          email: need(values.email, 'email'),
        })
        out(result, formatSubmission(result))
        return EXIT_OK
      }
      case 'test-drive': {
        const [sub, ...args] = rest
        if (sub !== 'request' || args.length > 0) {
          throw new UsageError('Usage: omp test-drive request --email <email> --consent')
        }
        const email = need(values.email, 'email')
        if (!values.consent) {
          throw new UsageError('--consent is required: it confirms the recipient agrees to receive the verification email.')
        }
        const result = await client.requestTestDrive({ email, consent: true })
        out(result, formatTestDrive(result))
        return EXIT_OK
      }
      case 'auth': {
        const [sub, ...args] = rest
        if (sub === 'token' && args.length === 0) {
          const scopes = parseScopes(values.scopes)
          const token = await client.registerAgentIdentity({
            agentName: values['agent-name'] ?? 'omp-cli',
            ...(scopes ? { scopes } : {}),
          })
          out(token, formatToken(token))
          if (!json) io.stderr(`${formatTokenDetails(token)}\n`)
          return EXIT_OK
        }
        if (sub === 'revoke' && args.length <= 1) {
          const target = args[0] ?? values.token ?? io.env.OMP_TOKEN
          if (!target) throw new UsageError('Pass the token to revoke, or set --token / OMP_TOKEN.')
          const result = await client.revokeAgentToken(target)
          out(result, formatRevoke(result))
          return EXIT_OK
        }
        throw new UsageError('Usage: omp auth token | omp auth revoke [token]')
      }
      default:
        throw new UsageError(`Unknown command "${command}".`)
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`omp: ${error.message}\nRun "omp --help" for usage.\n`)
      return EXIT_USAGE
    }
    if (error instanceof OmpApiError) {
      io.stderr(formatError(error, json) + '\n')
      return EXIT_API_ERROR
    }
    if (error instanceof TypeError) {
      // Input validation raised by the SDK before any request was sent.
      io.stderr(`omp: ${error.message}\n`)
      return EXIT_USAGE
    }
    io.stderr(`omp: ${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT_API_ERROR
  }
}

export function defaultIo(): CliIo {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    env: process.env,
    makeClient: (options) => createClient(options),
  }
}
