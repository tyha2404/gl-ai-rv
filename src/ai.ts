import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

export type Severity = "CRITICAL" | "WARNING" | "SUGGESTION";
export type Category = "SECURITY" | "BUG" | "PERFORMANCE" | "CLEAN_CODE";

export interface AIReviewComment {
  path: string;
  line: number;
  severity: Severity;
  category: Category;
  text: string;
  suggestion?: string | undefined;
}

export interface AIReviewResult {
  summary: string;
  verdict?: ("APPROVE" | "REQUEST_CHANGES" | "COMMENT") | undefined;
  riskLevel?: ("LOW" | "MEDIUM" | "HIGH") | undefined;
  comments: AIReviewComment[];
}

export interface MRContext {
  title: string;
  author: string;
  repoName: string;
  targetBranch: string;
  description?: string | undefined;
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
    this.model = process.env.GLM_MODEL || "glm-4-flash"; // Hoặc model tùy chỉnh qua env
  }

  /**
   * Parse git unified diff thành định dạng có số dòng chính xác cho file mới (new_path)
   */
  private formatDiffWithLineNumbers(diffs: any[]): string {
    const formattedFiles: string[] = [];

    for (const diff of diffs) {
      const filePath = diff.new_path || diff.old_path;
      if (!diff.diff) continue;

      const lines = diff.diff.split("\n");
      const formattedLines: string[] = [];
      let currentNewLine = 0;

      for (const line of lines) {
        // Hunk header: @@ -old_start,old_count +new_start,new_count @@
        const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        if (hunkMatch) {
          currentNewLine = parseInt(hunkMatch[1], 10);
          formattedLines.push(`\n--- Hunk Context (Starts at line ${currentNewLine}) ---`);
          continue;
        }

        if (line.startsWith("+")) {
          // Dòng được thêm mới
          formattedLines.push(`Line ${currentNewLine}: + ${line.slice(1)}`);
          currentNewLine++;
        } else if (line.startsWith("-")) {
          // Dòng bị xoá (không tăng new line number)
          formattedLines.push(`         - ${line.slice(1)}`);
        } else {
          // Context line (không đổi)
          if (currentNewLine > 0) {
            formattedLines.push(`Line ${currentNewLine}:   ${line.startsWith(" ") ? line.slice(1) : line}`);
            currentNewLine++;
          } else {
            formattedLines.push(`         ${line}`);
          }
        }
      }

      formattedFiles.push(`=== FILE: ${filePath} ===\n${formattedLines.join("\n")}`);
    }

    return formattedFiles.join("\n\n");
  }

  private cleanJsonResponse(content: string): string {
    let clean = content.trim();
    if (clean.startsWith("```json")) {
      clean = clean.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (clean.startsWith("```")) {
      clean = clean.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }
    // Tìm đoạn JSON trong text nếu vẫn còn text bao quanh
    const firstBrace = clean.indexOf("{");
    const lastBrace = clean.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      clean = clean.substring(firstBrace, lastBrace + 1);
    }
    return clean;
  }

  async reviewCode(diffs: any[], mrContext?: MRContext): Promise<AIReviewResult> {
    const formattedDiff = this.formatDiffWithLineNumbers(diffs);

    if (!formattedDiff.trim()) {
      return {
        summary: "Không tìm thấy thay đổi code nào cần review.",
        verdict: "APPROVE",
        riskLevel: "LOW",
        comments: [],
      };
    }

    const contextSection = mrContext
      ? `
THÔNG TIN MERGE REQUEST:
- Tiêu đề: ${mrContext.title}
- Tác giả: ${mrContext.author}
- Repository: ${mrContext.repoName}
- Target Branch: ${mrContext.targetBranch}
${mrContext.description ? `- Mô tả: ${mrContext.description}` : ""}
`.trim()
      : "";

    const systemPrompt = `
Bạn là một Principal Software Engineer & Lead Security Auditor kỳ cựu.
Nhiệm vụ của bạn là thực hiện Code Review chuyên sâu, chính xác, có tính xây dựng cho GitLab Merge Request.

NGUYÊN TẮC REVIEW QUAN TRỌNG:
1. Độ chính xác số dòng (Line Numbers):
   - Chỉ chỉ định số dòng (line) dựa trên các dòng có tiền tố "Line <số>" trong diff mới của file tương ứng.
   - Luôn gán đúng "path" (đường dẫn file chính xác như được chỉ định trong header === FILE: <path> ===).
2. Chất lượng Review (Zero False Positives):
   - Không comment các lỗi về formatting/dấu chấm phẩy/khoảng trắng (linter/prettier xử lý).
   - Chỉ comment khi chắc chắn có lỗi logic, bảo mật, hiệu năng hoặc vi phạm best practices nghiêm trọng.
   - Tránh suy đoán viển vông ngoài phạm vi diff.
3. Đề xuất Code cụ thể (Suggestion):
   - Mỗi comment chỉ ra vấn đề nên kèm theo đoạn code sửa đổi (suggestion) chuẩn chỉnh, ngắn gọn, có thể áp dụng ngay.
4. Ngôn ngữ phản hồi:
   - Sử dụng Tiếng Việt súc tích, chuyên nghiệp, đi thẳng vào trọng tâm kỹ thuật.
5. Định dạng đầu ra:
   - BẮT BUỘC chỉ trả về duy nhất một chuỗi JSON hợp lệ theo đúng cấu trúc schema được yêu cầu, không kèm bất kỳ văn bản nào ngoài JSON.
`.trim();

    const prompt = `
${contextSection}

HÃY ĐÁNH GIÁ CÁC THAY ĐỔI THEO CÁC TIÊU CHÍ SAU:
1. 🚨 BUG & LOGIC (Category: "BUG"):
   - Null/Undefined pointer, NaN, Array Out of Bound, Off-by-one.
   - Race conditions, Promise unhandled rejections, thiếu 'await', nuốt lỗi (empty catch blocks).
   - Memory leaks, không release resources (stream, DB connection, timer).

2. 🔒 BẢO MẬT (Category: "SECURITY"):
   - SQL/NoSQL Injection, XSS, SSRF, Path Traversal, Insecure Deserialization.
   - Hardcoded Credentials / Secrets / Token / Private Keys.
   - Thiếu validation/sanitization dữ liệu đầu vào.

3. ⚡ HIỆU NĂNG (Category: "PERFORMANCE"):
   - N+1 queries, truy vấn DB trong loop, độ phức tạp O(n^2)+ không cần thiết.
   - Blocking Node.js event loop (synchronous I/O nặng).

4. 🏛️ KIẾN TRÚC & CLEAN CODE (Category: "CLEAN_CODE"):
   - Vi phạm SOLID / DRY nghiêm trọng, lạm dụng 'any' trong TypeScript.
   - Code trùng lặp, logic quá phức tạp hoặc khó bảo trì.

YÊU CẦU ĐỊNH DẠNG JSON TRẢ VỀ:
{
  "summary": "Tóm tắt súc tích (2-3 câu) bằng Tiếng Việt về chất lượng tổng quan của MR, rủi ro chính và kết luận.",
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  "riskLevel": "LOW" | "MEDIUM" | "HIGH",
  "comments": [
    {
      "path": "đường_dẫn_file",
      "line": 42,
      "severity": "CRITICAL" | "WARNING" | "SUGGESTION",
      "category": "SECURITY" | "BUG" | "PERFORMANCE" | "CLEAN_CODE",
      "text": "Mô tả ngắn gọn nguyên nhân và rủi ro.",
      "suggestion": "Đoạn code sửa đổi cụ thể để thay thế dòng/đoạn code bị lỗi"
    }
  ]
}

Quy ước Verdict & RiskLevel:
- Nếu có lỗi CRITICAL hoặc rủi ro bảo mật nghiêm trọng: verdict = "REQUEST_CHANGES", riskLevel = "HIGH".
- Nếu có cảnh báo WARNING hoặc SUGGESTION cần lưu ý: verdict = "COMMENT", riskLevel = "MEDIUM".
- Nếu code tốt, không có vấn đề gì: verdict = "APPROVE", riskLevel = "LOW", comments = [].

DIFF CẦN REVIEW:
${formattedDiff}
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

      const rawText = response.choices[0]?.message?.content || "{}";
      const cleanedText = this.cleanJsonResponse(rawText);
      const result = JSON.parse(cleanedText) as AIReviewResult;

      return {
        summary: result.summary || "Đã hoàn thành review code.",
        verdict: result.verdict || (result.comments && result.comments.length > 0 ? "COMMENT" : "APPROVE"),
        riskLevel: result.riskLevel || (result.comments && result.comments.length > 0 ? "MEDIUM" : "LOW"),
        comments: Array.isArray(result.comments) ? result.comments : [],
      };
    } catch (error) {
      console.error("Error with GLM review:", error);
      return {
        summary: "Đã xảy ra lỗi trong quá trình phân tích code bằng AI.",
        verdict: "COMMENT",
        riskLevel: "HIGH",
        comments: [],
      };
    }
  }
}
