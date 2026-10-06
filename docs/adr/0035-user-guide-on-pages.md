# 0035: A user guide in docs/guide, published at /guide/

Status: Accepted, 6 October 2026, under the owner's standing instruction to take the recommended option. Changes SPEC section 4 (its layout lines for `apps/site` and `docs/`). Amends ADR 0029: the Pages site holds the guide beside the demo and the tour, under the tour's rules. Section 9 is unchanged.

## Context

Everything a user needs is in the repository, but written for someone else. `SPEC.md` is for implementers, the ADRs record decisions, and `docs/tour/` is one explainer per milestone for the owner: the build's history, not a path through the product. The README jumps from a link to commands, and the client surface (the five fixed tools, the labels, the error codes) is named only in SPEC section 7. The docs review of 6 October planned a guide for four readers: app developers adding Tabdock to a page, people calling a page from Claude or another MCP client, operators sharing a page, and whoever runs a relay. It needs a home in the repository, and a place on the Pages site, which ADR 0029 kept to the demo and the tour.

## Decision

**In the repository.** The guide lives in `docs/guide/` as numbered Markdown pages, [`01-concepts.md`](../guide/01-concepts.md) to [`12-setup-and-limits.md`](../guide/12-setup-and-limits.md), with [`README.md`](../guide/README.md) as its index. It describes the code at HEAD, not its history: every option, default, command and number it states comes from the source, and it says where something waits for the 0.1.0 publish or has not run live. Its pages link each other by relative paths, so GitHub renders the whole guide, Mermaid included, before Pages is ever published. The README becomes the front door that sends readers there; the tour stays as it is.

**On the site.** `apps/site` publishes the guide at `/guide/` beside `/tour/`, with the demo staying at `/`. The build handles a list of collections, each with a source, an output directory and an index title (`docs/tour` to `tour/`, `docs/guide` to `guide/`), in place of its one `TOUR_DIR`; a relative link to a page of either collection becomes that page's `.html` link, and every other repository path still goes to GitHub at the commit built; the header gains the guide, whose index says the guide is for users and the tour is the build's history; and diagrams draw into `guide/img`, with raster images copied from `docs/guide/img` under the tour's rule. `pages.yml` builds and publishes the whole site already, so it does not change.

**The same rules as the tour.** Guide pages share the demo's origin, which the relay's allowlist vouches for (S2) and whose tab holds the adapter's `sessionStorage`, so they get exactly the tour's guarantees: no script, no `on*` attribute, the same policy and no-referrer metas, images from the site alone, Mermaid drawn to SVG at build time, and the build reading every page back through `tourPageProblems` and every SVG through `svgProblems` and stopping on a failure. No rule is loosened, and ADR 0029's line holds for both: a page that wants script needs an ADR of its own.

**SPEC wording.** Section 4's `apps/site` line now reads: "`apps/site           Builds the GitHub Pages site: the demo's static build at /, docs/tour at /tour/ and docs/guide at /guide/, Mermaid drawn to SVG at build time; kept out of the pnpm workspace, with its own lockfile`". Its `docs/` line gains "`guide/ (for users)`" ahead of "`tour/ (explainers for the owner)`"; ADR 0036 records the rest of that line.

Section 9 stays. S2's origin check still vouches only for the demo's own code, since guide pages, like tour pages, carry none; nothing else in the section touches documentation.

## Consequences

A guide that states numbers drifts unless tests hold it, so this decision comes with doc sync tests: the settings tables against `config.ts`, the code blocks compiled against the packages, the adapter reference against `AttachOptions`, `Dock` and `PolicySchema`, the error codes against `ERROR_CODES`, the limits against the constants, every pointer and ADR number against the tree, every versioned install against the workspace's pins, and the house style (no U+2013 or U+2014, no outside hosts, one H1 and a word cap per page). With them, a change to a setting, a default or an error code fails a test until the guide follows. Until the site build carries the guide, GitHub's rendering is the only one, and every link in it works there. Each Pages publish then carries three parts, so the build stays whole.
