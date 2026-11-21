import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * What a host installs is the PACKED package, not this checkout: `files` in
 * package.json decides what is in it. Every test above runs from source, so a
 * module left out of the pack passes them all and breaks the host on load.
 * This packs the package as a host would get it and checks that every import
 * a shipped file makes resolves to a file in the pack.
 */
const root = process.cwd();
let pkg = '';
let shipped: string[] = [];

beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), 'tabs-pack-'));
  execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: root, stdio: 'pipe' });
  const tgz = readdirSync(out).find((f) => f.endsWith('.tgz'))!;
  execFileSync('tar', ['-xzf', join(out, tgz), '-C', out]);
  pkg = join(out, 'package');
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  shipped = walk(pkg).map((f) => relative(pkg, f));
}, 60_000);

afterAll(() => {
  if (pkg) rmSync(dirname(pkg), { recursive: true, force: true });
});

/** The module specifiers a source file imports or re-exports. */
const specifiers = (src: string): string[] =>
  [...src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (m) => (m[1] ?? m[2])!,
  );

const resolves = (from: string, spec: string): boolean =>
  ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].some((ext) => existsSync(resolve(dirname(from), spec + ext)));

describe('the package a host installs', () => {
  it('has every module its own files import', () => {
    const missing: string[] = [];
    for (const f of shipped.filter((s) => /\.tsx?$/.test(s))) {
      const file = join(pkg, f);
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.') && !resolves(file, spec)) missing.push(`${f} → ${spec}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('imports nothing through this repo’s own `@/` alias, which a host cannot resolve', () => {
    const aliased = shipped
      .filter((s) => /\.tsx?$/.test(s))
      .flatMap((f) => specifiers(readFileSync(join(pkg, f), 'utf8')).filter((s) => s.startsWith('@/')).map((s) => `${f} → ${s}`));
    expect(aliased).toEqual([]);
  });

  it('ships the entry points package.json names', () => {
    const json = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { exports: Record<string, string> };
    for (const target of Object.values(json.exports)) expect(shipped).toContain(target.replace(/^\.\//, ''));
  });

  it('never ships the e2e host page, the tests, the e2e specs or a build', () => {
    expect(shipped.filter((f) => /^(app|tests|e2e|out|\.next)\//.test(f))).toEqual([]);
  });
});
