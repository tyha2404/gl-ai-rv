import { Gitlab } from "@gitbeaker/rest";
import dotenv from "dotenv";

dotenv.config();

export class GitLabClient {
  private api: any;

  constructor(gitlabUrl?: string, gitlabToken?: string) {
    this.api = new Gitlab({
      host: gitlabUrl || process.env.GITLAB_URL || "https://gitlab.com",
      token: gitlabToken || process.env.GITLAB_TOKEN,
    });
  }

  async getMergeRequestDiff(
    projectId: string | number,
    mergeRequestIid: number,
  ) {
    try {
      const response = await this.api.MergeRequests.showChanges(
        projectId,
        mergeRequestIid,
      );
      return response.changes || response || [];
    } catch (err1: any) {
      try {
        if (typeof this.api.MergeRequests.allDiffs === "function") {
          const diffs = await this.api.MergeRequests.allDiffs(
            projectId,
            mergeRequestIid,
          );
          return diffs || [];
        }
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
