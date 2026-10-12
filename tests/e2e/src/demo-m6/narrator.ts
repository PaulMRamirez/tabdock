// The voice of pnpm demo:m6, and its guard (S11): every line the demo prints
// goes through say(), which first looks for each secret the run has met
// (bearer tokens, the pairing codes it read, invite and session link secrets
// and their digests, the agent token, each phone's sign-in cookies and the
// authorization code, state and nonce of its sign-in, and the relay's own
// client secret) and hides any it finds, counting the step as unexpected so
// the run fails. Codes and links reach the narration only masked, so a clean
// run hides nothing. A pairing code the widget showed and the run never read
// is not among them.

import { createHash } from 'node:crypto';
import { maskCode } from '@tabdock/adapter/testing';
import type { AuditLine } from '@tabdock/protocol';

export { maskCode };

/** What a phone kept of its sign-in at /pair or /i, as the relay tests' Phone keeps it. */
export interface SignedInPhone {
  /** Every cookie the relay set it. */
  readonly setCookies: readonly { readonly value: string }[];
  /** Every URL it requested, at the relay and at the provider. */
  readonly requested: readonly string[];
}

/** The query parameters of a sign-in that would let someone finish or replay it. */
const SIGN_IN_PARAMETERS = ['code', 'state', 'nonce'];

export class Narrator {
  /** Everything that must never be printed. */
  readonly #secrets = new Set<string>();
  /** More secrets read at print time, such as the tokens the stand-in provider issued. */
  readonly #more: (() => readonly string[])[] = [];
  #unexpected = 0;

  get unexpected(): number {
    return this.#unexpected;
  }

  /** A secret from here on; anything shorter than six characters could match ordinary words. */
  remember(secret: string | null | undefined): void {
    if (secret !== null && secret !== undefined && secret.length >= 6) this.#secrets.add(secret);
  }

  /** Secrets a source holds when each line is printed, read afresh every time. */
  rememberFrom(source: () => readonly string[]): void {
    this.#more.push(source);
  }

  /** An invite or session link: its secret, and the SHA-256 the relay keeps of it, are both secrets. */
  rememberLink(link: string): void {
    const secret = link.slice(link.indexOf('#') + 1);
    this.remember(secret);
    this.remember(createHash('sha256').update(secret, 'utf8').digest('hex'));
  }

  /**
   * A phone's sign-in: each cookie value the relay set it (the session's
   * secret and the sign-in in progress) and the authorization code, state
   * and nonce its sign-in carried through the provider and back.
   */
  rememberSignIn(phone: SignedInPhone): void {
    for (const cookie of phone.setCookies) this.remember(cookie.value);
    for (const url of phone.requested) {
      const params = URL.parse(url)?.searchParams;
      for (const name of SIGN_IN_PARAMETERS) this.remember(params?.get(name));
    }
  }

  /** Every secret met so far, for scanning text the demo does not print itself. */
  secrets(): string[] {
    return [...this.#secrets, ...this.#more.flatMap((source) => source())];
  }

  /** The first secret `text` holds, as a description that names none of it, or null. */
  leakIn(text: string): string | null {
    for (const secret of this.secrets()) {
      if (secret.length > 0 && text.includes(secret)) return 'a secret the run met';
    }
    return null;
  }

  /** Prints a line, unless it would print a secret: then the secret is hidden and the run fails. */
  say(text: string): void {
    let line = text;
    for (const secret of this.secrets()) {
      if (secret.length > 0 && line.includes(secret)) {
        line = line.split(secret).join('[hidden]');
        this.#unexpected += 1;
        console.log('   UNEXPECTED: a secret was about to be printed, and was hidden');
      }
    }
    console.log(line);
  }

  /** Counts a step that did not behave as the narration says it should. */
  check(ok: boolean, what: string): void {
    if (ok) return;
    this.#unexpected += 1;
    this.say(`   UNEXPECTED: ${what}`);
  }

  /** A leg's heading, with how long the run has taken so far. */
  leg(number: number, title: string, startedAt: number): void {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    this.say(`\n${String(number)}. ${title} (at ${String(seconds)} s)`);
  }
}

/** A link with its secret hidden: the part after # is the secret (ADR 0016). */
export function maskLink(link: string): string {
  const split = link.indexOf('#');
  return split === -1 ? link : `${link.slice(0, split + 1)}${'*'.repeat(link.length - split - 1)}`;
}

/** An account as the narration names it: a member by id, an invitee by its short id. */
export function who(userId: string): string {
  return userId.startsWith('g_') ? `invitee ${userId.slice(2, 10)}` : userId;
}

/** One audit record as a short line of the fields that tell the story, never a secret. */
export function storyLine(record: AuditLine): string {
  const seq = String(record.seq).padStart(4);
  switch (record.type) {
    case 'call': {
      const extra = [
        record.callId === undefined ? null : `callId ${record.callId}`,
        record.proposalId === undefined ? null : `proposal ${record.proposalId}`,
        record.acceptedOnPage === true ? 'acceptedOnPage' : null,
        record.image === undefined
          ? null
          : `image ${record.image.mimeType} ${String(record.image.bytes)} bytes`,
      ].filter((part) => part !== null);
      return `${seq} call             ${who(record.userId)} ${record.tool}: ${record.outcome}${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`;
    }
    case 'attach':
      return `${seq} attach           ${who(record.userId)} as ${record.role} via ${record.via}`;
    case 'revoke':
      return `${seq} revoke           ${who(record.userId)}${record.everyone ? ', by Revoke all' : ''}`;
    case 'invite_closed':
      return `${seq} invite_closed    ${record.inviteId}: ${record.reason}`;
    case 'expire':
      return `${seq} expire           ${who(record.userId)}: ${record.reason}`;
    case 'members_reloaded':
      return `${seq} members_reloaded ${String(record.members)} members, added [${record.added.join(', ')}], removed [${record.removed.join(', ')}], ${String(record.attachments)} attachment(s) ended`;
    case 'session_start':
      return `${seq} session_start    ${record.sessionId}, ${String(record.lengthMs / 60_000)} min, ${String(record.maxDrivers)} driver seat(s), proposals ${record.proposals}`;
    case 'session_end':
      return `${seq} session_end      ${record.sessionId}: ${record.reason}, closing ${String(record.attachments)} attachment(s), ${String(record.invites)} invite(s), ${String(record.agents)} agent token(s)`;
    case 'agent_minted':
      return `${seq} agent_minted     ${record.tokenId}, sponsor ${record.sponsor}`;
    case 'agent_closed':
      return `${seq} agent_closed     ${record.tokenId}: ${record.reason}`;
    case 'snapshot_written':
      return `${seq} snapshot_written ${String(record.pages)} page(s), ${String(record.attachments)} attachment(s), sha256 ${record.sha256.slice(0, 16)}...`;
    case 'snapshot_loaded':
      return `${seq} snapshot_loaded  ${String(record.pages)} page(s), ${String(record.attachments)} attachment(s), ${String(record.dropped)} dropped, ${String(record.ageMs)} ms old`;
    case 'proposal_closed':
      return `${seq} proposal_closed  ${record.proposalId} by ${who(record.userId)}: ${record.reason}`;
    default:
      return `${seq} ${record.type}`;
  }
}
