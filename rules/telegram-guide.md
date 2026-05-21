# Telegram Reporting Guide

> **Paths:** `teleport/` is a sibling of every project. Agents invoke with `cwd = project root` and refer to `../teleport/...`. No absolute paths.

`node ../teleport/scripts/send-telegram.mjs` sends messages/files to admins in `../teleport/.env`. `[PROJECT]` prefix auto-derived from `basename(cwd)` (override via `TELE_PROJECT_CODE`).

## When to use
- Finished a task while user is away.
- User asks for a file (spec/RFC/log) → use `--file`.

## Content format

```
[Project] <emoji> *<Agent> on <topic>:*

✅ done

✅ another done

⬜ skipped
```

- **One blank line between items.** MarkdownV2 treats single `\n` as soft break (one wrapped paragraph) — `\n\n` for hard break. For noisy logs use `--plain` (Telegram skips parsing, every `\n` is a break).
- **Target < 320 chars.** Don't paste diffs/logs.
- **Agent:** `Claude` / `Codex` / `Gemini` / `<Other>`.
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

`send-telegram.mjs` picks `convoId` per send (first non-null wins):

1. `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID` env → UUID hashed to int. Wins for the agent's whole session.
2. `--convo <N>` flag — effective only when no native env (Gemini / other agents).
3. `--reply-to <Y>` — if Y is a registered messageId for this `(botId, chatId)`, join that convo.
4. Else allocate new convo: `convoId = messageId of this send`.

**Claude / Codex:** nothing to do; native env wins for the session. `--convo` passed on the command line is silently ignored (env is more reliable).

**Gemini / Antigravity / plain shell:** always `--reply-to <admin-or-own-prev-messageId>` to stay in the same convo. Forgetting `--reply-to` opens a new convo.

Send stdout ends with:
```
[send-telegram] sent to <chatId> (messageId: <M>)
[send-telegram] convo: <N> messageId: <M> pid: <P>
```

Capture `<N>` once; pass to the listener as `--convo <N>`.

## Listening for replies (MUST after every successful send)

**Claude (Monitor tool):**
```
TaskStop(task_id: <LAST_MONITOR_ID>)   # skip on first send

Monitor({
  command: "until node ../teleport/scripts/tele-listen.mjs --convo $CONVO_ID; do sleep 12; done",
  timeout_ms: 300000,
  persistent: true,
  description: "Telegram reply to convo <CONVO_ID>"
})
```

**Codex / Gemini / others (foreground loop):**
```bash
until node ../teleport/scripts/tele-listen.mjs --convo $CONVO_ID; do sleep 5; done
```

When the loop exits with `prompt written to <path>`, parse that file as JSON:
- `text`, `messageId`, `chatId`, `replyToMessageId`, `replyToText`, `quotedText`, `convoId`, `attachments[]`.

Reply:
```bash
node ../teleport/scripts/send-telegram.mjs --reply-to <prompt.messageId> --convo $CONVO_ID "..."
```

Then delete the prompt JSON. Restart the listener (same command).

**Attachments:** `attachments[].localPath` (if non-null) → file under `tmp/tele-reply/attachments/<botId>/<updateId>/`. After processing, delete each referenced `<botId>/<updateId>/` dir. Entries with `error` (`exceeds_20mb`, `download_failed`) have `localPath: null`.

**Two Monitors per convo = silent loss bug.** Always `TaskStop` the previous before starting a new one. Auto-supersede is a safety net but not a substitute.

## Crash recovery

`tele-listen` prints `convo <N> has no registered messages … Run: node …/import-convo.mjs --convo <N> --bot <id>` when `send-telegram` crashed mid-write. Run `import-convo.mjs` to repair from `sent-registry.jsonl`; offset is not advanced on this path, so replies are not lost.

## Flags

**send-telegram.mjs:**
- `--reply-to <messageId>` — Telegram reply to a specific message.
- `--convo <N>` — explicit convoId (overrides --reply-to inference; env still wins).
- `--file <path>` — send as document.
- `--plain` — plain text, no markdown.
- `--raw` — caller already escaped MarkdownV2.
- `--react <messageId>` — react 👍 to a message.

**tele-listen.mjs:**
- `--convo <N>` — explicit convoId.
- `--filter-reply-to <IDS>` — legacy IDS-list mode. Errors if a native session env is set; pair with `--legacy-filter` to override.
- `--legacy-filter` — opt-out of the legacy/env conflict check; requires `--filter-reply-to`.
- `--offset-file <path>` — explicit offset file (auto-synthesised for convo mode).

## Troubleshooting

- `--filter-reply-to is incompatible with <env> env` → unset env OR drop `--filter-reply-to` OR pass `--legacy-filter`.
- `convo <N> has no registered messages …` → send-telegram crashed before convo-registry append. Run `node import-convo.mjs --convo <N> --bot <id>` to repair from sent-registry.
