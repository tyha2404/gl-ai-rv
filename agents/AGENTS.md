# GitLab AI Reviewer - Agent Documentation

Tài liệu tổng quan hệ thống và Tech Stack của dự án **GitLab AI Reviewer** dành cho các AI Agent và Developer tham gia phát triển.

---

## 1. 📌 Tổng quan dự án (Project Overview)

**GitLab AI Reviewer** là dịch vụ Webhook tự động phân tích và review mã nguồn cho các **GitLab Merge Request (MR)** sử dụng trí tuệ nhân tạo (AI).

### 🚀 Luồng hoạt động chính (Core Workflow)

1. **Lắng nghe Webhook**: Server Express tiếp nhận webhook từ GitLab khi có sự kiện Merge Request (`opened`, `reopened`, `update`).
2. **Lấy Diffs & Lọc File**:
   - Sử dụng GitLab API (`@gitbeaker/rest`) để lấy danh sách thay đổi (changes/diffs) của MR.
   - Tự động bỏ qua các file không cần thiết như `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `.env`, `node_modules/`, `dist/`.
3. **Phân tích bằng AI**:
   - Chuyển diff qua model AI (mặc định: Requesty AI / Gemma qua OpenAI SDK).
   - AI đánh giá các khía cạnh: Lỗi logic/bug, lỗ hổng bảo mật, quy ước đặt tên (Naming convention), Code Style & DRY, tối ưu hiệu suất.
   - AI trả về dữ liệu cấu trúc dạng JSON: gồm `summary` và danh sách `comments` (kèm `path`, `line`, `text`, `suggestion`).
4. **Gửi thông báo Google Chat**:
   - Định dạng kết quả review thành Card giao diện đẹp mắt chuẩn **Google Chat Cards V2**.
   - Hiển thị tóm tắt, số lượng lỗi phát hiện, chi tiết từng lỗi/gợi ý sửa đổi và nút điều hướng xem trực tiếp trên GitLab.

---

## 2. 🛠️ Tech Stack & Dependencies

### Core Technologies

- **Runtime**: [Node.js](https://nodejs.org/) (hỗ trợ ES Modules & CommonJS qua TypeScript)
- **Ngôn ngữ**: [TypeScript](https://www.typescriptlang.org/) (Type-safe & strict checking)
- **Web Framework**: [Express 5.x](https://expressjs.com/) (RESTful Webhook API Server)

### Tích hợp bên ngoài (Integrations & SDKs)

- **GitLab API Client**: [`@gitbeaker/rest`](https://github.com/jdalrymple/gitbeaker) (v43.x) - Thao tác với GitLab REST API (MRs, diffs, comments, discussions, labels).
- **AI Engine**:
  - [`openai`](https://github.com/openai/openai-node) SDK (v6.x) kết nối với **Requesty AI** (endpoint chuẩn OpenAI `https://router.requesty.ai/v1/`, model `google/gemma-4-31b-it` hoặc các model tương thích chuẩn OpenAI).
  - [`@google/generative-ai`](https://github.com/google/generative-ai-js) (Sẵn sàng mở rộng tích hợp Google Gemini API).
- **Notification**: **Google Chat Webhook** (sử dụng Cards V2 schema tương tác giàu tính năng).

### Dev & Testing Tools

- **Quản lý biến môi trường**: [`dotenv`](https://github.com/motdotla/dotenv)
- **Hot Reload Development**: [`nodemon`](https://nodemon.io/) kết hợp [`ts-node`](https://typestrong.org/ts-node/)
- **Test Runner**: Node.js built-in test runner (`node --test`) kết hợp `ts-node/register`

---

## 3. 📂 Cấu trúc mã nguồn (Project Structure)

```text
gitlab-ai-reviewer/
├── agents/
│   └── AGENTS.md                 # Tài liệu tổng quan dự án cho AI Agents
├── docs/
│   └── superpowers/             # Tài liệu đặc tả và kế hoạch tính năng
├── src/
│   ├── index.ts                 # Entrypoint: Express Server & Webhook Orchestration
│   ├── ai.ts                    # AI Client: Kết nối Requesty AI, xây dựng prompt và parse JSON
│   ├── gitlab.ts                # GitLab Client: Tương tác GitLab REST API
│   ├── notifier.ts              # Google Chat Notifier: Xây dựng Google Chat Cards V2
│   └── notifier.test.ts         # Unit tests cho GoogleChatNotifier
├── .env.example                 # File mẫu cấu hình biến môi trường
├── package.json                 # Định nghĩa scripts và dependencies
├── tsconfig.json                # Cấu hình TypeScript compiler
└── GEMINI.md                    # Hướng dẫn ngữ cảnh cho AI tool
```

---

## 4. ⚙️ Cấu hình môi trường (Environment Variables)

| Biến môi trường            | Bắt buộc |              Mặc định           | Mô tả                                                       |
| :------------------------- | :------: | :-----------------------------: | :---------------------------------------------------------- |
| `PORT`                     |  Không   |             `3000`              | Port lắng nghe của Express Server                           |
| `GITLAB_URL`               |  Không   |      `https://gitlab.com`       | Base URL của GitLab instance (GitLab SaaS hoặc Self-hosted) |
| `GITLAB_TOKEN`             |  **Có**  |                -                | Personal Access Token của GitLab có quyền đọc/ghi MR        |
| `REQUESTY_API_KEY`         |  **Có**  |                -                | API Key từ Requesty AI platform                             |
| `REQUESTY_BASE_URL`        |  Không   | `https://router.requesty.ai/v1/`| Base URL Router của Requesty AI                             |
| `REQUESTY_MODEL`           |  Không   |     `google/gemma-4-31b-it`     | Model AI dùng để review code                                |
| `REQUESTY_EMBEDDING_MODEL` |  Không   |          `embedding-3`          | Model embedding nếu cần sử dụng                             |
| `GOOGLE_CHAT_WEBHOOK_URL`  |  **Có**  |                -                | Webhook URL của Google Chat Space nhận thông báo            |

---

## 5. 🚦 Hướng dẫn cài đặt & Lệnh vận hành

```bash
# 1. Cài đặt dependencies
npm install

# 2. Cấu hình biến môi trường
cp .env.example .env
# Điền các giá trị vào .env

# 3. Chạy môi trường phát triển (Hot-reload)
npm run dev

# 4. Chạy Unit Tests
npm test

# 5. Chạy môi trường Production
npm start
```

---

## 6. 📝 Lưu ý phát triển cho AI Agents & Contributors

- **Format phản hồi từ AI**: Prompt trong [`src/ai.ts`](file:///Users/tyha/Documents/my-self/gitlab-ai-reviewer/src/ai.ts) yêu cầu strictly JSON output (`response_format: { type: "json_object" }`). Khi thay đổi prompt, phải đảm bảo duy trì cấu trúc `AIReviewResult`.
- **HTML Escaping trong Google Chat**: Cards V2 của Google Chat rất nhạy cảm với các ký tự đặc biệt (`<`, `>`, `&`). Bất kỳ nội dung động nào (như code snippets, review summary, tên tác giả) đều phải qua `escapeHtml()` trong [`src/notifier.ts`](file:///Users/tyha/Documents/my-self/gitlab-ai-reviewer/src/notifier.ts) để tránh lỗi API 400.
- **Payload Limits**: Google Chat Cards giới hạn kích thước payload. Hiện tại hệ thống giới hạn hiển thị tối đa 10 issues chi tiết đầu tiên trên card và dẫn link xem toàn bộ trên GitLab.
