# Kho rule Exness

Một agent theo yêu cầu: [hướng dẫn](../../agents/exness-api-reviewer.md).
Kho này tách hợp đồng công bố, quan sát thực tế có phạm vi và suy luận chưa rõ.
Mốc 600 USC không chứng minh nguyên nhân các lỗi lịch sử hay mọi cặp Cent đều hỗ trợ.

## Cài đặt và lệnh

Node.js >=22; dependency được khóa bằng `pnpm-lock.yaml`.

```powershell
pnpm install --frozen-lockfile --ignore-scripts
node tools/exness-rules.cjs collect
node tools/exness-rules.cjs check-updates
node tools/exness-rules.cjs review --project-root PATH_TO_PROJECT --files client.cjs --out .cache/exness-rules/review.json
node tools/exness-rules.cjs review --project-root PATH_TO_PROJECT --base HEAD
node tools/exness-rules.cjs approve --candidate CANDIDATE_ID --reviewed-by REVIEWER_NAME
pnpm test
```

Kho rule được xác định theo vị trí CLI trong repo này. `--project-root` chỉ dùng
cho review và mặc định là thư mục làm việc hiện tại. Git HEAD, diff, source và
báo cáo review thuộc dự án đích; cache nguồn, candidates và approvals thuộc repo
rule. Không cần khóa Exness hoặc SSH. CLI không import hay chạy các tệp được
review. `review --base` so sánh commit đó với working tree của dự án đích,
kèm tệp JS mới chưa track; tệp đã xóa được bỏ qua. Dùng `--files` cho phạm vi rõ ràng.

## Thu thập, duyệt và quay lại phiên bản

- `source-catalog.json`: tên miền/đường dẫn công khai cho phép, hai YAML và các trang
  nền. Tìm liên kết từ phần nội dung của hai guide, tối đa 80 nguồn mỗi lượt.
- `rule-seeds.json`: nội dung rule được người review biên soạn và nguồn cần đối chiếu.
  Agent không tự suy ra quy tắc bắt buộc từ code ví dụ. Khi tài liệu đổi nghĩa,
  phải biên soạn lại seed bằng yêu cầu riêng trước khi duyệt.
- `collect`: tạo `candidates/ID/` gồm nguồn nguyên byte, manifest/hash, rules và diff.
  Candidate ở local và bị Git ignore; chưa phải dữ liệu đang áp dụng.
- `approve`: kiểm tra hash, cấu trúc, bằng chứng và snapshot, lưu bản bất biến vào
  `versions/`, ghi approval và thay `active.json`. `--reviewed-by` là xác nhận của
  người gọi rằng đã đọc nội dung, không phải bằng chứng CLI tự hiểu đúng tài liệu.
- `check-updates`: ghi cache và báo cáo tại `.cache/exness-rules/`; không thay active,
  phiên bản, seed hay approval. Kể cả khi thay đổi là tương thích, chỉ báo cáo.
- Các phiên bản trước được giữ. Để quay lại phiên bản đã có, dùng candidate gốc
  còn lưu và duyệt lại; nếu candidate không còn, một người bảo trì có thể chủ động
  trỏ `active.json` về phiên bản đã verify sau khi ghi quyết định review trong Git.
  Không xóa hoặc chỉnh sửa snapshot cũ. Snapshot download được giữ nguyên byte.

## Giới hạn và kết quả

Mọi tải mạng chỉ dùng GET tới tài liệu được cho phép, timeout 20 giây, thử lại
transport tối đa hai lần, tối đa 5 MiB/nguồn. Redirect luôn được kiểm tra lại.
Không dùng môi trường, cookie đăng nhập hay khóa tài khoản cho yêu cầu tài liệu.
Không tải được hoặc không parse được là kết quả chưa đầy đủ, không phải “không đổi”.

HTML được so sánh theo nội dung article, bỏ điều hướng/kiểu dáng; code block được
so sánh riêng để phân biệt thay đổi ví dụ. YAML bỏ example/examples/externalDocs
trước khi so sánh kỹ thuật. Đây là phân loại hỗ trợ review: ví dụ có thể phản ánh
một thay đổi quan trọng và vẫn cần đọc; phần mô tả đổi chữ vẫn bị báo kỹ thuật.

Schema thành phần được kiểm tra bằng AJV 2020-12, local refs và các ràng buộc
kiểu/pattern/enum/required. Kiểm tra `format` và quy tắc nghiệp vụ không được suy
ra từ schema; checklist/test riêng phải xác minh các phần đó.

Review AST có giới hạn, luôn trả `PARTIAL_REVIEW_REQUIRES_HUMAN`. Không có finding
không có nghĩa mọi rule đã đạt. Code động, precision, quyền, rate limit, retry,
nhật ký và data flow cần bằng chứng bổ sung. CLI không truy cập mạng khi review.
`sourceFreshness.latestClaim=false` nhắc rằng snapshot không bảo đảm mới nhất;
muốn kiểm tra nguồn hiện tại, gọi `check-updates` riêng.

Exit code: `0` hoàn tất tác vụ (không đồng nghĩa code đã được duyệt), `1` review
có finding P1, `2` lỗi đầu vào/dữ liệu/nguồn chưa đầy đủ. Báo cáo JSON giữ chi tiết.

Version đầu tiên được review trong yêu cầu triển khai của người dùng. Các lần
thay đổi sau cần yêu cầu duyệt riêng. Không tạo lịch, commit hoặc push tự động.

`verification` trong từng rule mô tả mức kiểm tra tự động về trích dẫn; việc duyệt
nội dung toàn bộ bundle được ghi riêng trong `approvals/` và `active.json`.
Báo cáo review từng dự án do dự án đó giữ. Repo rule chứa fixture đã loại định danh
và bằng chứng được hash trong bundle; không phụ thuộc thư mục bên ngoài để chạy test.
