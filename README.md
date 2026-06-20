# Teleport — Telegram bridge for AI coding agents

A small tool that lets AI agents (Claude Code, Codex, Gemini, …) send short progress reports to your Telegram and take short instructions back, while you are away from the desk.

Short reports, short replies — not a full session mirror.

Extracted from internal tooling built for **[trumviahe.com](https://trumviahe.com)**.

## Quick start

### 1. Clone next to your projects

```bash
cd ~/Projects   # any parent folder works (e.g. ~/work, ~/code, D:\dev)
git clone https://github.com/thith/teleport.git
cd teleport
cp .env.example .env
```

`teleport/` must sit as a sibling of every project that uses it:

```
<your-parent-folder>/   # e.g. ~/Projects, ~/work, D:\dev
├── teleport/
├── ProjectA/
└── ProjectB/
```

The parent folder name doesn't matter — what matters is that `teleport/` is a **sibling** of your projects.

### 2. Get a bot token and a forum-group chat ID

teleport posts every conversation in its own **forum topic**, so the chat **must be a forum supergroup** — a private DM (personal chat ID) or a plain group will fail the forum check and sends will error.

- **Bot token:** open [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → follow prompts → copy the token.
- **Create the group + enable Topics (required):** create a Telegram group and enable Topics (*Group → Edit → Topics*) — this auto-upgrades it to a forum supergroup. teleport then auto-creates one topic **per conversation** (named after the agent's persona) on first send.
- **Add the bot as admin with "Manage Topics" (required):** add your bot (+ teammates) to the group and make the bot an **admin** with the **Manage Topics** permission on — otherwise it can't create topics and every send fails.
- **Turn Group Privacy OFF (required):** [@BotFather](https://t.me/BotFather) → `/mybots` → your bot → `Bot Settings` → `Group Privacy` → *Turn off* — so the bot receives your replies inside topics (otherwise the listener never sees them).
- **Group ID:** add [@RawDataBot](https://t.me/RawDataBot) to the group → it instantly prints the group ID (a negative number) → remove RawDataBot when done.

### 3. Fill `.env` (secrets) and `projects.json` (config)

`.env` holds **secrets only**:

```ini
REPORT_BOT_TOKEN=<bot token from BotFather>
```

Non-secret config lives in `projects.json` (copy `projects.sample.json` → `projects.json`; it's gitignored). Two reserved blocks: `_default` is the catch-all group (chatId + its member roster), `_config` is global config (daemon DM, quiet hours):

```json
{
  "_default": {
    "chatId": "<forum supergroup ID — a negative number>",
    "roles": { "<your telegram user id>": { "role": "admin", "name": "You" } }
  },
  "_config": {
    "daemonChatId": "<your private chat id — only if you run the daemon>",
    "quietHours": { "start": 22, "end": 8 }
  }
}
```

Then verify it works:

```bash
node scripts/send-telegram.mjs "hello from teleport"
```

You should see the message land in your Telegram. If not, fix `.env` before continuing.

### 4. Wire it into your AI agents (one-time, global)

Open Claude Code, Codex, or Gemini CLI **inside any project sibling of `teleport/`** (so `../teleport/` resolves correctly), then paste this prompt — the agent does the rest:

> Enable Telegram reporting **globally for all my AI agents** by following `../teleport/README.md`. Copy the canonical snippet **verbatim** (do not paraphrase or rewrite) from the "Wiring snippet" section of that README into **all three** global config files so it works whichever agent I run later — `~/.claude/CLAUDE.md` (Claude Code), `~/.gemini/GEMINI.md` (Gemini), `~/.codex/AGENTS.md` (Codex). Create any file that does not exist yet. On Windows use the equivalent under `%USERPROFILE%`. After writing, send a test "hello" from whichever agent I am running now.

This wires Telegram support into **all three** global agent config files at once, so every project — and every agent you switch to later — picks it up automatically.

You can also do this manually if you wish: copy the snippet below into each of those files yourself. For per-project setup, write it into the project's local `CLAUDE.md` / `GEMINI.md` / `AGENTS.md` instead — useful if you only want Telegram on specific projects.

##### Other agents

- **Antigravity:** uses `~/.gemini/GEMINI.md` — already covered by the step above.
- **Cursor:** no home directory file. Open Cursor → Settings → Rules → User Rules, and paste the canonical snippet (below) into the User Rules box.
- **OpenCode, or any other agent:** start the agent, then paste this short prompt — it will read this README and configure itself: *"Configure Telegram reporting for yourself by following `../teleport/README.md`. Find the 'Wiring snippet' section and copy it verbatim into your global config file (you know where it lives on this OS)."*

#### Wiring snippet (for the agent — or for manual install)

This is what the agent copies into each config file when you paste the prompt above. You normally do not need to read or touch this — it is shown here so the agent can find it, and so you can copy it yourself if you prefer to install manually.

````markdown
## Telegram Reporting

**WHENEVER** the user asks to "send a Telegram report" (or variants: "send via tele", "tele me", "ping me when done", "gửi tele", "báo cáo qua tele", "tele cho tôi khi xong"…), you **MUST** read `../teleport/rules/telegram-guide.md` and follow it. Look up your identity prefix in the guide's prefix table.

Scripts + guide are centralized at `../teleport/` (sibling of every project). Each project keeps no local copy. Do **NOT** rely on any invocation details from memory or from this config snippet; the guide is the single source of truth and may change as Teleport is updated.

After sending any Telegram message, you **MUST immediately** start the reply-listener flow described in the guide's "Listening for Replies" section. **MUST NOT** skip or defer this step even if the task feels complete — the user may reply via Telegram at any time.

## Spawn agent instances

**WHENEVER** the user asks to spawn / start / launch a Claude agent — e.g. "spawn Claude", "start an agent", "launch a Claude", "... headless" — **or any similar phrasing in any language** (Vietnamese e.g. "chạy một Claude", "khởi động một agent", "chạy Claude headless") — you **MUST** read `../teleport/rules/telegram-guide.md` section "Spawning a new agent instance" and follow it. Do **NOT** rely on invocation details from this snippet; the guide is the single source of truth.

## Handover to another topic/agent

**WHENEVER** the user asks to **hand over / hand off** the current work to another topic or agent — e.g. "handover cho Tuộc", "bàn giao cho …", "chuyển việc sang topic khác", "handover sang topic mới" — **or any similar phrasing in any language** — you **MUST** read `../teleport/rules/telegram-guide.md` section "Handover sang convo/topic khác" and follow it. Teleport performs the handover for you via `handover.mjs` — do **NOT** improvise (do **NOT** just write a file and ask the user to send it manually, and do **NOT** spawn a new agent yourself). Use `--to <persona|#hashtag|convoId>` to hand to an **existing** live topic; use `--new` **only** when a brand-new topic is explicitly wanted. The guide is the single source of truth.
````

#### Per-project setup for spawn

The spawn helper lives at `teleport/scripts/spawn.mjs`. Add these scripts to each project's `package.json` (or call the script directly):

```json
"spawn:i": "node ../teleport/scripts/spawn.mjs --interactive",
"spawn:headless": "node ../teleport/scripts/spawn.mjs",
"spawn:ls": "node ../teleport/scripts/spawn.mjs --list",
"spawn:kill": "node ../teleport/scripts/spawn.mjs --kill"
```

`spawn:i` (interactive, subscription billing) / `spawn:headless` (`claude -p`, SDK pool) launch an agent; `spawn:ls` lists running agents; `spawn:kill <id>` stops one (id = the topic hashtag). Interactive mode needs `screen` (preinstalled on macOS) or `tmux` on the host. (Command/billing specifics live in `rules/telegram-guide.md` — the single source of truth — so this README and the wiring snippet never drift.)

## Supervisor daemon (optional)

A small, **non-AI**, **manually-started** process (`scripts/daemon.mjs`) that gives you remote control even when **every agent has died** (quota / network / API) — the one case the normal "an agent runs the command" model can't recover from, because a dead agent can't receive "spawn a new one". It's best-effort: start it before you step away (or have a live agent start it); forget to, and teleport behaves exactly as before.

It listens to **one private DM** (`DAEMON_CHAT_ID`) and handles known commands — `/spawn <project>`, `/run <project> <script> [args]` (auto-detects npm/pnpm/yarn, validates the script in package.json, then runs `<pm> run <script>`; admin/maintainer only — remote exec), `/whisper topic:#<hash> <text>`, `/pending`, `/start` — plus the heartbeat auto-reminder (which now lives **only** here, moved out of the agent listeners). It never calls an LLM. It "harvests" Telegram updates into the *same* shared cache the agent listeners use (cooperative, no offset war); only its own private-DM lane is processed by the daemon.

```bash
node ../teleport/scripts/daemon.mjs            # run (keep a terminal/screen open)
node ../teleport/scripts/daemon.mjs --status   # is it running?
node ../teleport/scripts/daemon.mjs --stop      # stop it (pidfile)
# detached (survives the terminal):
screen -dmS teleport-daemon node ../teleport/scripts/daemon.mjs
```

Per-project `package.json` scripts (optional convenience):

```json
"daemon": "node ../teleport/scripts/daemon.mjs",
"daemon:bg": "screen -dmS teleport-daemon node ../teleport/scripts/daemon.mjs",
"daemon:status": "node ../teleport/scripts/daemon.mjs --status",
"daemon:stop": "node ../teleport/scripts/daemon.mjs --stop"
```

**Config:** set `_config.daemonChatId` (your private chat id) in `projects.json`. Chat-id rule (validated at startup): every project / `_default.chatId` chat must be a **group** (negative id); `daemonChatId` must be a **private** chat (positive id). `/spawn <project>` resolves `<workspace-parent>/<project>` as the new agent's cwd (which is how it joins that project's group). **Whisper** injects a discreet steer into a topic with `whisper:true` — invisible in the group; the receiving agent acts on it without announcing it (see `rules/telegram-guide.md`).

## How to use

Say *"tele me"* (or similar) **before** you leave the desk. Examples:

- *"Ping me on Telegram when done."*
- *"Report via Telegram and wait for instructions."*
- *"Schedule a wakeup in 30 minutes; tele me when you wake up."*
- *"Send a tele report after each PR you open."*

The agent sends a short report, listens for your reply, and continues while you're away. *If the bot reacts 💔 on your message, it means it was ignored — you sent a plain message instead of using Telegram's Reply feature.*

## Before you go away from the desk

Teleport does not bridge permission dialogs. If the agent stops to ask "may I run this?", nobody on Telegram can answer and the agent stalls. Put the agent in a mode that runs without confirmation:

- **Claude Code 4.7+:** Auto Mode (not `auto-accept` — they are different modes).
- **Codex:** Auto-Review.
- **Gemini CLI:** YOLO (`-y`).
- **Antigravity:** Settings → **Auto Execution** (or *Terminal Command Auto Execution*) → choose **Always Proceed**. Also enable **Agent Non-Workspace File Access** — Teleport scripts live in `../teleport/`, outside the current workspace. If commands still get blocked, install the [YoloMode extension](https://marketplace.visualstudio.com/items?itemName=mrkeles61.yolomode).
- **Cursor:** Settings → Features → Agent → enable **YOLO mode** (auto-runs terminal commands without confirmation).
- **Other agents (OpenCode, etc.):** any mode equivalent to "run without confirmation".

For older Claude Code / Codex versions: use `--dangerously-skip-permissions` or Full Access mode.

Also: keep your host machine awake. The agent and the reply listener live on the same machine — if the OS sleeps, both die.

- **macOS:** `caffeinate -i` in a terminal for the session.
- **Linux desktop:** `systemd-inhibit --what=sleep -- sleep infinity`.
- **Windows:** set the active power plan's sleep timer to *Never*.

Teleport can also run on a VPS / cloud VM (no host-awake needed there).

## Why not /remote-control or other Telegram mirrors?

Those tools mirror your full local session to your phone — every thinking token, tool call, and partial diff. On a small screen you end up scrolling and micro-managing every line, which defeats the point of being away from the desk.

Teleport does the opposite: full conversation stays on your laptop; only short reports go to your phone, only short replies come back. Like a human assistant in the next room. If you don't trust the agent to run unattended, use `/remote-control` instead — Teleport is the wrong tool for that.

## Notes

- **Zero deps:** pure Node built-ins.
- **Requirements:** `node` on `PATH`; every project sits as a sibling of `teleport/`; one bot, one chat, one shared `.env`.
- **Don't rely on it for critical work.** Agents sometimes forget to send follow-up messages.
