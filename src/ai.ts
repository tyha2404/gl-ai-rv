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
    const apiKey = process.env.GLM_API_KEY;
    if (!apiKey) {
      console.error("GLM_API_KEY is not defined in .env file");
    }

    // GLM-4 (Zhipu AI) dùng chuẩn OpenAI
    this.client = new OpenAI({
      apiKey: (apiKey || "").trim(),
      baseURL: "https://bigmodel.cn/api/paas/v4/", // Endpoint của Zhipu AI
    });
    this.model = "glm-4.7-flash"; // Hoặc model cụ thể bạn muốn
  }

  async reviewCode(diffs: any[]): Promise<AIReviewResult> {
    const prompt = `
      Bạn là một kỹ sư phần mềm cao cấp. Nhiệm vụ của bạn là SOÁT LỖI và ĐÁNH GIÁ chất lượng mã nguồn.
      Hãy xem xét các thay đổi mã sau đây từ một GitLab Merge Request.
      
      Hãy phân tích và tìm các vấn đề sau:
      1. Lỗi logic, bug hoặc các trường hợp biên không được xử lý.
      2. Lỗ hổng bảo mật.
      3. Cách đặt tên: Tên biến, hằng số, hàm, class có rõ nghĩa và tuân thủ quy tắc camelCase/PascalCase/snake_case phù hợp không?
      4. Code Style: Mã nguồn có dễ đọc, có bị lặp lại (DRY), hoặc có quá phức tạp không?
      5. Hiệu suất: Có cách nào tối ưu hơn không?
      
      Nếu mã nguồn hoàn hảo, đặt tên rõ ràng và không có lỗi, hãy trả về mảng "comments" trống.
      
      CHỈ phản hồi bằng một đối tượng JSON:
      {
        "summary": "Tóm tắt các lỗi và vấn đề về phong cách lập trình (bằng tiếng Việt).",
        "comments": [
          {
            "path": "file_path.ts",
            "line": 10,
            "text": "Giải thích chi tiết lỗi hoặc góp ý về đặt tên/style (bằng tiếng Việt).",
            "suggestion": "Gợi ý mã nguồn để sửa hoặc cải thiện (nếu có)."
          }
        ]
      }
      
      Nội dung Diff:
      ${JSON.stringify(diffs, null, 2)}
    `;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant that outputs JSON.",
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" }, // GLM-4 hỗ trợ ép kiểu JSON
      });

      const text = response.choices[0]?.message?.content || "{}";
      return JSON.parse(text) as AIReviewResult;
    } catch (error) {
      console.error("Error with GLM review:", error);
      return {
        summary: "I encountered an error while reviewing the code with GLM.",
        comments: [],
      };
    }
  }
}
