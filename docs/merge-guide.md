# Guide: lệnh `/merge` của teleport daemon

Gửi file này cho agent đang làm trong project và nhờ nó: *"Soạn lệnh /merge cho các PR cần merge"*. Agent trả về lệnh, owner copy rồi gửi cho daemon.

## Cú pháp

```
/merge <project> <số PR> [<số PR> …] [--squash|--merge|--rebase] [--keep-branch] [--force]
```

| Phần | Ý nghĩa |
|---|---|
| `<project>` | **Tên folder thật** của repo, nằm cạnh `teleport` trong `~/Projects`. Repo GitHub lấy từ `git remote` của folder đó. Với workspace umbrella (ví dụ `umipay` gom `be/`, `fe/`, `hub/`, `landing/` bằng symlink), phải dùng **folder thật của repo con** (đích của symlink, ví dụ `umipay-be`), không dùng `umipay/be`. Không phải tên repo GitHub, không phải đường dẫn. |
| `<số PR>` | Số PR trên GitHub, viết `12` hoặc `#12`. Có thể ghi **nhiều PR**: chúng được merge lần lượt theo thứ tự đã ghi, gặp PR không merge được thì **dừng** và báo PR nào đã merge, PR nào chưa thử. Các PR trong một lệnh phải cùng một repo. |
| `--squash` | Mặc định: gộp thành 1 commit. |
| `--merge` / `--rebase` | Merge commit thường / rebase. Chỉ chọn một. |
| `--keep-branch` | Giữ branch trên GitHub sau khi merge (mặc định là xoá). |
| `--force` | **Chỉ** bỏ qua check CI đang chạy dở, hoặc trạng thái BLOCKED. Không bao giờ bỏ qua check fail, conflict hay draft. |

Quyền: **admin**. Gửi trong DM với bot, hoặc trong topic nhóm thêm tiền tố `/dm` (ví dụ `/dm merge umipay 3`).

## Daemon kiểm tra gì trước khi merge

- PR phải **đang mở**, không phải draft, không có conflict. Nếu GitHub chưa tính xong trạng thái conflict (thường xảy ra ngay sau lần merge trước trong cùng lệnh), lệnh tự đợi vài giây.
- Không có check CI nào **fail**. Còn check đang chạy thì phải đợi, hoặc dùng `--force`.
- Merge ghim đúng commit vừa kiểm tra. Nếu có người push thêm giữa chừng, GitHub từ chối, chỉ cần gửi lại lệnh.
- Merge qua GitHub API: **không đụng tới checkout local** của project.
- Xoá branch sau merge chỉ khi an toàn: không phải branch mặc định, không có PR đang mở nào khác dùng nó (làm head hay base). Không kiểm tra được thì giữ lại.

## Việc của agent khi soạn lệnh

1. Xác định đúng **folder thật** của repo chứa PR (`readlink -f be` → `~/Projects/umipay-be` → project = `umipay-be`), rồi liệt kê PR đang mở: `gh -R <owner/repo> pr list --json number,title,isDraft,headRefName,baseRefName`.
2. Với mỗi PR định merge, kiểm tra: không phải draft, CI xanh (`gh pr checks <n>`), không conflict.
3. **Thứ tự**: nếu các PR đụng chung file hoặc phụ thuộc nhau thì xếp PR nền trước. Sau mỗi lần merge, PR sau có thể bị conflict, khi đó lệnh tự từ chối và báo lại.
4. Trả về danh sách lệnh, mỗi lệnh một dòng (để copy), kèm một dòng ghi chú cho mỗi PR. Ví dụ:

```
/merge umipay 2 3
```
(#2 KYT docs trước, rồi #3 môi trường dev. #3 không đụng file của #2.) PR ở repo khác thì viết lệnh riêng.

5. **Không** tự gửi lệnh cho daemon và không đặt `--force` khi chưa nói rõ lý do.

## Kết quả daemon trả về

- `✅ merged PR #N "…" into main (squash).` và `🧹 deleted branch … on GitHub`
- `❌ PR #N "…": <lý do>` (đã đóng / draft / conflict / check fail / check đang chạy). Không có gì bị thay đổi.
