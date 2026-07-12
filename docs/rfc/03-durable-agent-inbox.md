# RFC 03: Durable, non-blocking side-message delivery

> **Status:** Accepted (GO-SIMPLER) — qua 2 vòng debate 3 reviewer, cả 3 hội tụ GO. Sẵn sàng implement theo §7 rollout + change-list §11.
> **Author:** Claude (🐸 Ếch 2) + Thi
> **Created:** 2026-07-12
> **Last Updated:** 2026-07-12

> Liên quan: [RFC 02](02-self-rearm-listener-mailbox.md) (self-re-arm + mailbox không chặn cho tin Telegram — RFC này mở rộng cùng tinh thần sang tin agent↔agent/daemon, **tái dùng gần hết máy sẵn có của nó**) và [RFC 01](01-supervisor-daemon.md) (daemon control-plane — xác nhận **KHÔNG** nằm trên đường-đi-của-tin).

## 1. Context & Motivation

"Side-messages" = các tin KHÔNG đến từ người dùng qua Telegram, mà do một **agent hoặc daemon bơm thẳng** vào mailbox của agent nhận: `ask` (agent→agent hỏi), `handover` (bàn giao), và các lệnh steer của daemon `whisper`/`instruct`/`broadcast`. Tất cả hiện dùng CÙNG một cơ chế: `writePromptExclusive` ghi `prompt-convo-<N>.json` (shape `buildCombinedPromptData`) vào mailbox; `tele-listen` của agent nhận nhặt như một prompt thường.

Cơ chế này **không bền, hay chặn**. Khe mailbox là **một-slot, độc quyền** (`O_EXCL`). Có đúng **hai cửa hỏng**:

- **Cửa "bận" (đã có prompt chưa tiêu):** `O_EXCL` fail `EEXIST` → tin **bị chặn ngay ở cổng, chưa từng được lưu**. `ask` retry vài lần rồi in "thử lại sau 3'" và bỏ; `handover`/`broadcast`/`whisper`/`instruct` bỏ luôn. Người gửi tự lo — không ai giữ hộ tin. *(Đây chính là bug khởi phát cả loạt RFC 02/03: "ask/handover/broadcast hay lỗi khi người nhận bận".)*
- **Cửa "rảnh" (ghi được nhưng không ai đánh thức) — bất đối xứng runtime:**
  - `--wait-once` (Gemini/Codex): mỗi poll thấy prompt chưa tiêu → in `prompt ready` → agent xử (`waitOnceSupervisor` `tele-listen.mjs:2475`). **Có sẵn "drainer"** cho prompt injected.
  - Monitor (Claude): `main()` chỉ phát event khi **tự tay ghi prompt từ tin Telegram** (`console.log` L~2301). Prompt **injected** (hoặc sống sót qua cái chết) nằm đó **không ai xướng** → chỉ nổi lên khi tình cờ có tin Telegram tới coalesce vào. **Claude thiếu drainer cho side-messages.**

Đối chiếu: tin Telegram thật **bền** nhờ **Telegram làm broker** (offset/ack, at-least-once; listener bận/chết chỉ làm trễ). Side-messages **bỏ qua Telegram**, chọc thẳng một khe file → không broker → bận là hỏng, và Claude còn không tự vớt.

**Mục tiêu:** side-message **không bị chặn khi bận**, **sống qua cái chết + tái sinh của agent**, **giao đúng kênh reply** — mà **không dựng thêm hạ tầng mới**. Sau debate 3 reviewer (§11), thiết kế chính là **GO-SIMPLER**: nới cửa khe-hiện-có + cho Claude con mắt mà wait-once đã có. Một hàng-đợi-bền-đa-khe riêng ("kí túc xá") được cân nhắc nhưng **hoãn** (§4.4) — nó tự đẻ ra phần lớn độ phức tạp mà chưa có nhu cầu đo được (đúng tinh thần RFC02-NG3).

