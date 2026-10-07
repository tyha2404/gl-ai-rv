import dotenv from "dotenv";
import OpenAI from "openai";
import { ImpactAnalysisReport } from "./analyzer/impact";
import { loadProjectRules } from "./config/rules";
import {
  buildContextSection,
  buildReviewOutputSchema,
  buildRoleOutputSchema,
  LEAD_CONSOLIDATOR_PROMPT,
  REVIEW_CRITERIA,
  REVIEW_ROLES,
  UNIFIED_MULTI_ROLE_PROMPT,
} from "./roles/prompts";
import { extractTechStackSummary } from "./utils/context";
import { chunkDiffs, DiffBatch, GitLabDiffItem } from "./utils/diff";
import { callWithRetry, RateLimitQueue } from "./utils/rateLimiter";
import { GitCommitInfo } from "./workspace";

dotenv.config();

export type Severity = "CRITICAL" | "WARNING" | "SUGGESTION";
export type Category = "SECURITY" | "BUG" | "PERFORMANCE" | "CLEAN_CODE";
export type ReviewStrategy = "unified" | "multi_agent";

export interface AIReviewComment {
  path: string;
  line: number;
  severity: Severity;
  category: Category;
  text: string;
  suggestion?: string | undefined;
  /** Đoạn code trích nguyên văn làm bằng chứng; dùng để lọc finding bịa đặt. */
  evidence?: string | undefined;
}

export interface AIReviewResult {
  summary: string;
  verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  comments: AIReviewComment[];
  impactAssessment?: string | undefined;
}

export interface MRContext {
  title: string;
  author: string;
  repoName: string;
  targetBranch: string;
  description?: string | undefined;
  customRules?: string | undefined;
  projectKnowledge?: string | undefined;
  techStack?: string | undefined;
  commits?: GitCommitInfo[] | undefined;
  impactReport?: ImpactAnalysisReport | undefined;
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
  private strategy: ReviewStrategy;
  private queue: RateLimitQueue;

  constructor(
    customClient?: OpenAI,
    customModel?: string,
    customStrategy?: ReviewStrategy,
  ) {
    this.strategy =
      customStrategy ||
      ((
        process.env.REVIEW_STRATEGY || "unified"
      ).toLowerCase() as ReviewStrategy);

    this.queue = new RateLimitQueue();

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
   * Chế độ 1: UNIFIED REVIEW (Tối ưu cho 1 RPM & Model Free)
   * Đóng gói cả 4 lăng kính chuyên môn trong duy nhất 1 request.
   */
  private async reviewCodeUnified(
    batches: DiffBatch[],
    contextSection: string,
  ): Promise<AIReviewResult> {
    const combinedDiffText = batches
      .map((b) => b.formattedDiffText)
      .join("\n\n");

    const prompt = `
${contextSection}

${REVIEW_CRITERIA}

${buildReviewOutputSchema()}

DIFF CẦN REVIEW:
${combinedDiffText}
`.trim();

    try {
      const response = await callWithRetry(async () => {
        return await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: "system", content: UNIFIED_MULTI_ROLE_PROMPT },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        });
      });

