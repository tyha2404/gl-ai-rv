import dotenv from "dotenv";
import OpenAI from "openai";
import { loadProjectRules } from "./config/rules";
import {
  LEAD_CONSOLIDATOR_PROMPT,
  REVIEW_ROLES,
  RoleConfig,
} from "./roles/prompts";
import { chunkDiffs, DiffBatch, GitLabDiffItem } from "./utils/diff";

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
  verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  comments: AIReviewComment[];
}

export interface MRContext {
  title: string;
  author: string;
  repoName: string;
  targetBranch: string;
  description?: string | undefined;
  customRules?: string | undefined;
}

export interface RoleReviewOutput {
  role: string;
  category: Category;
  comments: AIReviewComment[];
  analysis?: string;
}

export class AIClient {
  private client: OpenAI;
  private model: string;

  constructor(customClient?: OpenAI, customModel?: string) {
    if (customClient) {
      this.client = customClient;
      this.model = customModel || "auto";
      return;
    }

    const apiKey =
      process.env.NINE_ROUTER_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.GLM_API_KEY ||
      "9router-local";

    const baseURL =
      process.env.NINE_ROUTER_URL ||
      process.env.GROQ_BASE_URL ||
      (process.env.GROQ_API_KEY
        ? "https://api.groq.com/openai/v1"
        : process.env.GLM_API_KEY
          ? "https://bigmodel.cn/api/paas/v4/"
          : "http://localhost:20128/v1/");

    this.client = new OpenAI({
      apiKey: apiKey.trim(),
      baseURL: baseURL.trim(),
    });
    this.model =
      customModel ||
      process.env.NINE_ROUTER_MODEL ||
      process.env.GROQ_MODEL ||
      process.env.GLM_MODEL ||
      "auto";
  }

  /**
   * Làm sạch và trích xuất JSON từ chuỗi phản hồi của LLM
   */
  public cleanJsonResponse(content: string): string {
    let clean = content.trim();
    if (clean.startsWith("```json")) {
      clean = clean.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (clean.startsWith("```")) {
      clean = clean.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }
    const firstBrace = clean.indexOf("{");
    const lastBrace = clean.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      clean = clean.substring(firstBrace, lastBrace + 1);
    }
    return clean;
  }

