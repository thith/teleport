# RFC 03: Durable agent-inbox — "kí túc xá" cho side-messages

> **Status:** Draft / In Review (RFC-first — viết TRƯỚC code, đúng chuẩn)
> **Author:** Claude (🐸 Ếch 2) + Thi
> **Created:** 2026-07-12
> **Last Updated:** 2026-07-12

> Liên quan: [RFC 02](02-self-rearm-listener-mailbox.md) (self-re-arm + mailbox không chặn cho tin Telegram — RFC này mở rộng cùng tinh thần sang tin agent↔agent/daemon) và [RFC 01](01-supervisor-daemon.md) (daemon control-plane — ở đây được xác nhận **KHÔNG** nằm trên đường-đi-của-tin).

## 1. Context & Motivation

"Side-messages" = các tin KHÔNG đến từ người dùng qua Telegram, mà do một **agent hoặc daemon bơm thẳng** vào mailbox của agent nhận: `ask` (agent→agent hỏi), `handover` (bàn giao việc), và các lệnh steer của daemon `whisper`/`instruct`/`broadcast`. Tất cả hiện dùng CÙNG một cơ chế: `writePromptExclusive` ghi `prompt-convo-<N>.json` (shape `buildCombinedPromptData`) vào thư mục mailbox; `tele-listen` của agent nhận nhặt như một prompt thường.

Vấn đề: cơ chế này **không bền (không durable)**. Khe mailbox là **một-slot, độc quyền** (`O_EXCL`). Có đúng **hai cửa hỏng**:

- **Cửa "bận" (đã có prompt chưa tiêu):** `O_EXCL` fail `EEXIST` → tin **bị chặn ngay ở cổng, chưa từng được lưu**. `ask` retry vài lần rồi in "thử lại sau 3'" và bỏ; `handover`/`broadcast`/`whisper`/`instruct` bỏ luôn. Người gửi phải tự lo — không có ai giữ hộ tin.
- **Cửa "rảnh" (ghi được nhưng không ai đánh thức):** tin ghi thành công vào file, nhưng **bất đối xứng giữa runtime**:
  - `--wait-once` (Gemini/Codex): mỗi poll thấy prompt chưa tiêu → in `prompt ready` → agent xử. Tức nó **có sẵn "drainer"** cho prompt injected.
  - Monitor + bare one-shot/`--append` (Claude): `main()` chỉ phát event khi **tự tay ghi prompt từ tin Telegram** (`console.log` L~2301); một prompt **injected** nằm đó **không ai xướng** → chỉ nổi lên khi tình cờ có một tin Telegram tới coalesce vào. **Claude không có drainer cho side-messages.**

Đối chiếu vì sao **tin Telegram thật thì bền** còn side-messages thì không: tin Telegram bền nhờ **Telegram làm broker bền** — tin nằm trên server Telegram, listener consume theo mô hình **offset/ack (at-least-once)**; listener bận/chết chỉ làm trễ, không rớt. Side-messages **bỏ qua Telegram**, chọc thẳng một khe file → không có broker → bận là hỏng.

**Mục tiêu RFC này:** cho side-messages một **hàng đợi bền, đa-khe** ("kí túc xá") riêng, tách khỏi khe prompt chính ("chính điện"), và cho **listener tự drain** nó mỗi poll (fold vào prompt cho agent). Kết quả: side-message **không bị chặn khi bận**, **sống qua cái chết + tái sinh của agent**, và **được giao đúng kênh reply**.

> RFC 02 §NG3 cố tình hoãn "durable multi-slot queue". RFC 03 là phần mở rộng có chủ đích lấy lại đúng NG3 đó, khi nhu cầu đã rõ.

### 1.1 Vì sao listener drain, không phải daemon

Hai cách đánh thức tin trong kí túc xá:
1. **Listener (agent) tự ghé kí túc xá mỗi poll** (chọn).
2. Daemon rình lúc khe chính rảnh rồi dắt tin vào (bác).

