import dotenv from "dotenv";
import express from "express";
import { AIClient } from "./ai";
import { GitLabClient } from "./gitlab";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const gitlab = new GitLabClient();
const ai = new AIClient();

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
) {
  try {
    const filteredDiffs = filterDiffs(diffs);
    if (filteredDiffs.length === 0) return;

    console.log(`Starting AI Review for MR #${iid}...`);
    const reviewResult = await ai.reviewCode(filteredDiffs);

    console.log(
      `AI Review completed for MR #${iid}. Summary: ${JSON.stringify(reviewResult.summary)}. Comments: ${JSON.stringify(reviewResult.comments)}`,
    );

    if (!reviewResult.comments || reviewResult.comments.length === 0) {
      await gitlab.addLabel(projectId, iid, ["AI-Reviewed"]);
      return;
    }

    console.log(
      `Found ${reviewResult.comments.length} issues for MR #${iid}. Posting comments...`,
    );

    // 1. Post Summary
    await gitlab.postComment(
      projectId,
      iid,
      `### 🤖 AI Đánh giá & Soát lỗi mã nguồn (GLM-4)\n\n${reviewResult.summary}\n\n---\n*Bot được vận hành bởi Zhipu AI*`,
    );

    // 2. Post Line Comments với cơ chế Fallback
    for (const comment of reviewResult.comments) {
      try {
        const body = `**Gợi ý cho \`${comment.path}\` (dòng ${comment.line}):**\n${comment.text}${comment.suggestion ? `\n\n\`\`\`\n${comment.suggestion}\n\`\`\`` : ""}`;

        await gitlab.postLineComment(
          projectId,
          iid,
          {
            body: body,
            path: comment.path,
            line: comment.line,
            type: "new",
          },
          diffRefs,
        );
      } catch (e: any) {
        console.warn(
          `Could not post line comment on ${comment.path}:${comment.line}. Falling back to general comment.`,
        );
        // Fallback: Nếu không thể post line comment (do sai dòng), post thành comment chung
        const fallbackBody = `**Gợi ý bổ sung cho \`${comment.path}\` (dòng ${comment.line}):**\n${comment.text}`;
        await gitlab.postComment(projectId, iid, fallbackBody);
      }
    }

    await gitlab.addLabel(projectId, iid, ["AI-Reviewed"]);
    console.log(`AI Review for MR #${iid} completed.`);
  } catch (error) {
    console.error("Error in handleAIReview:", error);
  }
}

app.post("/webhook", async (req, res) => {
  const event = req.headers["x-gitlab-event"];
  const payload = req.body;

  if (event === "Merge Request Hook") {
    const { object_attributes, project } = payload;
    const { iid, action, state } = object_attributes;
    const projectId = project.id;

    if (state === "opened") {
      try {
        const mr = await gitlab.getMergeRequest(projectId, iid);
        const diffs = await gitlab.getMergeRequestDiff(projectId, iid);

        res.status(200).send("Processing");
        // Quan trọng: Sử dụng diff_refs trực tiếp từ MR để đảm bảo SHA mới nhất
        handleAIReview(projectId, iid, diffs, mr.diff_refs);
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