  /**
   * Thực thi một Agent / Role chuyên môn cho 1 batch diff
   */
  private async runRoleReview(
    role: RoleConfig,
    batch: DiffBatch,
    contextSection: string,
    customRulesSection: string,
  ): Promise<RoleReviewOutput> {
    const prompt = `
${contextSection}
${customRulesSection}

[DIFF CẦN REVIEW - BATCH ${batch.batchIndex}/${batch.totalBatches}]:
${batch.formattedDiffText}

HƯỚNG DẪN REVIEW:
- Đóng đúng vai trò: ${role.name}.
- Chỉ tìm các vấn đề thuộc nhóm Category: "${role.category}".
- Chỉ comment khi chắc chắn có vấn đề xác thực (Zero False Positives).
- Nếu không có vấn đề gì thuộc chuyên môn của bạn, hãy trả về danh sách rỗng: "comments": [].

BẮT BUỘC TRẢ VỀ JSON THEO SCHEMA:
{
  "analysis": "Đánh giá nhanh khía cạnh ${role.category}",
  "comments": [
    {
      "path": "đường_dẫn_file",
      "line": 42,
      "severity": "CRITICAL" | "WARNING" | "SUGGESTION",
      "category": "${role.category}",
      "text": "Mô tả vấn đề ngắn gọn, giải thích rủi ro",
      "suggestion": "Đoạn code sửa đổi cụ thể nếu có"
    }
  ]
}
`.trim();

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: role.systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const raw = response.choices[0]?.message?.content || "{}";
      const clean = this.cleanJsonResponse(raw);
      const parsed = JSON.parse(clean);

      const comments: AIReviewComment[] = Array.isArray(parsed.comments)
        ? parsed.comments.map((c: any) => ({
            path: String(c.path || ""),
            line: Number(c.line) || 1,
            severity: (["CRITICAL", "WARNING", "SUGGESTION"].includes(
              c.severity,
            )
              ? c.severity
              : "WARNING") as Severity,
            category: role.category,
            text: String(c.text || ""),
            suggestion: c.suggestion ? String(c.suggestion) : undefined,
          }))
        : [];

      return {
        role: role.name,
        category: role.category,
        comments,
        analysis: parsed.analysis || "",
      };
    } catch (err) {
      console.warn(
        `[MultiAgentReview] Role ${role.name} error on batch ${batch.batchIndex}:`,
        err,
      );
      return {
        role: role.name,
        category: role.category,
        comments: [],
        analysis: "Role review error",
      };
    }
  }

  /**
   * Lead Reviewer tổng hợp các ý kiến từ các chuyên gia, lọc bỏ trùng lặp và thẩm định chất lượng
   */
  private async consolidateReviews(
    allRoleOutputs: RoleReviewOutput[],
    batches: DiffBatch[],
    contextSection: string,
    customRulesSection: string,
  ): Promise<AIReviewResult> {
    const allRawComments: AIReviewComment[] = [];
    for (const out of allRoleOutputs) {
      allRawComments.push(...out.comments);
    }

    // Nếu không có bất kỳ chuyên gia nào phát hiện lỗi
    if (allRawComments.length === 0) {
      return {
        summary:
          "Đội ngũ chuyên gia (Security, Performance, Clean Code, Bug Hunter) đã kiểm tra toàn diện và không phát hiện vấn đề nào cần lưu ý. Code đạt chất lượng tốt.",
        verdict: "APPROVE",
        riskLevel: "LOW",
        comments: [],
      };
    }

    const consolidatorPrompt = `
${contextSection}
${customRulesSection}

KẾT QUẢ THÔ TỪ CÁC CHUYÊN GIA REVIEW:
${JSON.stringify(allRoleOutputs, null, 2)}

DIFF CỦA CÁC FILE ĐƯỢC REVIEW:
${batches.map((b) => b.formattedDiffText).join("\n\n")}

NHIỆM VỤ CỦA LEAD REVIEWER:
1. Thẩm định chéo (Critique): Kiểm tra lại xem các comment từ chuyên gia có thật sự chính xác, có đúng dòng không, có bị false positive không.
2. Khử trùng lặp (Deduplicate): Nếu cùng 1 file và line bị nhiều chuyên gia nhắc đến, gộp lại thành 1 comment hoàn chỉnh với mức severity cao nhất.
3. Đánh giá tổng quan: Viết summary (2-3 câu tiếng Việt súc tích), chọn verdict và riskLevel phù hợp.

BẮT BUỘC TRẢ VỀ ĐÚNG SCHEMA JSON:
{
  "summary": "Tóm tắt đánh giá chất lượng tổng quan của MR",
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  "riskLevel": "LOW" | "MEDIUM" | "HIGH",
  "comments": [
    {
      "path": "đường_dẫn_file",
      "line": 42,
      "severity": "CRITICAL" | "WARNING" | "SUGGESTION",
      "category": "SECURITY" | "PERFORMANCE" | "CLEAN_CODE" | "BUG",
      "text": "Mô tả nguyên nhân & rủi ro rõ ràng",
      "suggestion": "Đoạn code sửa đổi cụ thể"
    }
  ]
}
`.trim();

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: LEAD_CONSOLIDATOR_PROMPT },
          { role: "user", content: consolidatorPrompt },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const raw = response.choices[0]?.message?.content || "{}";
      const clean = this.cleanJsonResponse(raw);
      const parsed = JSON.parse(clean);

      const finalComments: AIReviewComment[] = Array.isArray(parsed.comments)
        ? parsed.comments.map((c: any) => ({
            path: String(c.path || ""),
            line: Number(c.line) || 1,
            severity: (["CRITICAL", "WARNING", "SUGGESTION"].includes(
              c.severity,
            )
              ? c.severity
              : "WARNING") as Severity,
            category: ([
              "SECURITY",
              "PERFORMANCE",
              "CLEAN_CODE",
              "BUG",
            ].includes(c.category)
              ? c.category
              : "BUG") as Category,
            text: String(c.text || ""),
            suggestion: c.suggestion ? String(c.suggestion) : undefined,
          }))
        : allRawComments;

      let verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" = "APPROVE";
      if (finalComments.some((c) => c.severity === "CRITICAL")) {
        verdict = "REQUEST_CHANGES";
      } else if (finalComments.length > 0) {
        verdict = "COMMENT";
      }

      let riskLevel: "LOW" | "MEDIUM" | "HIGH" = "LOW";
      if (verdict === "REQUEST_CHANGES") {
        riskLevel = "HIGH";
      } else if (finalComments.length > 0) {
        riskLevel = "MEDIUM";
      }

      return {
        summary:
          parsed.summary ||
          "Đã hoàn thành phân tích đa chuyên gia cho Merge Request.",
        verdict: parsed.verdict || verdict,
        riskLevel: parsed.riskLevel || riskLevel,
        comments: finalComments,
      };
    } catch (err) {
      console.warn(
        "[MultiAgentReview] Lead Consolidator error, using fallback deduplication:",
        err,
      );

      // Local programmatic fallback deduplication
      const deduplicatedMap = new Map<string, AIReviewComment>();
      for (const comment of allRawComments) {
        const key = `${comment.path}:${comment.line}`;
        const existing = deduplicatedMap.get(key);
        if (
          !existing ||
          (comment.severity === "CRITICAL" && existing.severity !== "CRITICAL")
        ) {
          deduplicatedMap.set(key, comment);
        }
      }

      const finalComments = Array.from(deduplicatedMap.values());
      const hasCritical = finalComments.some((c) => c.severity === "CRITICAL");

      return {
        summary: "Đã hoàn thành đánh giá chuyên sâu qua các chuyên gia.",
        verdict: hasCritical
          ? "REQUEST_CHANGES"
          : finalComments.length > 0
            ? "COMMENT"
            : "APPROVE",
        riskLevel: hasCritical
          ? "HIGH"
          : finalComments.length > 0
            ? "MEDIUM"
            : "LOW",
        comments: finalComments,
      };
    }
  }

  /**
   * Main Entrypoint: Multi-Agent Code Review
   */
  async reviewCode(
    diffs: GitLabDiffItem[],
    mrContext?: MRContext,
  ): Promise<AIReviewResult> {
    const batches = chunkDiffs(diffs);

    if (batches.length === 0) {
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

    const customRules = mrContext?.customRules || loadProjectRules();
    const customRulesSection = customRules
      ? `\nQUY TẮC BẮT BUỘC CỦA DỰ ÁN (PROJECT RULES):\n${customRules}\n`
      : "";

    console.log(
      `[MultiAgentReview] Reviewing ${batches.length} diff batches across ${REVIEW_ROLES.length} specialist roles...`,
    );

    const allRoleOutputs: RoleReviewOutput[] = [];

    // Chạy review song song cho từng batch
    for (const batch of batches) {
      console.log(
        `[MultiAgentReview] Processing Batch ${batch.batchIndex}/${batch.totalBatches} (${batch.files.length} files)...`,
      );

      const rolePromises = REVIEW_ROLES.map((role) =>
        this.runRoleReview(role, batch, contextSection, customRulesSection),
      );

      const results = await Promise.allSettled(rolePromises);
      for (const res of results) {
        if (res.status === "fulfilled") {
          allRoleOutputs.push(res.value);
        }
      }
    }

    console.log(
      `[MultiAgentReview] Running Lead Consolidator & False-Positive Filter...`,
    );
    const finalResult = await this.consolidateReviews(
      allRoleOutputs,
      batches,
      contextSection,
      customRulesSection,
    );

    return finalResult;
  }
}