      const raw = response?.choices?.[0]?.message?.content || "{}";
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
            evidence: c.evidence ? String(c.evidence) : undefined,
          }))
        : [];

      return {
        summary:
          parsed.summary ||
          "Đã hoàn thành đánh giá toàn diện cho Merge Request.",
        verdict:
          parsed.verdict || (comments.length > 0 ? "COMMENT" : "APPROVE"),
        riskLevel: parsed.riskLevel || (comments.length > 0 ? "MEDIUM" : "LOW"),
        comments,
      };
    } catch (error) {
      console.error("[AIClient] Error in reviewCodeUnified:", error);
      return {
        summary: "Đã xảy ra lỗi trong quá trình phân tích code bằng AI.",
        verdict: "COMMENT",
        riskLevel: "HIGH",
        comments: [],
      };
    }
  }

  /**
   * Chế độ 2: MULTI_AGENT REVIEW (Chạy tuần tự qua Hàng đợi Rate Limit)
   */
  private async reviewCodeMultiAgent(
    batches: DiffBatch[],
    contextSection: string,
  ): Promise<AIReviewResult> {
    const allRoleOutputs: RoleReviewOutput[] = [];

    for (const batch of batches) {
      for (const role of REVIEW_ROLES) {
        const prompt = `
${contextSection}

[DIFF CẦN REVIEW - BATCH ${batch.batchIndex}/${batch.totalBatches}]:
${batch.formattedDiffText}

HƯỚNG DẪN REVIEW:
- Đóng đúng vai trò: ${role.name}.
- Chỉ tìm các vấn đề thuộc nhóm Category: "${role.category}".

${buildRoleOutputSchema(role.category)}
`.trim();

        try {
          const res = await this.queue.enqueue(() =>
            callWithRetry(() =>
              this.client.chat.completions.create({
                model: this.model,
                messages: [
                  { role: "system", content: role.systemPrompt },
                  { role: "user", content: prompt },
                ],
                temperature: 0.1,
                response_format: { type: "json_object" },
              }),
            ),
          );

          const raw = res.choices[0]?.message?.content || "{}";
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
                evidence: c.evidence ? String(c.evidence) : undefined,
              }))
            : [];

          allRoleOutputs.push({
            role: role.name,
            category: role.category,
            comments,
            analysis: parsed.analysis || "",
          });
        } catch (err) {
          console.warn(
            `[MultiAgentReview] Role ${role.name} error on batch ${batch.batchIndex}:`,
            err,
          );
        }
      }
    }

    // Lead Consolidator Step
    const allRawComments: AIReviewComment[] = [];
    for (const out of allRoleOutputs) {
      allRawComments.push(...out.comments);
    }

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

KẾT QUẢ THÔ TỪ CÁC CHUYÊN GIA REVIEW:
${JSON.stringify(allRoleOutputs, null, 2)}

DIFF CỦA CÁC FILE ĐƯỢC REVIEW:
${batches.map((b) => b.formattedDiffText).join("\n\n")}

NHIỆM VỤ CỦA LEAD REVIEWER:
1. Thẩm định chéo (Critique): Kiểm tra lại xem các comment từ chuyên gia có thật sự chính xác, có đúng dòng không, có bị false positive không.
2. Khử trùng lặp (Deduplicate): Nếu cùng 1 file và line bị nhiều chuyên gia nhắc đến, gộp lại thành 1 comment hoàn chỉnh với mức severity cao nhất.
3. Đánh giá tổng quan: Viết summary (2-3 câu tiếng Việt súc tích), chọn verdict và riskLevel phù hợp.

${buildReviewOutputSchema()}
`.trim();

    try {
      const response = await this.queue.enqueue(() =>
        callWithRetry(() =>
          this.client.chat.completions.create({
            model: this.model,
            messages: [
              { role: "system", content: LEAD_CONSOLIDATOR_PROMPT },
              { role: "user", content: consolidatorPrompt },
            ],
            temperature: 0.1,
            response_format: { type: "json_object" },
          }),
        ),
      );

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
            evidence: c.evidence ? String(c.evidence) : undefined,
          }))
        : allRawComments;

      return {
        summary:
          parsed.summary ||
          "Đã hoàn thành phân tích đa chuyên gia cho Merge Request.",
        verdict:
          parsed.verdict || (finalComments.length > 0 ? "COMMENT" : "APPROVE"),
        riskLevel:
          parsed.riskLevel || (finalComments.length > 0 ? "MEDIUM" : "LOW"),
        comments: finalComments,
      };
    } catch (err) {
      console.warn(
        "[MultiAgentReview] Lead Consolidator error, using fallback deduplication:",
        err,
      );
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
   * Main Entrypoint
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

    const contextSection = buildContextSection({
      title: mrContext?.title ?? "(không rõ)",
      author: mrContext?.author ?? "(không rõ)",
      repoName: mrContext?.repoName ?? "(không rõ)",
      targetBranch: mrContext?.targetBranch ?? "(không rõ)",
      description: mrContext?.description,
      commits: mrContext?.commits,
      impactSummary: mrContext?.impactReport?.summary,
      impactedFiles: mrContext?.impactReport?.impactedFiles,
      techStack: mrContext?.techStack || extractTechStackSummary(),
      projectRules: mrContext?.customRules || loadProjectRules(),
      projectKnowledge: mrContext?.projectKnowledge,
    });

    console.log(
      `[AIReview] Starting review using strategy '${this.strategy}' (${batches.length} diff batches)...`,
    );

    if (this.strategy === "multi_agent") {
      return await this.reviewCodeMultiAgent(batches, contextSection);
    }

    // Default: 'unified' (1 request for 1 RPM & Model Free safety)
    return await this.reviewCodeUnified(batches, contextSection);
  }
}
