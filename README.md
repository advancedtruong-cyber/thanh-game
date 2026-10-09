# Chinh phục Thành cổ mật mã — Giải mã mê cung

Game thi đấu 4 đội trên lớp: **1 máy cô (máy chiếu)** + **4 điện thoại** (mỗi đội 1 máy).

- **Cô:** mở trang → *Tạo phòng mới* → cho học sinh quét QR → chỉnh cài đặt → *Bắt đầu*.
- **Học sinh:** quét QR (hoặc nhập mã 6 ký tự) → chọn đội → đi qua các ô chia hết.
- Nội dung **cố định theo giáo án**: chia hết cho 3, sơ đồ 3×6 với các số 5 / 24 / 126 / 72 / 123 / 136 · 21 / 15 / 36 / 66 / 1 245 · 12 / 6 / 19 / 54 / 77 (đáp án: START → 21 → 15 → 36 → 66 → 1 245 → THÀNH CỔ). Cô chỉ chỉnh thời gian, phạt lỗi, ẩn/hiện tiến độ, gợi ý.
- Tổng kết: bảng xếp hạng + chi tiết hành trình **của cả 4 đội** (cô và học sinh đều xem được), tải CSV, xem lại cuộc đua.

## Kiến trúc
Không cần máy chủ riêng. Thông điệp đi qua `ntfy.sh` (SSE + HTTPS). Mọi tin được ký ECDSA P-256 (khoá của cô cho lệnh điều khiển, khoá của từng đội cho nước đi); mọi máy chạy cùng một reducer (`js/core.js`) trên cùng nhật ký tin nên cùng ra một kết quả. Giờ lấy theo máy chủ ntfy nên đồng hồ điện thoại sai cũng không ảnh hưởng.

Giới hạn: ntfy.sh miễn phí cho ~250 tin / 12 giờ / địa chỉ mạng (một trận ~30–60 tin). Bảo mật là mức "chống học sinh nghịch", không phải mức thi cử.

## Kiểm thử
```
node --test tests/core.test.js          # logic thuần
node tests/e2e.js                       # 1 cô + 4 điện thoại (Playwright, ntfy giả); cần playwright-core + Chrome
```
