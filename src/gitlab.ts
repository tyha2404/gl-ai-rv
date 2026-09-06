import { Gitlab } from "@gitbeaker/rest";
import dotenv from "dotenv";

dotenv.config();

export class GitLabClient {
  private api: any;

  constructor() {
    this.api = new Gitlab({
      host: process.env.GITLAB_URL || "https://gitlab.com",
      token: process.env.GITLAB_TOKEN,
    });
  }

  async getMergeRequestDiff(projectId: string | number, mergeRequestIid: number) {
    try {
      // Ưu tiên dùng allDiffs (GitLab API v4 mới nhất)
      if (typeof this.api.MergeRequests.allDiffs === "function") {
        const diffs = await this.api.MergeRequests.allDiffs(projectId, mergeRequestIid);
        return diffs || [];
      }
      // Fallback nếu dùng GitLab phiên bản cũ
      const response = await this.api.MergeRequests.showChanges(projectId, mergeRequestIid);
      return response.changes || [];
    } catch (error: any) {
      console.error(`Error fetching MR changes:`, error.message);
      // Fallback thử lại phương thức còn lại nếu gặp lỗi
      try {
        const response = await this.api.MergeRequests.showChanges(projectId, mergeRequestIid);
        return response.changes || [];
      } catch {
        throw error;
      }
    }
  }

  async postComment(projectId: string | number, mergeRequestIid: number, body: string) {
    try {
      return await this.api.MergeRequestNotes.create(projectId, mergeRequestIid, body);
    } catch (error) {
      console.error("Error posting comment:", error);
      throw error;
    }
  }

  async postLineComment(projectId: string | number, mergeRequestIid: number, comment: { 
    body: string; 
    path: string; 
    line: number; 
    type: "new" | "old" 
  }, diffRefs: any) {
    try {
      if (!diffRefs.base_sha || !diffRefs.head_sha || !diffRefs.start_sha) {
        throw new Error("Missing SHA in diffRefs");
      }

      return await this.api.MergeRequestDiscussions.create(projectId, mergeRequestIid, comment.body, {
        position: {
          base_sha: diffRefs.base_sha,
          start_sha: diffRefs.start_sha,
          head_sha: diffRefs.head_sha,
          position_type: "text",
          new_path: comment.path,
          old_path: comment.path,
          new_line: comment.type === "new" ? comment.line : undefined,
          old_line: comment.type === "old" ? comment.line : undefined,
        }
      });
    } catch (error: any) {
      throw error;
    }
  }

  async getMergeRequest(projectId: string | number, mergeRequestIid: number) {
    try {
      return await this.api.MergeRequests.show(projectId, mergeRequestIid);
    } catch (error) {
      console.error("Error fetching MR:", error);
      throw error;
    }
  }

  async addLabel(projectId: string | number, mergeRequestIid: number, labels: string[]) {
    try {
      const mr = await this.getMergeRequest(projectId, mergeRequestIid);
      const currentLabels = (mr as any).labels || [];
      const newLabels = Array.from(new Set([...currentLabels, ...labels]));
      
      return await this.api.MergeRequests.edit(projectId, mergeRequestIid, {
        labels: newLabels.join(","),
      });
    } catch (error) {
      console.error("Error adding labels:", error);
      throw error;
    }
  }
}
