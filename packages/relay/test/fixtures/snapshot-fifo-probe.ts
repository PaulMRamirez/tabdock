// node snapshot-fifo-probe.ts <audit dir> <regular file>: takes the restart
// snapshot from an audit directory whose relay-snapshot.json is a FIFO, with
// lstat answering for it as the regular file named, as when a FIFO is swapped
// in between the loader's lstat and its open, and prints the outcome as one
// JSON line. restart-snapshot.test.ts runs it in a process of its own with a
// timeout: an open that waits for a FIFO's writer blocks the whole thread,
// which no timer inside the same process could end.

import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { SNAPSHOT_FILE, takeSnapshot } from '../../src/snapshot.ts';

const [dir, regularFile] = process.argv.slice(2);
if (dir === undefined || regularFile === undefined) {
  throw new Error('usage: snapshot-fifo-probe.ts <audit dir> <regular file>');
}
const fifo = join(dir, SNAPSHOT_FILE);
const regular = nodeFs.lstatSync(regularFile);
const lstatSync = ((path: nodeFs.PathLike, options?: nodeFs.StatSyncOptions) =>
  path === fifo ? regular : nodeFs.lstatSync(path, options)) as typeof nodeFs.lstatSync;
const outcome = takeSnapshot({
  dir,
  enabled: true,
  now: Date.now(),
  mode: 'public',
  fs: { ...nodeFs, lstatSync },
});
process.stdout.write(`${JSON.stringify(outcome)}\n`);
