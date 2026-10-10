# 0046: Restart snapshot

Status: Accepted, 10 October 2026, under the owner's standing instruction. Brought in by ADR 0043 from the backlog row of 3 October (option B of D3 in `docs/notes/m4/m4-decisions.md`), which asked for a record of its own. Changes SPEC sections 4 (what persists), 9 (S7 and S9) and 11 (a host's graceful stop), and adds A6.18 to section 10. Amends ADR 0019's rule that a restart ends every page session, and adds notes to ADRs 0017 and 0019 and to D3.

## Context

The relay keeps pages, attachments, invites and, from M6, time-boxed sessions in memory, so every restart, a planned deploy included, ends them all and every page pairs again (ADR 0019). D3 weighed three choices on 3 October and took (A), the audit log alone on disk, noting that (B), a snapshot written at a graceful stop and loaded once at the next start, could follow if re-pairing proved a nuisance. ADR 0043 makes it one: a teacher who deploys during a lesson would detach the whole class.

Two things make a snapshot dangerous. A stale or replayed file could bring back an attachment that was revoked, or an invite that was closed, after the snapshot was taken (S8, S14). And `docs/deploy.md`'s credential rotation (its steps at lines 103 and 220) relies on a restart ending every attachment, so a snapshot on by default would quietly undo that procedure.

## Options

A. No snapshot: every restart ends everything, as in M5.

B. A snapshot on by default wherever there is an audit directory, written at a graceful stop and loaded once within 10 minutes (ADR 0043's design).

C. B, but off unless the operator turns it on, and loaded only when the audit log's hash chain shows it was the relay's last act before its stop.

## Decision

C. `TABDOCK_RESTART_SNAPSHOT` is a flag, off by default, refused at start without an audit directory (local mode's counts). With it on:

- **Writing.** At a graceful stop, after the hub stops taking new work and before `relay_stop`, the relay writes one file into the audit directory at mode 0600, through a temporary file renamed into place and synced, as the owner token is written. It holds pages (origin, path, title, policy and the session ceiling, any time-boxed session, the resume token's digest), attachments, live invites with their digests, terms, sponsors and bars, and agent tokens' records, never a secret, token or code. The `snapshot_written` audit record carries counts and the file's SHA-256, and `relay_stop` follows it.
- **Loading.** At the next start, before it listens, the relay reads the file and unlinks it before parsing; an unlink that fails means no load. It applies the snapshot only if its `writtenAt` is under `RESUME_WINDOW_MS` (10 minutes) old and not in the future, it parses strictly at `SNAPSHOT_VERSION`, and the audit log's last two records are `snapshot_written` naming that digest followed by `relay_stop`. Anything else is a fresh start, as without the setting.
- **What comes back.** Pages return asleep with a fresh resume window, so their tabs resume as after a dropped link. Attachments of users who are no longer valid (a member no longer listed, ADR 0043) are dropped and counted. Timers for idle expiry, invites, agent tokens and sessions are re-armed from their stored ends, and a session already past its end ends at once with reason `time`. `snapshot_loaded` records the age and counts, the dropped included.

A crash writes nothing, so it still ends everything. The guide and `docs/deploy.md` say to leave the setting off while rotating credentials.

## Consequences

A planned deploy within 10 minutes keeps a lesson: pages resume, guests stay attached, and invite links still work. Binding the file to the audit chain means a file planted or kept from an earlier run never loads, and unlinking before applying means it loads at most once, so a revoke or a closed invite after the write cannot be undone by it. Emails (as invitees' display names) and page titles sit on disk for up to 10 minutes, at 0600 in the audit directory, beside an audit log that already names them. Fly's `kill_timeout` must leave room for the write; the owner's checklist measures the gap between SIGTERM and `relay_stop`.
