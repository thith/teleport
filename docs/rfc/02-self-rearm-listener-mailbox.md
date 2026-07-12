# RFC 02: Listener tự re-arm + mailbox không chặn cho agent Telegram

> **Status:** Accepted / Shipped — COMPLETE. P0+P1+P2+P3 + merge-attribution guard (`8f10529`) + orphan-snapshot sweep (`fda970a`) all on `main` (2026-07-12). No open follow-ups. See §9.
> **Author:** Claude (🐸 Ếch 2) + Thi
> **Created:** 2026-07-11
> **Last Updated:** 2026-07-12

## 1. Context & Motivation

Agent Claude nghe Telegram bằng Monitor chạy `until node tele-listen --convo N; do sleep 12; done`. Mỗi lần giao được 1 tin, `tele-listen` exit 0 → vòng `until` kết thúc → **Monitor chết**. Từ đó agent phải **tự nhớ 2 bước máy móc**: (a) xoá prompt đã tiêu (`rm prompt-convo-N.json`), (b) khởi động lại Monitor (re-arm). Đây là 2 bước *thủ công, dễ quên*, và thực tế đã hỏng:

- **Quên re-arm** → agent điếc âm thầm. Quan sát gần đây: hiện tượng lan rộng + đột ngột trên nhiều agent (Claude, Khỉ…). Nguyên nhân cơ học: commit burst-settle (`0486d7b`) thêm `console.log` trạng-thái-poll chạy gần như mỗi tin; Monitor coi mỗi dòng stdout = 1 event → tích tới ngưỡng *"too many events → auto-stop"* → listener bị harness giết NGOÀI chu trình giao-tin→re-arm → agent không biết để bật lại. Tệ hơn, dòng `exists — skipping` **đánh lừa** agent tưởng prompt cũ đã xử → bỏ đọc tin thật.
- **Quên xoá prompt** → listener kẹt ở `exists`, chặn giao tin mới (đã xảy ra trong chính phiên thiết kế RFC này).

Để bù cho điểm yếu "điếc-khi-làm-việc" của mô hình `until`, `telegram-guide.md` phải gánh cả một lớp machinery: self-heal + heartbeat (`ScheduleWakeup`), "ưu tiên giao task cho subagent để rảnh mà nghe", drain-before-critical, chống death-loop… — nhiều rule agent phải nhớ, dễ quên, và là nguồn lỗi tự thân.

**Taxonomy "điếc" — 2 TẦNG (quan trọng để định phạm vi RFC):**
- **Tầng A — listener-loop:** Monitor chết khi giao tin → quên re-arm; hoặc log-flood → auto-stop. **Đây là tầng RFC này chữa (bằng `while`).**
- **Tầng B — tiến-trình-agent bị chặn/dừng:** (a) Claude Code CLI **block vì đang hỏi câu hỏi** (chờ input) → không xử event; (b) agent **hết token → dừng**, và **khi token về KHÔNG tự sống lại**. `while` KHÔNG chữa tầng B: listener vẫn giao tin vào mailbox nhưng agent-process không tiêu. Theo maintainer, tầng B mới là ca "điếc" **thường gặp** ở version cũ.

Heartbeat cũ (`ScheduleWakeup` mỗi ~20 phút) là nỗ lực bù cho CẢ hai tầng, nhưng **mỗi nhịp = một lần gọi AI = tốn token**; chạy ròng rã cả đêm là đắt, và **luẩn quẩn** (nếu agent dừng vì hết token thì heartbeat cũng cần token). → Sai công cụ. **RFC này BỎ HẲN heartbeat và KHÔNG thêm cơ chế thay thế** (§3 NG5, §9): continuity qua cửa-sổ-token đã được **`cswap` auto-swap** (đổi account trước khi cạn) lo sẵn; recovery tầng B sâu hơn (steer lúc block / auto-resume) để dịp khác, ngoài scope.

Pain cụ thể user nêu: **user lỡ gửi tin nhầm thì không kịp gửi đính chính/cancel** — vì trong lúc agent làm việc, `until` không có listener nào chạy nên tin cancel vô hình tới khi agent xong + re-arm.

Đã ship (prerequisite, branch riêng, chưa merge):
- `feat/ask-retry-liveness` (`cdb3f83`): ask robust — auto-retry BUSY + cảnh báo inactive + self-retry hint.
- `fix/tele-listen-quiet-polls` (`3234273`): **bỏ hẳn** các log trạng-thái-poll lặp → listener câm ở đường thường (mở đường cho `while`).

