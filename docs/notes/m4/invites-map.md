# ADR 0016 invites mapped onto the code (M4 research, 3 October 2026)

Branch `m4-cloud` at 4aa1464. H, M, L = confidence; "proposal" is design, not fact.

## 1. Frames (packages/protocol)

Facts (H): `via` is `code | qr` (page-link.ts:212); `AttachmentView` has no kind, invite or hard end (85-93); `PolicySchema` has no `invites` (57-62); no invite frames (180-190, 239-248); no `invite_required` (errors.ts:2-14).

Proposal (the adapter draws `inviteId`, so it can store the record before the ack):

```ts
const Secret = z.string().regex(/^[A-Za-z0-9_-]{22}$/);                 // 128 bits
const InviteTerms = z.object({ inviteId: IdSchema, role: RoleSchema,      // observer = watch, driver = control
  label: z.string().min(1).max(60), uses: z.number().int().min(1).max(20), // control: 1
  expiresAt: EpochMsSchema.nullable() });                                 // null = while open; relay caps 24 h
// page to relay
InviteCreate = InviteTerms.extend({ t: z.literal('invite_create'), secretHash: z.string().regex(/^[0-9a-f]{64}$/) });
InviteCancel = z.object({ t: z.literal('invite_cancel'), inviteId: IdSchema });
// relay to page, after each welcome and on every change
Invites = z.object({ t: z.literal('invites'), linkBase: z.string().max(2048).nullable(),  // <public URL>/i
  invites: z.array(InviteTerms.extend({ usesLeft: z.number().int().min(0), sponsor: UserSchema,
    pending: z.boolean(), refusals: z.number().int().min(0).max(3) })).max(32),
  refused: z.object({ inviteId: IdSchema,
    reason: z.enum(['no_sponsor','policy','limit','duplicate','no_public_url']) }).optional() });
// changed
Account = z.object({ kind: z.enum(['member','invitee']), verified: z.boolean() });
AttachRequest += { via: z.enum(['code','qr','invite']), account: Account,
  invite: z.object({ inviteId: IdSchema, secret: Secret, label }).optional() } // refine: iff via 'invite'
AttachmentView += { kind, inviteId: IdSchema.nullable(), endsAt: EpochMsSchema.nullable() }
Policy += { invites: z.enum(['off','watch','all']).default('watch') }
ERROR_CODES += 'invite_required';   pair_page input: { code?: max 64, invite?: max 300 }, exactly one
```

The relay keeps only the hash and forwards the presented secret, so it cannot fabricate a redemption the adapter accepts. M.

## 2. Relay invite store and lifecycle

`SingleUseKind` is `'pair'` only and `take` deletes (store.ts:59, 299-304). Proposal: kind `'invite'` with a `ref` as the digest index, plus an `InviteStore` of `{inviteId, pageId, role, label, usesLeft, expiresAt, secretHash, sponsorId, pendingRequestId, refusals, barred}`; `AttachmentRecord` (store.ts:36-46) gains `inviteId`, `endsAt`.

| Event                         | Proposal                                                                                                                                                        | Hook                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Mint                          | page awake, policy allows role, member attached (sponsor), 10 live per page, unique hash                                                                        | beside `#revoke` (hub.ts:1368)           |
| Redeem                        | limits per user, invite, page; digest lookup, live, not barred, seats; `attach_request` via `invite`                                                            | like `#startPairing` (hub.ts:1691)       |
| Spend                         | watch: reserve a use per pending, spend on approval; control: spend on approval, one pending (same user joins, others `page_busy`), third deny or timeout burns | `#decision` (hub.ts:1268)                |
| Role                          | grant `min(invite role, decided role)`; today `frame.role ?? 'observer'` is unchecked (hub.ts:1294)                                                             | `#grant`, `#setRole`                     |
| 24 h                          | `endsAt = redeemedAt + 24 h`; touch sets `expiresAt = min(now + idle, endsAt)` (hub.ts:2356)                                                                    | `#armExpiry`                             |
| Cancel, expire                | delete records, deny its pending request, send `invites`                                                                                                        | timer                                    |
| Sponsor loss                  | sponsor's attachment ends any way: cancel its invites, end what they made                                                                                       | `#endAttachments` (1398), `#expireIfDue` |
| `revoke(user)`, `revoke('*')` | bar user from that invite; `*` also deletes every invite                                                                                                        | `#revoke`                                |
| Asleep, gone                  | asleep: `page_asleep`; gone: delete invites                                                                                                                     | `#sleep`, `#gone`                        |

