# M4 research: persistent audit log and restart state

Checked 3 October 2026 on `m4-cloud`. Conf.: H high, M medium. Paths are under `packages/relay/src` unless named.

## Repo facts

| Claim                                                                                                                                                                                                    | Evidence                                           | Conf. |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----- |
| The record is `at, pageId, origin, userId, client, tool, outcome, durationMs`, with no arguments. It sits in a 1000-entry memory ring behind a synchronous `AuditLog`, which config marks for M4 to swap | `store.ts:96-106,149-153,348-367`; `config.ts:177` | H     |
| Every attempt is appended in a `finally`, and the same record goes to stderr as a `call` line, so platform logs already hold an off-host copy                                                            | `hub.ts:1888-1923`; `log.ts:60-62`                 | H     |
| The access check runs before the rate limit, so `not_attached` refusals are unbudgeted. In M4 any stranger who signs up becomes an invitee and could write records without limit                         | `hub.ts:1943-1956`; ADR 0016                       | H     |
| A refused call's `pageId` (up to 100 characters) and `tool` (up to 200) are free client text                                                                                                             | `mcp.ts:55-59,311`                                 | H     |
| An invitee's id is a digest of its `sub`; the roster shows its verified email                                                                                                                            | `oauth.ts:359`; ADR 0016                           | H     |
| SPEC asks only that the audit log persist                                                                                                                                                                | `SPEC.md:58`                                       | H     |
| On `resumed: false` the adapter drops its grants, so a relay that forgets a page forces everyone to pair again                                                                                           | `adapter/src/core.ts:1044-1051`                    | H     |
| Shutdown fails calls still in flight, and those failures are audited, so the log must close after `hub.shutdown()`                                                                                       | `hub.ts:2490-2515`; `relay.ts:490-508`             | H     |

## External facts (fetched today)

| Claim                                                                                                                                                                                                            | Evidence                                                                                                          | Conf. |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----- |
| `node:sqlite` on the 22 line (latest 22.23.3) is Stability 1.1, "no longer behind `--experimental-sqlite` but still experimental". It is a release candidate from 24.15.0                                        | nodejs.org/docs/latest-v22.x/api/sqlite.html, latest-v24.x/api/sqlite.html                                        | H     |
| Measured: Node 22.22.0 (repo `.nvmrc` 22, engines `>=22.18`) and 22.23.3 print `ExperimentalWarning` to stderr with no flag, which `--disable-warning=ExperimentalWarning` silences. Node 24.21.0 prints nothing | local probe with nodejs.org/dist binaries                                                                         | H     |
| Node 22 is in maintenance with end of life on 2027-04-30; Node 24 enters maintenance on 2026-10-20 with end of life on 2028-04-30                                                                                | github.com/nodejs/Release schedule.json                                                                           | H     |
| In SQLite WAL with `synchronous=NORMAL`, a commit can roll back after a power loss but survives an application crash; FULL is fully durable. Network filesystems risk corruption                                 | sqlite.org/pragma.html#pragma_synchronous, sqlite.org/useovernet.html                                             | H     |
| `O_APPEND` positions and writes as one atomic step (except on NFS). Node offers `fdatasyncSync`                                                                                                                  | man7.org open(2); nodejs.org fs (v22)                                                                             | H     |
| **Fly:** a volume is an NVMe slice tied to one host and one Machine, $0.15/GB-month, with daily snapshots kept 5 days. Logs stay 7 days. Shutdown sends SIGINT and allows 5 s                                    | docs.fly.io volumes/overview, about/pricing, monitoring/logging-overview, reference/configuration                 | H     |
| **Railway:** volumes cost $0.15/GB-month and allow no replicas, so a redeploy has brief downtime. Hobby keeps logs 7 days at up to 500 lines/s, with no native drain                                             | docs.railway.com reference/volumes, reference/logging; railway.com/pricing                                        | H     |
| **Render:** disks are paid-only at $0.25/GB-month and rule out zero-downtime deploys. Hobby keeps logs 7 days at up to 6,000 lines/min                                                                           | render.com docs/disks, docs/logging, pricing                                                                      | H     |
| **Cloud Run:** the filesystem is in memory and is lost when the instance stops. Cloud Logging is free to 50 GiB, then $0.50/GiB, and keeps 30 days                                                               | docs.cloud.google.com/run/docs/container-contract; cloud.google.com/stackdriver/pricing                           | H     |
| A 2025-era MCP client MUST re-initialize on a 404 for its session; OWASP asks for tamper detection, no tokens in logs and no data kept past retention                                                            | modelcontextprotocol.io/specification/2025-06-18/basic/transports; cheatsheetseries.owasp.org Logging Cheat Sheet | H     |
| Sandbox measurements, a rough guide only: 314 B per record; 4.2 µs per append with a SHA-256 link; 0.64 ms with `fdatasync`; 445 ms to scan 63 MB. `node:sqlite` inserts took 36 µs (NORMAL) and 186 µs (FULL)   | `bench.mjs`, `bench-sqlite.mjs` beside this file                                                                  | M     |

## Options

**JSON Lines on a volume** (`node:fs`, no dependency): crash-safe appends, bounded by rotation, readable with `tail` or a small CLI, and a hash chain fits it. A 1 GB volume costs $0.15 a month.

**`node:sqlite`**: SQL filters and `DELETE` for retention. On Node 22 it is experimental and puts a non-JSON warning into the JSON log stream. Its rows can be edited in place, and the file needs `VACUUM` to shrink. Fixing the warning means moving to Node 24 (ADR).

**Platform logs only**: these already exist. They keep 7 days on cheap plans, drop lines over their rate limits (so a flood can push real records out) and offer no scoped reads. They make a good off-host copy, not the record of truth. On Cloud Run they are the only option.

