// Reads the script-tag build's data attributes into attach() options. Kept free
// of the DOM so it can be tested in Node.

import { PolicySchema, type PolicyInput } from '@tabdock/protocol';

export type ScriptOptions =
  { ok: true; relay: string; policy: PolicyInput } | { ok: false; error: string };

/**
 * `data` is a script element's dataset: data-relay, data-auto-approve,
 * data-max-drivers, data-consequential, data-consequential-tools (a comma
 * list), data-invites (off, watch or all; ADR 0016) and data-confirm-via
 * (page or client; ADR 0026). Absent attributes stay absent, so the policy
 * defaults apply and an omitted data-confirm-via keeps the operator's prompt.
 * A data-consequential-tools that names no tool, empty or only commas, reads as
 * an empty list, which like an absent one leaves ADR 0002's fallback on where
 * the runtime drops the hint (ADR 0034).
 */
export function readScriptOptions(
  data: Readonly<Record<string, string | undefined>>,
): ScriptOptions {
  const relay = data.relay?.trim() ?? '';
  if (relay === '') {
    return { ok: false, error: 'data-relay is required, for example ws://127.0.0.1:8787/page' };
  }
  // Checked here, as attach() would, so a bad URL is one console line rather
  // than an uncaught TypeError, and never quoted, since a URL's query can carry a secret.
  let protocol = '';
  try {
    protocol = new URL(relay).protocol;
  } catch {
    // Refused below; URL.parse is newer than some browsers a polyfill serves.
  }
  if (protocol !== 'ws:' && protocol !== 'wss:') {
    return {
      ok: false,
      error: 'data-relay must be a ws: or wss: URL, for example ws://127.0.0.1:8787/page',
    };
  }
  const policy: Record<string, unknown> = {};
  if (data.autoApprove !== undefined) policy.autoApprove = data.autoApprove.trim();
  if (data.maxDrivers !== undefined) policy.maxDrivers = Number(data.maxDrivers.trim() || NaN);
  if (data.consequential !== undefined) policy.consequential = data.consequential.trim();
  if (data.invites !== undefined) policy.invites = data.invites.trim();
  // Only 'page' or 'client' parses: a typo keeps the adapter from attaching,
  // with the error below, rather than quietly choosing who confirms.
  if (data.confirmVia !== undefined) policy.confirmVia = data.confirmVia.trim();
  if (data.consequentialTools !== undefined) {
    policy.consequentialTools = data.consequentialTools
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
  }
  const parsed = PolicySchema.safeParse(policy);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    return { ok: false, error: `invalid data attributes for ${fields}` };
  }
  return { ok: true, relay, policy };
}
