import dotenv from "dotenv";
import express from "express";
import { AIClient, AIReviewComment } from "./ai";
import {
  extractModifiedSymbolsFromDiff,
  ImpactAnalysisReport,
  ImpactAnalyzer,
} from "./analyzer/impact";
import { GitLabClient, shouldPostToGitLab } from "./gitlab";
import { KnowledgeStore } from "./knowledge";
import { ClaudeRunner, deriveVerdict, dropFabricatedComments } from "./claude";
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
const claudeRunner = new ClaudeRunner();
const knowledgeStore = new KnowledgeStore();
const knowledgeEnabled = process.env.KNOWLEDGE_ENABLED !== "false";

process.on("uncaughtException", (error) => {
  console.error("[Fatal] Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Fatal] Unhandled Rejection at:", promise, "reason:", reason);
});

app.use(express.json());

app.get("/", (_req, res) => {
  res.send("GitLab Multi-Agent AI Reviewer is running!");
});

async function learnFromReview(
  project: string,
  repoPath: string,
  mrInfo: { title: string; repoName: string },
  rawDiff: string,
  findings: AIReviewComment[],
  previousKnowledge: string,
): Promise<void> {
  try {
    await knowledgeStore.withLock(project, async () => {
      // đọc lại trong lock để không dựa vào bản cũ nếu MR khác vừa học xong
      const latest = knowledgeStore.load(project) || previousKnowledge;
      const updated = await claudeRunner.learn({
        repoPath,
        repoName: mrInfo.repoName,
        previousKnowledge: latest,
        maxChars: knowledgeStore.maxChars,
        title: mrInfo.title,
        rawDiff,
        findings,
      });
      if (knowledgeStore.save(project, updated)) {
        console.log(`[Knowledge] Updated knowledge for ${project}.`);
      }
    });
  } catch (learnErr) {
    console.warn(`[Knowledge] Learning failed for ${project}:`, learnErr);
  }
}

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

    // Quét phạm vi ảnh hưởng tốn thời gian (đọc toàn repo) và Claude tự Grep được,
    // nên chỉ chạy khi cần cho các engine fallback, và chỉ chạy một lần.
    let impactCache: Promise<ImpactAnalysisReport | undefined> | undefined;
    const getImpactReport = () => {
      impactCache ??= (async () => {
        if (!localRepoPath || !localRawDiff) return undefined;
        try {
          return await impactAnalyzer.analyzeImpact(
            localRepoPath,
            extractModifiedSymbolsFromDiff(localRawDiff),
          );
        } catch (impactErr) {
          console.warn("[Impact] Analysis failed:", impactErr);
          return undefined;
        }
      })();
      return impactCache;
    };

    const projectKnowledge = knowledgeEnabled
      ? knowledgeStore.load(projectPathWithNamespace)
      : "";

    let reviewResult;
    let verificationNote: string | undefined;
    const useClaude = process.env.USE_CLAUDE === "true";
    const claudeFallback = process.env.CLAUDE_FALLBACK !== "false";
    let claudeSucceeded = false;
    const useOpenCode =
      process.env.USE_OPENCODE === "true" ||
      process.env.OPENCODE_ENABLED === "true";

    // Claude CLI (review 2 pass có kiểm chứng) là engine đáng tin nhất; lỗi thì báo, không fallback ngầm
    if (useClaude) {
      if (!localRepoPath) {
        throw new Error(
          "Claude review cần local workspace nhưng sync thất bại",
        );
      }
      try {
        const claudeResult = await claudeRunner.runReview({
          repoPath: localRepoPath,
          title: mrInfo.title,
          author: mrInfo.author,
          repoName: mrInfo.repoName,
          targetBranch: mrInfo.targetBranch,
          description: mrInfo.description,
          commits,
          rawDiff: localRawDiff,
          projectKnowledge,
        });
        const v = claudeResult.verification;
        verificationNote = `Claude phát hiện ${v.raised}, kiểm chứng đúng ${v.verified} (loại ${v.droppedNoEvidence} thiếu bằng chứng, ${v.droppedByVerifier} bị phản biện bác bỏ).`;
        reviewResult = claudeResult;
        claudeSucceeded = true;
      } catch (claudeErr) {
        if (!claudeFallback) throw claudeErr;
        const reason =
          claudeErr instanceof Error ? claudeErr.message : String(claudeErr);
        verificationNote = `⚠️ Claude lỗi (${reason.slice(0, 150)}) nên kết quả dưới đây từ agent miễn phí, KHÔNG được kiểm chứng. Độ tin cậy thấp, nên review thủ công.`;
        console.warn(
          `[Claude] Failed, falling back to free agents:`,
          claudeErr,
        );
      }
    }

    // Khởi chạy OpenCode trên VPS nếu được kích hoạt và có local repo
    if (!reviewResult && useOpenCode && localRepoPath) {
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
          impactReport: await getImpactReport(),
          projectKnowledge,
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

    // Fallback sang AIClient (Unified / Multi-agent) nếu OpenCode không chạy, gặp lỗi, hoặc bị ngắt quãng giữa chừng
    const isOpenCodeIncomplete =
      !claudeSucceeded &&
      reviewResult &&
      reviewResult.comments.length === 0 &&
      reviewResult.verdict === "COMMENT" &&
      (reviewResult.summary.includes("Let me") ||
        reviewResult.summary.includes("Đã chạy OpenCode review xong") ||
        !reviewResult.summary.includes("đạt"));

    if (!reviewResult || isOpenCodeIncomplete) {
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
        impactReport: await getImpactReport(),
        projectKnowledge,
      });
    }

    // Kết quả từ agent free: loại comment có evidence không khớp code thật
    if (!claudeSucceeded && localRepoPath) {
      const { kept, dropped } = dropFabricatedComments(
        localRepoPath,
        reviewResult.comments,
      );
      if (dropped > 0) {
        console.warn(
          `[AIReview] Dropped ${dropped} comments with fabricated evidence.`,
        );
        reviewResult = { ...reviewResult, comments: kept };
        verificationNote = `${verificationNote ? verificationNote + " " : ""}Đã loại ${dropped} comment có bằng chứng không khớp code thật.`;
      }
    }

    // Verdict/risk nhất quán giữa mọi engine: suy ra từ severity thay vì tin model
    if (reviewResult.comments.length > 0) {
      reviewResult = {
        ...reviewResult,
        ...deriveVerdict(reviewResult.comments),
      };
    }

    console.log(
      `[AIReview] Completed for MR #${iid}. Verdict: ${reviewResult.verdict}, Risk: ${reviewResult.riskLevel}, Issues: ${reviewResult.comments.length}`,
    );

    // Đăng thẳng lên GitLab các lỗi BUG/CRITICAL. Với agent free chỉ đăng comment đã có evidence khớp code.
    if (process.env.GITLAB_COMMENTS_ENABLED !== "false") {
      const toPost = reviewResult.comments.filter(
        (c) => shouldPostToGitLab(c) && (claudeSucceeded || !!c.evidence),
      );
      if (toPost.length > 0) {
        try {
          const posted = await gitlab.postReviewComments(
            projectId,
            iid,
            toPost,
          );
          console.log(`[GitLab] Posted comments for MR #${iid}:`, posted);
          verificationNote = `${verificationNote ? verificationNote + " " : ""}Đã đăng ${posted.inline + posted.general} comment BUG/CRITICAL lên GitLab (${posted.skippedDuplicate} trùng, ${posted.failed} lỗi).`;
        } catch (postErr) {
          console.error("[GitLab] Failed to post review comments:", postErr);
        }
      }
    }

    // 4. Gửi báo cáo phân tích chi tiết về Google Chat (Cards V2)
    console.log(
      `[Notifier] Sending review report to Google Chat for MR #${iid}`,
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
      verificationNote,
    });

    console.log(`[AIReview] Process finished successfully for MR #${iid}.`);

    // 5. Học từ lần review này (nghiệp vụ, kiến trúc, lỗi hay gặp). Chạy sau khi đã gửi kết quả nên không làm chậm review.
    if (knowledgeEnabled && claudeSucceeded && localRepoPath) {
      await learnFromReview(
        projectPathWithNamespace,
        localRepoPath,
        mrInfo,
        localRawDiff,
        reviewResult.comments,
        projectKnowledge,
      );
    }
  } catch (error) {
    console.error("[AIReview] Error in handleAIReview:", error);
    await notifier.sendFailureNotification({
      title: mrInfo.title,
      url: mrInfo.url,
      repoName: mrInfo.repoName,
      mrId: iid,
      error: error instanceof Error ? error.message : String(error),
    });
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
