// `/pending` — list convos waiting on an admin reply. A daemon command: prints
// the formatted list to stdout; the daemon relays it. Reads the pending-store
// (and listener-alive so a dead agent's convo isn't shown as "waiting").
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import path from 'node:path';
import { readPendingStore, listPending, formatPendingList } from './pending-store.mjs';
import { getLastAliveMs, DEFAULT_FRESH_MS as ALIVE_FRESH_MS } from './listener-alive.mjs';

export function renderPending({ store = readPendingStore(), now = Date.now() } = {}) {
  return formatPendingList(listPending(store, { now, getLastAliveMs, aliveFreshMs: ALIVE_FRESH_MS }), { now });
}

if (isMainModule(import.meta.url)) {
  process.stdout.write(renderPending() + '\n');
}
