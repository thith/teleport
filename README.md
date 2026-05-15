# Teleport — Telegram reporting for AI agents

## What

A tiny Telegram bridge so AI coding agents (Claude Code, Codex, Gemini, …) can **send you short progress reports and take short instructions back over Telegram while you're away from the desk**.

Extracted from the internal tooling I built for **[trumviahe.com](https://trumviahe.com)**, where several agents run in parallel and the only way to stay sane on mobile was *report + reply*, not full chat mirroring.

## Why

Think of it as a human assistant working in the next room. You drink your tea, glance at the report when it lands, give a one-line nudge if something's off, go back to your tea. You're not watching them type — you're checking outcomes.

Existing alternatives (Claude Code's `/remote-control`, Codex's equivalent, several third-party Telegram-mirror products) do the opposite: they reflect the **entire local session** to your phone. That works for short stretches, but the moment you actually leave the desk you end up scrolling thinking tokens, tool calls, and partial diffs on a 6-inch screen and micro-managing line by line — which defeats the point of going AFK.

Teleport keeps the full conversation on your laptop where it belongs and forwards only what matters: **short report in, short instruction out**.

If you're not comfortable letting the agent run unattended on a given project, teleport is the wrong tool — use `/remote-control` and mirroring instead.

## How to set up

### Step 1 — Clone into the same parent folder as your projects

Teleport assumes it sits as a sibling of every project that uses it. If your projects live in `~/Projects/`, clone there:

```bash
cd ~/Projects
git clone <teleport-repo-url> teleport
cd teleport
cp .env.example .env
# fill in REPORT_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID
```

Final layout:

```
~/Projects/
├── teleport/
├── ProjectA/
└── ProjectB/
```

No `npm install`, no symlinks, no shell config — the scripts use Node's built-ins.

### Step 2 — Wire it into a project (pick one)

**Option A — let the agent do it (recommended).** Open the project, then paste this into the agent's prompt:

> Enable Telegram reporting for this project by following `../teleport/README.md` — add the wiring snippet from the README into my agent context file (CLAUDE.md / GEMINI.md / AGENTS.md), then test it once by sending a "hello" message.

The agent will read this README, paste the snippet below into the right file, and confirm with a test send.

**Option B — paste it manually** into your project's `CLAUDE.md`, `GEMINI.md`, or `AGENTS.md`:

````markdown
## Telegram Reporting

**WHENEVER** the user asks to "send a Telegram report" (variants: "send via tele", "tele me", "ping me when done"…), you **MUST** read `../teleport/rules/telegram-guide.md` and follow it. Look up your identity prefix in the guide's prefix table.

Scripts + guide are centralized at `../teleport/` (sibling of every project). This project keeps no local copy.

- Send: `node ../teleport/scripts/send-telegram.mjs "<message>"`
- Listen: `node ../teleport/scripts/tele-listen.mjs --filter-reply-to <IDS> --offset-file ../teleport/scripts/tmp/tele-reply/<offset-file>`

After sending, you **MUST immediately** start the reply-listener loop described in the guide's "Listening for Replies" section. **MUST NOT** skip — the user may reply at any time.
````

## How to use

### Step 1 — Put the agent in non-attended mode

Teleport does **not** bridge permission confirmations. If the agent stops to ask "may I run this?", nobody on the Telegram side can answer, and the agent stalls. So before going AFK, flip the agent into a mode where it acts without prompting:

- **Claude Code (4.7+):** **Auto Mode** — a classifier lets safe actions through and blocks risky ones (different behavior from the older "auto-accept edits" mode, even though both live on the same `shift+tab` cycle). Cycle to it with `shift+tab`, configure via `/config` → `autoMode`. Max / Team / Enterprise / API plans. [Docs](https://code.claude.com/docs/en/auto-mode-config.md).
- **Codex:** **Auto-Review** — a secondary reviewer agent auto-approves low-risk actions in the sandbox. [Docs](https://developers.openai.com/codex/concepts/sandboxing/auto-review).
- **Gemini:** **YOLO** (`-y` / accept-all).

> **On older versions** that don't have Auto / Auto-Review: use Claude Code's "dangerously skip permissions" mode (`--dangerously-skip-permissions`) or Codex's "Full Access" mode. Same idea — let the agent run without confirmation dialogs.

**Also: if you're running the agent on a personal computer, keep the host machine awake.** The agent and the reply listener live on the same machine you started them from — if the OS sleeps, both die. Display sleep is fine; system sleep is the killer. (Skip this section if your host is a cloud VM, home server, or anything else that doesn't sleep on idle — those are always-on by default and need no action.)

Quick fixes for a laptop / desktop:

- macOS: `caffeinate -i` in a terminal for the duration of the session, or System Settings → Battery → *Prevent automatic sleeping when display is off* while plugged in.
- Linux desktop: `systemd-inhibit --what=sleep -- sleep infinity` in a spare terminal, or set "Suspend when inactive" to *Never* in your power settings.
- Windows: change the active power plan's sleep timer to *Never* while plugged in.

### Step 2 — Tell the agent what you want, in natural language

Mention "Telegram" or "tele" so the agent knows to use the bridge. Examples:

- *"Ping me on Telegram when done."*
- *"Report to me via Telegram and wait for instructions."*
- *"Schedule a wakeup in 30 minutes; when you wake up, tele me."*
- *"Send me a tele report after each PR you open."*

The agent reads `telegram-guide.md` (already wired in Step 2 of setup) and handles the rest — short report, listener loop for your reply, the lot.

## Notes

- **Reactions on your replies:** 👍 means a listener picked it up. 💔 means you sent a plain message (not a reply to a bot message) — agents only see direct replies.
- **Multiple recipients:** `TELEGRAM_ADMIN_CHAT_ID` is one chat ID. For a team, make a Telegram group, add the bot + people, use the group's chat ID.
- **Requirements:** `node` on `PATH`; every consumer project sits as a sibling of `teleport/`; one bot, one chat, one shared `.env`.
