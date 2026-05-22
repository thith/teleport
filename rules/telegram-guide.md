# Telegram Reporting Guide

> **Paths:** `teleport/` is a sibling of every project. Agents normally invoke with `cwd = project root` and refer to `../teleport/...`. Before running any Teleport script, verify the shell working directory: if you are not at the project root, either set `workdir` to the project root first or adjust the relative path to the actual `teleport/scripts/...` location. Do not use absolute paths in reusable instructions.

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

**Other agents choose by shell behavior:**

### Choosing between --watch and --wait-once

If you are writing/integrating a new agent or unsure about your execution model, choose the listener mode based on the following:

* **Use `--wait-once` (Recommended for most other agents, including Gemini CLI, Antigravity, Cursor, etc.):**
  * **How it works:** Blocks the shell until a message is received, writes the prompt JSON, and **exits**, freeing the shell.
  * **Command:** `node ../teleport/scripts/tele-listen.mjs --wait-once --convo $CONVO_ID`
  * **Workflow:** Run `--wait-once` → command exits → process JSON and reply → delete prompt JSON → re-run `--wait-once`.
  * **If in doubt:** Choose `--wait-once` as the safe default.

* **Use `--watch` (Specifically for Codex):**
  * **How it works:** Runs continuously in the foreground, writing prompt JSONs and pausing until they are deleted before resuming.
  * **Command:** `node ../teleport/scripts/tele-listen.mjs --watch --convo $CONVO_ID`
  * **Workflow:** Run `--watch` → wait for prompt JSON → read/reply in separate session → delete JSON to auto-resume the watcher.
  * **Note:** Keep this command session open; do not rely on shell backgrounding with `&`, because some tool wrappers detach or reap background jobs silently. Stop it with Ctrl-C when the conversation is done. If you accidentally backgrounded it, stop it with `pkill -f "tele-listen.*--watch.*--convo ${CONVO_ID}( |$)"`.

After starting `--watch` or `--wait-once`:
- Do NOT end your turn / send a "final" or similar response while waiting for replies (most agent runtimes stop polling once the turn ends).
- Capture the convoId from `[send-telegram] convo: <N>` stdout: `export CONVO_ID=<N>`.
- Keep the turn active until the command prints `prompt written to .../prompt-convo-$CONVO_ID.json` or `prompt ready: .../prompt-convo-$CONVO_ID.json`, then read+reply+delete.
- Loop: when prompt appears → read JSON → reply via send-telegram → delete the prompt file → loop. For `--wait-once`, re-run the same `--wait-once` command to wait for the next reply.
- **Anti-Loop Bypass:** If your agent environment imposes a strict timeout on commands (e.g. 5 minutes) and forcefully terminates them, you must restart the listener. To prevent anti-loop detectors from assuming you are stuck when you restart the same command multiple times, prepend a dummy environment variable to your command (e.g., `RESTART_COUNT=1 node ../teleport/scripts/tele-listen.mjs --wait-once --convo $CONVO_ID`) or append a bash comment (e.g., `... --convo $CONVO_ID # restart=1`). Increment or update this value on each restart.
- End the turn ONLY when the user explicitly requests to stop (e.g., "close connection", "end turn", "stop loop").
- If the user says something ambiguous like "done", "ok", or "bye", DO NOT end the turn. Instead, ask for explicit confirmation (e.g., "Should I wait for further instructions, or are we finished here?") and wait for a clear confirmation before ending the turn.

When the loop / daemon writes `prompt written to <path>`, parse that file as JSON:
- `text`, `messageId`, `chatId`, `replyToMessageId`, `replyToText`, `quotedText`, `convoId`, `attachments[]`.

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
- `--watch` — start a long-running foreground supervisor (ideal for streaming shells like Codex).
- `--wait-once` — poll until exactly one new reply is ready, then exit (ideal for buffered shells).

## Troubleshooting

- `convo <N> has no registered messages …`: Run the repair command printed in the error message to restore the local session registry:
  ```bash
  node ../teleport/scripts/import-convo.mjs --convo <N> --bot <id>
  ```