Chọn (1) vì: **daemon không luôn sống**; durability không được phụ thuộc thứ có thể chết. Listener là thứ **sống đúng lúc agent có thể xử** → giao đúng thời điểm cần. Về cơ chế, bước "ghé kí túc xá" **y hệt khuôn `sweepOrphanSnapshots`/`reclaimStaleProcessing`** (RFC 02): mỗi poll readdir một chỗ bên rồi fold vào prompt — rẻ, có sẵn mẫu.

**Agent chết thì không cần đẩy tin cho nó** (giao cho vua băng hà là vô nghĩa). Kho bền **giữ hộ** qua cái chết; agent **tái sinh** (maintainer resume qua CLI, gỡ block, prompt "listen đi") → listener kiếp mới **ngay poll đầu ghé kí túc xá** → dâng hết backlog. Durability = **store bền + listener kéo mỗi (tái) sinh**, không cần ai đẩy. Daemon vì thế **rút hẳn khỏi đường-đi-của-tin**; vai nó vẫn đúng RFC 01 (spawn/steer/hồi sinh), không drain tin.

## 2. Goals

- **G1 — Không chặn khi bận:** sender luôn gửi được (append đa-khe), không còn `EEXIST`-reject.
- **G2 — Bền qua chết + tái sinh:** tin nằm trong kho tới khi được drain; sống sót khi agent chết và được giao khi agent sống lại.
- **G3 — Có drainer cho Claude:** listener Claude cũng surface side-messages (đối xứng với `--wait-once`).
- **G4 — Reply đúng kênh:** mỗi side-message mang đủ thẻ để agent đáp đúng nơi (ask-reply / DM / topic / none).
- **G5 — Không regression:** tin Telegram thật, claim/append/reclaim/sweep (RFC 02), và Gemini/Codex `--wait-once` vẫn chạy nguyên. Daemon không đổi vai.

## 3. Non-goals

- **NG1 — Không** làm broker mạng/socket giữa agent; kho là **file trên đĩa chung** (như toàn bộ teleport).
- **NG2 — Không** ack "đã đọc/seen" phía gửi trong v1 (chỉ "đã xếp hàng bền"). Ack ngữ-nghĩa tầng ứng dụng (handover "đã tiếp quản", instruct DM-reply) **giữ nguyên** — trực giao.
- **NG3 — Không** ưu tiên/định-thời phức tạp trong v1: kho FIFO một sảnh; `priority` chỉ là **thẻ logic** để nâng cấp sau, chưa xử.
- **NG4 — Không** giải recovery "agent chết hẳn không ai resume" — đó là người + RFC 01 (spawn/resume), không phải RFC này.
- **NG5 — Không** đổi cơ chế reply-về của ask/instruct (vẫn ghi vào inbox của người gửi / DM).

## 4. Alternatives Considered

### 4.1 Coalesce side-message thẳng vào KHE CHÍNH (`prompt-convo-N.json`)
- Đổi `writePromptExclusive` → merge (như `--append`) vào khe chính.
- Cons: (1) khe chính là "chính điện" của tin Telegram — trộn side-message vào làm lẫn concern + vẫn **một khe** (bận vẫn tranh chấp, nhiều side-message chồng nhau khó tách); (2) **không** tự bền cho ca "rảnh" nếu Claude vẫn thiếu drainer. Chỉ vá nửa vời.
- **Không chọn:** kho RIÊNG (kí túc xá) tách concern + đa-khe sạch hơn.

### 4.2 Daemon làm broker/drainer
- Daemon rình khe chính rảnh rồi bơm tin.
- Cons: phụ thuộc daemon luôn sống (nó không); thêm một tiến trình vào đường-đi-của-tin = thêm nguồn lỗi; timing/poll phức tạp.
- **Không chọn:** xem §1.1. Listener-drain không phụ thuộc daemon.

