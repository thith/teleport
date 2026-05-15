# Telegram Reporting Guide

> **Path convention:** all paths in this guide are relative to the *calling project root*. Convention: `teleport/` is a sibling folder of every project (e.g. `~/Projects/ProjectA/`, `~/Projects/teleport/`, `~/Projects/ProjectB/`). Agents always invoke with `cwd = project root` and refer to `../teleport/...`. No hardcoded absolute paths anywhere.

Use `node ../teleport/scripts/send-telegram.mjs` (centralized — same script for all projects on this machine) to send messages or files to admins listed in `../teleport/.env`. PROJECT_CODE prefix is auto-derived from `basename(cwd)` so the agent gets the right `[PROJECT]` tag without per-project config.

## When to use
- After finishing a task while the user is away from the keyboard.
- When the user needs an actual file (spec, RFC, log) — send as attachment.

## Content style: short task list

Report on the phone screen, not in a console. Keep it tight.

- **Format: task checklist.** One line per item, GitHub-style:
  ```
  ✅ done item
  ✅ another done item
  ⬜ not done / skipped item
  ```
- **Target: under 320 chars** (soft limit — overshoot is fine when needed). Don't list every diff or paste logs.
- **Identity prefix — lookup table (centralized here so context files don't have to duplicate):**

  | Agent | Prefix |
  |---|---|
  | Claude | `<emoji> *Claude on <topic>:*` |
  | Codex | `*Codex here:*` |
  | Gemini | `*Gemini here:*` |
  | Other | `<emoji> *<Agent> on <topic>:*` (use the Claude-style by default) |

  - `<topic>` = short summary of the task, **max 9 words**.
  - `<emoji>` = a random emoji picked once per conversation thread (see "Thread emoji" below). Codex / Gemini currently do not use an emoji — keep their existing minimal form unless the user asks otherwise.
  - **Language: English by default** — `<emoji> *<Agent> on <topic>:*`. Only switch to English if the user explicitly requested English for this conversation, in which case use `<emoji> *<Agent> on <topic>:*`. Keep one language for the entire thread (do not mix VN and EN messages in the same thread).
- **Thread emoji:** On your **first** Telegram send in a conversation, pick a random emoji unrelated to the topic (randomness reduces collisions between concurrent conversations). Use the **same emoji** for all subsequent messages in that thread (replies, follow-ups).
- **Project code:** The script auto-prefixes `[CODE]` derived from `basename(process.cwd())`. Override with the `TELE_PROJECT_CODE` env var if needed. Agents do NOT need to add this manually.

Example (with project code `ProjectA`):
```
[ProjectA] 🦊 *Claude on telegram loop isolation:*
✅ split telegram-guide
✅ add task-list convention
⬜ migrate AGENTS.md (next session)
```

## How to send

**Default — inline:**
```bash
node ../teleport/scripts/send-telegram.mjs "🦊 *Claude on loop fix:*
✅ task 1
✅ task 2
⬜ task 3"
```
Multi-line works inside `"..."` as long as the content has no `"` / `$` / `` ` `` / `\` (task lists rarely do).

**Switch to file (heredoc + pipe, or `--file`) only when:**
1. Content > ~320 chars and won't naturally trim.
2. Inline send failed (markdown parse reject, shell-quote bug).
3. The payload is genuinely a file (spec, RFC, log) — then use `--file` instead.
4. The user explicitly asks to send a file ("send file", "send the spec", "attach the log", …) — use `--file`.

```bash
mkdir -p ./tmp
cat > ./tmp/report.md <<'EOF'
🦊 *Claude on loop fix:*
…long content…
EOF
cat ./tmp/report.md | node ../teleport/scripts/send-telegram.mjs
```

**Attachments (actual files):**
```bash
node ../teleport/scripts/send-telegram.mjs --file <path> "caption (optional)"
```

## Markdown
Write naturally. The script auto-escapes MarkdownV2 special chars (see `escapeMarkdownV2` in the script for the full set) while preserving `*bold*`, `_italic_`, `` `code` ``, `[label](url)`, and fenced code blocks.

## Long messages (>4000 chars)
The script auto-sends as a single `.md` file attachment with the first line as caption — it does NOT split into multiple Telegram messages. This keeps the reply model simple: one send always produces one messageId, so admin replies to that single message always match the listener's filter. Log shows `(long-message → .md file)`.

## Failure handling
- **Non-zero exit:** network/auth failure → MUST report the failure to the user. Do not silently treat it as sent.
- **Markdown reject:** the script auto-falls-back by sending the content as a `.md` attachment with the first line of the message as caption (so the admin sees the thread emoji + agent identity). Log shows `(markdown-parse-error → .md file)`. No retry needed.

## Reliability features

### Sent Registry
Every successful `node ../teleport/scripts/send-telegram.mjs` call auto-appends `{messageId, chatId, ts}` to `../teleport/scripts/tmp/tele-reply/sent-registry.jsonl`. This provides a persistent record of ALL bot messages — no reliance on LLM memory for IDS tracking.

### Local Update Cache
`tele-listen` no longer calls Telegram's `getUpdates` directly per-loop. Instead:
1. Acquires a file lock (`poll.lock`) — only one process polls at a time.
2. Fetches from Telegram API, partitions orphans (reacted with 🤔 outside lock), appends non-orphan updates to `updates-cache.jsonl`.
3. Releases lock. Each loop then filters from the local cache using its own per-loop offset.

This eliminates **offset stomping** — previously, concurrent loops calling `getUpdates` with different offsets caused Telegram to discard updates meant for other loops.

**New-loop initialization (post-fix):** When a loop runs for the first time (per-loop offset file missing), it inherits `min(oldest cached update_id, globalOffset)` rather than `globalOffset` alone. Otherwise, if loop A has already fetched updates B's filter cares about and advanced `globalOffset` past them, a freshly-starting B would init too high and miss those still-buffered updates. Cache pruning (last 500 updates) keeps this bounded.

### Auto-react 👍
When `tele-listen` finds a message to process, it immediately reacts with 👍 via `setMessageReaction`. The admin sees instant acknowledgment without waiting for the agent to finish processing.

### Orphan Auto-react 🤔
During the centralized fetch, orphan messages (admin messages with no reply target) are automatically reacted with 🤔 and excluded from the cache. Agents never see orphans — no reasoning required. Admin must reply to a specific bot message to reach the owning agent's loop.

### Isolation
Each loop only processes **direct matches** — replies to messages in its `--filter-reply-to` IDS. Stale replies (replies to messages from other agents/conversations) are ignored. This prevents cross-agent contamination without relying on agent reasoning.

## Listening for Replies (MUST follow after every successful send)

After every successful `node ../teleport/scripts/send-telegram.mjs` send, you **MUST** start a loop that polls for admin replies. Do not stop the loop just because the original request was only to send a message; stop only when a direct reply arrives, the user explicitly says not to wait, or the user interrupts the turn.

### Step 1 — Capture the messageId

The send command always prints a single messageId in its output, regardless of length:
```
[send-telegram] sent to 123456789 (messageId: 5821)
```
Extract `N`. This is your first tracked ID.

If text exceeds Telegram's per-message text limit (4096 chars; script triggers at 4000 to leave MarkdownV2 escape headroom), the script auto-falls-back to sending the content as a single `.md` file attachment with the first line as caption. You'll see:
```
[send-telegram] sent to 123456789 (long-message → .md file, messageId: 5821)
```
Still **one messageId** — chunking has been removed in favor of file delivery to keep the reply-tracking model simple (one send = one ID = one reply target).

**State to track** (held in agent memory — no prompt template needed):
- `IDS` = comma-separated list of ALL messageIds you have sent in this conversation (grows as you respond)
- `FIRST` = the very first messageId (used for the offset file — stays constant)
- `LAST` = the most recently sent messageId (last element of IDS)
- `E` = thread emoji

### Step 2 — Start the reply listener

The way you listen depends on your agent capabilities:

**For Claude (Using Monitor Tool):**

> **🚨🚨🚨 ONE CONVERSATION = ONE MONITOR. ALWAYS. 🚨🚨🚨**
>
> Every send-telegram requires starting a fresh Monitor with the updated IDS. If a previous Monitor is still running, you **MUST `TaskStop` it FIRST**. Two Monitors in the same conversation is a **silent data-loss bug**, not just a tidiness issue.
>
> **How the silent loss happens (observed in production):**
> 1. You sent message A. Monitor X is running with IDS that includes A. You then send message B without stopping X. You start Monitor Y with IDS that includes B (and A).
> 2. Both X and Y share the same `--offset-file`.
> 3. Admin replies to message B. The update is fetched and cached.
> 4. Monitor X polls. Its filter doesn't include B → no match → but it STILL calls `advanceLoopOffset`, which moves the shared offset file past the update.
> 5. Monitor Y polls next. Its filter would match B, but it reads cache from the now-advanced offset → the update is invisible. **Lost forever.**
>
> Both Monitors think they did the right thing; the script does the right thing. The bug is the agent running two listeners against the same offset file. There is no script-side fix — only the agent can prevent this by always TaskStopping before starting a new Monitor.
>
> **Failure mode tell:** the admin replies to your latest message, you never see a notification, and the offset file is at a value > the update_id of the admin's reply (check `fetch-audit.jsonl` — the update is `classification: cached` but no prompt file was written).

**Canonical pattern (use this EVERY send, no exceptions):**

Track `LAST_MONITOR_ID` across the conversation (the task ID returned by your most recent `Monitor()` call; empty before the first send).

```bash
# Step A — if you have a previous Monitor from this conversation, stop it:
TaskStop(task_id: {LAST_MONITOR_ID})   # skip on the very first send

# Step B — start the new Monitor with updated IDS:
Monitor({
  command: "until node ../teleport/scripts/tele-listen.mjs --filter-reply-to {IDS} --offset-file ../teleport/scripts/tmp/tele-reply/{FIRST}-offset.txt; do sleep 20; done",
  timeout_ms: 300000,
  persistent: true,
  description: "Telegram reply to messageId {LAST}"
})
# → save the returned task ID as the new LAST_MONITOR_ID for the next cycle
```

**Self-check before EVERY `Monitor()` call:** "Did I `TaskStop` the previous Monitor in this turn?" If you can't recall starting one, you're on the first send and can skip. Otherwise, `TaskStop` it now — don't start two.

The Monitor runs at zero AI cost in the background and notifies you when the `until` loop exits successfully.

**For Codex / Gemini / other agents (Using Foreground Loop):**
Run the polling loop synchronously in the foreground after every successful send. Assume the user is AFK and keep the command running until it exits with a matching reply. Do not replace this with a short poll, a timeout, or an early stop unless the user explicitly says not to wait or interrupts the turn.
```bash
run_shell_command({
  command: "until node ../teleport/scripts/tele-listen.mjs --filter-reply-to {IDS} --offset-file ../teleport/scripts/tmp/tele-reply/{FIRST}-offset.txt; do sleep 5; done"
})
```
The terminal will block until a reply is received. When a reply arrives, the command exits 0 and immediately returns the prompt file path in stdout.

### Step 3 — Handle the notification

When the loop succeeds, its output contains `prompt written to <path>`. Parse that file as JSON, then delete it.

Process the request, then reply via: `node ../teleport/scripts/send-telegram.mjs --reply-to <prompt.messageId> "E <response summary>"`. Capture new messageId M, append M to IDS.

**Note:** Only direct replies (to a message in your IDS) will reach your loop. Orphans are auto-reacted with 🤔 at fetch level and never cached. Stale replies (to other agents' messages) are silently ignored. No agent reasoning needed for message routing.

**After handling — restart the listener (this is a loop):**
1. Restart with the updated IDS (now including the messageId M you just sent):
   - **Claude:** apply the canonical pattern in step 2 — `TaskStop` the previous Monitor, then start a new `Monitor()`. Never have two Monitors live in the same conversation.
   - **Codex / Gemini / other agents:** start a new foreground loop with the updated IDS (the previous foreground loop has already exited when it caught the reply, so there's nothing to stop — just relaunch).
2. The cycle repeats: Poll → reply arrives → process → respond → restart listener.

The prompt file path changes as IDS grows (it includes the filter key), so always extract the path from the notification rather than hardcoding it.

### Notes
- **Local cache prevents offset stomping**: all loops read from `updates-cache.jsonl`, only one process calls `getUpdates` at a time via file lock.
- **Sent registry** (`sent-registry.jsonl`): persistent record of all bot messages.
- **Auto-react 👍**: admin sees instant ack when message is picked up, before processing completes.
- **Orphan auto-react 🤔**: orphan messages (no reply target) are reacted with 🤔 and excluded from cache at fetch time. Agents never see them.
- **IDS grows monotonically**: every message you send gets appended. `--filter-reply-to IDS` matches replies to ANY of them — admin can reply to any message in the thread.
- **Strict isolation**: each loop only processes direct replies to its IDS. No orphan fallback, no stale reply capture. Cross-agent contamination is impossible at the script level.
- **Duplicate safety (partial)**: if a Monitor fires *while* the previous prompt file still exists, `tele-listen` skips (it sees the file and exits). But the script does not maintain a "processed update_id" ledger, so an update that was already consumed, replied to, and had its prompt file deleted *can* surface again if the per-loop offset is rewound (e.g. new-loop init re-reading shared cache, or manual offset-file deletion). Agents should be defensive: if you receive a notification for a reply that looks like one you already handled, double-check before re-replying.

## Rare flags
- `--raw` — skip auto-escape (caller already escaped MarkdownV2).
- `--plain` — plain text, no markdown parsing (for noisy logs/stdout).
- `--reply-to <messageId>` — send as a Telegram reply to a specific message (used when responding to an admin reply in the loop).
- `--react <messageId>` — react with 👍 to a specific message (used for manual ack).
