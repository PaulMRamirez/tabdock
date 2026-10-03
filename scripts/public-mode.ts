// What pnpm dev:public needs from .env, and what it tells the owner to enter
// at the identity provider and in Claude (ADR 0013, ADR 0014). Kept apart from
// dev.ts, which starts servers, so a test can check the wording without them.
// Nothing here returns a setting's value except the public URL and the issuer,
// which are addresses: never a client secret, a client id or a subject.

import { pairRedirectUriOf, parsePublicUrl, publicMcpUrlOf } from '../packages/relay/src/index.ts';

export interface PublicSetting {
  name: string;
  what: string;
}

/**
 * Everything public URL mode needs, in the order the owner meets them. The
 * relay refuses to start without each one; this list lets dev:public name
 * every gap at once instead of one per run.
 */
export function publicSettings(demoOrigin: string): PublicSetting[] {
  return [
    {
      name: 'TABDOCK_PUBLIC_URL',
      what: 'the https origin your tunnel serves, with no path, such as https://<name>.ngrok-free.app',
    },
    {
      name: 'TABDOCK_OAUTH_ISSUER',
      what: "your identity provider's issuer, exactly as its metadata states it, such as https://<subdomain>.authkit.app",
    },
    {
      name: 'TABDOCK_OAUTH_USERS',
      what: 'who may sign in: sub=userId:Display Name entries separated by commas, sub being the person at the provider',
    },
    {
      name: 'TABDOCK_PAIR_CLIENT_ID',
      what: "the relay's own confidential client at the provider, which the QR page at /pair signs phones in with",
    },
    {
      name: 'TABDOCK_PAIR_CLIENT_SECRET',
      what: "that client's secret; it stays in .env and nothing prints it",
    },
    {
      name: 'TABDOCK_ALLOWED_ORIGINS',
      what: `the page origins allowed to attach, which public URL mode needs listed; for the demo board, ${demoOrigin}`,
    },
  ];
}

/** The settings that are missing or blank, in the order publicSettings gives them. */
export function missingPublicSettings(env: NodeJS.ProcessEnv, demoOrigin: string): string[] {
  return publicSettings(demoOrigin)
    .map((setting) => setting.name)
    .filter((name) => (env[name]?.trim() ?? '') === '');
}

export interface ProviderValues {
  /** The connector URL in Claude, the protected resource and the audience of every token. */
  connectorUrl: string;
  /** What the provider must issue access tokens for (WorkOS calls it a Resource Indicator). */
  resourceIndicator: string;
  /** Where the provider sends a phone back after it signs in at /pair. */
  pairRedirectUri: string;
  pairPage: string;
}

/** The addresses the owner registers at the provider, all derived from the public URL. */
export function providerValues(publicUrl: string): ProviderValues {
  const origin = parsePublicUrl(publicUrl);
  const connectorUrl = publicMcpUrlOf(origin);
  return {
    connectorUrl,
    resourceIndicator: connectorUrl,
    pairRedirectUri: pairRedirectUriOf(origin),
    pairPage: new URL('/pair', origin).href,
  };
}

/** The lines that tell the owner what to enter at the provider. */
export function providerLines(values: ProviderValues, issuer: string | null): string[] {
  return [
    issuer === null
      ? 'At your identity provider, enter:'
      : `At your identity provider (${issuer}), enter:`,
    `  Resource Indicator (the audience of access tokens):  ${values.resourceIndicator}`,
    `  Redirect URI of the /pair client:                    ${values.pairRedirectUri}`,
    '  The /pair client is a confidential client; its id and secret go in .env as',
    '  TABDOCK_PAIR_CLIENT_ID and TABDOCK_PAIR_CLIENT_SECRET.',
  ];
}

/**
 * Why dev:public will not start, naming each missing setting and what it is.
 * When the public URL is already there, the provider values follow, so the
 * owner can register them before the client id and secret exist.
 */
export function missingSettingsMessage(
  command: string,
  missing: readonly string[],
  env: NodeJS.ProcessEnv,
  demoOrigin: string,
): string {
  const settings = publicSettings(demoOrigin).filter((setting) => missing.includes(setting.name));
  const width = Math.max(...settings.map((setting) => setting.name.length));
  const lines = [
    `${command} runs the relay in public URL mode (ADR 0014) and needs these in .env,`,
    'which are missing or empty:',
    '',
    ...settings.map((setting) => `  ${setting.name.padEnd(width)}  ${setting.what}`),
    '',
    '.env.example describes each one. Keep .env to yourself; git ignores it.',
  ];
  const publicText = env.TABDOCK_PUBLIC_URL?.trim() ?? '';
  if (publicText !== '') {
    let values: ProviderValues | null = null;
    try {
      values = providerValues(publicText);
    } catch (error) {
      // The relay's own message names the variable and the rule, never the value.
      lines.push('', error instanceof Error ? error.message : String(error));
    }
    if (values !== null) {
      const issuer = env.TABDOCK_OAUTH_ISSUER?.trim() ?? '';
      lines.push('', ...providerLines(values, issuer === '' ? null : issuer));
    }
  }
  return `${lines.join('\n')}\n`;
}