Liên quan: [RFC 01](01-supervisor-daemon.md) (daemon là lưới an toàn khi mọi agent chết — trực giao với RFC này).

## 2. Goals

- **G1:** Listener Claude **sống qua mỗi lần giao tin** — agent KHÔNG BAO GIỜ phải tự re-arm.
- **G2:** "Tiêu thụ" prompt là **tự động** — không còn bước `rm` thủ công dễ quên.
- **G3:** Tin tới lúc đang có prompt chưa tiêu **không bị chặn/rớt** — được gộp (coalesce) với **attribution đúng người + role** mỗi tin; user cancel/đính chính đến được agent.
- **G4:** **Claude, Gemini, Codex đều chạy được** sau thay đổi (không regression runtime nào).
- **G5:** `telegram-guide.md` **teo lại** — bỏ các mục thành thừa nhờ self-re-arm.

## 3. Non-goals

- **NG1:** KHÔNG đổi semantics `--wait-once` (Gemini/Codex giữ nguyên).
- **NG2:** KHÔNG gom mọi runtime về một lệnh listener chung (đã bác — xem §4).
- **NG3:** KHÔNG làm hàng đợi nhiều-slot bền (durable queue); `append-until-claimed` một-prompt là đủ giai đoạn này.
- **NG4:** KHÔNG thiết kế lại kênh ask agent-agent (append mailbox đã bao phần lớn; ask retry đã ship).
- **NG5:** KHÔNG giải "tầng B" (agent-process block/dừng-vì-token) trong RFC này. `while` chỉ chữa tầng A (listener-loop). Recovery tầng B (restart agent khi token về; steer lúc agent block) thuộc **daemon (RFC 01)** — watchdog không-AI, sẽ là RFC/spec daemon riêng. RFC 02 chỉ *bỏ heartbeat* và *trỏ residual sang daemon*.

## 4. Alternatives Considered

### 4.1 Alternative A: Hồi sinh `--watch` cho Claude
- `--watch` là supervisor persistent sẵn có (từng chạy production trên Codex), tự re-arm ở tầng tiến trình.
- Pros: máy móc đã test, có singleton-lock.
- Cons: (1) supervision lồng nhau (Monitor bọc ngoài supervisor của tele-listen); (2) đổi mode giữa chừng gây **replay** vì `--watch`/`--wait-once` giữ offset RIÊNG (`convo-N-wait-once-offset.txt`) — kiểm chứng thực tế: bật `--wait-once` giữa phiên đã replay nguyên loạt tin cũ, `--settle` gộp thành 1 prompt; (3) chỉ Claude hưởng lợi.
- **Không chọn:** thêm path thứ 3 trái tinh thần hợp-nhất; rủi ro replay.

### 4.2 Alternative B: Gom mọi runtime về `--wait-once`
- Ý tưởng: một lệnh chung; ai có background chạy nền, ai không chạy foreground.
- Cons: (1) `--wait-once` khi thấy prompt chưa tiêu **exit 0 + in "prompt ready" NGAY** (`waitOnceSupervisor` ~L2354) → bọc `while true; do --wait-once; done` sẽ **flood** mỗi vòng; (2) đổi mode → **replay** (offset riêng, như 4.1); (3) sửa `--wait-once` cho hợp Claude dễ làm **Gemini oẳng** (nó phụ thuộc semantics hiện tại).
- **Không chọn:** vi phạm G4.

### 4.3 Alternative C (CHỌN): Claude giữ bare one-shot, đổi `until`→`while`; không đụng `--wait-once`
- Bare one-shot khi thấy prompt tồn tại **exit 2 IM** (sau khi bỏ log ở `3234273`) → bọc `while` an toàn, không flood, tự re-arm.
- Không sờ `--wait-once` → Gemini/Codex nguyên vẹn (G4).
- Chấp nhận **2 path** (Claude=while bare one-shot; Gemini/Codex=--wait-once) vì chúng khác execution model thật (nền vs foreground).

## 5. Proposed Design

Năm mảnh, tất cả để **script làm thay agent** (bề mặt thủ công của agent teo còn "đọc + trả lời").

### 5.1 Components
> **Refined qua debate 3 reviewer (§10):** `while true` trần **KHÔNG dùng** — nó biến dòng exit-0 `superseded` thành flood (auto-stop) và re-arm vô hạn một listener cấu hình sai. Thay bằng **exit-code ngữ nghĩa + wrapper `case $?`**.

