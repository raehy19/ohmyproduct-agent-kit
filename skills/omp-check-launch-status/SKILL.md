---
name: omp-check-launch-status
description: Check the current Oh My Product launch state (phase, whether participation is open, launch date, public counts) before telling anyone whether they can sign up or when it launches. Use before answering any question about availability, access or dates.
---

# Check the Oh My Product launch status

Availability changes over time. Read the live status instead of repeating what
you remember.

## Steps

1. Call the status endpoint. No auth is needed.

   ```sh
   curl -s https://ohmyproduct.com/api/v1/status
   ```

   Example response:

   ```json
   {
     "phase": "closed_beta",
     "participation_open": false,
     "launch_date": null,
     "counts": { "discovered_products": 0, "measured_at": "2026-11-15T09:00:00.000Z" }
   }
   ```

   `phase` is `closed_beta` or `open`. `launch_date` is an ISO 8601 string or
   `null`. `counts.discovered_products` may be `null` when the snapshot is
   unavailable, and `counts.measured_at` says when it was taken.

2. Interpret it literally.

   - `phase: "closed_beta"` and `participation_open: false` mean the product is
     not open to the public. People can join the launch list, submit a product
     for private review, or request a Test Drive. They cannot browse a catalog
     or create accounts.
   - `launch_date: null` means no date has been announced. Say "coming soon".
     Never state or estimate a date.
   - `counts.discovered_products` counts products found by Omi, the site's
     product scout. They are not maker submissions, customers or reviews.
     Report it as a count, not as a list, and mention `measured_at` when the
     age of the number matters.

3. Tell the user what you read and when you read it. If the call fails, say the
   status is unknown. Do not fall back to a guess.

With the SDK: `await createClient().getStatus()`. With the CLI: `omp status`
(add `--json` for machine output). The same data is the `get_status` tool on
the product MCP server, `https://ohmyproduct.com/mcp`.
If `curl` answers `401 invalid_token`, you sent a bad `Authorization` header;
the status endpoint needs none.

## Rules

- Do not describe features that the status or the docs do not confirm.
- Do not claim that anything has launched unless `participation_open` is true.
