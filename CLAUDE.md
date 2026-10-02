# CLAUDE.md

## Project

Tabdock (working name) lets MCP clients attach to a live web page. A page adapter dials out to a relay; the relay is a remote MCP server with one stable URL; several clients and several people can attach to one page, with the tab operator approving each. `SPEC.md` is the source of truth. This is a personal-hat, Apache-2.0 open source project.

## First run

Read this file and `SPEC.md`. Summarize the design back to the owner in ten sentences, list anything unclear or already out of date, then start Milestone 0. If the repo is empty, scaffold it from the layout in SPEC.md section 4. Keep `SPEC.md` at the root beside this file.

## How to work

Work one milestone at a time, in order. Before coding a milestone, write a short plan in `docs/plans/MN.md`. At the end, stop and report: what was built, test results, the demo command, the explainer path and open questions. Wait for the owner's go before the next milestone.

Use subagents or an agent team for independent workstreams (relay, adapter, tests). Before declaring a milestone done, run a separate reviewer agent against the security requirements in SPEC.md section 9.

Verify moving APIs against current documentation before using them: WebMCP, the MCP-B packages, the MCP SDK and Claude's connector docs. Do not rely on recall. Record each check, with its date, in `docs/notes/verified.md`.

If code and spec disagree, stop and raise it. Change the spec only through a short ADR in `docs/adr/`.

Never weaken or skip a security requirement to make a test pass. Do not hand-roll MCP transports, OAuth flows or cryptography; use maintained libraries.

Ask before adding a runtime dependency outside this list: `ws`, `zod`, `hono`, `qrcode-generator`, and the official MCP SDK packages. Dev tooling (TypeScript, vitest, Playwright, tsup or esbuild, eslint, prettier) is pre-approved. The demo page may use `@mcp-b/global` or `@mcp-b/webmcp-polyfill`.

## Running in a cloud session

This repo may be built from a Claude Code cloud session started on a phone, with no owner laptop or browser available. Do every check you can inside the sandbox using the sim page and headless Chromium, including items marked manual when they can be scripted. Record anything that truly needs the owner's own device in `docs/checklists/` and continue to the milestone report instead of waiting on it. Work on a branch and open one pull request per milestone, with the explainer linked in its description, so the owner can review from a phone.

## Teach as you build

The owner wants to understand the system, not only receive it. Every milestone ships an explainer at `docs/tour/NN-title.md`, under about 600 words: what was built, one traced example from request to result with file pointers, and three things to try by hand. Every milestone also ships a demo that runs from a clean clone with one command.

Write for the owner in dense prose with minimal bullets. Use no em dashes or en dashes anywhere in docs, comments or commit messages; use commas, semicolons, colons or parentheses. Keep pages short enough to read on a phone, and draw diagrams as Mermaid or SVG.

## Conventions

TypeScript strict mode, ESM, Node 22+, pnpm workspace. Every message crossing a boundary is validated with zod schemas from `packages/protocol`. No `any` on protocol types. Comments explain why, not what. Python is not expected; if a helper script needs it, use uv with PEP 723 inline dependencies.

Commands, to be created in M0 and kept working: `pnpm install`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm dev` (relay plus demo page), `pnpm demo:mN`.

Secrets never enter the repo. Dev tokens come from `.env`, which is ignored; keep `.env.example` current. Tokens and pairing codes never appear in logs.

Personal-hat rule: no employer names, branding or internal systems in code, docs, issues or commits. Include `LICENSE` (Apache-2.0) and `NOTICE`.

## Definition of done for a milestone

Acceptance tests in SPEC.md section 10 pass, with manual ones recorded in `docs/checklists/`. The demo runs from a clean clone. The explainer exists. ADRs and `docs/notes/verified.md` are current. No TODO hides an unmet requirement.
