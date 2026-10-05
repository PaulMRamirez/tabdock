// Builds and packs the three published packages (ADR 0028):
//   node scripts/release-pack.ts [<dir>]       (pnpm release:pack)
// into <dir> (default dist/packages, which git ignores): the protocol's and
// the adapter's tsc output with declarations, the adapter's script-tag build,
// and the relay's bundle with an npm-shrinkwrap.json made for this pack and
// removed after it. Each package is packed by `pnpm pack`, which applies
// publishConfig, pins workspace:* to the shared version and adds the root
// LICENSE; each package keeps its own copy of NOTICE, which pnpm would not
// add. Beside the tarballs go SHA256SUMS and tabdock-adapter.integrity.txt,
// the script-tag file's SRI digest and a ready jsDelivr tag, which the release
// carries. release-check.ts then checks what was packed; nothing here
// publishes.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { writeShrinkwrap } from '../packages/relay/scripts/shrinkwrap.ts';
import { DEFAULT_OUT, integrityOf, PACKAGES, ROOT, tarballName } from './release-check.ts';

/** pnpm as this script was run with, when it was, else whatever `pnpm` is on the PATH. */
function pnpm(args: string[], cwd: string = ROOT): void {
  const execPath = process.env.npm_execpath ?? '';
  const [command, prefix] = basename(execPath).startsWith('pnpm')
    ? [process.execPath, [execPath]]
    : ['pnpm', []];
  const ran = spawnSync(command, [...prefix, ...args], { cwd, stdio: 'inherit' });
  if (ran.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`);
}

function versionOf(name: string): string {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8'),
  ) as { version: string };
  return manifest.version;
}

export function releasePack(out: string): string[] {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // The adapter's build builds the protocol's first, which its declarations need.
  pnpm(['--filter', '@tabdock/adapter', 'build']);
  pnpm(['--filter', '@tabdock/relay', 'build']);
  const shrinkwrap = writeShrinkwrap();
  const packed: string[] = [];
  try {
    for (const name of PACKAGES) {
      pnpm(['pack', '--pack-destination', out], join(ROOT, 'packages', name));
      packed.push(join(out, tarballName(name, versionOf(name))));
    }
  } finally {
    rmSync(shrinkwrap, { force: true });
  }
  const sums = packed
    .map(
      (file) =>
        `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${basename(file)}`,
    )
    .join('\n');
  writeFileSync(join(out, 'SHA256SUMS'), `${sums}\n`);
  const version = versionOf('adapter');
  const integrity = integrityOf(
    readFileSync(join(ROOT, 'packages', 'adapter', 'dist', 'tabdock-adapter.js')),
  );
  writeFileSync(
    join(out, 'tabdock-adapter.integrity.txt'),
    `${integrity}\n<script src="https://cdn.jsdelivr.net/npm/@tabdock/adapter@${version}/dist/tabdock-adapter.js" integrity="${integrity}" crossorigin="anonymous" data-relay="wss://relay.example/page"></script>\n`,
  );
  return packed;
}

if (import.meta.main) {
  const out = resolve(process.argv[2] ?? DEFAULT_OUT);
  const packed = releasePack(out);
  console.log(`release-pack: ${packed.map((file) => basename(file)).join(', ')} in ${out}`);
}
