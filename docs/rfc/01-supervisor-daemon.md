# RFC 01: Supervisor Daemon — registry-driven control plane

> **Status:** In Review (retroactive — code đã ship + review, RFC viết sau theo yêu cầu maintainer để chốt design as-built và soi lại lỗ hổng)
> **Author:** Claude (🐮 Bò) + Thi
> **Created:** 2026-06-20
> **Last Updated:** 2026-06-20

> Ghi chú quy trình: đúng ra RFC phải đi TRƯỚC code. RFC này viết sau khi daemon đã implement (commit `2a86e24` → `384db02`) vì lúc làm chưa theo RFC-first. Mục tiêu: (1) ghi lại design thật để review gate soi được, (2) các RFC daemon về sau (Phase 2…) đi trước code như chuẩn.

## 1. Context & Motivation

Mô hình điều khiển hiện tại của teleport là **"một agent đang sống chạy lệnh hộ"**: muốn spawn agent mới, kill, xem pending… thì nhắn vào topic và agent đó thực thi. Mô hình này sập ở đúng một tình huống không thể tự thoát: **mọi agent đã chết** (hết quota, rớt mạng, API lỗi). Một agent chết không nhận được lệnh "spawn một agent mới" — nên khi ở xa, không còn cách nào khởi động lại cả hệ.

Hai nhu cầu phụ cũng cần một chỗ "luôn-sẵn-sàng, không-phải-AI" để bám vào:
- **Whisper** — nhắc kín một agent qua DM riêng mà không lộ trong group (cần một process ghi prompt vào hàng đợi của agent đích).
- **Heartbeat reminder** — quét convo đang chờ admin reply; trước đây nằm trong `tele-listen` của agent, nên agent chết là mất luôn reminder.

Điểm khó cốt lõi: Telegram `getUpdates` có **một offset toàn cục cho mỗi bot**. Thêm một process poll song song với `tele-listen` của agent = tranh offset = mất update — đúng bài toán mà teleport đã giải bằng updates-cache + offset-isolation. Bất kỳ "control plane" nào cũng phải tôn trọng giao thức đó.

Tham chiếu: `rules/telegram-guide.md` (§ Supervisor daemon, § Whisper), `scripts/tele-listen.mjs` (updates-cache + poll-lock), `scripts/handover.mjs` (resolve `#hash → convoId`).

## 2. Goals

- **G1 — Remote recovery khi mọi agent đã chết.** Từ Telegram bật được agent mới mà không cần một agent sống nào. Đo: gửi `/spawn <project>` trong lúc không agent nào chạy → có agent mới greet trong topic.
- **G2 — Không-phải-AI, đủ bền để "bật trước khi đi".** Daemon là plain Node, không gọi LLM → không chết vì quota. Đo: chạy nhiều giờ không phụ thuộc bất kỳ LLM/credit nào.
- **G3 — Giữ zero-infra.** Daemon **tùy chọn**, bật tay; quên bật thì teleport hành xử y như cũ (fallback sạch, không sửa default path). Đo: không có launchd/systemd bắt buộc; tắt daemon → agent vẫn poll group như trước.
- **G4 — Hợp tác offset, không tranh.** Daemon và agent listener cùng "gặt lúa" vào một cache chung dưới cùng một lock → **không mất Telegram update do tranh poller**, không tin lặp. (Lưu ý: đây là bảo đảm ở tầng *offset Telegram*; độ bền *thực thi lệnh* là best-effort — crash giữa lệnh có thể rớt lệnh, xem §8.)
- **G5 — Thêm lệnh không cần sửa code daemon.** Lệnh khai báo bằng dữ liệu (registry), không hardcode trong daemon. Đo: thêm một lệnh = một entry JSON + một script, daemon không đổi.

## 3. Non-goals

- **NG1 — Không launchd/systemd.** Always-on thật là tùy chọn của người dùng (tự bọc), không thuộc teleport.
- **NG2 — Không tự-restart agent chết (Phase 1).** Chỉ báo cáo (`/pending`, heartbeat). Auto-restart dễ tạo vòng lặp đốt quota → để Phase 2 cân nhắc.
- **NG3 — Không gọi LLM.** Daemon chỉ chạy lệnh tất định; mọi việc cần "suy nghĩ" vẫn là của agent.
- **NG4 — Không ôm outbound/state ownership.** Daemon không trở thành router trung tâm cho mọi tin gửi đi (để Phase 2).

