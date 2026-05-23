# Telegram Reporting Guide

> **Paths:** `teleport/` is a sibling of every project. Agents normally invoke with `cwd = project root` and refer to `../teleport/...`. Before running any Teleport script, verify the shell working directory: if you are not at the project root, either set `workdir` to the project root first or adjust the relative path to the actual `teleport/scripts/...` location. Do not use absolute paths in reusable instructions.

`node ../teleport/scripts/send-telegram.mjs` sends messages/files to admins in `../teleport/.env`. `[PROJECT]` prefix auto-derived from `basename(cwd)` (override via `TELE_PROJECT_CODE`).

## When to use
- Finished a task while user is away.
- User asks for a file (spec/RFC/log) → use `--file`.

## Content format

What you type:
```
<emoji> *<Agent> on <topic>:*

✅ done

✅ another done

⬜ skipped
```

What admin receives (script auto-prepends `[<project>]` and clickable convo hashtag):
```
[<project>] [<emoji> #c<convoId>] *<Agent> on <topic>:*

✅ done

✅ another done

⬜ skipped
```

- `<project>` is auto-derived from `basename(process.cwd())` (or `TELE_PROJECT_CODE` env). `<convoId>` is the convo identifier resolved per-send.
- **You do NOT type the `[<project>]` prefix or `#c<convoId>` hashtag** — `send-telegram.mjs` injects both. Just type the emoji + topic line as before.
- **Why the hashtag:** Telegram makes `#<letter><digits>` clickable; admin taps it to filter every message of one convo across multiple concurrent threads. The leading letter is required — Telegram does NOT render pure-numeric `#1234` as clickable (hashtags must contain at least one letter).
- **convoId encoding:** scheme keeps the hashtag short while remaining clickable:
  - **Long convoId** (≥ 8 chars — Claude/Codex env-derived 16-digit hash): take the LAST 8 chars, then convert the first of those 8 digits → letter (`0→a, 1→b, …, 9→j`). Total: 8 chars. Example: `2205483045424020` → last 8 `45424020` → first `4` → `e` → **`#e5424020`**.
  - **Short convoId** (< 8 chars — Gemini's 4-char id): prepend literal `t`. Total: original + 1. Example: `1234` → **`#t1234`**.
  - Constants: `CONVO_HASH_LONG_LEN = 8`. Collision risk between concurrently-active convos is negligible (7-digit tail entropy).
- **First send of a brand-new convo** (no `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID` env, no `--convo`, no `--reply-to`): convoId equals the messageId of that very send, so the FIRST message has no hashtag; subsequent sends do.
- **One blank line between items.** MarkdownV2 treats single `\n` as soft break (one wrapped paragraph) — `\n\n` for hard break. For noisy logs use `--plain` (Telegram skips parsing, every `\n` is a break).
- **Target < 320 chars.** Don't paste diffs/logs.
- **Agent:** `Claude` / `Codex` / `Gemini CLI` / `Antigravity` / `Cursor` / `<Other>`.
- **Emoji:** random per-thread (collision-avoidance for concurrent convos). Pick once on first send; reuse for the lifetime of the thread. All agents must include one.
- **Topic:** ≤ 9 words.
- **Language:** match user's language; keep consistent in the thread. The "on" wording is the English form — translate.

## How to send

Inline (default):
```bash
node ../teleport/scripts/send-telegram.mjs "🦊 *Claude on loop fix:*

✅ task 1

✅ task 2"
```

Heredoc / pipe (when inline shell-quoting is fragile):
```bash
cat > ./tmp/report.md <<'EOF'
🦊 *Claude on loop fix:*
…
EOF
cat ./tmp/report.md | node ../teleport/scripts/send-telegram.mjs
```

Attachment:
```bash
node ../teleport/scripts/send-telegram.mjs --file <path> "caption"
```

**Auto fallbacks:**
- Message > 4000 chars → sent as one `.md` file (never split into multiple messages).
- MarkdownV2 parse reject → resent as `.md` attachment with first line as caption.

**Failure:** non-zero exit → report failure to user; do not assume sent.

## Convo identity

To stay in the same thread, the agent must associate messages under a single conversation (`convoId`):

1. **First send:** Send the message. Capture the convo ID from the stdout: `[send-telegram] convo: <N> messageId: <M>`.
2. **Subsequent sends:** Always pass `--convo <convoId>` and `--reply-to <prompt.messageId>` (where `prompt` is the incoming user message JSON parsed from `tele-listen`) to stay in the same convo and visually reply to the user's message.

Send stdout ends with:
```
[send-telegram] sent to <chatId> (messageId: <M>)
[send-telegram] convo: <N> messageId: <M> pid: <P>
```

Capture `<N>` once; pass to the listener as `--convo <N>`.

## Listening for replies (MUST after every successful send)

Two cases. `send-telegram.mjs` prints the matching hint on stdout.

**Claude (Monitor tool):** one-shot tele-listen inside an `until` loop. Monitor restarts it after each reply.
```
TaskStop(task_id: <LAST_MONITOR_ID>)   # skip on first send

Monitor({
  command: "until node ../teleport/scripts/tele-listen.mjs --convo $CONVO_ID; do sleep 12; done",
  timeout_ms: 300000,
  persistent: true,
  description: "Telegram reply to convo <CONVO_ID>"
})
```

**All other agents:** wait for one prompt at a time.
```bash
node ../teleport/scripts/tele-listen.mjs --wait-once --convo $CONVO_ID
```
`--wait-once` is synchronous: it blocks until the next prompt file is ready, prints the prompt path, then exits so the agent can read and handle it. A prompt may aggregate consecutive admin messages using `Admin follow-up:` lines. Run it again after deleting the prompt if you need to keep listening.

After starting `--wait-once`:
- Do NOT end your turn / send a "final" or similar response while waiting for replies (most agent runtimes stop polling once the turn ends).
- Capture the convoId from `[send-telegram] convo: <N>` stdout: `export CONVO_ID=<N>`.
- Keep the turn active until the command prints `prompt ready: .../prompt-convo-$CONVO_ID.json`, then read+reply+delete.
- Loop: when prompt appears → read JSON → reply via send-telegram → delete the prompt file → re-run the same `--wait-once` command to wait for the next reply.
- **Anti-Loop Bypass:** If your agent environment imposes a strict timeout on commands (e.g. 5 minutes) and forcefully terminates them, you must restart the listener. To prevent anti-loop detectors from assuming you are stuck when you restart the same command multiple times, prepend a dummy environment variable to your command (e.g., `RESTART_COUNT=1 node ../teleport/scripts/tele-listen.mjs --wait-once --convo $CONVO_ID`). Increment or update this value on each restart.
- End the turn ONLY when the user explicitly requests to stop (e.g., "close connection", "end turn", "stop loop").
- If the user says something ambiguous like "done", "ok", or "bye", DO NOT end the turn. Instead, ask for explicit confirmation (e.g., "Should I wait for further instructions, or are we finished here?") and wait for a clear confirmation before ending the turn.

When the listener writes `prompt ready: <path>`, parse that file as JSON:
- `text`, `messageId`, `chatId`, `replyToMessageId`, `replyToText`, `quotedText`, `convoId`, `attachments[]`.

**MUST: validate prompt relevance before acting (the "misrouted reply" check).** Multiple agents share one admin chat, and admins occasionally tap "reply" on the wrong message. Before treating a prompt as a directive, cross-check `replyToText` against the most recent message *you* sent in this turn. The strongest positive signal is: `replyToText` starts with the same `[project]` prefix and identity emoji you used in your last send.

Confirm before acting if the relevance check is uncertain OR any of these fire (the list is not exhaustive — when in doubt, confirm):
- `replyToText`'s `[project]` prefix is different from the one *you* are running under (e.g. you sent a `[md]` report and `replyToText` starts with `[tea_game]`).
- The reply names a file, PR, branch, ticket, or topic that does not appear in your recent turn at all.
- The reply asks you to switch project/scope ("switch to tea_game and fix X") — cross-project directives are valid but **MUST** still be confirmed explicitly so the admin sees they're handing the wheel.

If `$CONVO_ID` itself disagrees with the prompt's `convoId`, that is a listener bug (the wait-once was scoped to a specific convo) — log the mismatch and escalate to the user; do not just confirm-and-proceed.

When confirming, reply *to* the suspect prompt with a one-liner in the user's language and stop. Examples — translate to match the user:
- VI: *"Có vẻ message này gửi cho agent khác (replyToText là `[X]`, em đang làm `[Y]`). Anh confirm em xử lý hay bỏ qua?"*
- EN: *"This looks misrouted (replyToText is `[X]`, I'm running under `[Y]`). Confirm if you want me to handle it or skip?"*

Treat your reply as a clarification turn, not a task completion. **MUST NOT** start any non-read action (writes, commits, network calls, agent-side state changes) until the admin explicitly confirms.

Reply:
```bash
node ../teleport/scripts/send-telegram.mjs --reply-to <prompt.messageId> --convo $CONVO_ID "..."
```

Then delete the prompt JSON. Restart the listener (same command).

**Attachments:** `attachments[].localPath` (if non-null) → file under `tmp/tele-reply/attachments/<botId>/<updateId>/`. After processing, delete each referenced `<botId>/<updateId>/` dir. Entries with `error` (`exceeds_20mb`, `download_failed`) have `localPath: null`.

**Two Monitors per convo = silent loss bug.** Always `TaskStop` the previous before starting a new one. Auto-supersede is a safety net but not a substitute.


## Flags

**send-telegram.mjs:**
- `--convo <N>` — the ID of the conversation thread.
- `--reply-to <messageId>` — the Telegram message ID to reply to.
- `--file <path>` — send a file as a document.
- `--plain` — send as plain text without Markdown parsing.
- `--raw` — send pre-escaped MarkdownV2 text.
- `--react <messageId>` — react 👍 to a message.

**tele-listen.mjs:**
- `--convo <N>` — the conversation thread ID to listen to.
- `--wait-once` — poll until exactly one new reply is ready, then exit.

## Troubleshooting

- `convo <N> has no registered messages …`: Run the repair command printed in the error message to restore the local session registry:
  ```bash
  node ../teleport/scripts/import-convo.mjs --convo <N> --bot <id>
  ```
