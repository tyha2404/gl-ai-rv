import assert from "node:assert";
import test, { describe } from "node:test";
import { AIReviewComment } from "./ai";
import {
  commentFingerprint,
  formatGitLabComment,
  GitLabClient,
  shouldPostToGitLab,
} from "./gitlab";

const base: AIReviewComment = {
  path: "src/a.ts",
  line: 10,
  severity: "WARNING",
  category: "BUG",
  text: "Lỗi null",
  evidence: "x.y",
};

describe("gitlab comments", () => {
  test("shouldPostToGitLab only for BUG or CRITICAL", () => {
    assert.ok(shouldPostToGitLab(base));
    assert.ok(
      shouldPostToGitLab({
        ...base,
        category: "SECURITY",
        severity: "CRITICAL",
      }),
    );
    assert.ok(
      !shouldPostToGitLab({
        ...base,
        category: "CLEAN_CODE",
        severity: "WARNING",
      }),
    );
    assert.ok(
      !shouldPostToGitLab({
        ...base,
        category: "PERFORMANCE",
        severity: "SUGGESTION",
      }),
    );
  });

  test("fingerprint ignores line number but not content", () => {
    assert.strictEqual(
      commentFingerprint(base),
      commentFingerprint({ ...base, line: 99 }),
    );
    assert.notStrictEqual(
      commentFingerprint(base),
      commentFingerprint({ ...base, text: "Lỗi khác" }),
    );
    assert.ok(formatGitLabComment(base).includes(commentFingerprint(base)));
  });

  test("posts inline, falls back to general, skips duplicates", async () => {
    const created: { body: string; position?: unknown }[] = [];
    const dup = { ...base, path: "src/dup.ts" };
    const api = {
      MergeRequestDiscussions: {
        all: async () => [{ notes: [{ body: formatGitLabComment(dup) }] }],
        create: async (
          _p: number,
          _i: number,
          body: string,
          opts?: { position?: { newPath?: string } },
        ) => {
          if (opts?.position?.newPath === "src/bad.ts") {
            throw new Error("400 line_code invalid");
          }
          created.push({ body, position: opts?.position });
          return {};
        },
      },
      MergeRequests: {
        show: async () => ({
          diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" },
        }),
      },
    };
    const client = new GitLabClient("http://x", "t", api);
    const result = await client.postReviewComments(1, 2, [
      base,
      { ...base, path: "src/bad.ts", text: "bad pos" },
      dup,
    ]);
    assert.deepStrictEqual(result, {
      inline: 1,
      general: 1,
      skippedDuplicate: 1,
      failed: 0,
    });
    assert.ok(created[1]?.body.includes("(src/bad.ts:10)"));
    assert.ok(!created[0]?.body.includes("**"));
  });
});