## 4. Alternatives Considered

### 4.1 Alternative A: Không daemon — giữ "agent chạy lệnh hộ" (status quo)
- Mọi điều khiển qua một agent đang sống.
- Pros: zero process thêm; không có bề mặt tấn công mới.
- Cons: **không giải được G1** — mọi agent chết thì bất lực. Whisper/heartbeat không có chỗ bám khi không agent nào sống.
- Vì sao không chọn: bỏ lửng đúng case quan trọng nhất (remote recovery).

### 4.2 Alternative B: Service always-on (launchd/systemd)
- Cài daemon thành dịch vụ hệ thống, tự chạy lúc boot.
- Pros: thật sự always-on; tự restart.
- Cons: phá **G3 zero-infra**; setup khác nhau theo OS; nặng nề cho một công cụ "siblings + scripts".
- Vì sao không chọn: trái triết lý teleport. Vẫn để ngỏ cho ai muốn (tự bọc `screen`/launchd quanh `daemon.mjs`).

### 4.3 Alternative C: Daemon với handler hardcode từng lệnh
- `cmdSpawn`/`cmdWhisper`/`cmdRun`… viết thẳng trong `daemon.mjs` (đây là hình hài Phase-1 ĐẦU TIÊN, commit `2a86e24`).
- Pros: đơn giản lúc đầu; ít gián tiếp.
- Cons: mỗi lệnh mới = sửa code daemon + thêm test daemon; daemon phình; logic lệnh và logic vận chuyển trộn vào nhau. Trái **G5**.
- Vì sao không chọn: không mở rộng được sạch; CLI của các script (`spawn.mjs`) đã tự đủ tính năng, daemon chỉ nên *gọi* chúng.

### 4.4 Alternative D: Tái dùng `package.json` scripts của project làm registry lệnh
- Lệnh `/xxx` map vào `npm run xxx` của project.
- Pros: không cần file registry riêng.
- Cons: **teleport phải self-sufficient** — danh sách lệnh BUILT-IN (spawn/kill/ls…) không được phụ thuộc `package.json` của luni hay bất kỳ project nào. `/run` thì hợp lý chạy script của project, nhưng built-in thì không.
- Vì sao không chọn: lẫn lộn "lệnh built-in của teleport" với "script của project". Tách: built-in ở `commands.json` (teleport sở hữu), `/run` mới đụng `package.json` của project.

## 5. Proposed Design

### 5.1 Components
- **`scripts/daemon.mjs`** — vòng lặp + dispatcher mỏng. Không chứa logic lệnh cụ thể.
- **`commands.json`** (root teleport) — registry built-in, **committed**, self-sufficient.
- **`scripts/commands.mjs`** — loader/validator: `loadCommands` (merge `commands.json` + `projects.json._commands`), `resolveCommand` (validate + normalise), `roleMeets`, `tokenizeArgs`.
- **Script lệnh** (mỗi lệnh một file, có CLI riêng): `spawn.mjs` (sẵn có), `run.mjs`, `whisper.mjs`, `pending.mjs`, `start.mjs`.
- **`scripts/projects-config.mjs`** — `_config` (daemonChatId, quietHours), `_default` (catch-all chatId + roles), `resolveSenderRole`, chat-id kind validation.

Boundary then chốt: **daemon = vận chuyển (parse → gate → exec → relay); script = nghiệp vụ.** Daemon không biết lệnh "spawn" làm gì, chỉ biết chạy `node scripts/<run>`.

### 5.2 Data Flow

```
Telegram DM (DAEMON_CHAT_ID)
  → [co-op harvest] getUpdates → shared updates-cache (poll-lock chung)
  → daemon đọc lane riêng: update có chat.id == daemonChatId
  → parseDaemonCommand("/cmd rest")
  → resolveCommand(cmd, registry)         # null → im lặng (DM có thể có chat thường)
  → gate: roleMeets(resolveSenderRole(cfg, from.id), spec.minRole)
  → tokenizeArgs(rest)                     # quote-aware
  → needsProject? token[0] = folder → resolveSpawnCwd(folder) = cwd ; else cwd = workspace root
  → execFile(process.execPath, [scripts/<run>, ...spec.args, ...rest],
             { cwd, env: {…strip secrets…, TELE_FROM_ID/ROLE/NAME/USERNAME}, timeout, maxBuffer })   # KHÔNG shell
  → relay stdout về DM (sendTextToAdmin → tự fallback .md khi dài)
```