Seats: invite-made `< usersPerPage - 2`, 8 of the default 10 (config.ts:241).

## 3. Invitee tier

Facts (H): `accountOf` returns `{kind:'invitee', key}` (32 hex, oauth.ts:356-361) but `authenticate` 403s it (538-551); `AuthOutcome` and `AuthExtraSchema` carry no kind (auth.ts:29, mcp.ts:41-44); `/pair/claim` answers 403 `not_allowed` (pair.ts:637-643); oauth.test.ts:387 and pair.test.ts:644-669 pin both and flip in M4.

Proposal: `AuthOutcome.user` gains `account`, `email?`, `emailVerified?`; invitee `userId = g_<key>`, a shape config refuses for members. Sessions (sessions.ts:215-237): one per invitee until `hub.holds(userId)`, then 2; own pool of about 50; a full member pool evicts the idlest invitee first, as `/pair` does (pair.ts:397). The stateless leg needs a per-invitee request limiter. Invitees may use `list_pages`, `list_page_tools`, `call_page_tool`, `detach_page` on held pages (S13 unchanged, hub.ts:1520-1583) and `pair_page` with `invite`; a code gets `invite_required` after the per-user count and before `#matchTicket`, so it is neither spent nor rotated (hub.ts:1609-1625, 1702). Never M5 tools.

## 4. Adapter record and honour path

Facts (H): stored records are `resume, grants, revoked, paused` under the ADR 0011 key (core.ts:316-318, 615-618); grants map `userId` to Role (445-459); `pageRole` falls back to `autoApprove` (856-862); any approval clears a pending revoke (1783); no WebCrypto yet.

Proposal: a stored `invites` record `{pageId, invites:[{inviteId, secretHash, role, label, usesLeft, expiresAt, pending, refusals, barred}]}`; grants become `{role, inviteId?, endsAt?}`, old form still parsed. `dock.invite()` draws 16 bytes (`getRandomValues`), base64url, hashes the UTF-8 text with `subtle.digest('SHA-256')` to match relay `digest()` (secrets.ts:80-86), keeps only the hash, sends `invite_create`, returns `<linkBase>#<secret>` once. `onAttachRequest` (1721) checks a `via: 'invite'` request against the record (id, hash, live, uses, not barred, not revoked): watch calls `decide(allow,'observer')` without a prompt or `forgetRevokes`; control prompts; deny or timeout counts a refusal. `pageRole` caps invite grants and drops them after `endsAt`; `setRole` (1804) refuses above the invite role; `revoke('*')` (1827) clears invite records.

## 5. Widget

Facts (H): prompts, roster rows and pause arm after 500 ms still (widget.ts:28-43, 266-327); Revoke all is unheld (365-367); QR draws only `<https origin>/pair#<22>` (qr.ts:64-75). Proposal: the Invite form is an armed box (Create grants access; switching watch and control re-arms); Cancel and Revoke stay unheld. Hidden for `off`, Can control only for `all`, disabled with a reason while no member is listed, the link is down or `linkBase` is null. The link shows once as text and QR (qr.ts also accepts `/i#<22>`). Live list: label, kind, uses left, expiry, pending, Cancel. Roster: "invited" badge, email or "unverified account" plus a short id; a multi-use invitee's Revoke shows "and close this link", checked.

## 6. /i flow (modelled on pair.ts)

Static `/i` under `PAGE_CSP`; script takes the fragment, `replaceState`, `sessionStorage` (pair.js:41-63). `POST /i/preview` looks up before counting (ADR 0016 notes) and returns origin, title and label marked as page-written, sponsor, kind, expiry, account. Sign-in reuses `/pair/login` and `/pair/callback` with a fixed return target in the login cookie (redirect is hard-coded today, pair.ts:572), so WorkOS needs no second redirect URI; scope becomes `openid email` (pair.ts:503). `POST /i/claim` (same Origin, signed in, members or invitees), then `/i/status`. Add `/i` paths to route logging (relay.ts:113). Then show "signed in as <email>" and the connector URL: Claude must use the same WorkOS user.

## 7. S14 rules and tests

