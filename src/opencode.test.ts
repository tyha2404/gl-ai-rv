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

  test("should strip ANSI escape sequences and parse JSON", () => {
    const runner = new OpenCodeRunner();
    const rawWithAnsi =
      '\u001b[32m✔\u001b[0m \u001b[1m{\n  "summary": "All good",\n  "verdict": "APPROVE",\n  "riskLevel": "LOW",\n  "comments": []\n}\u001b[0m';
    const result = runner.parseOpenCodeOutput(rawWithAnsi);
    assert.strictEqual(result.verdict, "APPROVE");
    assert.strictEqual(result.summary, "All good");
  });

  test("should fallback gracefully when raw text is not valid json", () => {
    const runner = new OpenCodeRunner();
    const rawPlainText =
      "Reviewed code: REQUEST_CHANGES due to breaking changes in auth.";
    const result = runner.parseOpenCodeOutput(rawPlainText);
    assert.strictEqual(result.verdict, "REQUEST_CHANGES");
    assert.strictEqual(result.riskLevel, "HIGH");
    assert.ok(result.summary.includes("Reviewed code"));
  });
});
