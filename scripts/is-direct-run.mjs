// Robust "was this module run directly?" check that works THROUGH symlinks.
//
// Node's ES loader resolves symlinks, so `import.meta.url` is always the REAL
// on-disk path of the module. `process.argv[1]`, however, is whatever path the
// caller typed — NOT symlink-resolved. So when a script is invoked through a
// symlinked directory (e.g. an umbrella repo exposing `./teleport` → a real
// `../teleport`), a naive
//   fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
// compares a real path against a symlinked one, they differ, and the direct-run
// guard silently no-ops — the CLI does nothing, exits 0, prints nothing. That
// footgun cost a full debugging session once; resolving BOTH sides through
// `fs.realpathSync` before comparing removes it for good.
//
// realpath can throw (path removed mid-run, permission) — fall back to the
// unresolved (but still absolute) path so the guard degrades to the old
// behaviour instead of crashing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * True when the module identified by `importMetaUrl` is the entry script Node
 * was invoked with — even when reached via a symlinked path. Pass
 * `import.meta.url` from the calling module.
 */
export function isMainModule(importMetaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const modulePath = realpathOrSelf(fileURLToPath(importMetaUrl));
  const invokedPath = realpathOrSelf(path.resolve(argv1));
  return modulePath === invokedPath;
}