- **`tele-listen.mjs` — exit code ngữ nghĩa (điều kiện tiên quyết của P0):** `0`=đã giao prompt · `2`=idle/prompt-đang-chờ (im) · **`3`=superseded** · `4`=fatal/misconfig (bot/convo sai). Tín hiệu `3` phải phát **NGAY khi bị giành singleton-lock**, không đợi hết long-poll (tránh nới cửa sổ 2-listener).
- **`telegram-guide.md` — lệnh Monitor Claude:** `until` → wrapper theo exit code:
  ```
  while :; do node tele-listen --convo N; case $? in 0|2) ;; 3) break;; 4) sleep 30;; esac; sleep 2; done
  ```
  (persistent). `break` khi superseded; `sleep 30` chặn tight-loop khi fatal; `sleep 2` crash-guard. Mirror sang CLAUDE/GEMINI/AGENTS + README verbatim.
- **`send-telegram.mjs` — auto-consume CÓ RÀO (G4 firewall):** chỉ xoá `prompt-convo-N.**processing**.json` do **chính agent này claim**, **KHÔNG BAO GIỜ** xoá `prompt-convo-N.json` trần. (Nếu xoá mù, một proactive/status-send của Gemini/Codex lúc đang giữ prompt sẽ **bốc hơi** prompt đó — vỡ G4.) Ca đọc-mà-không-trả-lời (cancel) dùng lệnh tường minh `tele-listen --consume --convo N`.
- **`tele-listen.mjs::buildCombinedPromptData` — attribution:** thay nhãn cứng `Admin follow-up:` (L606) + `fromName` chỉ-lấy-người-cuối (L620) bằng **tên + role thật mỗi tin** (resolve `m.from.id` qua `roles` đã truyền sẵn), vd `↳ Thi (admin): …`, `↳ Nam (member): …`, người lạ → `(unknown)`. Fix authority (member ≠ admin) (G3).
- **`tele-listen.mjs` — claim/append protocol (P3, đổi hành vi thật):** agent **claim** bằng atomic `rename(prompt-convo-N.json → .processing.json)` **ngay trước khi đọc** (claim sớm = cancel tới kịp). Listener khi thấy `.processing.json` **KHÔNG exit 2** như hiện tại mà **spool tin mới vào một `prompt-convo-N.json` MỚI** (song song). `.processing.json` quá **TTL ≈5 phút** → listener force-rename ngược về `prompt.json` kèm **cảnh báo chèn vào event stream** (chống mồ côi wedge).
- **Drain-before-critical — respec (F7):** dưới `while` listener sống, drain **KHÔNG spawn `tele-listen` lần nữa** (sẽ trigger nhánh supersede/exit-0 = fight listener sống). Drain = **claim-rename + đọc `.processing.json`** thôi. (Trọng tài: Codex đúng về hazard, hiện thực bằng cơ chế rename của Gemini.)

### 5.2 Data Flow
1. `while` chạy `tele-listen` liên tục (nền qua Monitor). Poll rỗng → exit 2 im → lặp. Có tin → ghi/append prompt + in "prompt written" (event duy nhất) → exit 0 → **`while` vẫn lặp** (không như `until`).
2. Agent nhận event → đọc prompt → trả lời qua `send-telegram` (tự xoá prompt = consume). Không re-arm, không rm tay.
3. Trong lúc prompt chưa bị agent "claim" (rename→`.processing.json`), tin mới coalesce vào prompt (kèm attribution). Sau khi claim, tin mới mở lô prompt kế.
4. Tin tới **sau khi** agent đã đọc → không tự thấy; **drain-before-critical** (pattern đã có) bắt nốt trước hành động không hồi lại.

### 5.3 External Dependencies
Không thêm API/SDK. Chỉ đổi shell-loop + logic sẵn có trong 2 script. `.processing.json` đã tồn tại trong code (listener đã check nó).

## 6. Phases / Rollout

Prerequisite (đã xong): bỏ log poll-status (`3234273`) — điều kiện cho `while` không flood.

