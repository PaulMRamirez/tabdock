// A relay's audit log open in a process of its own, for the lock tests: it
// opens the directory it is given, prints "held" once it holds the lock, and
// keeps it, refreshing it as a relay does, until SIGTERM closes the log.

import { FileAuditLog } from '../../src/audit-file.ts';
import { createLogger } from '../../src/log.ts';

const [dir, staleMs] = process.argv.slice(2);
const audit = FileAuditLog.open({
  dir: dir ?? '',
  retentionDays: 30,
  maxBytes: 64 * 1024 * 1024,
  log: createLogger({ sink: (line) => process.stderr.write(`${line}\n`) }),
  lockStaleMs: staleMs === undefined ? undefined : Number(staleMs),
});
const alive = setInterval(() => undefined, 1000);
process.once('SIGTERM', () => {
  clearInterval(alive);
  void audit.close();
});
// Only once the handler is in: a test may send SIGTERM the moment it reads
// this line, and without a handler that signal kills the process outright,
// leaving the lock behind as a crash would and failing a test that checks
// close removed it.
process.stdout.write('held\n');
