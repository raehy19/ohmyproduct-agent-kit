---
name: omp-request-test-drive
description: Request a closed-beta Test Drive verification email for a person who has agreed to it, through the public API, sandbox first. Use only when the email owner asked for it and consented; never on someone else's behalf.
---

# Request an Oh My Product Test Drive

The Test Drive request is the beta intake form. A real request sends the
address a verification email, so consent is required by the API.

## Before you start

- The email belongs to the person you act for, and they agree to receive a
  verification email. The request body carries `"consent": true`; set it only
  when that is true. Never set it to get past validation.
- Do not request Test Drives for several addresses, for addresses you were not
  given, or in a loop.

## Steps

1. Dry run in the sandbox. Nothing is stored and no email is sent.

   ```sh
   curl -s -X POST https://ohmyproduct.com/api/v1/test-drive-requests \
     -H 'Content-Type: application/json' \
     -H 'X-OMP-Sandbox: true' \
     -d '{"email":"person@example.com","consent":true}'
   ```

   Expect HTTP 202 and `{"status":"check_email","sandbox":true}`. Without
   `"consent": true` the API answers `400 consent_required`.

2. Show the user the address and confirm they consent to the email.

3. Send the real request: the same command without the `X-OMP-Sandbox`
   header, plus `-H "Idempotency-Key: $KEY"` with a fresh key
   (`KEY=$(uuidgen)`). If the connection drops, retry once with the same key
   and body: the API replays the first answer (`Idempotent-Replayed: true`)
   instead of running the write twice.

4. Report the result. HTTP 202 `{"status":"check_email"}` means a
   confirmation email was sent, or a recent one is still valid. The
   person must open the verification link themselves; you cannot and should
   not do it for them. Repeat requests for the same address can be answered
   with a cooldown or a limit, so do not retry in a loop. Report the error
   `code` and `request_id` on failure.

With the SDK: `createClient({ sandbox: true }).requestTestDrive({ email, consent: true })`.
With the CLI: `omp test-drive request --email person@example.com --consent --sandbox`,
then again without `--sandbox`.

## Rules

- Sandbox first, every time.
- Consent comes from the email owner, not from you.
- A Test Drive request is not an account and does not open the catalog.
