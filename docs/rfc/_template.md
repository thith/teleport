# RFC NN: <Tiêu đề ngắn gọn>

> **Status:** Draft / In Review / Accepted / Rejected / Superseded by RFC NN
> **Author:** <tên>
> **Created:** YYYY-MM-DD
> **Last Updated:** YYYY-MM-DD

> Copy file này thành `NN-kebab-case-title.md` với NN là số tiếp theo trong `rfc/`. Xoá block hướng dẫn này và mọi `<placeholder>` trước khi submit review.

## 1. Context & Motivation

Vấn đề thực tế cần giải quyết là gì? User pain point cụ thể, hoặc constraint kỹ thuật buộc phải xử lý? Tránh phát biểu kiểu "user muốn X" — phát biểu kiểu "user đang gặp Y, hiện work-around bằng Z, không bền vững vì W".

Tham chiếu các spec/RFC liên quan: `[Spec NN](../specs/NN-*.md)`, `[RFC NN](NN-*.md)`.

## 2. Goals

2–4 outcome đo đếm được. Mỗi goal có thể trả lời "làm sao biết đã đạt?".

- G1: ...
- G2: ...

## 3. Non-goals

2–4 thứ **không** giải quyết trong RFC này (để chốt scope và tránh review trượt sang chuyện khác).

- NG1: ...
- NG2: ...

## 4. Alternatives Considered

Ít nhất 2 phương án thực sự khác nhau (không phải "X" vs "X đổi tên"). Với mỗi alternative:

### 4.1 Alternative A: <tên>
- Mô tả ngắn.
- Pros: ...
- Cons: ...
- Tại sao **không** chọn: ...

### 4.2 Alternative B: <tên>
- ...

## 5. Proposed Design

Mô tả cách làm được chọn. Đủ chi tiết để reader hình dung được cấu trúc, nhưng KHÔNG đi vào code-level (đó là việc của spec).

### 5.1 Components
- Module / file / service nào tham gia?
- Boundary giữa các module?

### 5.2 Data Flow
- Input → xử lý → output đi đâu?
- Persistence: ghi vào đâu, format gì?

### 5.3 External Dependencies
- API/SDK/service nào cần thêm?
- Cost / rate limit?

## 6. Phases / Rollout

Nếu feature đủ lớn, chia phase:

- **P0 (MVP):** scope tối thiểu để ship được. Test bằng tay.
- **P1:** add feature X, Y.
- **P2:** scale-out, optimisation.

Mỗi phase phải có **exit criteria** rõ ràng (cái gì phải đúng để được chuyển phase).

## 7. Open Questions

Câu hỏi *cần user/stakeholder quyết* trước khi xuống spec. Đừng tự trả lời rồi giấu — list ra để review gate bắt được.

- Q1: ...
- Q2: ...

## 8. Risks & Mitigations

Rủi ro lớn nhất có thể giết feature này? Cách mitigate?

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ... | Low/Med/High | Low/Med/High | ... |

## 9. Decision Log

Ghi lại quyết định lớn trong quá trình review (không phải mọi typo, chỉ thay đổi design).

- YYYY-MM-DD: chốt approach A thay vì B vì ... (link discussion nếu có).
- YYYY-MM-DD: thêm phase P2 sau review feedback từ ...
