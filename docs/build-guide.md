# Build nặng: một build mỗi lúc (RFC 17)

Máy dev có 16 GB RAM, dùng chung cho khoảng 10 agent. Hai build Android/Rust chạy song song là đủ để systemd-oomd giết agent. Vì vậy mọi build nặng chạy qua `heavy.mjs`, giữ một **lock chung cho cả máy**: mỗi lúc chỉ một build, agent khác xếp hàng.

## Dùng thế nào

```bash
node ../teleport/scripts/heavy.mjs -- ./gradlew test assembleDebug
node ../teleport/scripts/heavy.mjs -- scripts/ci/android-check.sh
node ../teleport/scripts/heavy.mjs -- cargo nextest run --workspace
```

- **Build nặng là:** Gradle (build/test/lint), `cargo build/test/clippy/nextest`, các script CI local (`scripts/ci/*-check.sh`), boot emulator. Lệnh nhỏ (`npm test` vài giây, `cargo fmt`) thì không cần.
- **Đang có build khác:** in `⏳ build đang bận: 🧛 Ma #c2383556 — ./gradlew … — từ 12:40 (3 phút)` rồi chờ tới lượt. Mặc định chờ vô hạn. `--wait <phút>` để bỏ cuộc (exit 75, lệnh không chạy).
- **Exit code** là exit code của lệnh.
- **Lệnh là `gradlew`:** sau khi xong, wrapper tự chạy `gradlew --stop` để trả vài GB RAM của Gradle daemon. Dùng `--no-stop` nếu sắp build tiếp ngay. Gọi `gradlew` **trực tiếp** (`./gradlew -p android …`), không gọi qua `sh -c "cd … && ./gradlew"`, nếu không sẽ không được nhận ra.
- Build chết (Ctrl-C, timeout, bị kill) thì lock tự nhả, không bao giờ kẹt.

## `target/` và chờ RAM (RFC 18)

- **`target/` riêng mỗi worktree:** wrapper không bao giờ đặt `CARGO_TARGET_DIR`, mỗi worktree build vào `target/` của nó. Dùng chung `target/` giữa các worktree đã bị bỏ: các worktree có crate cùng tên/phiên bản nên cargo có thể link nhầm mã của nhánh khác, kể cả cho test chạy xanh trên mã sai (🪱 Giun phát hiện, 2026-10-13). Disk được lấy lại nhờ dọn hằng ngày (xoá `target/` bỏ hoang) và `cargo clean` khi xong việc. `--own-target` vẫn được nhận (không làm gì).
- **Chờ RAM:** trước khi xếp hàng lấy lock, wrapper chờ nếu `MemAvailable` dưới 3 GiB (đổi bằng `TELEPORT_HEAVY_MIN_FREE_MB`; `0` = không bao giờ chờ), **hoặc** swap gần đầy (còn dưới 1 GiB / 10% swap, tối đa 25%) trong khi RAM cũng đã eo hẹp (dưới 2× ngưỡng), **hoặc** memory pressure cao (PSI `full avg10` ≥ 10%; systemd-oomd giết agent khi mức này ở 50% liên tục 20 giây). Nó in `⏳ chờ RAM: <lý do>…` tối đa mỗi phút một lần. Nếu RAM không tăng trong 2 phút, hoặc đã chờ 15 phút, wrapper vẫn chạy kèm cảnh báo. `--no-ram-wait` để bỏ bước chờ. Heavy lồng nhau không chờ. `--wait N` chỉ tính thời gian chờ lock, không tính thời gian chờ RAM, nên trường hợp xấu nhất là 15 + N phút.
- **Scope riêng (RFC 20):** build chạy trong một systemd scope riêng (`heavy-<pid>-….scope`), không nằm trong scope của agent. Khi máy thiếu bộ nhớ, systemd-oomd nhiều khả năng giết build thay vì giết cả agent (không bảo đảm 100%). Scope có giới hạn `MemoryMax` = 45% RAM (đổi bằng `TELEPORT_HEAVY_MEM_MAX`, vd `8G`; `0` = không giới hạn) và swap tối đa 2 GiB; vượt cả hai thì kernel giết tiến trình của build và wrapper in `⚠️ … vượt giới hạn RAM … — giảm CARGO_BUILD_JOBS`. Xong build, scope bị dừng (giết hết tiến trình con còn sót) rồi mới nhả lock. `TELEPORT_HEAVY_SCOPE=0` để tắt. Không tạo được scope thì chạy như cũ kèm cảnh báo.
- **CARGO_BUILD_JOBS=4** mặc định, trừ khi bạn đã đặt biến này hoặc `build.jobs` trong `.cargo/config.toml`. Lệnh `gradlew` gọi trực tiếp được `--stop` cả trước và sau build. Pressure được kiểm lại sau khi lấy lock, đo ở `user@<uid>.service` (chỗ oomd đo).

## Chờ lâu thì sao

Có thể phải chờ một build khác 10–20 phút, nên đừng chạy foreground trong tool có timeout ngắn:

- **Claude Code:** Bash với `run_in_background: true`, đọc output khi được báo xong.
- **Codex:** truyền `timeout_ms` lớn, hoặc chạy nền + log file.
- **Gemini:** chạy nền `… > /tmp/build.log 2>&1 &` rồi đọc log.

Bị kill khi **đang chờ** thì vô hại: chưa giữ lock, lệnh không chạy.

## Merge

Merge cũng có lock riêng (`merge.mjs` tự lấy, agent không cần làm gì). `/merge`, nút [Merge] và `merge-request` không bao giờ chạy 2 merge cùng lúc. Chờ quá 3 phút thì merge báo `❌ đang có merge khác chạy…`, thử lại sau.

## Chi tiết

- Lock: `~/.local/state/teleport/locks/{build,merge}.lock` (flock, do process Node giữ). `*.holder.json` chỉ để hiển thị ai đang giữ.
- Thiết kế, cùng lý do không dùng `flock <file> <cmd>`: RFC 17 trong `teleport-docs`.
