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
- **Identity prefix:** `<emoji> *<Agent> on <topic>:*` — where:
  - `<Agent>` = `Claude` / `Codex` / `Gemini`
  - `<topic>` = short summary of the task, **max 9 words**
  - `<emoji>` = a random emoji picked once per conversation thread (see below)
  - The "on" phrasing is Vietnamese ("reports on"). English-speaking agents may translate the verb part (e.g. `<emoji> *Claude on <topic>:*`) but keep the structure `<emoji> *<Agent> <connector> <topic>:*`.
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
Write naturally. The script auto-escapes MarkdownV2 special chars (see `escapeMarkdownV2` in the script for the full set) while preserving `*bold*`, `_italic_`, `` `code` ``, `[label](url)`, and fenced code blocks. Length > 4000 chars auto-splits at `\n\n`.

## Failure handling
- **Non-zero exit:** network/auth failure → MUST report the failure to the user. Do not silently treat it as sent.
- **Markdown reject:** the script auto-falls-back by sending the content as a `.md` attachment with the first line of the message as caption (so the admin sees the thread emoji + agent identity). Log shows `(markdown-file fallback)`. No retry needed.

## Reliability features

### Sent Registry
Every successful `node ../teleport/scripts/send-telegram.mjs` call auto-appends `{messageId, chatId, ts}` to `../teleport/scripts/tmp/tele-reply/sent-registry.jsonl`. This provides a persistent record of ALL bot messages — no reliance on LLM memory for IDS tracking.

### Local Update Cache
`tele-listen` no longer calls Telegram's `getUpdates` directly per-loop. Instead:
1. Acquires a file lock (`poll.lock`) — only one process polls at a time.
2. Fetches from Telegram API, partitions orphans (reacted with 🤔 outside lock), appends non-orphan updates to `updates-cache.jsonl`.
3. Releases lock. Each loop then filters from the local cache using its own per-loop offset.

This eliminates **offset stomping** — previously, concurrent loops calling `getUpdates` with different offsets caused Telegram to discard updates meant for other loops.

### Auto-react 👍
When `tele-listen` finds a message to process, it immediately reacts with 👍 via `setMessageReaction`. The admin sees instant acknowledgment without waiting for the agent to finish processing.

### Orphan Auto-react 🤔
During the centralized fetch, orphan messages (admin messages with no reply target) are automatically reacted with 🤔 and excluded from the cache. Agents never see orphans — no reasoning required. Admin must reply to a specific bot message to reach the owning agent's loop.

### Isolation
Each loop only processes **direct matches** — replies to messages in its `--filter-reply-to` IDS. Stale replies (replies to messages from other agents/conversations) are ignored. This prevents cross-agent contamination without relying on agent reasoning.

## Listening for Replies (MUST follow after every successful send)

After every successful `node ../teleport/scripts/send-telegram.mjs` send, you **MUST** start a loop that polls for admin replies. Do not stop the loop just because the original request was only to send a message; stop only when a direct reply arrives, the user explicitly says not to wait, or the user interrupts the turn.

### Step 1 — Capture the messageId

The send command prints `(messageId: N)` in its output, e.g.:
```
[send-telegram] sent to 123456789 (messageId: 5821)
```
Extract `N`. This is your first tracked ID.

**State to track** (held in agent memory — no prompt template needed):
- `IDS` = comma-separated list of ALL messageIds you have sent in this conversation (grows as you respond)
- `FIRST` = the very first messageId (used for the offset file — stays constant)
- `LAST` = the most recently sent messageId (last element of IDS)
- `E` = thread emoji

### Step 2 — Start the reply listener

The way you listen depends on your agent capabilities:

**If your agent has a background-task / Monitor tool (e.g. Claude Code's `Monitor`):**
**CRITICAL: One conversation = one Monitor.** TaskStop the previous Monitor before starting a new one.
```bash
Monitor({
  command: "until node ../teleport/scripts/tele-listen.mjs --filter-reply-to {IDS} --offset-file ../teleport/scripts/tmp/tele-reply/{FIRST}-offset.txt; do sleep 20; done",
  timeout_ms: 300000,
  persistent: true,
  description: "Telegram reply to messageId {LAST}"
})
```
Save the task ID returned by Monitor — you need it for TaskStop later. The Monitor runs at zero AI cost in the background and notifies you when the `until` loop exits successfully.

**If your agent only has a synchronous shell tool (Codex, Gemini, or any other agent without background tasks):**
Because these CLIs lack a background wakeup feature, you **MUST** run the polling loop synchronously in the foreground after every successful send. Assume the user is AFK and keep the command running until it exits with a matching reply. Do not replace this with a short poll, a timeout, or an early stop unless the user explicitly says not to wait or interrupts the turn.
```bash
run_shell_command({
  command: "until node ../teleport/scripts/tele-listen.mjs --filter-reply-to {IDS} --offset-file ../teleport/scripts/tmp/tele-reply/{FIRST}-offset.txt; do sleep 5; done"
})
```
The terminal will block until a reply is received. That blocking behavior is required for foreground-only agents (Codex, Gemini, and others). When a reply arrives, the command exits 0 and immediately returns the prompt file path in stdout.

### Step 3 — Handle the notification

When the loop succeeds, its output contains `prompt written to <path>`. Parse that file as JSON, then delete it.

Process the request, then reply via: `node ../teleport/scripts/send-telegram.mjs --reply-to <prompt.messageId> "E <response summary>"`. Capture new messageId M, append M to IDS.

**Note:** Only direct replies (to a message in your IDS) will reach your loop. Orphans are auto-reacted with 🤔 at fetch level and never cached. Stale replies (to other agents' messages) are silently ignored. No agent reasoning needed for message routing.

**After handling — restart the listener (this is a loop):**
1. If your agent uses background Monitors: TaskStop the current Monitor.
2. Go back to **step 2**: start a new listener (Monitor or foreground loop) with the updated IDS (including the messageId M you just sent).
3. The cycle repeats: Poll → reply arrives → process → respond → restart listener.

The prompt file path changes as IDS grows (it includes the filter key), so always extract the path from the notification rather than hardcoding it.

### Notes
- **Local cache prevents offset stomping**: all loops read from `updates-cache.jsonl`, only one process calls `getUpdates` at a time via file lock.
- **Sent registry** (`sent-registry.jsonl`): persistent record of all bot messages.
- **Auto-react 👍**: admin sees instant ack when message is picked up, before processing completes.
- **Orphan auto-react 🤔**: orphan messages (no reply target) are reacted with 🤔 and excluded from cache at fetch time. Agents never see them.
- **IDS grows monotonically**: every message you send gets appended. `--filter-reply-to IDS` matches replies to ANY of them — admin can reply to any message in the thread.
- **Strict isolation**: each loop only processes direct replies to its IDS. No orphan fallback, no stale reply capture. Cross-agent contamination is impossible at the script level.
- **Duplicate safety**: if a Monitor fires for a reply that was already processed (e.g. after context compaction), the prompt file will already be deleted — treat as no-op.

## Rare flags
- `--raw` — skip auto-escape (caller already escaped MarkdownV2).
- `--plain` — plain text, no markdown parsing (for noisy logs/stdout).
- `--reply-to <messageId>` — send as a Telegram reply to a specific message (used when responding to an admin reply in the loop).
- `--react <messageId>` — react with 👍 to a specific message (used for manual ack).