- **P0 — exit-code ngữ nghĩa + `until`→`while` (self-re-arm).** **Phụ thuộc BẮT BUỘC:** trước hết thêm exit code `0/2/3/4` vào `tele-listen` + wrapper `case $?` (không ship `while true` trần). Rồi đổi lệnh Monitor + mirror docs. *Exit:* agent không re-arm qua nhiều lần giao; superseded → `break` sạch (không flood/auto-stop); fatal → không tight-loop; Gemini/Codex (--wait-once) không đổi & vẫn chạy.
- **P1 — auto-consume có-rào** trong `send-telegram` (chỉ `.processing.json`). *Exit:* không cần `rm` thủ công; **proactive/status-send của Gemini/Codex KHÔNG mất prompt** (smoke-test cả 3 runtime).
- **P2 — per-sender attribution** trong coalescing. *Exit:* mỗi dòng gộp hiện đúng tên+role; test đa-người-gửi.
- **P3 — claim/append + TTL** (rename→processing; spool tin mới vào prompt.json mới; reclaim ≈5ph). *Exit:* tin đến giữa lúc chưa-claim được gộp; sau claim mở lô mới; cancel-mid-flight tới được agent; `.processing.json` mồ côi tự reclaim; không race.

> **Gate (verdict GO-WITH-CHANGES):** P0 chỉ ship SAU khi có exit-code + `case` wrapper. **P1 & P3 KHÓA** cho tới khi rào-`.processing.json` + claim protocol qua **smoke-test xanh trên CẢ Claude, Gemini, Codex** (điểm chung dùng: prompt-path, offset/cache, registry, `send-telegram`).
- **Guide cleanup (đi kèm mỗi phase):** P0 xong → **cắt hẳn** (Q4) các mục thành thừa khi listener tự sống:
  - *Heartbeat `ScheduleWakeup` (bỏ hẳn):* lý do tồn tại của nó là bù cho `until` mong manh (Monitor chết khi giao tin → agent quên re-arm → điếc → thức dậy mỗi ~20 phút để self-heal). Với `while` self-re-arm, listener không chết khi giao tin → lý do đó biến mất. Residual "tiến trình Monitor chết vì hạ tầng (crash/máy ngủ)" giao cho **daemon (RFC 01)** — control-plane chung, không phải mỗi agent tự thức **đốt token cả đêm** (đúng thứ maintainer không thích ở version cũ).
  - *Self-heal detection layer:* bỏ (không còn "Monitor chết mỗi lần giao" để phát hiện).
  - *"Ưu tiên delegate task cho subagent để rảnh mà nghe":* bỏ/hạ ưu tiên — listener luôn nghe kể cả khi agent làm inline.
  - *Giữ lại:* drain-before-critical (P3 dựa vào), chống-death-loop khi (re)start thất bại.
  Mọi cắt-guide ghi trong RFC này (§9) + áp vào cả 3 file agent-config + README verbatim.

## 7. Open Questions — ĐÃ CHỐT qua debate

- **Q1 (RESOLVED):** **long-poll `getUpdates timeout≈25s`** (giữ dưới cửa-sổ-idle của harness) thay sleep cố định — giảm API churn + nhiễu stdout. Vẫn giữ **`sleep 2` crash-guard** trong wrapper (chống CPU-peg nếu `tele-listen` crash tức thì). Kèm điều kiện: tín hiệu supersede (`3`) phải phát **khi giành lock**, không đợi hết long-poll (tránh nới cửa sổ 2-listener).
- **Q2 (RESOLVED):** lệnh tường minh `tele-listen --consume --convo N` cho ca đọc-mà-không-trả-lời; `send-telegram` auto-consume **chỉ** trên `.processing.json`. KHÔNG dựa vào drain cho consume thường.
- **Q3 (RESOLVED):** claim **ngay trước khi đọc** bằng atomic `rename(prompt.json→.processing.json)`; listener spool tin mới vào `prompt.json` mới; ghép **TTL≈5ph reclaim** để chống mồ côi khi agent chết sau claim.
- **Q4 (RESOLVED):** cắt guide **hẳn**, nhưng CHỈ sau khi các semantics (exit-code, drain, consume, claim) đã hiện thực + smoke-test xanh trên cả 3 runtime.

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Monitor không-bao-giờ-complete → event flood | Med | High | Prerequisite đã bỏ log; chỉ "prompt written" ra stdout |
| Đổi mode/regress làm Gemini/Codex oẳng | Med | High | Không đụng `--wait-once`; mục compat + smoke-test cả 3 runtime trong mỗi phase |
| Replay backlog khi đổi offset | Low | High | Claude ở nguyên bare-one-shot (offset của nó), không switch mode |
| Race append vs đọc/xoá | Med | Med | `.processing.json` claim handshake (atomic rename) |
| Prompt mồ côi nếu agent chết sau khi claim | Low | Med | TTL/reclaim cho `.processing.json` (đã có tiền lệ prune trong repo) |
| Tiến trình Monitor/agent chết vì hạ tầng (crash/máy ngủ/hết token) — sau khi bỏ heartbeat | Low | Med | **Chấp nhận residual** lần này: `persistent:true` lo timeout; `cswap` auto-swap lo continuity qua-token; nếu process chết thật → restart thủ công (daemon steer sau). KHÔNG khôi phục heartbeat per-agent (tránh token-drain đêm) |
| auto-delete xoá nhầm prompt lô mới | Low | Med | Chỉ xoá đúng messageId/lô đang reply; hoặc claim-rồi-xoá-processing |

