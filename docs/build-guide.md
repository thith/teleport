# Build nặng: giới hạn số build mỗi lúc (RFC 17, RFC 23)

Máy dev dùng chung cho khoảng 10 agent. Với 16 GB RAM, hai build Android/Rust chạy song song là đủ để systemd-oomd giết agent. Vì vậy mọi build nặng chạy qua `heavy.mjs`, giữ một **lock chung cho cả máy**: mỗi lúc chỉ **N** build, agent khác xếp hàng. N = 1 khi máy < 28 GiB RAM, N = 2 khi ≥ 28 GiB (RFC 23).

## Dùng thế nào

```bash
node ../teleport/scripts/heavy.mjs -- ./gradlew test assembleDebug
node ../teleport/scripts/heavy.mjs -- scripts/ci/android-check.sh
node ../teleport/scripts/heavy.mjs -- cargo nextest run --workspace
```

- **Build nặng là:** Gradle (build/test/lint), `cargo build/test/clippy/nextest`, các script CI local (`scripts/ci/*-check.sh`), boot emulator. Lệnh nhỏ (`npm test` vài giây, `cargo fmt`) thì không cần.
- **Đang có build khác — xếp hàng (RFC 21, RFC 24):** hàng build **công bằng giữa các agent**: vé đầu của mỗi agent (theo convo) được phục vụ trước, rồi vé thứ hai… — agent đang có build chạy, hoặc vừa được phục vụ, xếp sau agent chưa có. Agent có nhiều subagent vẫn được chạy đủ, chỉ xen kẽ với agent khác; trong một agent vẫn đến trước lấy trước. (merge / cleanup: đến trước lấy trước.) Wrapper in `⏳ build đang bận: 🧛 Ma #c2383556 — ./gradlew … — từ 12:40 (3 phút) — bạn đứng thứ 2, trước bạn: 🐭 Chuột …` rồi chờ tới lượt. Mặc định chờ vô hạn. `--wait <phút>` để bỏ cuộc (exit 75, lệnh không chạy).
- **Xem hàng:** `node ../teleport/scripts/lock-queue.mjs ls` (hoặc `/health` trên Telegram): `🔒 build: đang chạy x/N`, mỗi build đang chạy một dòng `▶`, rồi `Chờ (k):` theo thứ tự; mỗi dòng ghi `· <worktree>` để phân biệt hai lệnh giống nhau ở hai worktree. Cùng mẫu cho merge/cleanup.
- **Rời hàng khi không cần build nữa:** `node ../teleport/scripts/lock-queue.mjs leave` — rời các vé đang chờ của convo bạn **trong worktree hiện tại** (mỗi subagent làm ở worktree riêng nên không rời nhầm vé của subagent khác); `leave --all` rời mọi vé của convo; job đang chờ thoát với **exit 76** ("đã rời hàng"), không chạy. Job đã bắt đầu chạy thì không rời được (dừng chính tiến trình đó). Hoặc dừng thẳng tiến trình heavy đang chờ. `--pid N` chỉ dành cho admin/maintainer (lưu ý: `--pid <pid daemon>` rời **mọi** việc daemon đang chờ lock, và offer dọn hằng ngày bị rời thì bỏ luôn). Lúc đang **chờ RAM** (trước khi vào hàng) thì chưa có vé: muốn huỷ thì dừng tiến trình heavy.
- **Exit code** là exit code của lệnh.
- **Lệnh là `gradlew`:** sau khi xong, wrapper tự chạy `gradlew --stop` để trả vài GB RAM của Gradle daemon. Dùng `--no-stop` nếu sắp build tiếp ngay. Gọi `gradlew` **trực tiếp** (`./gradlew -p android …`), không gọi qua `sh -c "cd … && ./gradlew"`, nếu không sẽ không được nhận ra.
- Build chết (Ctrl-C, timeout, bị kill) thì lock tự nhả, không bao giờ kẹt.
- **Build giữ lock quá lâu (RFC 24):** chạy ≥ 30 phút trong khi có người chờ ≥ 10 phút (và hết chỗ) → daemon nhắn owner kèm nút [⏹ Dừng]. Owner bấm thì heavy tự dừng build (TERM rồi KILL cả process group, dọn scope), in `⏹ Owner đã dừng build này qua daemon … — đừng tự chạy lại; hỏi owner trước.` và thoát **exit 77**. Thấy exit 77: **đừng chạy lại tự động** — hỏi owner. Agent cũng nhận một prompt báo việc này.

## `target/` và chờ RAM (RFC 18)

