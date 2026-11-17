---
name: omp-join-launch-list
description: Add a person's email to the Oh My Product launch list through the public API, sandbox first. Use only when the email owner has asked to be on the list; never for emails you scraped, guessed or invented.
---

# Join the Oh My Product launch list

This is a real write. It stores an email address. Follow the order below.

## Before you start

- The email must belong to the person you are acting for, and they must have
  asked to join. Ask them if you are unsure. Never use an address you found,
  guessed or made up, and never add several people in a loop.
- Check the state first with the `omp-check-launch-status` skill so you can
  describe the result accurately.

## Steps

1. Dry run in the sandbox. Nothing is stored and no email is sent.

   ```sh
   curl -s -X POST https://ohmyproduct.com/api/v1/launch-list \
     -H 'Content-Type: application/json' \
     -H 'X-OMP-Sandbox: true' \
     -d '{"email":"person@example.com","source":"my-agent"}'
   ```

   Expected answer (HTTP 200):

   ```json
   {"status":"joined","share_code":null,"share_url":null,"referral_count":0,"sandbox":true}
   ```

   A `4xx` with `{"error":{"code","message","hint",...}}` tells you what to fix
   (`invalid_email`, `invalid_json`, `unsupported_media_type`). `409 launch_open`
   means the prelaunch list has closed because the product opened; stop and
   tell the user to create an account at <https://ohmyproduct.com/login>.

2. Show the user the exact email and ask for a go-ahead if they have not
   already given one for this address.

3. Send the real request: the same command without the `X-OMP-Sandbox`
   header, plus `-H "Idempotency-Key: $KEY"` with a fresh key
   (`KEY=$(uuidgen)`). If the connection drops, retry once with the same key
   and body: the API replays the first answer (`Idempotent-Replayed: true`)
   instead of running the write twice.

4. Report the result (HTTP 200).

   - `"status":"joined"`: the address is on the list. Give the user
     `share_url` (a personal referral link built from `share_code`) and say
     `referral_count` is the number of people who joined through it so far.
   - `"status":"already_joined"`: the address was on the list already.
     `share_code`, `share_url` and `referral_count` are `null`; do not invent
     a link.

   If the API returns an error, report its `code` and `request_id`. On a 429
   or 503, wait for `Retry-After` and try once more.

`source` is an optional short label for where the signup came from (for
example the name of your agent). Do not put personal data in it.

With the SDK: `createClient({ sandbox: true }).joinLaunchList({ email, source })`.
With the CLI: `omp launch-list join person@example.com --sandbox`, then run it
again without `--sandbox`; the CLI prints the share link for a new entry.

## Rules

- Sandbox first, every time.
- One address per explicit request from its owner.
- Joining the list is not an account and does not open the product.
