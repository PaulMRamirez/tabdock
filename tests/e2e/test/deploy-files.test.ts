// The CI check on the files that build and deploy the relay (ADR 0018,
// docs/deploy.md): deploy/fly/fly.toml keeps Fly's HTTP handler, whose proxy
// is what overwrites Fly-Client-IP, and the tabdock_audit mount, and runs one
// Machine that never stops on its own; the Dockerfile pins both bases by
// digest and runs as uid 65532 in exec form; the build context lets in only
// what the image needs; and every workflow pins every action by commit SHA,
// asks for no permission by default, and splices no expression into a shell
// script, where an input could become a command. The checks read the files as
// text, so a change they cannot read fails rather than slips through.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

type TomlValue = string | number | boolean | string[];
type TomlTable = Record<string, TomlValue>;

/**
 * The few TOML forms fly.toml uses: [table], [[array.of.tables]], and
 * key = value with a string, integer, boolean or array of strings. Anything
 * else is refused, so the file stays simple enough for this check to read.
 */
export function readFlyToml(text: string): { tables: Map<string, TomlTable[]>; top: TomlTable } {
  const top: TomlTable = {};
  const tables = new Map<string, TomlTable[]>();
  let current = top;
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^(\[\[?)([a-z_.]+)(\]\]?)$/.exec(line);
    if (header !== null) {
      const name = header[2] ?? '';
      const list = tables.get(name) ?? [];
      if (header[1] === '[' && list.length > 0) throw new Error(`[${name}] appears twice`);
      current = {};
      list.push(current);
      tables.set(name, list);
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (pair === null)
      throw new Error(`fly.toml line ${String(index + 1)} is no form this check reads`);
    const key = pair[1] ?? '';
    const value = pair[2] ?? '';
    let parsed: TomlValue;
    if (/^"[^"\\]*"$/.test(value)) parsed = value.slice(1, -1);
    else if (/^\d+$/.test(value)) parsed = Number(value);
    else if (value === 'true' || value === 'false') parsed = value === 'true';
    else if (/^\[("[^"\\]*"(,\s*"[^"\\]*")*)?\]$/.test(value)) {
      parsed = [...value.matchAll(/"([^"\\]*)"/g)].map((match) => match[1] ?? '');
    } else
      throw new Error(`fly.toml line ${String(index + 1)} has a value this check does not read`);
    if (key in current) throw new Error(`fly.toml line ${String(index + 1)} repeats ${key}`);
    current[key] = parsed;
  }
  return { tables, top };
}

describe('deploy/fly/fly.toml (ADR 0018)', () => {
  const { tables, top } = readFlyToml(read('deploy/fly/fly.toml'));
  const one = (name: string): TomlTable => {
    const list = tables.get(name) ?? [];
    expect(list, `[${name}]`).toHaveLength(1);
    return list[0] ?? {};
  };

  it("keeps Fly's HTTP handler: [http_service], and no [[services]] that could carry raw TCP instead", () => {
    const service = one('http_service');
    const env = one('env');
    expect(service.internal_port).toBe(8787);
    expect(String(service.internal_port)).toBe(env.TABDOCK_PORT);
    expect(service.force_https).toBe(true);
    expect(tables.has('services')).toBe(false);
    // The header the relay trusts is the one that handler overwrites, and no other.
    expect(env.TABDOCK_CLIENT_ADDRESS_HEADER).toBe('fly-client-ip');
    expect(tables.get('http_service.checks')?.map((check) => check.path)).toEqual(['/healthz']);
  });

  it('keeps the tabdock_audit mount, holding the audit directory', () => {
    const mount = one('mounts');
    expect(mount.source).toBe('tabdock_audit');
    const destination = String(mount.destination);
    expect(destination).not.toBe('/');
    const auditDir = String(one('env').TABDOCK_AUDIT_DIR);
    expect(auditDir === destination || auditDir.startsWith(`${destination}/`)).toBe(true);
  });

  it('runs exactly one Machine that never stops on its own, replaced by stopping the old one first', () => {
    const service = one('http_service');
    expect(service.auto_stop_machines).toBe('off');
    expect(['rolling', 'immediate']).toContain(one('deploy').strategy);
    expect(one('vm').memory).toBe('512mb');
  });

  it('is hosted mode in production, and names no app, domain or secret', () => {
    const env = one('env');
    expect(env).toMatchObject({
      TABDOCK_ENV: 'production',
      TABDOCK_HOST: '0.0.0.0',
      TABDOCK_INVITES: '1',
    });
    expect(top.app).toBeUndefined();
    for (const secret of [
      'TABDOCK_PUBLIC_URL',
      'TABDOCK_ALLOWED_ORIGINS',
      'TABDOCK_OAUTH_ISSUER',
      'TABDOCK_OAUTH_USERS',
      'TABDOCK_PAIR_CLIENT_ID',
      'TABDOCK_PAIR_CLIENT_SECRET',
      'TABDOCK_DEV_TOKENS',
      'TABDOCK_SPIKE',
      'TABDOCK_DEV_ALLOW_NO_ORIGIN',
    ]) {
      expect(env[secret], secret).toBeUndefined();
    }
  });

  it('reads only the forms it knows', () => {
    expect(() => readFlyToml('[a]\nkey = { inline = true }\n')).toThrow(/does not read/);
    expect(() => readFlyToml('[http_service]\n[http_service]\n')).toThrow(/appears twice/);
  });
});