- **`target/` riêng mỗi worktree:** wrapper không bao giờ đặt `CARGO_TARGET_DIR`, mỗi worktree build vào `target/` của nó. Dùng chung `target/` giữa các worktree đã bị bỏ: các worktree có crate cùng tên/phiên bản nên cargo có thể link nhầm mã của nhánh khác, kể cả cho test chạy xanh trên mã sai (🪱 Giun phát hiện, 2026-10-13). Disk được lấy lại nhờ dọn hằng ngày (xoá `target/` bỏ hoang) và `cargo clean` khi xong việc. `--own-target` vẫn được nhận (không làm gì).
- **Chờ RAM:** trước khi xếp hàng lấy lock, wrapper chờ nếu `MemAvailable` dưới 3 GiB (đổi bằng `TELEPORT_HEAVY_MIN_FREE_MB`; `0` = không bao giờ chờ), **hoặc** swap gần đầy (còn dưới 1 GiB / 10% swap, tối đa 25%) trong khi RAM cũng đã eo hẹp (dưới 2× ngưỡng), **hoặc** memory pressure cao (PSI `full avg10` ≥ 10%; systemd-oomd giết agent khi mức này ở 50% liên tục 20 giây). Nó in `⏳ chờ RAM: <lý do>…` tối đa mỗi phút một lần. Nếu RAM không tăng trong 2 phút, hoặc đã chờ 15 phút, wrapper vẫn chạy kèm cảnh báo. `--no-ram-wait` để bỏ bước chờ. Heavy lồng nhau không chờ. `--wait N` chỉ tính thời gian chờ lock, không tính thời gian chờ RAM, nên trường hợp xấu nhất là 15 + N phút.
- **Scope riêng (RFC 20):** build chạy trong một systemd scope riêng (`heavy-<pid>-….scope`), không nằm trong scope của agent. Khi máy thiếu bộ nhớ, systemd-oomd nhiều khả năng giết build thay vì giết cả agent (không bảo đảm 100%). Scope có giới hạn `MemoryMax` = 45% RAM (đổi bằng `TELEPORT_HEAVY_MEM_MAX`, vd `8G`; `0` = không giới hạn) và swap tối đa 2 GiB; vượt cả hai thì kernel giết tiến trình của build và wrapper in `⚠️ … vượt giới hạn RAM … — giảm CARGO_BUILD_JOBS`. Xong build, scope bị dừng (giết hết tiến trình con còn sót) rồi mới nhả lock. `TELEPORT_HEAVY_SCOPE=0` để tắt. Không tạo được scope thì chạy như cũ kèm cảnh báo. **Mọi tiến trình lệnh để lại chạy nền đều bị giết khi heavy xong** — việc cần sống tiếp (vd boot emulator) thì dùng `--no-scope`; `--no-stop` (giữ Gradle daemon) cũng tự chạy không scope.
- **CARGO_BUILD_JOBS=4** mặc định, trừ khi bạn đã đặt biến này hoặc `build.jobs` trong `.cargo/config.toml`. Lệnh `gradlew` gọi trực tiếp được `--stop` cả trước và sau build. Pressure được kiểm lại sau khi lấy lock, đo ở `user@<uid>.service` (chỗ oomd đo).

## Chờ lâu thì sao

Có thể phải chờ một build khác 10–20 phút, nên đừng chạy foreground trong tool có timeout ngắn:

- **Claude Code:** Bash với `run_in_background: true`, đọc output khi được báo xong.
- **Codex:** truyền `timeout_ms` lớn, hoặc chạy nền + log file.
- **Gemini:** chạy nền `… > /tmp/build.log 2>&1 &` rồi đọc log.

Bị kill khi **đang chờ** thì vô hại: chưa giữ lock, lệnh không chạy.

## Hai chỗ build (RFC 23, máy ≥ 28 GiB)

- **N cho cả máy:** tự động theo RAM. Owner giới hạn về 1 bằng `node ../teleport/scripts/lock-queue.mjs slots 1` (ghi `~/.local/state/teleport/locks/build.slots`), bỏ giới hạn bằng `slots auto`, xem bằng `slots`. N mới áp dụng cho build lấy chỗ từ giờ; build đang chạy chạy nốt. Chỉ lock `build` có 2 chỗ; merge và cleanup luôn 1.
- **Agent không phải làm gì khác:** vẫn `heavy.mjs -- <lệnh>`. Build ở chỗ thứ hai tự có Gradle daemon riêng (`~/.gradle/daemon-slot1`) và biên dịch Kotlin ngay trong daemon đó (qua `GRADLE_OPTS`), nên hai build không bao giờ dùng chung daemon. Đừng tự đặt `org.gradle.daemon.registry.base` trong lệnh.
- **RAM:** mỗi build giới hạn 30% RAM khi có thể chạy cùng build khác (45% khi chạy một mình như trước). Build thứ hai, sau khi lấy chỗ, chờ tới khi RAM trống ≥ giới hạn của nó + 3 GiB, và tổng giới hạn các build cùng chạy ≤ 65% RAM (in `⏳ chờ RAM cho build thứ 2: …`; `/health` ghi `(chờ RAM)`). Build không giới hạn RAM (`--no-scope`, `--no-stop`, `TELEPORT_HEAVY_MEM_MAX=0`) chỉ chạy khi không còn build nào lấy chỗ trước nó.
- **Triển khai:** merge code RFC 23 **trước** khi cắm RAM (cắm RAM = tắt máy → mọi tiến trình cũ chạy lại bằng code mới); không giữ worktree teleport cũ còn chạy được. Nếu RAM vào trước: `lock-queue.mjs slots 1` cho tới khi code mới chạy và `lock-queue.mjs ls` trống.

## Merge

Merge cũng có lock riêng (`merge.mjs` tự lấy, agent không cần làm gì). `/merge`, nút [Merge] và `merge-request` không bao giờ chạy 2 merge cùng lúc. Chờ quá 3 phút thì merge báo `❌ đang có merge khác chạy…`, thử lại sau.

## Chi tiết

- Lock: `~/.local/state/teleport/locks/{build,merge,cleanup}.lock` (flock, do process Node giữ); chỗ build thứ hai là `build.1.lock`. `*.holder.json` để hiển thị ai đang giữ (và với build: giới hạn RAM đã khai báo).
- Thiết kế, cùng lý do không dùng `flock <file> <cmd>`: RFC 17 trong `teleport-docs`; hai chỗ build: RFC 23.