| Rule                  | Test (relay vitest unless noted)                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| Member sponsor        | mint with nobody or only an invitee attached: `no_sponsor`                                                    |
| `policy.invites`      | `off` refuses all, `watch` refuses control, default `watch` (protocol)                                        |
| Watch in advance      | attaches observer, no prompt; tampered `driver` capped; `set_role` driver refused                             |
| Control               | prompt names account and label; second account `page_busy`; 3 refusals burn                                   |
| Own record and secret | adapter harness: wrong secret, unknown, expired, spent, barred: deny; ungranted roster invitee: `role_denied` |
| `revoke('*')`         | old link `pairing_expired`; adapter records gone                                                              |
| Session, revoke, 24 h | gone; `not_attached`; fake clock, hourly calls, ends at 24 h                                                  |
| Two seats             | `usersPerPage: 4`: third invitee `page_busy`, members still pair                                              |
| Sponsor loss, barring | detach, revoke or idle sponsor ends both; revoked invitee re-redeems: denied                                  |
| `invite_required`     | invitee code on `pair_page`, `/pair/claim`: no rotation, no request                                           |
| Logs, tier            | sink scan for secret, hash, link (as oauth.test.ts:442); one session; limits never per address                |

## 8. SPEC sections 5 to 9 against ADR 0016

Section 2, section 5's Invite row and trust rule, S4, S11, S14 and section 8's widget sentence match (H). Gaps: section 6 has no invite frames or `via: invite`, and its `revoke "*"` row omits invites; section 7's "The last covers arguments the relay will not forward" now points at `invite_required`, not `invalid_arguments` (SPEC.md:116); section 7 gives `pair_page` only `code`; section 5 User and Attachment lack kind, email, `inviteId`, `endsAt`; section 8 omits `policy.invites` in its example, `invite()` and stored invites; S14 omits sponsor loss, the burn, barring, name copying and per-invite limits. Record the wire shapes in a short ADR 0017.

## 9. Flags and resolutions

1. "With invites on" names no switch: add `TABDOCK_INVITES`, off by default, keeping today's 403.
2. Sponsor among several members, and "no sponsor is left": bind to the longest-attached member at mint and end on that sponsor's loss; never transfer, since `/i` showed the name.
3. Control under `maxDrivers: 1` while the sponsor drives is silently capped to observer (hub.ts:1339-1349): say so in the prompt.
4. "pair_page also takes a single-use link": accept only one-use invites there, since chat history keeps links; add `invite`, `link` to `REDACTED_FIELDS` (log.ts:18).
5. "While the page is open" can last days: cap 24 h and 20 uses.
6. Email: Connect access tokens carry none by default (a JWT template can add it); code-flow email claims come from UserInfo, so `/i` calls `fetchUserInfo` (openid-client 6.8.8) when the ID token lacks them.
7. Name copying: compare NFKC-casefolded names with members'; on a match show the short id.
8. Members redeeming invites are undefined: treat as invite-made.
9. Tests: `/i` needs public mode and dev-token has no invitee kind; add dev-token invitee entries.
10. `usersPerPage <= 2` leaves no invite seats: refuse with invites on.
11. Audit mint, redeem and cancel (no secrets) in M4's persistent log.

## 10. Workstreams

Superseded: `docs/plans/M4.md` (Workstreams) assigns the work, giving `/i` to workstream A.

First, by the lead: the schemas above, `AuthOutcome` and `Account`, store interfaces, hub signatures (`createInvite`, `cancelInvite`, `previewInvite(secret)`, `claimInvite(caller, secret): ClaimOutcome`), Dock API (`invite()`, `state.invites`), ADR 0017, SPEC edits. Then in parallel: **A relay** (store, lifecycle, invitee tier, sessions, `pair_page`, limits, tests); **B adapter and widget** (record, honour path, form, list, badges, QR, Playwright); **C `/i` and end to end** (routes, page, return target, email, phone-sized redemption, `demo:m4`), needing only A's signatures.

## External checks today

| Claim                                                                                                       | Evidence                                                    | Conf. |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----- |
| Templates render into Connect tokens for MCP clients; 3072 bytes; `iss sub exp iat nbf jti` reserved        | workos.com/docs/authkit/jwt-templates                       | H     |
| Template context shows `user.email_verified: true`; live render untested                                    | same page, example input                                    | M     |
| Connect access tokens: `iss aud sub client_id org_id sid scope jti exp iat`, no email                       | workos.com/docs/authkit/connect/token-claims                | H     |
| AuthKit email verification "is always on"                                                                   | workos.com/docs/authkit/email-verification                  | H     |
| `email` scope gives `email`, `email_verified`, from UserInfo in code flow; only `iss` plus `sub` are stable | openid.net/specs/openid-connect-core-1_0.html 5.1, 5.4, 5.7 | H     |
| `subtle.digest` needs a secure context; `getRandomValues` is fit for cryptography                           | MDN SubtleCrypto/digest, Crypto/getRandomValues             | H     |

No new dependency is needed.