describe('the image (Dockerfile, .dockerignore)', () => {
  const dockerfile = read('Dockerfile');
  const instructions = dockerfile
    .split('\n')
    .filter((line) => !line.startsWith('#') && line.trim() !== '' && !line.startsWith(' '));

  it('pins every base by digest, and runs distroless as uid 65532 in exec form', () => {
    const froms = instructions.filter((line) => line.startsWith('FROM '));
    expect(froms).toHaveLength(2);
    for (const from of froms) expect(from).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}( AS \w+)?$/);
    expect(froms[0]).toMatch(/^FROM node:22-bookworm-slim@/);
    expect(froms[1]).toMatch(/^FROM gcr\.io\/distroless\/nodejs22-debian13:nonroot@/);
    const last = instructions.slice(instructions.indexOf(froms[1] ?? ''));
    expect(last).toContain('USER 65532:65532');
    const cmd = last.find((line) => line.startsWith('CMD '));
    expect(JSON.parse(cmd?.slice(4) ?? 'null')).toEqual([
      expect.stringMatching(/^--max-old-space-size=\d+$/),
      'packages/relay/src/main.ts',
    ]);
    expect(instructions.some((line) => line.startsWith('ADD '))).toBe(false);
    expect(dockerfile).toContain('--frozen-lockfile');
  });

  it('lets only the relay, protocol and lockfile into the build context', () => {
    const lines = read('.dockerignore')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    expect(lines[0]).toBe('*');
    expect(lines.filter((line) => line.startsWith('!'))).toEqual([
      '!package.json',
      '!pnpm-lock.yaml',
      '!pnpm-workspace.yaml',
      '!packages/protocol/package.json',
      '!packages/protocol/src/',
      '!packages/relay/package.json',
      '!packages/relay/src/',
    ]);
    expect(lines).toContain('**/.env*');
  });
});

describe('the workflows', () => {
  const dir = '.github/workflows';
  const workflows = readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith('.yml'))
    .map((name) => ({ name, text: read(`${dir}/${name}`) }));

  it('pin every action by full commit SHA, with its version in a comment', () => {
    for (const { name, text } of workflows) {
      for (const line of text.split('\n')) {
        const uses = /^\s*(?:- )?uses:\s*(\S+)(.*)$/.exec(line);
        if (uses === null) continue;
        expect(uses[1], `${name}: ${line.trim()}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        expect(uses[2], `${name}: ${line.trim()}`).toMatch(/^ # v\d+(\.\d+)*$/);
      }
    }
  });

  it('ask for no permission by default', () => {
    for (const { name, text } of workflows) {
      if (name === 'ci.yml') {
        expect(text).toMatch(/^permissions:\n {2}contents: read$/m);
        continue;
      }
      expect(text, name).toMatch(/^permissions: \{\}$/m);
    }
  });

  it('splice no expression into a shell script', () => {
    for (const { name, text } of workflows) {
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        const run = /^(\s*)(?:- )?run:(.*)$/.exec(line);
        if (run === null) continue;
        expect(run[2], `${name}:${String(index + 1)}`).not.toContain('${{');
        const indent = (run[1] ?? '').length;
        for (const body of lines.slice(index + 1)) {
          if (body.trim() !== '' && body.search(/\S/) <= indent + 2) break;
          expect(body, `${name}: a run script`).not.toContain('${{');
        }
      }
    }
  });

  it('deploy only a checked, attested digest, from main, behind the production environment', () => {
    const deploy = read(`${dir}/deploy.yml`);
    expect(deploy).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
    expect(deploy).not.toMatch(/^ {2}(push|pull_request|schedule|workflow_run):/m);
    expect(deploy).toContain('DIGEST: ${{ inputs.digest }}');
    expect(deploy).toContain('"$DIGEST" =~ ^sha256:[0-9a-f]{64}$');
    expect(deploy).toContain(
      '--signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/image.yml"',
    );
    expect(deploy).toContain('--source-ref refs/heads/main');
    expect(deploy).toMatch(/environment: production/);
    expect(deploy).toMatch(/needs: verify/);
    expect(deploy).toMatch(/flyctl secrets import --stage/);
    expect(deploy).toMatch(
      /setup-flyctl@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}version: \d+\.\d+\.\d+\n/,
    );
    // Every job that reads a secret first waits for the environment's approval.
    for (const { name, text } of workflows) {
      if (!text.includes('secrets.') || name === 'image.yml') continue;
      for (const job of text.split(/\n {2}(?=[a-z][\w-]*:\n)/).slice(1)) {
        if (job.includes('secrets.')) expect(job, name).toMatch(/environment: production/);
      }
    }
  });

  it('publish and attest the image only from a push to main', () => {
    const image = read(`${dir}/image.yml`);
    expect(image).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(image).toMatch(/node scripts\/smoke-image\.ts/);
    expect(image).toMatch(/anchore\/scan-action@/);
    expect(image).not.toMatch(/trivy/);
  });

  it('keep Dependabot on the action and image pins', () => {
    const dependabot = read('.github/dependabot.yml');
    expect(dependabot).toMatch(/package-ecosystem: github-actions/);
    expect(dependabot).toMatch(/package-ecosystem: docker/);
  });
});