- **Dispatch là fire-and-forget:** không `await` lệnh con trong vòng lặp (một build/kill có thể vài giây→vài phút, await sẽ làm đơ poll + heartbeat). Đính `.catch` để lỗi vẫn được báo.
- **Folder syntax:** POSITIONAL — token đầu là folder khi `needsProject`; phần còn lại là args của script.
- **Identity:** truyền qua env `TELE_FROM_*` để script (vd whisper) áp đúng role thật của người gửi vào gate của agent đích.
- **Persistence:** không có state mới của riêng daemon ngoài `daemon.pid` (single-instance) và `daemon-offset.<bot>.txt` (lane offset, khởi tạo ở frontier hiện tại để không replay lệnh cũ). Dùng chung updates-cache với agent.

### 5.3 Registry format
`commands.json` (built-in) merge với `projects.json._commands` (custom per-deployment, custom thắng). Mỗi entry:
```json
{ "run": "<script>.mjs", "args": [], "needsProject": false, "minRole": "member", "desc": "…" }
```
`resolveCommand` validate `run` khớp `^[A-Za-z0-9._-]+\.mjs$` và không chứa `..` (chống `_commands` trỏ script tùy ý), normalise default (`args=[]`, `needsProject=false`, `minRole='public'`).

Built-in Phase 1: `spawn` `headless` `kill` `ls` `run` `whisper` `pending` `start`.

**Trust boundary:** `commands.json` + `projects.json._commands` là **config của operator** (maintainer sở hữu, `projects.json` gitignored per-deployment) — **không** phải bề mặt mở rộng cho repo của project hay người ngoài. `_commands` có thể override built-in, đặt `minRole: public`, trỏ tới bất kỳ `scripts/*.mjs` — chấp nhận được *vì* chỉ operator sửa được file đó. Nếu sau này cho project tự đăng ký lệnh thì phải coi là **untrusted** và siết thêm (validate, sandbox, cấm override built-in).

### 5.4 Domain split & cooperative harvest (điểm thiết kế then chốt)
- **Quy ước chat-id:** group/supergroup = id **âm**; private DM = id **dương**. Validate lúc khởi động: mọi project/`_default.chatId` phải là group; `daemonChatId` phải là private. Sai → thoát + báo.
- **Hợp tác xã ("cùng gặt lúa"):** daemon poll vào **đúng** updates-cache chung dưới **đúng** poll-lock mà `tele-listen` dùng. Ai thức thì gặt vào kho chung; mỗi bên đọc lane của mình (agent theo `message_thread_id`; daemon theo `daemonChatId`). Không tranh offset toàn cục.

### 5.5 Security (REMOTE CODE EXECUTION)
Gate gồm nhiều lớp:
1. **Kênh:** chỉ xử lý update có `chat.id == daemonChatId` (một DM riêng, một người).
2. **Role:** `roleMeets(resolveSenderRole(cfg, from.id), spec.minRole)`. `resolveSenderRole` chỉ tin `_default.roles` (catch-all) + roles của project **dedicated** (có chatId); roles của shared project là dead-config, không nâng quyền. `/run`,`/spawn`,`/kill`,`/headless` = maintainer; `/whisper` = admin.
3. **Containment:** `resolveSpawnCwd` cho folder token: charset `^[A-Za-z0-9._-]+$` (chống path-separator/ký tự lạ); `.` và `..` **lọt charset** (dấu chấm hợp lệ) nên bị chặn riêng bằng so sánh chuỗi tường minh (`project === '.' || '..'`) — trong đó `.` là chốt quan trọng nhất vì nếu lọt sẽ trỏ vào chính workspace root; và **realpath containment** (symlink trỏ ra ngoài workspace bị từ chối).
4. **No shell (ở tầng teleport):** daemon dùng `execFile("node", argv)` — không có shell nội suy argv. `/run` build argv `<pm> run <script> -- <args>`: dấu `--` chặn `--prefix`/`--cwd`/`--dir` đẩy PM ra khỏi cwd; tên script không được bắt đầu `-`; phải là OWN property của `scripts`. *Lưu ý:* bản thân `npm/pnpm run` vẫn chạy nội dung script trong `package.json` **qua shell của nó** — đó là semantics cố hữu của PM, nằm ngoài tầm teleport; "no shell" ở đây nói về cách teleport *gọi* PM, không phải cách PM chạy script.
5. **Secret boundary (strip secrets của teleport khỏi child):** mỗi key teleport nạp từ **file `.env`** (theo contract "`.env` = secrets only") **bị strip khỏi env tiến trình con** trước khi exec — đặc biệt cho `/run`, vốn chạy npm script của project sibling; một `package.json` độc sẽ KHÔNG đọc được `REPORT_BOT_TOKEN`/keys. **Phạm vi bảo đảm:** chỉ các secret nằm trong teleport `.env` (đúng nơi teleport quy ước cất secret). Secret mà *operator tự export ra shell cha* (không qua `.env`) nằm ngoài phạm vi — không nên export secret kiểu đó khi chạy daemon (P2 có thể siết bằng allowlist env nếu cần). **Contract về credential:**
   - *teleport Node script* cần secret thì đọc lại từ **file** `.env` (như `send-telegram`), nên strip không bao giờ làm đói chúng.
   - *grandchild* như `claude` (do `spawn.mjs` bật) KHÔNG đọc teleport `.env`: agent dùng credential riêng của nó (subscription / `~/.claude`), và Telegram token thì script con của agent đọc-từ-file lúc gửi. → strip an toàn cho cả spawn. **Hệ quả thiết kế (cần Thi xác nhận):** credential của agent/PM phải nằm NGOÀI teleport `.env`.
   - Chỉ `TELE_FROM_*` (identity) được bơm thêm vào child.