## 9. Decision Log

- 2026-07-11: Bác Alternative A (--watch) và B (gom --wait-once) — cả hai gây replay khi đổi mode + rủi ro Gemini. Chọn C: Claude=while bare one-shot, không đụng --wait-once.
- 2026-07-11: Chốt bỏ hẳn log poll-status (không route stderr, không gate) — harness biến mọi output thành tín hiệu; đã ship `3234273` làm prerequisite.
- 2026-07-11: Đưa guide-cleanup + ràng buộc "Claude/Gemini/Codex đều chạy" vào scope RFC (per Thi).
- 2026-07-12: Q4 = cắt guide hẳn (không giữ chế độ tương thích). **Bỏ hẳn heartbeat `ScheduleWakeup` per-agent** — self-re-arm khử lý do tồn tại của nó; residual infra-death giao daemon (RFC 01). Lý do: maintainer không thích heartbeat cũ "drain token through the night".
- 2026-07-12: Phân tầng "điếc" A (listener-loop) vs B (agent-process block/token-stop). RFC 02 chỉ lo tầng A (`while`); tầng B đưa **ra khỏi** RFC (NG5).
- 2026-07-12 (**CHỐT CUỐI**): **Bỏ hẳn heartbeat, KHÔNG thêm cơ chế thay thế trong lần sửa này.** Lý do: `cswap` đã tự swap account khi sắp cạn token nên agent không bị đứt → **không cần cả low-token broadcast lẫn auto-resume**; những thứ đó "hơi rắc rối" → để dịp khác. Residual (process chết thật) chấp nhận, xử thủ công/daemon sau.
- 2026-07-12: Debate 3 reviewer (Codex→Gemini→Claude) → **GO-WITH-CHANGES**. Chốt: (1) exit-code ngữ nghĩa `0/2/3/4` + wrapper `case $?` (KHÔNG `while true` trần) — sửa flood supersede + loop-lỗi-vô-hạn; (2) auto-consume chỉ `.processing.json` (rào G4); (3) claim = atomic rename ngay trước đọc + spool lô mới + TTL reclaim; (4) drain respec = rename+read, không spawn listener; (5) Q1 long-poll≈25s + sleep-2 crash-guard + supersede-on-lock; (6) P1/P3 khoá tới khi smoke-test xanh cả 3 runtime. Chi tiết §10.
- 2026-07-12: Daemon liveness (ngoài scope) — **dùng `/start` sẵn có làm ping** (có reply=sống, không reply=chết); không thêm `/ping`/heartbeat-mtime (maintainer: "không trả lời là chết thôi, không cần phức tạp").

## 10. Review Outcome — debate 3 reviewer tuần tự (2026-07-12)

Reviewer 1 **Codex** → Reviewer 2 **Gemini** (thấy Codex) → Reviewer 3 **Claude** (trọng tài). Hội tụ mạnh; một bất đồng (F7) được phân xử.

**Đồng thuận (findings đã fold vào §5–§7):**
- **F1 (critical):** `while true` + dòng `superseded` (exit 0, stdout) → flood → auto-stop. Fix: exit-code ngữ nghĩa `0/2/3/4` + `case $?`.
- **F3/G4:** auto-consume mù trong `send-telegram` sẽ "bốc hơi" prompt của Gemini/Codex khi chúng proactive-send → chỉ xoá `.processing.json`.
- **F4:** claim protocol phải là hành vi THẬT — listener thấy `.processing.json` phải spool lô mới, không exit 2 mãi.
- **F5:** `.processing.json` mồ côi → TTL≈5ph reclaim + cảnh báo vào event stream.
- **F6:** dù không sửa `--wait-once`, vẫn coupling qua prompt-path/offset/cache/registry/`send-telegram` → P1/P3 phải smoke-test cả 3 runtime.