### 1.1 Vì sao drainer là LISTENER, không phải daemon
Durability không được phụ thuộc thứ có thể chết. **Daemon không luôn sống**; listener là thứ **sống đúng lúc agent có thể xử**. **Agent chết thì đẩy tin cho nó cũng vô nghĩa** — kho bền (file prompt trên đĩa) **giữ hộ** qua cái chết; agent **tái sinh** (maintainer resume qua CLI, gỡ block, prompt "listen đi") → listener kiếp mới **ngay poll đầu** xướng prompt còn tồn → dâng backlog. Durability = **file bền trên đĩa + listener xướng mỗi (tái) sinh**. Daemon **rút hẳn khỏi đường-đi-của-tin**; vai nó vẫn đúng RFC 01 (spawn/steer/hồi sinh).

## 2. Goals
- **G1 — Không chặn khi bận:** sender luôn gửi được (coalesce vào khe hiện có), không còn `EEXIST`-reject.
- **G2 — Bền qua chết + tái sinh:** prompt nằm trên đĩa tới khi tiêu; sống sót khi agent chết, được giao khi sống lại.
- **G3 — Có drainer cho Claude:** Monitor cũng xướng prompt injected/còn-tồn (đối xứng `--wait-once`).
- **G4 — Reply đúng kênh:** mỗi side-message mang đủ thẻ để agent đáp đúng nơi (ask-reply / DM / topic / none).
- **G5 — Chống giả danh:** danh tính người gửi là **hệ-thống-sinh**, agent không tự khai `from`/role cao hơn thực.
- **G6 — Không regression:** tin Telegram thật, claim/append/reclaim/sweep (RFC 02), Gemini/Codex `--wait-once` chạy nguyên; daemon không đổi vai.

## 3. Non-goals
- **NG1 — Không** hạ tầng mới (không socket, không store thứ hai). Tái dùng khe `prompt-convo-N.json` + máy RFC 02.
- **NG2 — Không** ack "đã đọc/seen" phía gửi. Ack ngữ-nghĩa tầng ứng dụng (handover "đã tiếp quản", instruct DM-reply) **giữ nguyên** — trực giao.
- **NG3 — Không** hàng đợi sâu / priority / lifecycle-per-message ở v1 (đó là "kí túc xá" §4.4, hoãn).
- **NG4 — Không** giải recovery "agent chết hẳn không ai resume" — người + RFC 01.
- **NG5 — Không** đổi cơ chế reply-về của ask/instruct (vẫn ghi vào inbox người gửi / DM).

## 4. Alternatives Considered

### 4.1 Giữ nguyên `writePromptExclusive` + chỉ thêm retry
- Chỉ vá cửa "bận" bằng retry sender; không giải cửa "rảnh" (Claude vẫn thiếu drainer) và không bền (retry hết là mất).
- **Không chọn.**

### 4.2 Daemon làm broker/drainer
- Phụ thuộc daemon luôn sống (nó không); thêm tiến trình vào đường-đi-của-tin. **Không chọn** (§1.1).

### 4.3 Route side-message QUA Telegram
- Thừa hưởng durability của Telegram nhưng: nhiễu topic, độ trễ, phí API, lo persona/impersonation. **Không chọn.**

### 4.4 "Kí túc xá" — hàng đợi bền đa-khe RIÊNG (`prompt-convo-N.inbox/`) — **HOÃN**
- Thiết kế: thư mục FIFO riêng, sender append (mỗi tin 1 file), listener drain + fold theo lô, delete-last, id-dedup.
- **Ưu thật:** hàng đợi sâu không phình prompt; tách concern Telegram-vs-side; lifecycle per-message (dedup/priority).
- **Nhược (lý do hoãn):** store thứ hai **tự đẻ** một loạt chi phí — tombstone chống trùng-giao, sender ghi-atomic temp+rename, TTL/expiry, inbox-GC khi convo bị GC, dual-read migration, và **bắt `--wait-once` phải thêm drainer inbox** (điều nó vốn không cần). Debate lần 1 (§11): R1/R2 chấp nhận và liệt kê 4 blocker + các mục này; R3 chỉ ra 2/4 blocker + hầu hết mục trên **chỉ tồn tại VÌ có store thứ hai**.
- **Khi nào kích hoạt (điều kiện đo được):** traffic máy-với-máy lên cao — broadcast fan-out nhiều chục agent, hàng chục `ask` xếp hàng cùng convo, hoặc merge-1-prompt phình rõ / lẫn-concern gây bug thật. Tới đó, nâng cấp GO-SIMPLER → kí túc xá là **thêm store + drainer**, không đập cái đã có.