### 4.3 Route side-message QUA Telegram (gửi tin thật vào topic người nhận)
- Thừa hưởng durability của Telegram.
- Cons: nhiễu topic (mỗi ask/whisper thành một tin hiển thị); độ trễ; lo persona/impersonation (ai đứng tên gửi?); phí API.
- **Không chọn:** kho file nội bộ gọn + kín hơn cho tin máy-với-máy.

## 5. Proposed Design

### 5.1 Kho: `prompt-convo-<N>.inbox/` — thư mục FIFO đa-khe
- Mỗi convo N có một thư mục inbox riêng cạnh `prompt-convo-<N>.json`.
- **Mỗi side-message = một file** trong đó, tên `<ts>-<id>.json` (ts để FIFO, id để dedup/idempotency). Nhiều tin cùng lúc → nhiều file, **không tranh `O_EXCL`** (mỗi file tên riêng).
- Chọn **thư mục nhiều file** thay **append-log NDJSON**: thêm/xoá từng tin dễ (xoá = tiêu), đa-khe tự nhiên, hợp idiom prompt-file sẵn có; NDJSON cần cursor + rewrite-khi-tiêu, phức tạp hơn.

### 5.2 Payload mỗi tin — thẻ JSON đầy đủ
```json
{
  "id": "<uuid/ts-rand>",
  "kind": "ask | handover | whisper | instruct | broadcast",
  "from": "Tên (#hash / convoId, role)",
  "replyVia": "ask --reply --to <convoId> | DM | topic | none",
  "priority": "normal | high",
  "ts": 1699999999,
  "text": "<nội dung>",
  "attachments": []
}
```
- `id`: idempotency + dedup (drain hai lần không nhân đôi).
- `replyVia`: để agent đáp **đúng kênh** (điểm mấu chốt của fold — mỗi kind reply nơi khác nhau).
- `priority`: thẻ logic, v1 chưa xử; mở đường prioritize sau mà không đập lại kho.

### 5.3 Sender: append vào kho (thay exclusive-write khe chính)
- `ask`/`handover`/`whisper`/`instruct`/`broadcast` **ghi một file mới** vào `prompt-convo-<N>.inbox/` (luôn thành công — G1) thay vì `writePromptExclusive` khe chính.
- Trả về **async**: `"đã xếp hàng (bền), sẽ giao"`. **Bỏ** retry/busy-reject/hint "thử lại 3'" của `ask` (workaround cho single-slot ko bền — nay thừa). **Giữ** ack ngữ-nghĩa phía nhận (handover "đã tiếp quản", instruct DM-reply) — trực giao với durability (§3 NG2).

### 5.4 Listener: drain + fold JSON theo lô (mỗi poll)
Trong `main()` (áp cho path Claude; cân nhắc cho `--wait-once` để đối xứng), sau khi lo prompt chính, **ghé kho**:
1. `readdir(prompt-convo-<N>.inbox/)`, sort theo `ts` (FIFO), đọc từng file JSON.
2. Gói cả lô thành **một khối JSON có rào** chèn vào `text` của prompt cho agent (để agent CHẮC CHẮN thấy — hơn field riêng dễ sót):
   ```
   📥 Tin bên (xử từng cái, reply đúng kênh):
   ```json
   [ {id, kind, from, replyVia, priority, ts, text}, ... ]
   ```
   ```
3. Fold vào prompt hiện có bằng `mergePromptData` (attribution/impersonation-guard của RFC 02 áp dụng); nếu không có prompt chính → khối side-messages tự thành prompt mới. Phát event như một prompt bình thường (đối xứng "prompt written").
4. **delete-last:** chỉ xoá các file inbox đã fold **SAU KHI** prompt gộp ghi bền (atomic). Crash giữa chừng → fold lại = **TRÙNG** (agent thấy lại), không **MẤT** — nhất quán triết lý orphan-sweep.

