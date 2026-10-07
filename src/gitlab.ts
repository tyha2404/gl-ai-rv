import { Gitlab } from "@gitbeaker/rest";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { AIReviewComment } from "./ai";

dotenv.config();

const MARKER_PREFIX = "<!-- ai-review:";

/** Chỉ đăng thẳng lên GitLab các lỗi BUG hoặc mức CRITICAL. */
export function shouldPostToGitLab(c: AIReviewComment): boolean {
  return c.category === "BUG" || c.severity === "CRITICAL";
}

/** Dấu vân tay không phụ thuộc số dòng, để MR update không đăng trùng comment cũ. */
export function commentFingerprint(c: AIReviewComment): string {
  const normalized = `${c.path}|${c.category}|${c.text.replace(/\s+/g, " ").trim().slice(0, 120)}`;
  return crypto
    .createHash("sha1")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);
}

/** Comment như người nói chuyện: chỉ văn bản thường + dấu ẩn để chống đăng trùng. */
export function formatGitLabComment(c: AIReviewComment): string {
  return `${c.text.trim()}\n\n${MARKER_PREFIX}${commentFingerprint(c)} -->`;
}

export interface PostCommentsResult {
  inline: number;
  general: number;
  skippedDuplicate: number;
  failed: number;
}

export class GitLabClient {
  private api: any;

  constructor(gitlabUrl?: string, gitlabToken?: string, api?: unknown) {
    this.api =
      api ??
      new Gitlab({
        host: gitlabUrl || process.env.GITLAB_URL || "https://gitlab.com",
        token: gitlabToken || process.env.GITLAB_TOKEN,
      });
  }

  /**
   * Đăng comment lên MR: ưu tiên inline tại đúng dòng; nếu GitLab từ chối vị trí
   * (dòng không nằm trong diff) thì đăng thành discussion chung kèm path:line.
   * Bỏ qua comment đã đăng trước đó (theo fingerprint).
   */
  async postReviewComments(
    projectId: string | number,
    mergeRequestIid: number,
    comments: AIReviewComment[],
  ): Promise<PostCommentsResult> {
    const result: PostCommentsResult = {
      inline: 0,
      general: 0,
      skippedDuplicate: 0,
      failed: 0,
    };
    if (comments.length === 0) return result;

    const existing = new Set<string>();
    try {
      const discussions: any[] =
        (await this.api.MergeRequestDiscussions.all(
          projectId,
          mergeRequestIid,
        )) || [];
      for (const d of discussions) {
        for (const n of d.notes || []) {
          const m = String(n.body || "").match(
            /<!-- ai-review:([a-f0-9]+) -->/,
          );
          if (m?.[1]) existing.add(m[1]);
        }
      }
    } catch (err) {
      console.warn("[GitLabClient] Could not list existing discussions:", err);
    }

    let diffRefs: any;
    try {
      const mr = await this.api.MergeRequests.show(projectId, mergeRequestIid);
      diffRefs = mr?.diff_refs;
    } catch (err) {
      console.warn("[GitLabClient] Could not fetch diff_refs:", err);
    }

    for (const c of comments) {
      if (existing.has(commentFingerprint(c))) {
        result.skippedDuplicate++;
        continue;
      }
      const body = formatGitLabComment(c);

      if (diffRefs?.base_sha && diffRefs.head_sha && diffRefs.start_sha) {
        try {
          await this.api.MergeRequestDiscussions.create(
            projectId,
            mergeRequestIid,
            body,
            {
              position: {
                positionType: "text",
                baseSha: diffRefs.base_sha,
                startSha: diffRefs.start_sha,
                headSha: diffRefs.head_sha,
                oldPath: c.path,
                newPath: c.path,
                newLine: String(c.line),
              },
            },
          );
          result.inline++;
          continue;
        } catch (err: any) {
          console.warn(
            `[GitLabClient] Inline comment failed for ${c.path}:${c.line}, falling back to general: ${err?.message ?? err}`,
          );
        }
      }

      try {
        await this.api.MergeRequestDiscussions.create(
          projectId,
          mergeRequestIid,
          `(${c.path}:${c.line}) ${body}`,
        );
        result.general++;
      } catch (err: any) {
        console.error(
          `[GitLabClient] Failed to post comment for ${c.path}:${c.line}: ${err?.message ?? err}`,
        );
        result.failed++;
      }
    }

    return result;
  }

  async getMergeRequestDiff(
    projectId: string | number,
    mergeRequestIid: number,
  ) {
    try {
      if (typeof this.api.MergeRequests.allDiffs === "function") {
        const diffs = await this.api.MergeRequests.allDiffs(
          projectId,
          mergeRequestIid,
        );
        return diffs || [];
      }
      const response = await this.api.MergeRequests.showChanges(
        projectId,
        mergeRequestIid,
      );
      return response.changes || response || [];
    } catch (err1: any) {
      try {
        const response = await this.api.MergeRequests.showChanges(
          projectId,
          mergeRequestIid,
        );
        return response.changes || response || [];
      } catch (err2: any) {
        console.error(
          `[GitLabClient] Error fetching MR diffs for MR #${mergeRequestIid}:`,
          err1?.message || err2?.message,
        );
      }
      throw err1;
    }
  }
}