## 5. Proposed Design (GO-SIMPLER)

Ba mảnh, tất cả **tái dùng máy RFC 02**; không hạ tầng mới.

### 5.1 Sender: `O_EXCL` → atomic-take MERGE (coalesce, không chặn) — **G1**
`ask`/`handover`/`whisper`/`instruct`/`broadcast` thôi ghi độc quyền; chuyển sang **đúng cơ chế `--append`** của listener (`tele-listen.mjs:2285-2295`), trích thành helper dùng chung:
1. Cầm **write-lock per-convo** `prompt-write-<N>.lock` (§5.5) — bắt buộc, nay sender ghi CHUNG file với listener + sender khác. (KHÔNG dùng `POLL_LOCK_FILE`.)
2. Nếu `prompt-convo-N.json` tồn tại: atomic-take rename → `.appending.<pid>`, đọc, `mergePromptData(existing, sideMsgData)`, `writePromptAtomic` ghi lại. Xoá snapshot **sau cùng** (crash → dup, không mất — triết lý RFC 02).
3. Nếu chỉ có `.processing.json` (agent đã claim) và không có open prompt → **spool** `prompt-convo-N.json` mới (side-msg thành prompt kế) — đúng đường "spool fresh" sẵn có.
4. Nếu trống → ghi thẳng (như cũ).
→ Bận **không còn** `EEXIST`-đuổi; nhiều side-msg **tự gộp**; luôn thành công. **Xoá** `ask.writePromptWithRetry`+hint "thử lại 3'" và các nhánh give-up của handover/steer. Sender trả **async**: "đã xếp hàng (bền trên đĩa), sẽ giao".