6. **Prototype-pollution guards:** own-property check ở `resolveCommand`, `roleFor`, `memberFor`.

### 5.6 External Dependencies
Không thêm SDK/service. Chỉ Telegram Bot API (đã dùng) + Node built-ins. `claude`/`screen` cho spawn (đã là phụ thuộc của `spawn.mjs`), `npm/pnpm/yarn` cho `/run` (của project, auto-detect).

## 6. Phases / Rollout

- **P1 (đã ship):** daemon bật-tay, best-effort, single-instance; co-op harvest; registry dispatch; built-in spawn/headless/kill/ls/run/whisper/pending/start; heartbeat + `/pending` chuyển từ tele-listen sang đây (call-site trong vòng lặp tele-listen đã gỡ; một số helper cũ `detect*`/`dispatch*` còn nằm trong `tele-listen.mjs` cho test/legacy — control handling giờ do daemon sở hữu; dọn helper chết là việc riêng, ngoài scope RFC). **Exit criteria:** từ DM bật được agent khi mọi agent chết; whisper kín; không tranh offset; thêm lệnh không sửa daemon; test xanh.
- **P2 (chưa):** cân nhắc auto-recovery có kiểm soát (chống vòng lặp quota); daemon nhận thêm vai trò routing/outbound nếu cần; có thể `--drain`/purge tool. **RFC P2 phải đi trước code.**

## 7. Open Questions

