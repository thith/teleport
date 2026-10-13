// cleanup-child.mjs — runs ONE cleanupRequested() in its own process, so the
// daemon's poll loop never blocks on its synchronous filesystem walks
// (fingerprints, tmp/ repo scan, the daily gates' transcript + 24h-edit walks).
// stdin: {"target": "<path>", "opts": {…JSON-serialisable cleanupRequested options}}
// stdout: the result object as one JSON line. Spawned by cleanup-inbox.mjs.

import { cleanupRequested } from './cleanup.mjs';
import { isMainModule } from './is-direct-run.mjs';

if (isMainModule(import.meta.url)) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', async () => {
    let r;
    try {
      const { target, opts } = JSON.parse(input);
      r = await cleanupRequested(target, opts || {});
    } catch (e) { r = { ok: false, path: null, reason: `lỗi: ${String(e?.message || e).split('\n')[0].slice(0, 160)}` }; }
    process.stdout.write(`${JSON.stringify(r)}\n`);
  });
}
