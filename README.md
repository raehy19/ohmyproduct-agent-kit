# Oh My Product agent kit

Skills, rules, MCP configuration and client packages for integrating AI coding
agents and scripts with the public
[Oh My Product](https://ohmyproduct.com) API.

> Status: this repository is public under the MIT license. The client packages
> `@ohmyproduct/sdk` and `ohmyproduct` are **not yet on npm**: build them from
> this repository as described in
> [Using the packages from source](#using-the-packages-from-source).

Oh My Product is in closed beta. The public API covers public documents, the
launch status, the read-only list of products discovered by Omi (the site's
product scout), and three public write actions (join the launch list, submit a
product for private review, request a Test Drive). It has no product pages,
reviews, posts, profiles or member data. See [AGENTS.md](AGENTS.md) for the
full boundary and the rules agents must follow.

The products are **discoveries by Omi**, not user reviews, customers or maker
participation, and their names and one-line descriptions are unverified
third-party claims. Agents must present them as Omi discoveries, never as
reviewed, endorsed or listed by their makers. A maker can ask for removal or
correction at `hi@ohmyproduct.com`.

## Contents

| Path | What it is |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Guidance for AI coding agents integrating with Oh My Product |
| [.cursorrules](.cursorrules) | The same guidance in brief, for Cursor |
| [skills/](skills) | One skill per capability, each a `SKILL.md` |
| [plugin.json](plugin.json) | Plugin manifest in the [agent-plugins.org](https://agent-plugins.org/specification) format |
| [mcp.json](mcp.json) | The two hosted MCP servers, in the agent-plugins format |
| [packages/sdk](packages/sdk) | `@ohmyproduct/sdk`, a typed JavaScript and TypeScript client (not yet on npm) |
| [packages/cli](packages/cli) | `ohmyproduct`, the `omp` command (not yet on npm) |

## Hosted endpoints

| Endpoint | URL |
| --- | --- |
| REST API | `https://ohmyproduct.com/api/v1` |
| Agent identity (anonymous tokens) | `POST https://ohmyproduct.com/agent/identity` |
| OpenAPI spec | <https://ohmyproduct.com/openapi.json> |
| Agent auth guide | <https://ohmyproduct.com/auth.md> |
| Product MCP server | `https://ohmyproduct.com/mcp` |
| Documentation MCP server | `https://ohmyproduct.com/mcp/docs` |
| Developer docs | <https://ohmyproduct.com/developers> |
| LLM index | <https://ohmyproduct.com/llms.txt> |

## Skills

| Skill | Purpose |
| --- | --- |
| `omp-read-docs` | Read and search the public docs |
| `omp-check-launch-status` | Read the live launch state |
| `omp-find-products` | Find products discovered by Omi (read-only), and present them as discoveries |
| `omp-join-launch-list` | Join the launch list, sandbox first |
| `omp-submit-product` | Submit a product for private review, sandbox first |
| `omp-request-test-drive` | Request a Test Drive email, sandbox first, with consent |
| `omp-mcp-setup` | Connect the two hosted MCP servers |

Install them with the [Skills CLI](https://skills.sh):

```sh
npx skills add raehy19/ohmyproduct-agent-kit --list                     # show the seven skills
npx skills add raehy19/ohmyproduct-agent-kit                            # install, choosing skills and agents
npx skills add raehy19/ohmyproduct-agent-kit --skill omp-read-docs      # one skill
```

Or copy the folders in `skills/` into your agent's skills directory.

## MCP

Add the servers to any MCP client that supports Streamable HTTP. For Claude
Code:

```sh
claude mcp add --transport http ohmyproduct https://ohmyproduct.com/mcp
claude mcp add --transport http ohmyproduct-docs https://ohmyproduct.com/mcp/docs
```

For clients that read `mcpServers` with a `url`, or for the agent-plugins
format, use [mcp.json](mcp.json). Details are in
[skills/omp-mcp-setup](skills/omp-mcp-setup/SKILL.md).

## Sandbox first

Every `/api/v1` operation is mirrored at the sandbox base
`https://ohmyproduct.com/api/sandbox/v1`, where every write is sandboxed. On the
production base, the three write endpoints (`/api/v1/launch-list`,
`/api/v1/product-submissions`, `/api/v1/test-drive-requests`) also accept
`X-OMP-Sandbox: true` (or `?sandbox=true`). A sandbox request is validated and
answered with the real status code and response shape plus `"sandbox": true`,
and nothing is stored or sent.

```sh
curl -s -X POST https://ohmyproduct.com/api/sandbox/v1/launch-list \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"email":"you@example.com","source":"readme"}'
# {"status":"joined","share_code":null,"share_url":null,"referral_count":0,"sandbox":true}
```

Send an `Idempotency-Key` on every write so a retry after a network failure
replays the first answer instead of running again.

A real join answers `{"status":"joined","share_code":"...","share_url":"https://ohmyproduct.com/launch?ref=...","referral_count":0}`
(or `already_joined` with the last three fields `null`). Product submissions
and Test Drive requests answer `202` (`{"status":"received"}` and
`{"status":"check_email"}`): accepted for review, not published.

## Using the packages from source

The SDK and the CLI are not yet on npm, so `npm install @ohmyproduct/sdk` and
`npx ohmyproduct` do not work yet. Build them from a clone instead (Node 20 or
newer). Build the SDK first: the CLI uses it through the local path
`file:../sdk`.

```sh
git clone https://github.com/raehy19/ohmyproduct-agent-kit.git
cd ohmyproduct-agent-kit
(cd packages/sdk && npm install && npm test)   # builds packages/sdk/dist, then runs the tests
(cd packages/cli && npm install && npm test)   # builds packages/cli/dist, then runs the tests

node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js docs search "beta testers"
node packages/cli/dist/bin.js products search "web scraping" --limit 5
node packages/cli/dist/bin.js launch-list join you@example.com --sandbox
```

To use the SDK from another project, install the built folder by path:

```sh
npm install /path/to/ohmyproduct-agent-kit/packages/sdk
```

After the API changes, refresh the checked-in OpenAPI copy that the SDK
contract test uses:

```sh
(cd packages/sdk && npm run sync:openapi && npm test)
```

## License

MIT. See [LICENSE](LICENSE).
