# Teleport — Telegram reporting for AI agents

Centralized Telegram bot scripts shared across multiple projects on the same machine. Replaces per-project copies of `scripts/send-telegram.mjs` + `scripts/tele-listen.mjs` to avoid race conditions when several projects use the same bot.

## Why centralize

When multiple projects on the same machine share one bot token but each holds its own script + cache, concurrent monitor processes call Telegram's `getUpdates` independently and "steal" each other's replies. Centralizing one cache, one poll lock, and one global offset eliminates that race.

## Layout

```
~/Projects/teleport/
├── .env                  ← REPORT_BOT_TOKEN + TELEGRAM_ADMIN_CHAT_IDS (shared by all projects)
├── rules/
│   └── telegram-guide.md ← canonical guide every agent reads
├── scripts/
│   ├── send-telegram.mjs
│   ├── tele-listen.mjs
│   └── tmp/tele-reply/   ← shared cache + lock + offset (gitignored)
└── README.md
```

## Path convention

All paths use `../teleport/...`, relative to the *calling project root*. Convention: every project lives as a sibling of `teleport/`:

```
~/Projects/
├── teleport/
├── md/
├── tea_game/
└── <other-project>/
```

Agents always invoke with `cwd = project root` and refer to `../teleport/...`. There are no hardcoded absolute paths anywhere.

## Usage

```bash
# Send (from project root, e.g. ~/Projects/md/)
node ../teleport/scripts/send-telegram.mjs "<message>"

# Listen (from project root)
node ../teleport/scripts/tele-listen.mjs \
  --filter-reply-to <messageIDs> \
  --offset-file ../teleport/scripts/tmp/tele-reply/<offset-file>
```

`PROJECT_CODE` (the `[XXX]` prefix on every message) is auto-derived from `basename(process.cwd())`. Override with `TELE_PROJECT_CODE=...` env var if needed.

## Wiring it into a project

Add the snippet below to your project's `CLAUDE.md`, `GEMINI.md`, or `AGENTS.md` — any file the agent reads at startup. Paste it verbatim; no edits required.

````markdown
## Telegram Reporting

**WHENEVER** the user asks to "send a Telegram report" (variants: "send tele", "send via tele", "ping me when done"…), you **MUST** read `../teleport/rules/telegram-guide.md` and follow it. Identity prefix for this agent is `<emoji> *Claude on <topic>:*` (see guide for emoji and topic rules).

Scripts + guide are centralized at `../teleport/` (sibling of every project). This project keeps no local copy. Invocation:

- Send: `node ../teleport/scripts/send-telegram.mjs "<message>"` (PROJECT_CODE auto-derived from `basename(cwd)`).
- Listen: `node ../teleport/scripts/tele-listen.mjs --filter-reply-to <IDS> --offset-file ../teleport/scripts/tmp/tele-reply/<offset-file>`.
- Cache + lock + audit log live in `../teleport/scripts/tmp/tele-reply/` (shared across all projects using the same bot).

After sending, you **MUST immediately** start the reply-listener loop described in the guide's "Listening for Replies" section. Capture the `messageId` from the send output, then start the Monitor. **MUST NOT** skip this step even if the task feels complete — the user may reply via Telegram at any time.
````

(Adapt the identity prefix wording — `Claude reports`, `Codex reports`, `Gemini reports` — to whichever agent is reading the file.)

## First-time setup on a new machine

```bash
cd ~/Projects
git clone <teleport-repo-url> teleport
cd teleport
cp .env.example .env
# Edit .env: fill in REPORT_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_IDS
```

No `npm install`, no `npm link`, no symlink, no shell config required.

## Requirements

- `node` on `PATH` (the scripts use Node's built-in fetch, fs, etc. — no dependencies).
- Every project that uses Teleport must sit as a sibling of `teleport/`.
- One Telegram bot, one chat (admin), one shared `.env`.
