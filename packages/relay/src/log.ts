// Structured logs, one JSON object per line, on stderr unless a sink is given (S11).
// Redaction works on field names wherever they appear, so a careless call site
// still cannot leak a token, a pairing code or tool arguments. Messages are fixed
// strings; secret values never go into them.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (line: string) => void;
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** Field names whose values never reach a log line, compared case-insensitively. */
export const REDACTED_FIELDS: readonly string[] = [
  'token',
  'code',
  'resumetoken',
  'authorization',
  'arguments',
  // The QR flow's secrets (S11): its nonce, cookies, and the sign-in's own values.
  'nonce',
  'secret',
  'clientsecret',
  'cookie',
  'set-cookie',
  'verifier',
  'idtoken',
  'id_token',
  'access_token',
  'refresh_token',
  // Invites (ADR 0017): a link or its secret as pair_page takes it, and the
  // digest the relay keeps, which ADR 0019 keeps out of every record too.
  'invite',
  'link',
  'secrethash',
  // People (ADR 0020): an invitee's address reaches its page and the audit
  // file's attach record, never stderr or a platform's logs.
  'email',
  'displayname',
];

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED = new Set(['ts', 'level', 'msg']);

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    return value;
  }
  if (depth >= MAX_DEPTH) return '[nested]';
  // Error messages from our own code never carry secrets; stacks add noise, not signal.
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return '[bytes]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = REDACTED_FIELDS.includes(key.toLowerCase()) ? REDACTED : redact(inner, depth + 1);
  }
  return out;
}

function stderrSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function createLogger(options: { sink?: LogSink; level?: LogLevel } = {}): Logger {
  const sink = options.sink ?? stderrSink;
  const threshold = LEVELS[options.level ?? 'info'];
  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVELS[level] < threshold) return;
    const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, msg: message };
    if (fields) {
      const clean = redact(fields) as Record<string, unknown>;
      for (const [key, value] of Object.entries(clean)) {
        if (!RESERVED.has(key)) entry[key] = value;
      }
    }
    try {
      sink(JSON.stringify(entry));
    } catch {
      // A broken sink must not take the relay down with it.
    }
  };
  return {
    debug: (message, fields) => {
      write('debug', message, fields);
    },
    info: (message, fields) => {
      write('info', message, fields);
    },
    warn: (message, fields) => {
      write('warn', message, fields);
    },
    error: (message, fields) => {
      write('error', message, fields);
    },
  };
}