### 5.2 Claude Monitor: CLAIM-before-ANNOUNCE prompt có-sẵn (drainer) — **G2 + G3**
Thêm nhánh **đầu poll** (trước fetch; path Claude/`--append`, không `--wait-once`): nếu tồn tại `prompt-convo-N.json` → **listener TỰ CLAIM rồi mới xướng** (chốt lại từ debate lần 2 — xem §11):
```
if append && exists(promptFile):
    acquire prompt-write-<N>.lock          // §5.5, dùng acquireLockWithRetry (:1401)
    try: renameSync(promptFile → processingFile)   // atomic claim = điểm tuyến-tính-hoá
    catch ENOENT: release + fall-through-fetch      // đứa khác đã claim/merge → KHÔNG xướng
    utimesSync(processingFile, now)         // touch: TTL đếm từ lúc claim (khớp guide:445)
    release lock
    console.log("prompt ready"); exit 0     // XƯỚNG SAU KHI claim
```
- Đóng **G3** (side-msg cho Claude rảnh được xướng) và **G2** (prompt sống sót qua cái chết → listener kiếp mới claim+xướng ở poll đầu — file vốn nằm đĩa = đã bền).
- **Vì sao claim-before-announce, KHÔNG dùng marker:** sau rename, `promptFile` biến mất → điều kiện nhánh SAI ở mọi poll sau tới khi tiêu/reclaim → **không thể flood** (đúng bug RFC 02 sinh ra để diệt). **Không điếc-âm-thầm:** batch đã claim nằm trong `.processing.json` bền; agent chết trước khi đọc → `reclaimStaleProcessing` (TTL 5') fold về open prompt → poll sau re-claim + re-xướng — **tự lành bằng máy RFC 02 đã có**. Marker (`.announced`) bị bác: nó đẻ ra ca **mất-vĩnh-viễn** (agent chết ôm prompt + marker cũ → skip mãi) + cần 5 hook clear. Dup tối đa = at-least-once (crash giữa claim-và-đọc → reclaim → dup, không mất).
- **Không phá:** sweep chỉ nhận `.stale`/`.appending` của pid **đã chết** (`:1651`), không đụng `.processing` sống; `--wait-once` (Gemini/Codex) là hàm riêng, không sờ; agent-side claim `mv` thành fallback vô hại (nếu listener claim trước, agent chỉ việc đọc `.processing`).
- **Scope v1:** chỉ thêm nhánh claim-before-announce đầu poll; **giữ nguyên** Telegram write-path (`:2292-2304`). Tối đa 1 announce thừa/batch (dup, chấp nhận). Hợp-nhất write-path qua cùng claim-before-announce = bước sau, gate riêng.

### 5.3 Anti-spoof + thẻ reply (payload hygiene) — **G4 + G5**
- `from`/`role` **hệ-thống-sinh**: sender resolve danh tính THẬT của mình (fromConvoId từ env, role từ `roles` config) — agent không tự khai `from:admin`. Listener render nhãn attribution từ field tin cậy (tái dùng guard chống-impersonate của RFC 02).
- Mỗi side-msg mang thẻ **có cấu trúc** trong payload: `kind` (ask/handover/whisper/instruct/broadcast), `from`, `replyVia` (object: `{kind:"ask"|"dm"|"topic"|"none", targetConvoId?, chatId?}` — **không** phải shell-string). **KHÔNG có `priority` ở v1** (chốt debate lần 2 §11): merge một-khe **không có thứ tự giao** — mọi tin fold vào 1 prompt đọc 1 lượt, nên `priority` chỉ đổi được text-framing, mà framing đã suy ra từ `kind` (§5.4). Priority thật chỉ có nghĩa khi kí túc xá đa-khe (§4.4) được kích hoạt. Khối render vào `text` (agent chắc thấy) + giữ mảng cấu trúc để test/tooling.

### 5.4 Fold-lô: routing + framing (điểm debate)
- **Reply routing khi lô gộp lẫn tin Telegram:** prompt ghi rõ khối Telegram-origin reply về **topic**, mỗi khối side-msg reply theo **`replyVia`** của nó. (Vấn đề này có ở MỌI thiết kế fold, không riêng gì kí túc xá.)
- **Framing subordinate suy từ `kind`:** `whisper`/`broadcast` render dạng **phụ** ("FYI — sau khi xong việc đang làm:") để không cướp attention của task đang chạy; `ask`/`handover`/`instruct` render bình thường (cần agent xử + reply).
- **Giữ nguyên mô hình enforce whisper=kín/ask=kể (mềm, guide-driven):** hôm nay marker là **1 flag/prompt** (`buildSteerPrompt` set `prompt.whisper=true`/`prompt.instruct=true`, steer.mjs:70) + luật hành vi trong `telegram-guide.md` (whisper=giấu&không đáp dòng 207; instruct=đáp qua DM; ask=`ask --reply` dòng 17; broadcast=ack ngắn OK dòng 242; handover=adopt) — agent TỰ tuân, không ép cứng. Khi fold NHIỀU side-msg khác kind vào 1 prompt, **không thể** dùng 1 flag chung → phải mang **`kind` THEO TỪNG KHỐI** (đúng khối JSON §5.3) để agent áp đúng luật guide mỗi khối. Bất biến: **fold KHÔNG được nuốt mất `kind`/flag**. Không cần cơ chế enforce mới — chỉ chuyển 1-flag-prompt → per-block-kind.

## 6. Interplay với RFC 01/02
- **claim/append/reclaim/sweep:** GO-SIMPLER **là** append — sender dùng chính atomic-take + `mergePromptData` + lock + spool. Không thêm đường mới. `reclaimStaleProcessing`/`sweepOrphanSnapshots` vẫn xử `.processing`/`.stale`/`.appending` như cũ.
- **`--wait-once` (Gemini/Codex):** **không cần đổi** — nó đã xướng prompt có-sẵn (`:2475`). Merge của sender vừa vào là nó thấy. (Ưu điểm lớn của GO-SIMPLER: bỏ được yêu cầu "wait-once phải drain inbox".)
- **daemon:** whisper/instruct/broadcast vẫn do daemon/agent phát; chỉ đổi **cách ghi** (exclusive → merge). Daemon không lên đường-đi-của-tin.

## 7. Rollout (thứ tự quan trọng)
1. **② trước (Claude announce):** có drainer đã, rồi mới cho sender merge — nếu không, sender merge vào khe mà Claude không dâng.
2. **① sender merge — opt-in flag, migrate từng cái:** `ask` trước (hưởng lợi nhất, đang có retry), → handover → steer(whisper/instruct) → broadcast. Giữ `writePromptExclusive` tới khi mỗi sender cắt sang.
3. **③ anti-spoof** xuyên suốt.
Mỗi bước: worktree → test → tri-runtime smoke → review → merge. Không bật đồng loạt.

### 5.5 Write-lock: một lock per-convo cho MỌI writer của `prompt-convo-N.json`
Nay sender cũng RMW `prompt-convo-N.json` (trước chỉ listener) → cần **lock RIÊNG per-convo** `prompt-write-<N>.lock` (KHÔNG dùng `POLL_LOCK_FILE` — đó là lock fetch/long-poll 25s, release TRƯỚC đoạn ghi prompt → không serialize gì; category error). Dùng `acquireLockWithRetry` (`:1401`, bounded ~50×20ms). **Lock này phải bọc MỌI writer của `prompt-convo-N.json`:** listener-append (`:2285-2295`), tất cả sender, `reclaimStaleProcessing` (`:1589,1594`) VÀ `sweepOrphanSnapshots` (`:1679`) — nếu bỏ sót reclaim/sweep thì race sender-vs-sweep tái xuất một tầng trên. Thứ tự lock nhất quán **sweepLock ⊐ write-lock** (không cycle → không deadlock; sender không đụng fetch-lock nên không kẹt sau long-poll). **Ghi bền XONG mới trả "queued"**; hết lock-retry thì **fail to ầm ĩ**, không lẳng lặng báo "queued". Trích helper chung `mergeOrSpoolPrompt(promptFile, processingFile, data)` tái tạo `:2285-2295` **nguyên văn** (giữ bất biến "write-fail parks in `.appending.<pid>`, rm-last") + bọc lock; listener và sender cùng gọi.

## 8. Risks / edge cases
- **(R1) Sender ghi chung file → race:** đã giải bằng §5.5 (write-lock per-convo bọc mọi writer). Đây là chi phí GO-SIMPLER (kí túc xá tránh được vì sender ghi file riêng) — nhưng rẻ (hold ~micro giây, không network).
- **Prompt phình / lệch task:** nhiều side-msg + Telegram gộp một prompt to; whisper chen làm nhiễu. Giảm bằng §5.4 framing subordinate + (sau) `priority`. Nếu phình thành vấn đề đo được → kích hoạt kí túc xá (§4.4).
- **Announce loop:** §5.2 phải chặt — chỉ xướng open-prompt chưa-claim, im khi `.processing` tồn tại. Cần test kỹ (đây là chỗ dễ gây flood/loop → điếc, đúng bài học RFC 02).
- **at-least-once:** crash sau announce trước claim → poll sau xướng lại = agent thấy lại (dup, không mất). Chấp nhận (nhất quán triết lý).
- **Reply-loop async:** ask-reply cũng đi qua merge vào inbox người gửi → đối xứng, cùng cơ chế.

## 9. Test / acceptance
- Sender: bận (open prompt tồn) → merge, không EEXIST; claimed → spool; trống → ghi thẳng; luôn exit "queued". Race 2 sender → lock serialize, không mất.
- Claude announce: prompt injected lúc rảnh → poll kế xướng; prompt sống sót "cái chết" (giả lập) → poll đầu kiếp mới xướng; `.processing` tồn → KHÔNG xướng (không loop).
- Anti-spoof: agent thường không set được `from:admin`; nhãn từ field hệ-thống-sinh.
- Regression: Telegram path, --wait-once, reclaim/sweep, tri-runtime smoke xanh.

## 10. Open questions (để debate lần 2)
1. **Announce guard đủ chặt chưa?** Phân biệt "prompt mình vừa ghi trong poll này" vs "prompt có sẵn từ trước" thế nào cho khỏi double-announce mà cũng không bỏ sót? (đề xuất: chỉ xướng ở ĐẦU poll trước khi fetch; nếu poll này tự ghi thì đã có event ghi.)
2. **Sender cầm poll-lock** có làm chậm/kẹt gì listener không (lock chung `POLL_LOCK_FILE` hay lock riêng per-convo)? Nên lock RIÊNG cho ghi-prompt để không đụng fetch-lock.
3. **replyVia enum** đủ chưa cho mọi kind (ask/dm/topic/none)? handover/broadcast map vào đâu?
4. **Framing subordinate** — mức nào (chỉ text? có field `priority` ngay v1)? whisper vs instruct khác ưu tiên không?
5. **Migration flag**: 1 flag chung hay per-sender; đọc-cả-hai giai đoạn chuyển cần không (GO-SIMPLER không có store thứ hai nên có thể đơn giản hơn)?
6. **Điều kiện kích hoạt kí túc xá (§4.4)** — chốt ngưỡng đo được để lần sau khỏi tranh luận lại.

## 11. Decision log
- 2026-07-12 (draft v1): thảo luận ẩn dụ "cung/kí túc xá/thái giám" với Thi → nháp đầu chọn "kí túc xá" (store riêng).
- 2026-07-12 (**debate lần 1**): **R1 Codex + R2 Gemini → SOUND-WITH-CHANGES** cho kí túc xá, 4 blocker (prompt/claim race → atomic-take; trùng-giao → tombstone; sender-atomic temp+rename; anti-spoof field hệ-thống-sinh) + R2 thêm TTL/sender-hang/inbox-GC. **R3 Claude → GO-SIMPLER (dissent)**: 2/4 blocker + wait-once-drainer + inbox-GC + TTL + dual-read đều là chi phí do store thứ hai đẻ; đóng 2 gap thật bằng single-slot-merge (reuse `2285-2295`) + Claude announce (copy `2475`) + anti-spoof. Author lean GO-SIMPLER.
- 2026-07-12 (**Thi chốt hướng**): viết lại RFC lấy **GO-SIMPLER làm thiết kế chính** (§5), kí túc xá → §4.4 hoãn kèm điều kiện kích hoạt; debate lại trên bản v2. Anti-spoof (blocker #4) giữ vì độc lập storage.
- 2026-07-12 (**debate lần 2** trên v2, cả 3 → **GO**): R1 Codex + R2 Gemini + R3 Claude hội tụ GO-SIMPLER. **Change-list v1 chốt:**
  1. **Write-lock:** `prompt-write-<N>.lock` per-convo (KHÔNG dùng `POLL_LOCK_FILE`) qua `acquireLockWithRetry`; bọc helper chung `mergeOrSpoolPrompt()` tái tạo `:2285-2295` nguyên văn. **Guard MỌI writer** của `prompt-convo-N.json`: listener-append, mọi sender, `reclaimStaleProcessing`, `sweepOrphanSnapshots`. Thứ tự sweepLock ⊐ write-lock. Ghi bền xong mới trả "queued"; fail ầm ĩ khi hết lock.
  2. **Announce:** **claim-before-announce** (đầu poll, Claude/append): write-lock → `rename promptFile→processingFile` → touch → announce/exit-0. **Bác marker** (đẻ ca mất-vĩnh-viễn). Tự lành qua reclaim TTL. Giữ nguyên Telegram write-path ở v1 (tối đa 1 dup/batch); hợp-nhất là bước sau.
  3. **Anti-spoof:** role = f(danh tính Telegram resolve tại biên daemon/trust); sender từ chối `role`/`from` từ argv/env. Test direct-script spoof.
  4. **Q4 → bỏ `priority`** (merge một-khe không có thứ-tự-giao; framing suy từ `kind`).
  5. **Tests/wording:** concurrent empty-slot senders; `--settle` = fetch-only (ghi rõ); reclaim/sweep nay sau write-lock.
  6. **Rollout §7 giữ nguyên:** ② announce-drainer TRƯỚC → ① sender merge opt-in (`ask` đầu) → ③ anti-spoof. Mỗi bước worktree+test+tri-runtime+review+merge.
  Dormitory (§4.4) vẫn hoãn; Q6 threshold không đổi. R3 nhấn: mọi fix vòng-2 đều tái dùng máy RFC 02, **zero new durable state** → GO-SIMPLER nới rộng khoảng cách so với inbox.