Các câu hỏi gốc (scratch spec) đã được implementation chốt — ghi lại để review xác nhận lựa chọn còn đúng:
- **Q1 — Whisper nhận từ đâu?** → **Chốt: chỉ DM riêng** (`daemonChatId`), đúng tinh thần "nói thầm", không lộ người gửi trong group.
- **Q2 — Health Phase 1?** → **Chốt: chỉ báo cáo** (`/pending` + heartbeat), không auto-restart.
- **Q3 — Phối hợp cache?** → **Chốt: làm luôn** — co-op harvest ngay từ P1 (§5.4).
- **Q4 — Đặt tên lệnh?** → **Chốt: registry** (`commands.json`), không hardcode; CLI daemon là `--status`/`--stop`.
- **Q5 (mới, packaging ergonomics — không phải design dependency):** teleport có nên có `package.json` riêng (để `pnpm daemon`/`pnpm test`)? Hiện **chưa có**, nhưng README + comment đã nhắc `pnpm daemon` → đang lệch: hoặc thêm `package.json` với các script đó, hoặc sửa doc về dạng `node scripts/…`. Thuần tiện-ích, không ảnh hưởng design.
- **Q6 (mới):** fire-and-forget cho phép nhiều lệnh chạy song song trong một DM một người — có cần hàng đợi/serialize không, hay chấp nhận (admin tự biết)? (Liên quan: mất-lệnh-âm-thầm khi crash, §8.)
- **Q7 (mới, naming):** Phase 1 KHÔNG supervise/auto-restart (NG2), thuần control-plane + heartbeat. Tên "Supervisor Daemon" có đặt kỳ vọng sai? Giữ tên (đón đầu auto-recovery P2) hay đổi thành "Control Plane / Dispatcher" tới khi P2 thật sự supervise? — cần anh quyết.

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Daemon chết âm thầm (best-effort) → tưởng còn điều khiển được | Med | Med | `--status`; tài liệu nói rõ "quên bật → như cũ"; heartbeat chỉ chạy khi daemon sống |
| Hai poller tranh offset toàn cục | Low | High | Cùng poll-lock + updates-cache (§5.4); single-instance pidfile |
| `/run`,`/spawn` là remote exec bị lạm dụng | Low | High | minRole gate + containment + no-shell + `--` delimiter (§5.5) |
| **Secret exfiltration:** `/run` chạy npm script project sibling kế thừa `REPORT_BOT_TOKEN`/keys | Med | High | **Mitigated (phạm vi: secret trong teleport `.env`):** strip mọi key của `.env` khỏi child env (§5.5.5). Ngoài phạm vi: secret operator tự export ra shell cha — đừng làm vậy; P2 cân nhắc allowlist env |
| `_commands` per-deployment trỏ script độc | Low | High | `resolveCommand` validate `*.mjs`, chặn `..`, chạy dưới `scripts/` |
| Fire-and-forget chồng nhiều lệnh nặng | Low | Med | Một DM một người; chấp nhận; có thể serialize ở P2 (Q6) |
| **Mất lệnh âm thầm:** daemon crash giữa lệnh dài (offset đã advance trước khi child xong) → restart bỏ qua, không báo | Low | Med | Chấp nhận theo triết lý best-effort; admin thấy không có hồi đáp thì gửi lại. Cân nhắc serialize/ack ở P2 (Q6) |
| Prototype pollution ở role/registry lookup | Low | High | own-property guards (`resolveCommand`/`roleFor`/`memberFor`) + test pollute prototype thật |

## 9. Decision Log

- 2026-06 (`2a86e24`): Phase 1 đầu tiên với handler hardcode (`cmdSpawn/cmdWhisper/cmdRun`) — chọn best-effort/manual/single-instance, co-op harvest, chỉ-báo-cáo health.
- 2026-06 (`f00edb9`): tách config khỏi `.env` vào `projects.json` `_default` (group catch-all) + `_config` (daemonChatId/quietHours); `.env` = secrets. `resolveSenderRole` chỉ tin `_default.roles` + dedicated.
- 2026-06 (`f0fe5f2`): `/run` — auto-detect PM, validate script, `--` delimiter, containment.
- 2026-06 (`384db02`): **chuyển sang registry-driven** (Alt C/D bị loại) — `commands.json` + `_commands`; daemon thành dispatcher mỏng; tách run/whisper/pending/start thành script; code review (Gemini→Codex): dispatch fire-and-forget, `tokenizeArgs` quote-aware, own-property guards.
- 2026-06-20: **RFC review vòng 1 (Gemini, debate mode).** Blocker: `/run` rò secret qua child env → **fix code:** strip mọi key `.env` khỏi env tiến trình con (§5.5.5) + test. Nits: làm rõ chặn `.`/`..` bằng equality (không phải charset); "no shell" chỉ ở tầng teleport gọi PM. Discussion: ghi risk "mất-lệnh-âm-thầm khi crash" (§8); naming "Supervisor" → Q7 chờ Thi.
- 2026-06-20: **RFC review vòng 2 (Codex, debate mode).** Tinh chỉnh: strip chỉ bảo đảm secret trong teleport `.env` (không phủ secret export ra shell cha) → thu hẹp phát biểu §5.5.5/§8; nêu **contract credential** (agent/PM creds ngoài teleport `.env`) cần Thi xác nhận; **trust boundary** registry = config operator, không phải bề mặt mở rộng untrusted (§5.3); thu hẹp G4 về "không mất Telegram update" (không phải "không mất lệnh"); Q5 chỉ là tiện-ích packaging (README nhắc `pnpm daemon` nhưng chưa có `package.json` → lệch doc cần sửa); pseudocode dùng `process.execPath`. Không phát sinh fix code mới (strip đã đúng trong phạm vi).
