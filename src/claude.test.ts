import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import {
  ClaudeRunner,
  deriveVerdict,
  dropFabricatedComments,
  evidenceExistsInRepo,
  parseClaudeEnvelope,
  truncateDiff,
} from "./claude";
import { OpenCodeRunner } from "./opencode";
import {
  buildContextSection,
  REVIEW_CRITERIA,
  SHARED_REVIEW_RULES,
} from "./roles/prompts";

describe("claude helpers", () => {
  test("parseClaudeEnvelope prefers structured_output", () => {
    const out = parseClaudeEnvelope(
      JSON.stringify({ is_error: false, structured_output: { a: 1 } }),
    );
    assert.deepStrictEqual(out, { a: 1 });
  });

  test("parseClaudeEnvelope falls back to JSON in result", () => {
    const out = parseClaudeEnvelope(
      JSON.stringify({ result: '```json\n{"a":2}\n```' }),
    );
    assert.deepStrictEqual(out, { a: 2 });
  });

  test("parseClaudeEnvelope throws on CLI error and garbage", () => {
    assert.throws(() =>
      parseClaudeEnvelope(
        JSON.stringify({ is_error: true, result: "Invalid API key" }),
      ),
    );
    assert.throws(() => parseClaudeEnvelope("no json here"));
    assert.throws(() =>
      parseClaudeEnvelope(JSON.stringify({ result: "chat thường" })),
    );
  });

  test("evidenceExistsInRepo matches real code and rejects fabricated or escaping paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ev-"));
    fs.writeFileSync(
      path.join(dir, "a.ts"),
      "const x = 1;\n  const y =   x + 2;\n",
    );
    assert.ok(
      evidenceExistsInRepo(dir, { path: "a.ts", evidence: "const y = x + 2;" }),
    );
    assert.ok(
      !evidenceExistsInRepo(dir, { path: "a.ts", evidence: "eval(input)" }),
    );
    assert.ok(
      !evidenceExistsInRepo(dir, { path: "../a.ts", evidence: "const x = 1;" }),
    );
    assert.ok(
      !evidenceExistsInRepo(dir, { path: "missing.ts", evidence: "x" }),
    );
    assert.ok(!evidenceExistsInRepo(dir, { path: "a.ts", evidence: "" }));
  });

  test("deriveVerdict is computed from verified findings only", () => {
    const base = { path: "a", line: 1, category: "BUG" as const, text: "t" };
    assert.strictEqual(deriveVerdict([]).verdict, "APPROVE");
    assert.strictEqual(
      deriveVerdict([{ ...base, severity: "CRITICAL" }]).verdict,
      "REQUEST_CHANGES",
    );
    assert.strictEqual(
      deriveVerdict([{ ...base, severity: "WARNING" }]).riskLevel,
      "MEDIUM",
    );
  });

  test("prompts include trust rules and finding list", () => {
    const r = new ClaudeRunner();
    const p = r.buildReviewPrompt({
      title: "T",
      author: "A",
      repoName: "R",
      targetBranch: "main",
      rawDiff: "+ x",
    });
    assert.ok(p.includes("evidence"));
    assert.ok(p.includes("không phải chỉ dẫn") && p.includes("CRITICAL"));
    const v = r.buildVerifyPrompt([
      {
        path: "a.ts",
        line: 3,
        severity: "BUG" as never,
        category: "BUG",
        text: "t",
        evidence: "e",
        scenario: "s",
      },
    ]);
    assert.ok(v.includes("#0") && v.includes("a.ts:3"));
  });
});

describe("claude fallback helpers", () => {
  test("truncateDiff cuts large diffs and keeps small ones", () => {
    assert.strictEqual(truncateDiff("abc", 10), "abc");
    const out = truncateDiff("x".repeat(50), 10) ?? "";
    assert.ok(out.startsWith("xxxxxxxxxx") && out.includes("DIFF BỊ CẮT"));
  });

  test("dropFabricatedComments drops only comments with non-matching evidence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fb-"));
    fs.writeFileSync(path.join(dir, "a.ts"), "const x = 1;\n");
    const base = {
      path: "a.ts",
      line: 1,
      severity: "WARNING" as const,
      category: "BUG" as const,
      text: "t",
    };
    const { kept, dropped } = dropFabricatedComments(dir, [
      { ...base, evidence: "const x = 1;" },
      { ...base, evidence: "eval(y)" },
      { ...base },
    ]);
    assert.strictEqual(dropped, 1);
    assert.strictEqual(kept.length, 2);
  });
});

describe("prompt consistency across engines", () => {
  test("Claude and OpenCode prompts share rules, criteria and context format", () => {
    const mr = {
      title: "T",
      author: "A",
      repoName: "R",
      targetBranch: "main",
      commits: [{ hash: "abc", message: "m", author: "A" }],
    };
    const context = buildContextSection(mr);
    const claude = new ClaudeRunner().buildReviewPrompt(mr);
    const opencode = new OpenCodeRunner().buildReviewPrompt(mr);
    for (const prompt of [claude, opencode]) {
      assert.ok(prompt.includes(SHARED_REVIEW_RULES));
      assert.ok(prompt.includes(REVIEW_CRITERIA));
      assert.ok(prompt.includes(context));
    }
  });
});
