# Integrating with Oh My Product (guidance for AI coding agents)

Read this before you write code that calls Oh My Product or answers questions
about it. Everything here describes what exists today. If something is not
listed, it does not exist; do not assume it.

## What Oh My Product exposes

Oh My Product (<https://ohmyproduct.com>) is a social launch community for
builders and early adopters. It is in a **closed beta**. The public surface is
deliberately small.

| Surface | Location |
| --- | --- |
| Developer docs | <https://ohmyproduct.com/developers> |
| OpenAPI 3.1 spec | <https://ohmyproduct.com/openapi.json> |
| Navigation index for LLMs | <https://ohmyproduct.com/llms.txt> |
| REST API base | `https://ohmyproduct.com/api/v1` |
| Product MCP server | `https://ohmyproduct.com/mcp` |
| Documentation MCP server | `https://ohmyproduct.com/mcp/docs` |
| Agent auth guide | <https://ohmyproduct.com/auth.md> |
| TypeScript SDK | `@ohmyproduct/sdk` in `packages/sdk` (not yet on npm; build from source) |
| CLI | `ohmyproduct`, command `omp`, in `packages/cli` (not yet on npm; build from source) |

API operations (OpenAPI `operationId`): `getApiRoot`, `getStatus`, `listDocs`,
`getDoc`, `searchDocs`, `joinLaunchList`, `submitProduct`, `requestTestDrive`,
`getAgentIdentity`, plus the identity endpoints `getAgentAuth`,
`describeAgentIdentityEndpoint`, `registerAgentIdentity` and
`revokeAgentToken`. Anonymous agent tokens come from
`POST https://ohmyproduct.com/agent/identity` (outside `/api/v1`).

Every `/api/v1` operation is mirrored at the sandbox base
`https://ohmyproduct.com/api/sandbox/v1` (the second server in the OpenAPI
document), where every write is sandboxed.

The two MCP servers are shipped separately from the REST API. Before you rely
on one, check that it answers `initialize` (see `skills/omp-mcp-setup`).

## The closed-beta boundary

While the beta is closed:

- The API returns **public data only**: the launch status, the public guides
  and legal pages, and one aggregate count that is already public.
- There is **no catalog, post, profile or member data** in the API, the MCP
  servers or the docs. Do not build features that expect it, and do not scrape
  the site to get it.
- There are exactly **three public write actions**: join the launch list,
  submit a product for private review, and request a Test Drive. They use the
  same validation, limits and storage as the website forms.
- No launch date is announced. Say "coming soon". Never state or guess a date.
  Read `GET /api/v1/status` for the live state.
- Do not try to bypass the gate (paths, user agents, headers). Gated routes
  answer `403` with `{"error":"closed_beta"}` to agents on purpose.

## Rules for agents

1. **Sandbox first.** Build and test against the sandbox base
   `https://ohmyproduct.com/api/sandbox/v1`, or send `X-OMP-Sandbox: true` (or
   `?sandbox=true`; `1` also works) on a write to `/api/v1`. A sandbox request
   is validated and answered with the real response (same status code, same
   fields) plus `"sandbox": true` and the response header
   `X-OMP-Sandbox: true`. Nothing is stored and no email is sent. Only use
   `/api/v1` without the flag for a real action the user confirmed. Writes
   need `Content-Type: application/json` and a body under 4 KB.
   Send an `Idempotency-Key` (a fresh UUID per action) on every write and
   reuse it only to retry the same request: a retry with the same key and body
   replays the first answer (`Idempotent-Replayed: true`) instead of running
   again; the same key with another body is `422 idempotency_key_reused`.
2. **Never fabricate.** Do not invent reviews, ratings, testimonials, users,
   accounts, products, email addresses or consent. Do not submit test data to
   the live endpoints. The API has no endpoint for reviews and you must not
   simulate one.
3. **Real people, real consent.** Use an email address only if its owner asked
   for the action. `requestTestDrive` needs `consent: true`; set it only when
   the email owner agreed to receive the verification email. One address per
   explicit request; no loops over lists of people.
4. **Read before you claim.** Fetch the docs (`/api/v1/docs`, `/llms.txt`, or
   the markdown twins at `<path>.md`) and the live status instead of answering
   from memory.
5. **Handle errors as data.** Every `/api/v1` error is
   `{"error":{"code","message","hint","docs","request_id"}}`. Branch on
   `code`, show the `hint`, and keep the `request_id` for bug reports. The two
   identity endpoints (`/agent/identity`, `/agent/identity/revoke`) use the
   OAuth shape instead: `{"error":"invalid_request","error_description":"...","error_uri":"...","request_id":"..."}`.
   Notable codes: `launch_open` (409, the prelaunch forms are closed because
   the product opened), `consent_required`, `invalid_email`, `invalid_name`,
   `invalid_url`, `invalid_cursor`, `idempotency_key_reused`, `rate_limited`,
   `invalid_token`, `insufficient_scope`.
6. **Respect limits.** Responses carry `RateLimit-Limit`, `RateLimit-Remaining`
   and `RateLimit-Reset`. On a 429 or 503, honor `Retry-After` and retry at most
   once. Do not hammer the API.
7. **Secrets.** The public API needs no secret. Agent tokens last one hour;
   do not commit them or paste them into logs. A token that is expired,
   revoked or malformed makes **every** `/api/v1` call fail with
   `401 invalid_token`, public ones included: drop the `Authorization` header
   or register a new identity.

## What the writes answer

| Operation | Request body | Success |
| --- | --- | --- |
| `joinLaunchList` | `{"email","source"?}` | `200` `{"status":"joined"\|"already_joined","share_code","share_url","referral_count"}` (the last three are `null` for `already_joined`) |
| `submitProduct` | `{"name","url","email"}` | `202` `{"status":"received"}`; queued for private review, duplicates get the same answer |
| `requestTestDrive` | `{"email","consent":true}` | `202` `{"status":"check_email"}`; counts only after the recipient opens the link |

Treat `202` as "accepted for processing", never as "published" or "enrolled".
Read-only examples:

```sh
curl -s https://ohmyproduct.com/api/v1/status
# {"phase":"closed_beta","participation_open":false,"launch_date":null,
#  "counts":{"discovered_products":0,"measured_at":"2026-11-15T09:00:00.000Z"}}
curl -s "https://ohmyproduct.com/api/v1/search?q=test%20drive&limit=5"
# {"data":[{"slug","title","url","snippet","score"}, ...],"next_cursor":"..."|null}   (limit is 1 to 25)
```

`GET /api/v1/docs` returns `{"data":[...],"next_cursor":...}`, each item
`{slug,title,description,url,markdown_url,section,last_updated}` (`section` is
`product`, `first-users`, `legal` or `developers`; `last_updated` may be
`null`; `limit` is 1 to 50, default 20). Both lists are cursor-paginated: pass
`next_cursor` back unchanged as `?cursor=` (with the same `q` for search) until
it is `null`. The next page is also in a `Link: <...>; rel="next"` header.

Anonymous agent identity, only when you need a token:

```sh
curl -s -X POST https://ohmyproduct.com/agent/identity \
  -H 'Content-Type: application/json' \
  -d '{"type":"anonymous","agent_name":"my-agent","scopes":["docs:read","launch:write"]}'
# {"access_token","token_type":"Bearer","expires_in":3600,"scope":"docs:read launch:write",
#  "registration_id","registration_type":"anonymous"}
```

`identity_type` is accepted as an alias of `type`. Revoke with
`curl -s -X POST https://ohmyproduct.com/agent/identity/revoke -d "token=$TOKEN"`
(form-encoded or JSON `{"token"}`); it always answers `200 {"revoked":true|false}`.

## Recommended integration path

1. Read <https://ohmyproduct.com/developers> and the OpenAPI spec.
2. Use the SDK in TypeScript projects (`createClient({ sandbox: true })`; it
   sends an `Idempotency-Key` on every write and has `iterateDocs` /
   `iterateSearch` for the cursors), the CLI in shell scripts
   (`omp ... --sandbox --json`), or plain HTTP against the sandbox base
   elsewhere. Neither package is on npm yet: build them from this repository
   (see the README, "Using the packages from source"). Do not tell a user to
   run `npm install @ohmyproduct/sdk` or `npx ohmyproduct` until they are.
3. For MCP clients, add `https://ohmyproduct.com/mcp/docs` for reading and
   `https://ohmyproduct.com/mcp` for the write tools.
4. Use the skills in `skills/` for step-by-step procedures.

## Skills in this repository

| Skill | Use it to |
| --- | --- |
| `omp-read-docs` | Read and search the public docs |
| `omp-check-launch-status` | Read the live launch state |
| `omp-join-launch-list` | Join the launch list (sandbox first) |
| `omp-submit-product` | Submit a product for private review (sandbox first) |
| `omp-request-test-drive` | Request a Test Drive email (sandbox first, consent) |
| `omp-mcp-setup` | Connect the two hosted MCP servers |

## When in doubt

Ask the user. A wrong write cannot always be undone, and a skipped question
costs one message.
