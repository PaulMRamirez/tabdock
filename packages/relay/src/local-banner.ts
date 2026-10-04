// What local mode prints at start (ADR 0022), for the relay alone (main.ts)
// and for pnpm dev: that it serves this computer only, where to connect, where
// the owner token lives, and a `claude mcp add` line for the current shell that
// reads the token from its file. The line names the path, never the token, so
// neither the terminal nor shell history holds it. User scope offers the relay
// in every project and keeps the token out of repositories, which only the
// project scope would write to; the name tabdock-local leaves `tabdock` for a
// hosted connector. Checking goes through `claude mcp list`, since `claude mcp
// get` prints the header in full.

export type Shell = 'posix' | 'powershell';

/** The Claude Code server name local mode suggests. */
export const LOCAL_SERVER_NAME = 'tabdock-local';

/** The shell whose command the banner prints: PowerShell on Windows, a POSIX shell elsewhere. */
export function shellFor(platform: NodeJS.Platform): Shell {
  return platform === 'win32' ? 'powershell' : 'posix';
}

/** Single quotes for a POSIX shell: all literal, each quote closed, escaped and reopened. */
export function quotePosix(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Single quotes for PowerShell, where a quote is escaped by doubling it.
 * PowerShell also reads the typographic single quotes as quotes, so those are
 * doubled too.
 */
export function quotePowerShell(text: string): string {
  return `'${text.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}

/** A URL as one word: left bare when it is plain, as the default always is, quoted otherwise. */
function urlWord(shell: Shell, url: string): string {
  if (/^[A-Za-z0-9:/._-]+$/.test(url)) return url;
  return shell === 'posix' ? quotePosix(url) : quotePowerShell(url);
}

/** The command that adds the relay to Claude Code, reading the token from its file as it runs. */
export function claudeAddCommand(shell: Shell, mcpUrl: string, tokenPath: string): string {
  const read =
    shell === 'posix'
      ? `$(cat ${quotePosix(tokenPath)})`
      : `$(Get-Content -TotalCount 1 -LiteralPath ${quotePowerShell(tokenPath)})`;
  return `claude mcp add --transport http --scope user ${LOCAL_SERVER_NAME} ${urlWord(shell, mcpUrl)} --header "Authorization: Bearer ${read}"`;
}

export interface LocalBanner {
  mcpUrl: string;
  pageUrl: string;
  tokenPath: string;
  /** Whether this start drew the token. */
  created: boolean;
  shell: Shell;
}

/**
 * The local mode lines both banners share; the last one points the way to
 * Claude in the cloud. The step for an older entry shows on every start, not
 * only when the token is new: a start that drew the token and then could not
 * listen leaves the next start reporting it kept, while Claude Code may still
 * hold an earlier token under the same name, and `claude mcp add` refuses to
 * replace an entry.
 */
export function localModeLines(banner: LocalBanner): string[] {
  return [
    'Local mode: this relay serves MCP clients on this computer only, and trusts every account on it (ADR 0022).',
    `  MCP endpoint:  ${banner.mcpUrl}`,
    `  Page socket:   ${banner.pageUrl}`,
    `  Owner token:   ${banner.tokenPath} (${banner.created ? 'created just now' : 'kept from an earlier start'})`,
    '',
    'Add the relay to Claude Code; the command reads the token from that file, so it is never shown:',
    `  ${claudeAddCommand(banner.shell, banner.mcpUrl, banner.tokenPath)}`,
    `If Claude Code says ${LOCAL_SERVER_NAME} already exists, remove the old entry first: claude mcp remove --scope user ${LOCAL_SERVER_NAME}`,
    'Check the connection with: claude mcp list',
    'Then ask Claude to pair with the code in the Tabdock widget, and approve the request on the page.',
    'For Claude on the web, desktop or phone, which connect from the cloud, see the top of docs/deploy.md: a tunnel (pnpm dev:public) or a host.',
  ];
}
