import assert from "node:assert";
import test, { describe } from "node:test";
import { OpenCodeRunner } from "./opencode";

describe("OpenCodeRunner", () => {
  test("should format opencode review prompt with instructions and schema", () => {
    const runner = new OpenCodeRunner();
    const prompt = runner.buildReviewPrompt({
      title: "Fix auth token leak",
      author: "Alice",
      repoName: "my-repo",
      targetBranch: "main",
      commits: [{ hash: "1234567", message: "fix leak", author: "Alice" }],
      rawDiff: "diff --git a/auth.ts b/auth.ts\n+ const safe = true;",
      impactSummary: "Found 2 external callers",
    });

    assert.ok(prompt.includes("Fix auth token leak"));
    assert.ok(prompt.includes("Alice"));
    assert.ok(prompt.includes("1234567"));
    assert.ok(prompt.includes("SCHEMA"));
  });

  test("should parse json output from opencode stdout", () => {
    const runner = new OpenCodeRunner();
    const rawStdout = `
Some opencode logs...
\`\`\`json
{
  "summary": "Code đạt chuẩn, không có lỗi bảo mật.",
  "verdict": "APPROVE",
  "riskLevel": "LOW",
  "comments": []
}
\`\`\`
Finished opencode session.
    `;
    const result = runner.parseOpenCodeOutput(rawStdout);
    assert.strictEqual(result.verdict, "APPROVE");
    assert.strictEqual(result.riskLevel, "LOW");
    assert.strictEqual(result.summary, "Code đạt chuẩn, không có lỗi bảo mật.");
  });
});
