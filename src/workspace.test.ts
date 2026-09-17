import assert from "node:assert";
import path from "node:path";
import test, { describe } from "node:test";
import { WorkspaceManager } from "./workspace";

describe("WorkspaceManager", () => {
  const testBaseDir = path.join(__dirname, "../tmp_test_workspaces");

  test("should compute sanitized workspace path and authenticated clone url", () => {
    const wm = new WorkspaceManager({
      baseDir: testBaseDir,
      gitlabUrl: "https://gitlab.example.com",
      gitlabToken: "glpat-test-token",
    });

    const repoDir = wm.getRepoPath("group/subgroup/my-repo");
    assert.strictEqual(
      repoDir,
      path.join(testBaseDir, "group_subgroup_my-repo"),
    );

    const cloneUrl = wm.getAuthenticatedCloneUrl("group/my-repo");
    assert.strictEqual(
      cloneUrl,
      "https://oauth2:glpat-test-token@gitlab.example.com/group/my-repo.git",
    );
  });

  test("should parse git commit logs correctly", () => {
    const wm = new WorkspaceManager({ baseDir: testBaseDir });
    const rawLog =
      "a1b2c3d - feat: add auth service (Alice)\ne4f5g6h - fix: typo in readme (Bob)";
    const parsed = wm.parseGitLog(rawLog);

    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0]?.hash, "a1b2c3d");
    assert.strictEqual(parsed[0]?.message, "feat: add auth service");
    assert.strictEqual(parsed[0]?.author, "Alice");
    assert.strictEqual(parsed[1]?.hash, "e4f5g6h");
    assert.strictEqual(parsed[1]?.author, "Bob");
  });
});
