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
process.stdout.write('held\n');
const alive = setInterval(() => undefined, 1000);
process.once('SIGTERM', () => {
  clearInterval(alive);
  void audit.close();
});
