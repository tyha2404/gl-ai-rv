import dotenv from "dotenv";
import express from "express";
import { AIClient } from "./ai";
import { GitLabClient } from "./gitlab";
import { GoogleChatNotifier } from "./notifier";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const gitlab = new GitLabClient();
const ai = new AIClient();
const notifier = new GoogleChatNotifier();

app.use(express.json());

const IGNORED_FILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".env",
  ".gitignore",
  "dist/",
  "node_modules/",
];

function filterDiffs(diffs: any[]) {
  return diffs.filter((diff) => {
    const path = diff.new_path || diff.old_path;
    return !IGNORED_FILES.some((ignored) => path.includes(ignored));
  });
}

app.get("/", (req, res) => {
  res.send("GitLab AI Reviewer is running!");
});

async function handleAIReview(
  projectId: number,
  iid: number,
  diffs: any[],
  diffRefs: any,
  mrInfo: {
    title: string;
    author: string;
    url: string;
    repoName: string;
    targetBranch: string;
  },
) {
  try {
    const filteredDiffs = filterDiffs(diffs);
    if (filteredDiffs.length === 0) return;

    console.log(`Starting AI Review for MR #${iid}...`);
    const reviewResult = await ai.reviewCode(filteredDiffs);

    console.log(
      `AI Review completed for MR #${iid}. Summary: ${JSON.stringify(reviewResult.summary)}. Comments: ${JSON.stringify(reviewResult.comments)}`,
    );

    // Send notification to Google Chat (Detailed)
    console.log(`Sending enriched notification to Google Chat for MR #${iid}`);
    await notifier.sendReviewNotification({
      title: mrInfo.title,
      author: mrInfo.author,
      url: mrInfo.url,
      repoName: mrInfo.repoName,
      mrId: iid,
      targetBranch: mrInfo.targetBranch,
      summary: reviewResult.summary,
      comments: reviewResult.comments || [],
    });

    console.log(`Found ${reviewResult.comments.length} issues for MR #${iid}.`);

    console.log(`AI Review for MR #${iid} completed.`);
  } catch (error) {
    console.error("Error in handleAIReview:", error);
  }
}

app.post("/webhook", async (req, res) => {
  const event = req.headers["x-gitlab-event"];
  const payload = req.body;

  if (event === "Merge Request Hook") {
    const { object_attributes, project, user } = payload;
    const { iid, action, state, title, source, target_branch } =
      object_attributes;
    const projectId = project.id;
    const repoName = project.name;

    // Trigger on open, reopen or code update
    if (state === "opened" || state === "reopened" || action === "update") {
      try {
        const mr = await gitlab.getMergeRequest(projectId, iid);
        const diffs = await gitlab.getMergeRequestDiff(projectId, iid);

        res.status(200).send("Processing");

        const mrInfo = {
          title: title,
          author: user.name,
          url: source.http_url,
          repoName: repoName,
          targetBranch: target_branch,
        };

        // Quan trọng: Sử dụng diff_refs trực tiếp từ MR để đảm bảo SHA mới nhất
        handleAIReview(projectId, iid, diffs, mr.diff_refs, mrInfo);
      } catch (error) {
        console.error("Webhook processing error:", error);
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