## Recommended design

Use JSON Lines on a volume as the record of truth and the stderr line as the off-host copy, with no new dependency.

1. **Writer.** A `FileAuditLog` implements the existing `AuditLog` in `TABDOCK_AUDIT_DIR` (directory 0700, files 0600). Production refuses to start without the directory, or if it cannot write and sync a `relay_start` record. Dev and tests keep the memory ring.
2. **Durability.** Each record is one `writeSync` of a whole line. `fdatasync` runs at most once a second while anything is unsynced, at rotation, and at close, which comes after `hub.shutdown()`. At start the writer appends a newline after a torn last line, and readers skip lines that fail to parse and report them. An ENOSPC or EIO error never reaches the hub: the record still goes to stderr, and an `audit_gap` record is written once writing works again. That makes the log fail open, which is the owner's call.
3. **Bounds.** Rotate at 8 MiB or at UTC midnight. After each rotation, and hourly, delete files older than `TABDOCK_AUDIT_RETENTION_DAYS` (30) and the oldest past `TABDOCK_AUDIT_MAX_MB` (64, about 200k records), never the current file. Without a budget, one invitee at 100 requests a second writes about 2.7 GB a day. So each user also gets a call budget before the access check, and refusals past it become one `refused_summary` line per user per minute, under a relay-wide cap. This narrows S7's "every call" for calls that never reached a page, so it needs an ADR. Client text that fails `IdSchema` or `ToolNameSchema` is stored as `"(invalid, N chars)"`.
4. **Content.** Each version 1 line carries `v, seq, at, type, prev`. Beyond `call`, the log records `attach` (with `via` and role), `attach_refused`, `role`, `revoke`, `detach`, `expire`, `invite_minted`, `invite_redeemed`, `invite_closed`, `sponsor_gone`, `relay_start` and `relay_stop`, so restarts show as gaps. It never holds arguments, results, tokens, codes, nonces, invite secrets or their hashes, resume-token hashes, cookies, `sub`, IP addresses or page-supplied labels (S10). For an invitee, only `attach` carries the roster email (or `unverified`), `inviteId` and the sponsor; call lines keep the opaque id. Keeping that email is an owner choice. The alternative stores none and has the CLI map a WorkOS user id to its digest.
5. **Reading.** `pnpm audit` runs a CLI with `--user`, `--page`, `--since`, `--outcome`, `--type` and `--verify`. It checks each line with a zod schema in `packages/protocol` and escapes control and bidi characters. The owner runs it from the host console; for the last 7 days, from the phone, platform log search finds the `call` lines. M4 adds no HTTP route. A later one would serve members only, through the `/pair` cookie session, and only their own `userId`. Page-wide views would leak other users' activity once attachments end (S13).
6. **Tamper evidence (cheap, optional).** `prev` is the SHA-256 (`node:crypto`) of the previous line, chained across files. Every 15 minutes, at rotation and at stop, an `audit checkpoint` line (`seq`, head) goes to stderr, where the platform keeps it for 7 days. This is evidence, not prevention: whoever holds the host can re-chain everything after the last checkpoint the platform still keeps. The reviewer should confirm it is not "hand-rolled cryptography" (no keys, no new primitive). If it is, keep only `seq` and the stderr copy.

## State across a restart

One in-memory process cannot deploy without downtime anyway. Railway and Render volumes rule out overlapping deploys, and a Fly volume mounts on one Machine. So every deploy is a restart.

**P0, everything in memory (recommended for M4).** After a restart each page reconnects within 30 s as a new session. The adapter drops its grants, so everyone pairs again and invite links stop working. 2025-era clients re-initialize after the 404 and phones sign in again at `/pair`. OAuth JWTs stay valid, and rate counters reset. This needs no code and adds no stale-state risk. It costs operator taps after each deploy, and the `relay_stop` and `relay_start` records show the gap.

**P1, snapshot at graceful shutdown (upgrade path, ADR).** Once the hub stops taking frames, the relay writes pages (resume-token hash, origin, path, policy), attachments and live invites (hash, terms, sponsor) to one synced, renamed file. At start it deletes the file, then applies it only if it is under 10 minutes old. Pages return asleep, so the resume window governs them and adapter grants still match. Deploys then cost nothing, and a crash falls back to P0. Risks: a stale snapshot reviving a revoked attachment or invite (S8, S14), which the one-shot, age-checked load guards against, and personal data briefly at rest. Fly's 5 s and Cloud Run's 10 s at shutdown are ample.

**P2, write-through of every change.** This survives crashes, but every revoke must be durable before it takes effect (S8), every call writes `lastUsedAt`, and on Node 22 it pulls in `node:sqlite`. Not for M4. Under every option, pairing tickets, attach requests, `/pair` sessions and MCP sessions stay in memory.

## Tests

Each fails without its fix: S7 keys exact, with an argument marker never in a file (extends `test/mcp.test.ts:902`); `seq` and chain continue after reopen; a torn tail is repaired, skipped and named by `--verify`; rotation by size and day (injected clock), deletion by age and cap, current file kept; an invitee `not_attached` flood adds bounded lines; ENOSPC or EIO still answers the call, reaches stderr and leaves `audit_gap`; calls failed by shutdown are synced; an edited or deleted line fails `--verify`; no secret, `sub` or address in any file; production refuses a missing or unwritable directory, and modes are checked; the CLI escapes hostile strings.

## Owner decisions

1. Should the log fail open or fail closed?
2. Should invitee emails be kept?
3. Is the 30-day retention right?
4. P0 now, or P1?
5. Do we stay on Node 22?
6. An ADR for refusal summaries.
7. Do we want the hash chain?
