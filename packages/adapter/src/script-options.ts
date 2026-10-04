// Reads the script-tag build's data attributes into attach() options. Kept free
// of the DOM so it can be tested in Node.

import { PolicySchema, type PolicyInput } from '@tabdock/protocol';

export type ScriptOptions =
  { ok: true; relay: string; policy: PolicyInput } | { ok: false; error: string };

/**
 * `data` is a script element's dataset: data-relay, data-auto-approve,
 * data-max-drivers, data-consequential, data-consequential-tools (a comma
 * list) and data-invites (off, watch or all; ADR 0016). Absent attributes
 * stay absent, so the policy defaults apply and an omitted tool list still
 * means "the page gave none" (ADR 0002).
 */
export function readScriptOptions(
  data: Readonly<Record<string, string | undefined>>,
): ScriptOptions {
  const relay = data.relay?.trim() ?? '';
  if (relay === '') {
    return { ok: false, error: 'data-relay is required, for example ws://127.0.0.1:8787/page' };
  }
  const policy: Record<string, unknown> = {};
  if (data.autoApprove !== undefined) policy.autoApprove = data.autoApprove.trim();
  if (data.maxDrivers !== undefined) policy.maxDrivers = Number(data.maxDrivers.trim() || NaN);
  if (data.consequential !== undefined) policy.consequential = data.consequential.trim();
  if (data.invites !== undefined) policy.invites = data.invites.trim();
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
