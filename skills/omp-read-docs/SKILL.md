---
name: omp-read-docs
description: Read and search the public Oh My Product documentation (guides, about, first-user playbooks, legal pages) through the public API or its markdown twins. Use when you need facts about Oh My Product, how its closed beta works, or what the API supports, instead of guessing or scraping HTML.
---

# Read the Oh My Product docs

Oh My Product publishes its public documents as markdown. Read them directly
instead of scraping pages or answering from memory.

## When to use

- The user asks what Oh My Product is, how the closed beta works, or how to
  use the API.
- You need an authoritative sentence to quote before you describe the product.

## Steps

1. List what exists. No auth is needed.

   ```sh
   curl -s https://ohmyproduct.com/api/v1/docs
   ```

   The response is one page: `{"data": [...], "next_cursor": "..." | null}`.
   Each item in `data` has `slug`, `title`, `description`, `url`,
   `markdown_url`, `section` (`product`, `first-users`, `legal` or
   `developers`) and `last_updated` (`YYYY-MM-DD` or `null`). While
   `next_cursor` is not null, fetch the next page with
   `?cursor=<next_cursor>` (pass it unchanged; `limit` is 1 to 50, default 20).

2. Search when you do not know the slug. Search is lexical (keyword based).

   ```sh
   curl -s "https://ohmyproduct.com/api/v1/search?q=test%20drive&limit=5"
   ```

   The response is a page, `{"data": [{slug,title,url,snippet,score}, ...],
   "next_cursor": ...}`, best first; `limit` is 1 to 25 (default 10) and an
   empty `data` means no match. For more results, repeat the same `q` with
   `&cursor=<next_cursor>`. A missing `q` answers `400 invalid_query`; an
   altered cursor, or one from another query, answers `400 invalid_cursor`.

3. Fetch one document. The response adds a `markdown` field.

   ```sh
   curl -s https://ohmyproduct.com/api/v1/docs/guide
   ```

   An unknown slug answers `404 doc_not_found`.

4. Quote from the `markdown` field and cite the document `url`. If a document
   does not answer the question, say so. Do not fill the gap with invented
   details.

Other ways to read the same content:

- `https://ohmyproduct.com/llms.txt` is the navigation index.
- Any public page has a markdown twin at `<path>.md`, for example
  `https://ohmyproduct.com/guide.md`.
- With the SDK: `(await createClient().searchDocs('test drive')).data`, or
  `for await (const doc of createClient().iterateDocs())` for every document.
  With the CLI: `omp docs search "test drive"`, `omp docs list`,
  `omp docs get guide`.
- The documentation MCP server at `https://ohmyproduct.com/mcp/docs` exposes
  `list_docs`, `get_doc` and `search_docs`. See the `omp-mcp-setup` skill.

## Rules

- Public data only. There is no catalog, post, profile or member data in the
  API while the beta is closed. If a question needs that data, say it is not
  available.
- On a 429 or 503, wait for the `Retry-After` header and retry once.
- Error bodies have the shape `{"error":{"code","message","hint","docs","request_id"}}`.
  Report the `code` and `request_id` when something fails.