**Bất đồng F7 (drain) — trọng tài Claude phân xử:** *Codex đúng về hazard, Gemini đúng về cơ chế.* Dưới `while` listener sống, drain kiểu cũ (spawn `tele-listen`) sẽ trigger nhánh supersede → fight listener. → **Respec drain = claim-rename + đọc `.processing.json`, KHÔNG spawn listener** (không phải "dừng Monitor trước" như Codex lo, cũng không "vô hại tự nhiên" như Gemini nói — mà là *đổi định nghĩa drain*).

**Cả 3 bỏ sót (Claude bổ sung):**
- Long-poll 25s **nới cửa sổ 2-listener**: listener thua không tới được supersede-check trong tối đa 25s → tín hiệu `3` phải phát **khi giành lock**, không đợi hết poll.
- `sleep` đổi nghĩa: dưới `while`+long-poll nó chỉ còn là **crash-guard**; `while true; …; sleep 2` sẽ **re-arm vĩnh viễn một listener fatal** (bot/convo sai) → `case $?` là **bắt buộc**, không phải trang trí.

**Verdict: GO-WITH-CHANGES.** Hướng lõi (`until`→`while`, `--wait-once` nguyên) đúng & an toàn. KHÔNG ship-as-written: **P0** cần exit-code + `case` wrapper trước; **P1/P3 khoá** tới khi rào-`.processing.json` + claim protocol smoke-test xanh trên cả Claude/Gemini/Codex.
- 2026-07-12 (**SHIPPED**): P0 (self-re-arm `--loop`) + P2 (attribution) + adaptive-settle + `..`/`,` override + P1 (auto-consume) + P3 (`--append` claim/spool/TTL-reclaim) all merged to `main` and activated (Claude guide flipped to `--loop --append` + CLAIM protocol). Reviews: RFC 3-reviewer debate; per-branch 3-reviewer (+ deep subagent for P3). Gemini's reclaim data-loss race + the append-vs-claim duplication race (#1, atomic-take) fixed. Live smoke: claim / P1 auto-consume / coalesce / spool / self-re-arm / override all pass. Suite 640/640; default (no `--append`, `--wait-once`) byte-identical → Gemini/Codex unchanged. **Open follow-ups (mine):** (#2) a poll sweep to adopt orphan `.stale.*` snapshots on the rare post-rename write failure; (#3-cosmetic) attribute a bare single message when it's appended onto a batch; (guide) prune the now-legacy self-heal/heartbeat sections.
- 2026-07-12 (follow-up #3 SHIPPED, `8f10529`): **Merge-attribution impersonation guard.** Reported by Thi ("Spool ko thể impersonate"): `mergePromptData` stamped the merged prompt with the newest sender's identity, so two bare singles from different senders merged → the first sender's words read as the second's. Fix: `buildCombinedPromptData` emits `textAttributed` (false=bare single, true=pre-labeled batch); `mergePromptData` prefixes any `textAttributed===false` segment with its own `<name> (<role>):` via `attributionLabelFromData`, marks result true (no double-label), leaves legacy `undefined` bare. Lone non-merge delivery stays bare. Covers both coalesce + reclaim sites. 2 reviews (Codex + subagent) no-blocker; +6 tests; suite 644/644. **Remaining:** only follow-up #2 (orphan `.stale.*`/`.appending.*` sweep — rare ENOSPC post-rename write failure).
- 2026-07-12 (follow-up #1 SHIPPED, `fda970a` — RFC 02 now COMPLETE): **Orphan-snapshot sweep.** `sweepOrphanSnapshots` (poll-time, --append-only, convo-scoped) adopts `.stale.<pid>`/`.appending.<pid>` snapshots orphaned when a reclaim/append died between its atomic rename and the write-back. Design converged over 4 Codex rounds + a subagent: **dead-owner-only** adoption via `isProcessAlive` (no age fallback — it could steal a paused-but-alive op's snapshot and clobber on resume); **per-convo `sweep-convo-<N>.lock`** serializes concurrent adopters (kills the sweep-vs-sweep last-writer-wins loss); **corrupt → quarantine** to `<name>.corrupt` (never delete the only copy); **write-fail → parked + one-shot `.warned` marker** (no per-poll log flood — this codebase regressed on that once); **delete-last** so a crash duplicates rather than loses. Residual sweep-vs-append race is at parity with the pre-existing append-vs-append behavior under the singleton-listener invariant. +8 tests (incl. a live-child liveness case + a forced-write-failure case). Suite 652/652. Gemini/Codex (`--wait-once`, no `--append`) never invoke it.
