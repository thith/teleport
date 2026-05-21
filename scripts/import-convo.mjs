#!/usr/bin/env node
// import-convo: repair a missing convo-registry row from sent-registry.jsonl.
// Use when send-telegram crashed between the sent-registry and convo-registry
// appends, leaving the message on Telegram but unrouteable by `tele-listen --convo`.
//
//   node import-convo.mjs --convo <N>             # repair allocation row only
//   node import-convo.mjs --convo <N> --all       # also repair every subsequent send
//   node import-convo.mjs --convo <N> --bot <id>  # disambiguate when sent-registry rows
//                                                 # are pre-v1 (no botId field)
//
// The tool holds the convo-registry lock; safe to run while live senders/listeners
// poll. Idempotent: if the rows already exist in convo-registry, the tool is a no-op.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFromFile, readSentRegistry, extractBotId } from './send-telegram.mjs';
import {
  acquireLock, appendRowLocked, CONVO_SCHEMA_VERSION,
  DEFAULT_LOCK_FILE, DEFAULT_REGISTRY_FILE, hasAllocationRow,
  readRows, releaseLock, validateConvoIdString,
} from './convo-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env');

function parseArgs(argv) {
  const out = { convo: null, all: false, bot: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--convo') {
      const next = argv[i + 1];
      if (!next) throw new Error('--convo requires a positive-integer convoId');
      out.convo = validateConvoIdString(next.trim()); i++;
    } else if (argv[i] === '--all') {
      out.all = true;
    } else if (argv[i] === '--bot') {
      const next = argv[i + 1];
      if (!next || !/^\d+$/.test(next.trim())) throw new Error('--bot requires a positive-integer bot id');
      out.bot = Number(next.trim()); i++;
    } else {
      throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  if (out.convo == null) throw new Error('--convo is required');
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) {
    console.error(`[import-convo] ${e.message}`);
    process.exit(1);
  }

  const envFromFile = loadEnvFromFile(ENV_FILE);
  const token = process.env.REPORT_BOT_TOKEN || envFromFile.REPORT_BOT_TOKEN;
  const envBotId = extractBotId(token);
  const botId = args.bot != null ? args.bot : envBotId;
  if (botId == null) {
    console.error('[import-convo] cannot determine bot id (REPORT_BOT_TOKEN missing, --bot not given)');
    process.exit(1);
  }

  // Snapshot-at-start: sent-registry is read once and `allocCandidates` /
  // `sent` are NOT refreshed during the lock-yield loop below. If a live
  // sender appends after this read, those rows are not considered by this
  // invocation — rerun `import-convo` to pick them up. We use snapshot
  // semantics intentionally so the operator's command produces deterministic
  // results regardless of concurrent activity.
  const sent = readSentRegistry();
  // Allocation candidate = a sent row that matches the convoId via either:
  //   (a) sent-registry `convoId` field (modern rows — works for env-derived
  //       convos whose convoId is a UUID-hash, NOT a real messageId), OR
  //   (b) `messageId === convo` (legacy / pre-convoId-field rows, including
  //       the "new convo = messageId" case).
  // Pre-v1 rows lack `botId` — refuse to repair unless `--bot` is explicit.
  const allocCandidates = sent.filter((r) => {
    const matchesConvo = (r.convoId === args.convo) || (r.messageId === args.convo);
    if (!matchesConvo) return false;
    if (r.botId != null && r.botId !== botId) return false;
    if (r.botId == null && args.bot == null) return false;
    return true;
  });

  if (allocCandidates.length === 0) {
    console.error(`[import-convo] no allocation send found in sent-registry for convo=${args.convo} bot=${botId}. ` +
      `Hint: pre-v1 sent-registry rows lack botId — re-run with --bot <id> if you're certain of the bot.`);
    process.exit(1);
  }

  // Subsequent rows (only used with --all): every sent row with matching botId/chatId
  // that landed AFTER an allocation row's timestamp. We don't know which sent rows
  // belong to the convo (sent-registry doesn't carry convoId), so --all is best-effort:
  // it appends every sent send for the same (botId, chatId) AFTER the allocation row,
  // newer-than-alloc-ts. This is over-inclusive; use with care.
  const acquired = await acquireLock();
  if (!acquired) {
    console.error('[import-convo] could not acquire convo-registry lock; abort');
    process.exit(1);
  }
  try {
    const { rows: existingRows } = readRows();
    let appended = 0;
    let skipped = 0;
    for (const r of allocCandidates) {
      const chatId = String(r.chatId);
      if (hasAllocationRow(existingRows, args.convo, botId, chatId)) {
        skipped++;
        continue;
      }
      appendRowLocked({
        v: CONVO_SCHEMA_VERSION,
        convoId: args.convo,
        messageId: args.convo,
        chatId,
        botId,
        ts: typeof r.ts === 'number' ? r.ts * 1000 : Date.now(),
      });
      appended++;
    }

    if (args.all) {
      // Walk sent rows newer than each allocation row's ts, same (botId, chatId),
      // append as messageId rows under the same convoId. Inferred, not authoritative.
      // Dedupe by (chatId, messageId). To avoid starving concurrent live
      // senders/listeners, release+reacquire the lock every YIELD_EVERY writes.
      const YIELD_EVERY = 100;
      const existingKeys = new Set();
      for (const r of existingRows) {
        if (Number.isInteger(r.messageId)) existingKeys.add(`${r.chatId}:${r.messageId}`);
      }
      let writesSinceYield = 0;
      const yieldLockIfDue = async () => {
        if (writesSinceYield < YIELD_EVERY) return;
        releaseLock();
        // Tiny pause so a waiting peer wins the race on the next openSync('wx').
        await new Promise((r) => setTimeout(r, 10));
        const re = await acquireLock();
        if (!re) throw new Error('lost lock during yield, cannot continue');
        // CRITICAL: rebuild existingKeys from disk. A peer may have appended
        // matching (chatId, messageId) rows during the yield — stale Set would
        // miss them and we'd double-write.
        const { rows: refreshed } = readRows();
        existingKeys.clear();
        for (const r of refreshed) {
          if (Number.isInteger(r.messageId)) existingKeys.add(`${r.chatId}:${r.messageId}`);
        }
        writesSinceYield = 0;
      };
      for (const alloc of allocCandidates) {
        const allocTs = alloc.ts ?? 0;
        const chatId = String(alloc.chatId);
        for (const r of sent) {
          if ((r.botId != null && r.botId !== botId) || String(r.chatId) !== chatId) continue;
          if (r.messageId === args.convo) continue; // allocation already handled
          if ((r.ts ?? 0) <= allocTs) continue;
          // If sent-registry has explicit convoId, restrict to matching rows
          // (precise). For pre-convoId rows fall back to the legacy ts-window
          // over-inclusive behavior (best-effort).
          if (r.convoId != null && r.convoId !== args.convo) continue;
          const key = `${chatId}:${r.messageId}`;
          if (existingKeys.has(key)) { skipped++; continue; }
          appendRowLocked({
            v: CONVO_SCHEMA_VERSION,
            convoId: args.convo,
            messageId: r.messageId,
            chatId,
            botId,
            ts: typeof r.ts === 'number' ? r.ts * 1000 : Date.now(),
          });
          existingKeys.add(key);
          appended++;
          writesSinceYield++;
          await yieldLockIfDue();
        }
      }
    }

    console.log(`[import-convo] convoId=${args.convo} bot=${botId} appended=${appended} skipped(already-present)=${skipped}`);
  } finally {
    releaseLock();
  }
}

const isDirectRun = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isDirectRun) {
  main().catch((e) => {
    console.error(`[import-convo] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
