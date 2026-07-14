import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('./is-direct-run.mjs', import.meta.url));

// A fixture that prints MAIN iff isMainModule reports it was run directly.
function makeFixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-direct-run-'));
  const fixture = path.join(dir, 'fixture.mjs');
  fs.writeFileSync(
    fixture,
    `import { isMainModule } from ${JSON.stringify(HELPER)};\n` +
      `if (isMainModule(import.meta.url)) console.log('MAIN');\n` +
      `export const marker = 'loaded';\n`,
  );
  return { dir, fixture };
}

test('run directly via real path → MAIN', () => {
  const { fixture } = makeFixtureDir();
  const out = execFileSync('node', [fixture], { encoding: 'utf8' });
  assert.equal(out.trim(), 'MAIN');
});

test('run directly via a SYMLINKED path → still MAIN (the symlink bug)', () => {
  const { dir, fixture } = makeFixtureDir();
  // Sibling symlink pointing at the fixture dir, mimicking umbrella `./teleport`.
  const linkDir = `${dir}-link`;
  fs.symlinkSync(dir, linkDir);
  try {
    const viaSymlink = path.join(linkDir, path.basename(fixture));
    const out = execFileSync('node', [viaSymlink], { encoding: 'utf8' });
    assert.equal(out.trim(), 'MAIN');
  } finally {
    fs.rmSync(linkDir, { force: true });
  }
});

test('imported (not the entry script) → not MAIN', () => {
  const { dir, fixture } = makeFixtureDir();
  const importer = path.join(dir, 'importer.mjs');
  fs.writeFileSync(
    importer,
    `import { marker } from ${JSON.stringify(fixture)};\n` +
      `console.log('IMPORTED:' + marker);\n`,
  );
  const out = execFileSync('node', [importer], { encoding: 'utf8' });
  assert.equal(out.trim(), 'IMPORTED:loaded');
});
