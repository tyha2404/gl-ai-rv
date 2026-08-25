import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

export interface AIReviewResult {
  summary: string;
  comments: {
    path: string;
    line: number;
    text: string;
    suggestion?: string;
  }[];
}

export class AIClient {
  private client: OpenAI;
  private model: string;

  constructor() {
    const apiKey = process.env.REQUESTY_API_KEY;
    if (!apiKey) {
      console.error("REQUESTY_API_KEY is not defined in .env file");
    }

    const baseURL =
      process.env.REQUESTY_BASE_URL || "https://router.requesty.ai/v1/";
    this.model = process.env.REQUESTY_MODEL || "google/gemma-4-31b-it";

    // Requesty AI (OpenAI compatible)
    this.client = new OpenAI({
      apiKey: (apiKey || "").trim(),
      baseURL: baseURL,
    });
  }

  async reviewCode(diffs: any[]): Promise<AIReviewResult> {
    const systemPrompt = `
      Bạn là một Tech Lead / Staff Software Engineer kỳ cựu với tiêu chuẩn kỹ thuật cực kỳ khắt khe và nghiêm túc.
      Nhiệm vụ của bạn là thực hiện Code Review chuyên sâu cho các Merge Request từ các lập trình viên.
      Bạn không chấp nhận mã nguồn viết ẩu, thiếu an toàn, vi phạm quy chuẩn kiến trúc hoặc có nguy cơ gây lỗi ở môi trường production.
      Bạn luôn trả về kết quả dưới định dạng JSON hợp lệ theo đúng cấu trúc được yêu cầu.
    `.trim();

    const prompt = `
      Bạn đang thực hiện rà soát mã nguồn (Code Review) ở vai trò Tech Lead. Hãy soi xét thật kỹ lưỡng, khắt khe và chi tiết từng thay đổi trong GitLab Merge Request dưới đây.

      TIÊU CHÍ REVIEW BẮT BUỘC (ĐÁNH GIÁ CỰC KỲ NGHIÊM NGẶT):
      1. 🚨 LỖI LOGIC, EDGE CASES & TÍNH ĐÚNG ĐẮN:
         - Phát hiện triệt để các trường hợp biên: null, undefined, NaN, mảng/chuỗi rỗng, divide-by-zero, off-by-one errors.
         - Xử lý bất đồng bộ: Race conditions, unhandled promise rejections, thiếu await, Promise.all không xử lý lỗi từng phần.
         - Quản lý tài nguyên & Memory Leaks: Không đóng stream, database connection, file handler, unremoved event listeners/timers.
         - Nuốt lỗi (Swallow errors): Bắt ngoại lệ catch mà không log/throw hoặc log sơ sài làm mất stack trace.

      2. 🔒 BẢO MẬT & PHÒNG THỦ (DEFENSIVE PROGRAMMING):
         - Lỗ hổng bảo mật: SQL Injection, NoSQL Injection, XSS, SSRF, IDOR, Path Traversal, ReDoS, v.v.
         - Hardcoded Secrets: API Keys, token, mật khẩu, IP nội bộ, endpoint nhạy cảm bị hardcode vào code.
         - Input Validation: Thiếu kiểm tra và làm sạch dữ liệu đầu vào (sanitization) ở ranh giới hệ thống (API inputs, payload, query params).

      3. ⚡ HIỆU SUẤT & KHẢ NĂNG MỞ RỘNG (PERFORMANCE & SCALABILITY):
         - N+1 query problem, truy vấn database trong vòng lặp.
         - Độ phức tạp thuật toán kém (O(n^2), O(2^n)) có thể tối ưu bằng Map/Set hoặc thuật toán hiệu quả hơn.
         - Block event loop: Đồng bộ hóa I/O, regex phức tạp chạy trên chuỗi lớn, xử lý CPU-intensive trên main thread.
         - Cấp phát bộ nhớ lãng phí, copy dữ liệu lớn không cần thiết.

      4. 🏛️ KIẾN TRÚC & NGUYÊN LÝ LẬP TRÌNH (SOLID, DRY, CLEAN CODE):
         - Vi phạm SOLID (đặc biệt Single Responsibility Principle - hàm/class làm quá nhiều việc).
         - Code duplication (vi phạm DRY), code smells, god object, spaghetti code.
         - Độ phức tạp nhận thức (Cognitive Complexity) quá cao, nested if/else quá sâu, code khó đọc và khó bảo trì.
         - Lạm dụng kiểu dữ liệu lỏng lẻo (như 'any' trong TypeScript thay vì type rõ ràng, type assertion ép kiểu mù quáng).

      5. 🏷️ QUY ƯỚC ĐẶT TÊN & CODE STYLE:
         - Tên biến, hàm, class, constant không rõ nghĩa, sai ngữ nghĩa nghiệp vụ, viết tắt vô nghĩa.
         - Sai convention (camelCase, PascalCase, UPPER_SNAKE_CASE). Magic numbers/strings không được khai báo constant.

      YÊU CẦU ĐẦU RA (JSON FORMAT):
      - Phản hồi CHỈ gồm một JSON Object hợp lệ (không kèm markdown ngoài khối JSON):
      {
        "summary": "Nhận xét tổng thể sắc sảo, thẳng thắn của Tech Lead về chất lượng MR (bằng tiếng Việt). Nêu rõ mức độ rủi ro, điểm yếu kiến trúc lớn nhất và kết luận xem MR này có đạt chuẩn hay cần refactor/sửa lỗi gấp.",
        "comments": [
          {
            "path": "đường_dẫn_file.ts",
            "line": 10,
            "text": "Giải thích sắc bén, rõ ràng về lỗi kỹ thuật hoặc rủi ro (bằng tiếng Việt). Nêu rõ nguyên nhân tại sao cách viết hiện tại là nguy hiểm hoặc kém tối ưu.",
            "suggestion": "Mã nguồn gợi ý chuẩn mực, tối ưu và sạch sẽ để thay thế (nếu có)."
          }
        ]
      }

      Nếu toàn bộ thay đổi đều đạt chuẩn xuất sắc, không có bất kỳ điểm nào cần cải thiện, hãy để "comments": [].

      Nội dung Diff cần review:
      ${JSON.stringify(diffs, null, 2)}
    `;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      });

      const text = response.choices[0]?.message?.content || "{}";
      return JSON.parse(text) as AIReviewResult;
    } catch (error) {
      console.error("Error with Requesty AI review:", error);
      return {
        summary: "I encountered an error while reviewing the code with Requesty AI.",
        comments: [],
      };
    }
  }
}
