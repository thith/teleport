// button-store.mjs — pending owner buttons (merge preview, manual cleanup) that
// survive a daemon restart.
//
// A Map (token → entry) mirrored to ~/.local/state/teleport/pending-buttons.json
// (the daemon's own state dir, not the agents' scripts/tmp) on every set/delete,
// loaded once at construction. Entries must be plain JSON. Only the daemon (a
// singleton) writes it, so a whole-file atomic rewrite is enough. A missing /
// corrupt file just starts empty (pending buttons then say "expired").
// The file is not trusted on its own: every press is checked against the text
// of the Telegram message the owner actually saw (see daemon / cleanup-inbox).
// delete() THROWS when the consumption can't be written — a one-shot button
// must not come back after a restart, so the caller then does nothing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BUTTON_STORE_FILE = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'teleport', 'pending-buttons.json');
export const BUTTON_STORE_CAP = 200; // oldest dropped beyond this (createdAt order)

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class PersistentMap extends Map {
  constructor(file = BUTTON_STORE_FILE, { cap = BUTTON_STORE_CAP } = {}) {
    super();
    this.file = file;
    this.cap = cap;
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data)) if (v && typeof v === 'object') super.set(k, v);
    }
  }

  set(k, v) {
    super.set(k, v);
    if (this.size > this.cap) {
      const oldest = [...this.entries()].sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
      for (const [key] of oldest.slice(0, this.size - this.cap)) super.delete(key);
    }
    try { this.flush(); } catch (e) { console.error(`[button-store] write failed: ${e?.message ?? e}`); } // still works in memory
    return this;
  }

  delete(k) {
    const had = super.delete(k);
    if (had) this.flush(); // throws → the caller must not act
    return had;
  }

  flush() {
    writeAtomic(this.file, JSON.stringify(Object.fromEntries(this)));
  }
}