### 5.5 Kỷ luật đồng thời (tái dùng RFC 02)
- Bọc bước drain trong **lock per-convo** (`acquirePollLock(inbox-convo-<N>.lock)`) như `sweepOrphanSnapshots`, để hai listener chồng nhau (cửa sổ supersede) không cùng fold một lô → clobber. Loser skip poll này, drain poll sau.
- Idempotency qua `id`: nếu một `id` đã xuất hiện trong prompt đang chờ (chưa tiêu), không fold lại.

## 6. Interplay với RFC 01/02
- **RFC 02 claim/append:** khi agent đã CLAIM (`.processing.json`), listener vẫn có thể fold lô inbox mới vào **prompt mở kế tiếp** (spool) — y mô hình append. Không đụng batch đang xử.
- **reclaim/sweep:** kho inbox là nguồn riêng; sweep xử `.stale/.appending`, drain xử `inbox/`. Độc lập, cùng khuôn.
- **Daemon (RFC 01):** không đổi. Whisper/instruct/broadcast **đổi đích ghi** (khe chính → inbox) nhưng vẫn do daemon/agent phát; daemon không drain.
- **Gemini/Codex `--wait-once`:** cần thêm bước drain đối xứng (G3) hoặc chấp nhận chúng đã có drainer prompt-injected sẵn và chỉ cần đọc inbox — quyết ở §10.

## 7. Rollout
- **Opt-in trước:** thêm ghi-inbox sau lưng một flag/đường mới, giữ `writePromptExclusive` cũ tới khi drain chạy ổn, để không gãy sender khi listener chưa biết drain. Cắt sang inbox khi tri-runtime smoke pass.
- Migrate lần lượt: `ask` trước (đang có retry, hưởng lợi nhất) → handover → steer(whisper/instruct) → broadcast.

## 8. Risks / edge cases
- **Backlog lớn** → một prompt fold quá to. Giảm bằng: cap số tin/lô (phần dư để poll sau), hoặc cap kích thước text.
- **Fold làm lệch task đang chạy:** whisper chen giữa có thể nhiễu; thẻ `kind` + hướng dẫn guide giúp agent xử đúng; `priority` để sau.
- **Rác kho:** file inbox hỏng/không parse → quarantine `.corrupt` (như sweep), không xoá, log một lần.
- **Ordering vs prompt chính:** chốt fold-sau-prompt-chính hay ưu tiên `priority` — v1 FIFO + prompt-chính-trước.
- **Reply-loop async:** ask-reply cũng đi vào inbox người gửi → cần cả hai đầu drain; nhất quán.

## 9. Decision log
- 2026-07-12: Khởi thảo qua thảo luận ẩn dụ "cung/kí túc xá/thái giám" với Thi. **Chốt:** (drainer) listener-only, không daemon; (kho) thư mục FIFO `prompt-convo-N.inbox/`, tin đeo thẻ JSON đầy đủ; (Q1) **fold theo lô, khối JSON có rào**; (Q2) **async, bỏ sender-retry, giữ receiver-semantic-ack**; (Q3) **delete-last**. Daemon rút khỏi đường-đi-của-tin; durability = store bền + listener kéo mỗi (tái) sinh.

## 10. Open questions (để debate reviewer)
1. **`--wait-once` (Gemini/Codex)** có cần drain inbox không, hay chúng đã đủ nhờ prompt-injected surface sẵn? (G3 đối xứng tới đâu.)
2. **Fold vào `text` (khối JSON có rào) vs field prompt riêng `sideMessages`** — cái nào agent chắc thấy + guide gọn hơn?
3. **Cap lô** (số tin / kích thước) bao nhiêu là hợp; phần dư drain poll sau thế nào để không đói.
4. **Reply-via chuẩn hoá:** enum `replyVia` đủ chưa (ask/DM/topic/none) cho mọi kind?
5. **Migration:** giữ song song exclusive-write + inbox bao lâu; có cần đọc cả hai trong giai đoạn chuyển?
6. **broadcast fan-out** vào N inbox — có cần cùng `id` để dedup xuyên topic không?
