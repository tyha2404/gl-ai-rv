import dotenv from "dotenv";
import express from "express";
import { AIClient } from "./ai";
import {
  extractModifiedSymbolsFromDiff,
  ImpactAnalyzer,
} from "./analyzer/impact";
import { GitLabClient } from "./gitlab";
import { GoogleChatNotifier } from "./notifier";
import { OpenCodeRunner } from "./opencode";
import { filterDiffs } from "./utils/diff";
import { GitCommitInfo, WorkspaceManager } from "./workspace";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const gitlab = new GitLabClient();
const ai = new AIClient();
const notifier = new GoogleChatNotifier();
const workspaceManager = new WorkspaceManager();
const impactAnalyzer = new ImpactAnalyzer();
const openCodeRunner = new OpenCodeRunner();

process.on("uncaughtException", (error) => {
  console.error("[Fatal] Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Fatal] Unhandled Rejection at:", promise, "reason:", reason);
});

app.use(express.json());

app.get("/", (req, res) => {
  res.send("GitLab Multi-Agent AI Reviewer is running!");
});

async function handleAIReview(
  projectId: number,
  iid: number,
  projectPathWithNamespace: string,
  sourceBranch: string,
  targetBranch: string,
  mrInfo: {
    title: string;
    author: string;
    url: string;
    repoName: string;
    targetBranch: string;
    description?: string | undefined;
  },
) {
  try {
    console.log(
      `[AIReview] Starting local workspace sync for MR #${iid} (${projectPathWithNamespace} @ ${sourceBranch} -> ${targetBranch})...`,
    );

    let commits: GitCommitInfo[] = [];
    let impactReport: any = undefined;
    let diffs: any[] = [];
    let localRepoPath = "";
    let localRawDiff = "";

    // 1. Đồng bộ repo cục bộ trên VPS (Clone/Fetch/Checkout/Pull)
    try {
      const syncResult = await workspaceManager.syncAndGetMRDiff({
        projectPathWithNamespace,
        sourceBranch,
        targetBranch,
      });
      commits = syncResult.commits;
      localRepoPath = syncResult.repoPath;
      localRawDiff = syncResult.rawDiff;

      // 2. Phân tích symbol và quét phạm vi ảnh hưởng (Impact Analysis)
      if (syncResult.rawDiff) {
        const modifiedSymbols = extractModifiedSymbolsFromDiff(
          syncResult.rawDiff,
        );
        impactReport = await impactAnalyzer.analyzeImpact(
          syncResult.repoPath,
          modifiedSymbols,
        );
      }
    } catch (wsErr) {
      console.warn(
        `[AIReview] Local workspace sync notice for MR #${iid}:`,
        wsErr,
      );
    }

    // 3. Lấy danh sách diffs từ GitLab API (hoặc fallback)
    try {
      diffs = await gitlab.getMergeRequestDiff(projectId, iid);
    } catch (glErr) {
      console.error(
        `[AIReview] Failed to fetch MR diffs from GitLab API:`,
        glErr,
      );
    }

    const validDiffs = filterDiffs(diffs);
    if (validDiffs.length === 0 && !localRawDiff) {
      console.log(`[AIReview] No reviewable diffs found for MR #${iid}.`);
      return;
    }

    let reviewResult;
    const useOpenCode =
      process.env.USE_OPENCODE === "true" ||
      process.env.OPENCODE_ENABLED === "true";

    // Khởi chạy OpenCode trên VPS nếu được kích hoạt và có local repo
    if (useOpenCode && localRepoPath) {
      try {
        console.log(
          `[OpenCode] Starting OpenCode review session in VPS repo: ${localRepoPath}...`,
        );
        reviewResult = await openCodeRunner.runReview({
          repoPath: localRepoPath,
          title: mrInfo.title,
          author: mrInfo.author,
          repoName: mrInfo.repoName,
          targetBranch: mrInfo.targetBranch,
          description: mrInfo.description,
          commits,
          rawDiff: localRawDiff,
          impactReport,
        });
        console.log(
          `[OpenCode] Review session completed and process stopped cleanly.`,
        );
      } catch (opencodeErr) {
        console.warn(
          `[OpenCode] Error running OpenCode CLI, falling back to AIClient:`,
          opencodeErr,
        );
      }
    }

    // Fallback sang AIClient (Unified / Multi-agent) nếu OpenCode không chạy hoặc gặp lỗi
    if (!reviewResult) {
      console.log(
        `[AIReview] Running review via AIClient for MR #${iid} (${validDiffs.length} files, ${commits.length} commits)...`,
      );
      reviewResult = await ai.reviewCode(validDiffs, {
        title: mrInfo.title,
        author: mrInfo.author,
        repoName: mrInfo.repoName,
        targetBranch: mrInfo.targetBranch,
        description: mrInfo.description,
        commits,
        impactReport,
      });
    }

    console.log(
      `[AIReview] Completed for MR #${iid}. Verdict: ${reviewResult.verdict}, Risk: ${reviewResult.riskLevel}, Issues: ${reviewResult.comments.length}`,
    );

    // 4. Gửi báo cáo phân tích chi tiết về Google Chat (Cards V2)
    console.log(
      `[Notifier] Sending review report with impact analysis to Google Chat for MR #${iid}`,
    );
    await notifier.sendReviewNotification({
      title: mrInfo.title,
      author: mrInfo.author,
      url: mrInfo.url,
      repoName: mrInfo.repoName,
      mrId: iid,
      targetBranch: mrInfo.targetBranch,
      summary: reviewResult.summary,
      verdict: reviewResult.verdict,
      riskLevel: reviewResult.riskLevel,
      comments: reviewResult.comments || [],
      commits,
      impactReport,
    });

    console.log(`[AIReview] Process finished successfully for MR #${iid}.`);
  } catch (error) {
    console.error("[AIReview] Error in handleAIReview:", error);
  }
}

app.post("/webhook", async (req, res) => {
  const event = req.headers["x-gitlab-event"];
  const payload = req.body;

  if (event === "Merge Request Hook") {
    const { object_attributes, project, user } = payload;
    const {
      iid,
      action,
      state,
      title,
      description,
      source,
      source_branch,
      target_branch,
      work_in_progress,
    } = object_attributes;
    const projectId = project.id;
    const repoName = project.name;
    const projectPathWithNamespace =
      project.path_with_namespace || project.name;

    // Bỏ qua nếu là draft / WIP MR
    if (
      work_in_progress ||
      title.startsWith("Draft:") ||
      title.startsWith("WIP:")
    ) {
      console.log(`[Webhook] MR #${iid} is Draft/WIP. Skipping review.`);
      res.status(200).send("Draft MR ignored");
      return;
    }

    // Trigger on open, reopen or code update
    if (state === "opened" || state === "reopened" || action === "update") {
      res.status(200).send("Processing");

      const mrInfo = {
        title: title,
        author: user.name,
        url:
          source?.http_url ||
          `https://gitlab.com/${projectPathWithNamespace}/-/merge_requests/${iid}`,
        repoName: repoName,
        targetBranch: target_branch,
        description: description || undefined,
      };

      handleAIReview(
        projectId,
        iid,
        projectPathWithNamespace,
        source_branch,
        target_branch,
        mrInfo,
      );
    } else {
      res.status(200).send("Ignored");
    }
  } else {
    res.status(200).send("Not an MR event");
  }
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
