// Quoting for the commands local mode prints and the helper script it writes
// (ADRs 0022 and 0028). Each form makes any text one literal word, so a path
// holding spaces, quotes or `$` reaches the command exactly as it is.

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
