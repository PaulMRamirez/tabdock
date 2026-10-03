# M3 spike measurements (A3.3, A3.4)

Filled in from the owner's runs on the laptop and phone (`docs/checklists/M3.md`). Run the relay with `TABDOCK_SPIKE=1`. The headless soak row can come from the sandbox; everything else needs the real laptop, tunnel and phone.

## Round trip

`pnpm spike:latency [--public] --code <code>`, date, client era. Nearest-rank p50 and p95 over 50 calls after 5 warm-up calls.

| Measure (ms)                                        | n   | p50 | p95 | min | max |
| --------------------------------------------------- | --- | --- | --- | --- | --- |
| Round trip at the client                            |     |     |     |     |     |
| Relay, request in to response out (page included)   |     |     |     |     |     |
| Page link and page handler                          |     |     |     |     |     |
| Relay without the page                              |     |     |     |     |     |
| Tunnel, network and client (round trip minus relay) |     |     |     |     |     |

## Hosted Claude and tool list changes

From the relay's `spike: tools/list` and `spike: client opened a stream` lines after typing `add` in its terminal.

| When | Client | Marker added | tools/list after it | Stream open | Seen in the same chat? | Seen in a new chat? |
| ---- | ------ | ------------ | ------------------- | ----------- | ---------------------- | ------------------- |

## Tab survival

| Run                                   | Duration | Freezes or sleeps | Link drops | Resumed same page | Attachment intact | Calls working after | Notes |
| ------------------------------------- | -------- | ----------------- | ---------- | ----------------- | ----------------- | ------------------- | ----- |
| Headless CDP soak (`pnpm spike:soak`) |          |                   |            |                   |                   |                     |       |
| Background 60 min, Energy Saver off   |          |                   |            |                   |                   |                     |       |
| Energy Saver on, demo with `?busy`    |          |                   |            |                   |                   |                     |       |
| Laptop sleep                          |          |                   |            |                   |                   |                     |       |

| Measure (ms)               | n   | p50 | p95 | min | max |
| -------------------------- | --- | --- | --- | --- | --- |
| Freeze to relay link drop  |     |     |     |     |     |
| Thaw to relay welcome      |     |     |     |     |     |
| Thaw to first working call |     |     |     |     |     |

## Scan to first call

From the relay's `spike: pairing milestone` lines (`packages/relay/src/spike.ts`), which share a random `tr_` trace id per pairing. The stages are `issued` (debug level), `scanned` (the first `/pair` preview only; the preview after sign-in does not count) with `sinceIssuedMs`, `claimed` with `sinceIssuedMs` and `sinceScannedMs`, `approved` or `refused` with `sinceClaimedMs` and `sinceScannedMs`, and `first_call` with `sinceApprovedMs`, `sinceClaimedMs`, `sinceScannedMs` and `sinceIssuedMs`. A code typed into `pair_page` has no scan. `pnpm demo:m3` prints a sample run.

| Run | Issued to scanned (ms) | Scanned to claimed | Claimed to approved | Approved to first call | Scanned to first call |
| --- | ---------------------- | ------------------ | ------------------- | ---------------------- | --------------------- |

## Go or no-go (A3.4)

| Gate                           | Threshold | Measured | Pass |
| ------------------------------ | --------- | -------- | ---- |
| Conversational latency         |           |          |      |
| Fixed tools on mobile          |           |          |      |
| An hour of background survival |           |          |      |

Verdict: to be written after the runs.
