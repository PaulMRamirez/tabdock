# 0011: One approval covers one page

Status: Accepted by the owner, 3 October 2026. Changes SPEC sections 6 and 8.

## Context

The adapter keeps its resume token, the operator's grants and the pause switch in `sessionStorage`, keyed by relay URL. Every page of a site shares that storage within a tab, so a site that includes the adapter on `/board` and `/settings` would resume the same session when the operator moved from one to the other, and users approved on the board could call the settings page's different tools without an approval for it (found in the M2 review).

## Decision

One approval covers one page: a document at one origin and path, and its reloads. The adapter keys the resume token, grants and pause by relay URL plus the page's origin and path, so another page of the site starts its own session with its own pairing code. The relay also refuses a resume whose `hello` comes from a different origin and path than the session's, starting a fresh session (`resumed: false`) instead; a different query string or fragment on the same path still resumes. A single-page app that changes its path without reloading keeps its session, since the adapter and its operator's approvals live in that one document.

## Consequences

Moving to another page that includes the adapter means pairing again there. Reloading the same page, as before, keeps its attachments.

## Notes after the build

The adapter fixes the page's address (origin and path) when `attach()` runs and sends it in every `hello`, so a single-page app that changes its path and later reconnects still resumes. Its storage keys pair the relay URL with that address; records an older adapter kept under the relay URL alone are removed unread, which also drops a pause made under the older build. The relay compares the origin and path of the `hello` url with the session's and, on a mismatch, starts a fresh session and leaves the old one asleep for its own page to resume.
