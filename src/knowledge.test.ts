import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { ClaudeRunner } from "./claude";
import { isAcceptableUpdate, KnowledgeStore, projectKey } from "./knowledge";
import { buildContextSection } from "./roles/prompts";

const doc = (n: number) => "# Kiến thức\n" + "nội dung nghiệp vụ. ".repeat(n);

describe("KnowledgeStore", () => {
  test("projectKey sanitizes paths", () => {
    assert.strictEqual(projectKey("grp/sub/app"), "grp_sub_app");
    assert.strictEqual(projectKey("../../etc"), ".._.._etc");
    assert.ok(!projectKey("a/b").includes("/"));
  });

  test("save/load roundtrip keeps previous version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kn-"));
    const store = new KnowledgeStore(dir, 12000);
    assert.strictEqual(store.load("g/app"), "");
    assert.ok(store.save("g/app", doc(30)));
    assert.ok(store.save("g/app", doc(31)));
    assert.strictEqual(store.load("g/app"), doc(31).trim());
    assert.ok(fs.existsSync(path.join(dir, "g_app", "knowledge.prev.md")));
  });

  test("rejects empty, oversized and shrunk updates", () => {
    assert.ok(!isAcceptableUpdate("", "ngắn", 12000).ok);
    assert.ok(!isAcceptableUpdate("", "x".repeat(20000), 12000).ok);
    assert.ok(!isAcceptableUpdate("y".repeat(4000), doc(30), 12000).ok);
    assert.ok(isAcceptableUpdate("y".repeat(4000), "z".repeat(3500), 12000).ok);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kn-"));
    const store = new KnowledgeStore(dir, 12000);
    assert.ok(!store.save("p", "ngắn"));
    assert.strictEqual(store.load("p"), "");
  });

  test("withLock serializes tasks for the same project", async () => {
    const store = new KnowledgeStore(os.tmpdir(), 12000);
    const order: string[] = [];
    const a = store.withLock("p", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("a");
    });
    const b = store.withLock("p", async () => {
      order.push("b");
    });
    await Promise.all([a, b]);
    assert.deepStrictEqual(order, ["a", "b"]);
  });
});

describe("knowledge in prompts", () => {
  test("context and review prompt include knowledge; learn prompt guards against injection", () => {
    const mr = {
      title: "T",
      author: "A",
      repoName: "R",
      targetBranch: "main",
      projectKnowledge: "## Nghiệp vụ\nĐơn hàng không được âm.",
    };
    assert.ok(buildContextSection(mr).includes("Đơn hàng không được âm"));
    const runner = new ClaudeRunner();
    assert.ok(runner.buildReviewPrompt(mr).includes("Đơn hàng không được âm"));

    const fresh = runner.buildLearnPrompt({
      repoName: "R",
      previousKnowledge: "",
      maxChars: 12000,
      title: "T",
      findings: [],
    });
    assert.ok(fresh.includes("KHỞI TẠO") && fresh.includes("KHÔNG TIN CẬY"));
    const update = runner.buildLearnPrompt({
      repoName: "R",
      previousKnowledge: "cũ",
      maxChars: 12000,
      title: "T",
      findings: [],
    });
    assert.ok(update.includes("CẬP NHẬT") && update.includes("cũ"));
  });
});
