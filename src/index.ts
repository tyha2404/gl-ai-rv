import dotenv from "dotenv";
import express from "express";
import { AIClient } from "./ai";
import { GitLabClient } from "./gitlab";
import { GoogleChatNotifier } from "./notifier";
import { filterDiffs } from "./utils/diff";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const gitlab = new GitLabClient();
const ai = new AIClient();
const notifier = new GoogleChatNotifier();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("GitLab Multi-Agent AI Reviewer is running!");
});

async function handleAIReview(
  projectId: number,
  iid: number,
  diffs: any[],
  mrInfo: {
    title: string;
    author: string;
    url: string;
    repoName: string;
    targetBranch: string;
    description?: string;
  },
) {
  try {
    const validDiffs = filterDiffs(diffs);
    if (validDiffs.length === 0) {
      console.log(`[AIReview] No reviewable diffs found for MR #${iid}.`);
      return;
    }

    console.log(
      `[AIReview] Starting Multi-Role AI Review for MR #${iid} (${validDiffs.length} files)...`,
    );
    const reviewResult = await ai.reviewCode(validDiffs, {
      title: mrInfo.title,
      author: mrInfo.author,
      repoName: mrInfo.repoName,
      targetBranch: mrInfo.targetBranch,
      description: mrInfo.description,
    });

    console.log(
      `[AIReview] Completed for MR #${iid}. Verdict: ${reviewResult.verdict}, Risk: ${reviewResult.riskLevel}, Issues: ${reviewResult.comments.length}`,
    );

    // Gửi báo cáo phân tích chi tiết về Google Chat (Cards V2)
    console.log(
      `[Notifier] Sending multi-agent review report to Google Chat for MR #${iid}`,
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
      target_branch,
      work_in_progress,
    } = object_attributes;
    const projectId = project.id;
    const repoName = project.name;

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
      try {
        const diffs = await gitlab.getMergeRequestDiff(projectId, iid);

        res.status(200).send("Processing");

        const mrInfo = {
          title: title,
          author: user.name,
          url:
            source?.http_url ||
            `https://gitlab.com/${project.path_with_namespace}/-/merge_requests/${iid}`,
          repoName: repoName,
          targetBranch: target_branch,
          description: description || undefined,
        };

        handleAIReview(projectId, iid, diffs, mrInfo);
      } catch (error) {
        console.error("[Webhook] Processing error:", error);
        res.status(500).send("Error");
      }
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
