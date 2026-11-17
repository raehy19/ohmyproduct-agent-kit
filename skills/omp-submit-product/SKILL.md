---
name: omp-submit-product
description: Submit a real product to Oh My Product for private review through the public API, sandbox first. Use only for a product the user actually owns or builds, with details the user supplied; never for invented or third-party products.
---

# Submit a product to Oh My Product

A submission goes to private review. It is not published and does not create a
listing or an account.

## Before you start

Collect these from the user. Do not invent or infer any of them:

- `name`: the product name.
- `url`: the product's public URL.
- `email`: a contact address the user controls.

Confirm the user owns or builds the product. Never submit someone else's
product, a placeholder, or test data to the real endpoint. Use the sandbox for
tests.

## Steps

1. Dry run in the sandbox. Nothing is stored and no email is sent.

   ```sh
   curl -s -X POST https://ohmyproduct.com/api/v1/product-submissions \
     -H 'Content-Type: application/json' \
     -H 'X-OMP-Sandbox: true' \
     -d '{"name":"My product","url":"https://example.com","email":"me@example.com"}'
   ```

   Expect HTTP 202 and `{"status":"received","sandbox":true}`. Fix anything
   the error `hint` points at (`invalid_name`: 1 to 80 characters;
   `invalid_url`: absolute http or https URL up to 2048 characters;
   `invalid_email`). `409 launch_open` means the prelaunch forms have closed.

2. Show the user the exact payload and get a clear go-ahead.

3. Send the real request: the same command without the `X-OMP-Sandbox`
   header, plus `-H "Idempotency-Key: $KEY"` with a fresh key
   (`KEY=$(uuidgen)`). If the connection drops, retry once with the same key
   and body: the API replays the first answer (`Idempotent-Replayed: true`)
   instead of running the write twice.

4. Report the response: HTTP 202 `{"status":"received"}` means the submission
   was accepted for review, not published. Duplicates and repeat submissions
   from one email get the same answer, so a `received` does not prove a new
   row was created. Tell the user it goes to private review by a person and
   that a reply is not guaranteed on a schedule. Quote the `X-Request-Id`
   response header (or the `request_id` of an error) in bug reports.

With the SDK: `createClient({ sandbox: true }).submitProduct({ name, url, email })`.
With the CLI: `omp submit --name "My product" --url https://example.com --email me@example.com --sandbox`,
then again without `--sandbox`.

## Rules

- Sandbox first, every time.
- One submission per product. Do not retry a success.
- Never write reviews, ratings or testimonials for a product. Oh My Product
  has no endpoint for that and you must not fabricate any.
