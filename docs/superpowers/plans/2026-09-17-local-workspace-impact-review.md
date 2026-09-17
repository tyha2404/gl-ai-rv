# Local Workspace & Impact Analysis Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tự động clone/fetch nhánh GitLab MR về VPS, trích xuất diff & commit mới, phân tích phạm vi ảnh hưởng (Impact Analysis/Callers Scan) trên toàn repo cục bộ, review bằng AI và gửi báo cáo Cards V2 về Google Chat.

**Architecture:** Tạo `WorkspaceManager` để quản lý git operations cục bộ và cache repository; tạo `ImpactAnalyzer` để trích xuất modified symbols và grep tìm callers/consumers trong workspace; tích hợp commit log và dữ liệu impact vào `AIClient` và hiển thị trên `GoogleChatNotifier` Cards V2; kết nối pipeline tại `src/index.ts`.

**Tech Stack:** TypeScript, Node.js (v20+ `node:test`, `child_process`, `fs/promises`), `@gitbeaker/rest`, `OpenAI` SDK, Express.

---

### Task 1: Tạo `WorkspaceManager` để Clone, Fetch, Checkout & Lấy Commit/Diff

**Files:**

- Create: `src/workspace.ts`
- Test: `src/workspace.test.ts`

- [ ] **Step 1: Viết test cho WorkspaceManager**

```typescript
// src/workspace.test.ts
import assert from "node:assert";
import fs from "node:fs";
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
    assert.strictEqual(parsed[0].hash, "a1b2c3d");
    assert.strictEqual(parsed[0].message, "feat: add auth service");
    assert.strictEqual(parsed[0].author, "Alice");
    assert.strictEqual(parsed[1].hash, "e4f5g6h");
    assert.strictEqual(parsed[1].author, "Bob");
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `node -r ts-node/register --test src/workspace.test.ts`
Expected: FAIL với lỗi Cannot find module './workspace'

- [ ] **Step 3: Viết mã nguồn `src/workspace.ts`**

```typescript
// src/workspace.ts
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommitInfo {
  hash: string;
  message: string;
  author: string;
}

export interface WorkspaceManagerOptions {
  baseDir?: string;
  gitlabUrl?: string;
  gitlabToken?: string;
}

export interface SyncBranchOptions {
  projectPathWithNamespace: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface WorkspaceSyncResult {
  repoPath: string;
  commits: GitCommitInfo[];
  rawDiff: string;
}

export class WorkspaceManager {
  private baseDir: string;
  private gitlabUrl: string;
  private gitlabToken: string;

  constructor(options: WorkspaceManagerOptions = {}) {
    this.baseDir = options.baseDir || path.resolve(process.cwd(), "workspaces");
    this.gitlabUrl = (
      options.gitlabUrl ||
      process.env.GITLAB_URL ||
      "https://gitlab.com"
    ).replace(/\/+$/, "");
    this.gitlabToken = (
      options.gitlabToken ||
      process.env.GITLAB_TOKEN ||
      ""
    ).trim();

    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public getRepoPath(projectPathWithNamespace: string): string {
    const sanitized = projectPathWithNamespace
      .replace(/[\/\\:]/g, "_")
      .replace(/[^a-zA-Z0-9._-]/g, "");
    return path.join(this.baseDir, sanitized);
  }

  public getAuthenticatedCloneUrl(projectPathWithNamespace: string): string {
    const urlObj = new URL(this.gitlabUrl);
    const host = urlObj.host;
    const protocol = urlObj.protocol;
    const cleanPath = projectPathWithNamespace.replace(/^\/+/, "");
    if (this.gitlabToken) {
      return `${protocol}//oauth2:${this.gitlabToken}@${host}/${cleanPath}.git`;
    }
    return `${protocol}//${host}/${cleanPath}.git`;
  }

  public parseGitLog(rawLog: string): GitCommitInfo[] {
    if (!rawLog || !rawLog.trim()) return [];
    const lines = rawLog.trim().split("\n");
    const commits: GitCommitInfo[] = [];

    for (const line of lines) {
      const match = line.match(/^([a-f0-9]+)\s+-\s+(.*?)\s+\((.*?)\)$/i);
      if (match && match[1] && match[2] && match[3]) {
        commits.push({
          hash: match[1],
          message: match[2],
          author: match[3],
        });
      } else {
        const parts = line.split(" - ");
        if (parts.length >= 2 && parts[0]) {
          commits.push({
            hash: parts[0].trim(),
            message: parts.slice(1).join(" - ").trim(),
            author: "Unknown",
          });
        }
      }
    }
    return commits;
  }

  private async runGit(
    args: string[],
    cwd: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return await execFileAsync("git", args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }

  public async syncAndGetMRDiff(
    options: SyncBranchOptions,
  ): Promise<WorkspaceSyncResult> {
    const repoPath = this.getRepoPath(options.projectPathWithNamespace);
    const cloneUrl = this.getAuthenticatedCloneUrl(
      options.projectPathWithNamespace,
    );

    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      console.log(
        `[WorkspaceManager] Cloning ${options.projectPathWithNamespace} into ${repoPath}...`,
      );
      fs.mkdirSync(repoPath, { recursive: true });
      await execFileAsync("git", ["clone", "--quiet", cloneUrl, repoPath], {
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    }

    // Fetch all remote branches
    await this.runGit(["fetch", "origin", "--prune", "--quiet"], repoPath);

    // Checkout target branch and pull latest
    try {
      await this.runGit(
        ["checkout", options.targetBranch, "--quiet"],
        repoPath,
      );
      await this.runGit(
        ["pull", "origin", options.targetBranch, "--quiet"],
        repoPath,
      );
    } catch (e: any) {
      console.warn(
        `[WorkspaceManager] Target branch checkout notice:`,
        e?.message,
      );
    }

    // Checkout source branch
    await this.runGit(["checkout", options.sourceBranch, "--quiet"], repoPath);
    await this.runGit(
      ["pull", "origin", options.sourceBranch, "--quiet"],
      repoPath,
    );

    // Get commit log between target and source branch
    let commits: GitCommitInfo[] = [];
    try {
      const { stdout: logOut } = await this.runGit(
        [
          "log",
          `origin/${options.targetBranch}..origin/${options.sourceBranch}`,
          "--pretty=format:%h - %s (%an)",
        ],
        repoPath,
      );
      commits = this.parseGitLog(logOut);
    } catch {
      // Fallback local branch check
      try {
        const { stdout: logOut } = await this.runGit(
          [
            "log",
            `${options.targetBranch}..${options.sourceBranch}`,
            "--pretty=format:%h - %s (%an)",
          ],
          repoPath,
        );
        commits = this.parseGitLog(logOut);
      } catch (err: any) {
        console.warn(
          `[WorkspaceManager] Failed to get commit logs:`,
          err?.message,
        );
      }
    }

    // Get git diff
    let rawDiff = "";
    try {
      const { stdout: diffOut } = await this.runGit(
        [
          "diff",
          `origin/${options.targetBranch}...origin/${options.sourceBranch}`,
        ],
        repoPath,
      );
      rawDiff = diffOut;
    } catch {
      const { stdout: diffOut } = await this.runGit(
        ["diff", `${options.targetBranch}...${options.sourceBranch}`],
        repoPath,
      );
      rawDiff = diffOut;
    }

    return {
      repoPath,
      commits,
      rawDiff,
    };
  }
}
```

- [ ] **Step 4: Chạy test để xác nhận pass**

Run: `node -r ts-node/register --test src/workspace.test.ts`
Expected: PASS 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/workspace.ts src/workspace.test.ts
git commit -m "feat: add WorkspaceManager for local git repo management and commit log extraction"
```

---

### Task 2: Tạo `ImpactAnalyzer` để Quét Callers/Usages và Phân Tích Phạm Vi Ảnh Hưởng (Blast Radius)

**Files:**

- Create: `src/analyzer/impact.ts`
- Test: `src/analyzer/impact.test.ts`

- [ ] **Step 1: Viết test cho ImpactAnalyzer**

```typescript
// src/analyzer/impact.test.ts
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { extractModifiedSymbolsFromDiff, ImpactAnalyzer } from "./impact";

describe("ImpactAnalyzer", () => {
  const dummyWorkspace = path.join(__dirname, "../tmp_impact_test");

  test("should extract function, class and const symbols from git diff hunk", () => {
    const sampleDiff = `
diff --git a/src/services/billing.ts b/src/services/billing.ts
--- a/src/services/billing.ts
+++ b/src/services/billing.ts
@@ -10,3 +10,4 @@
-export function calculateInvoice(orderId: string): number {
+export function calculateInvoice(orderId: string, applyVat: boolean): number {
+export const DEFAULT_TAX_RATE = 0.1;
+export class PaymentGateway {
    `;
    const symbols = extractModifiedSymbolsFromDiff(sampleDiff);
    assert.ok(symbols.includes("calculateInvoice"));
    assert.ok(symbols.includes("DEFAULT_TAX_RATE"));
    assert.ok(symbols.includes("PaymentGateway"));
  });

  test("should search workspace and find caller references across files", async () => {
    if (!fs.existsSync(dummyWorkspace)) {
      fs.mkdirSync(dummyWorkspace, { recursive: true });
    }
    fs.writeFileSync(
      path.join(dummyWorkspace, "service.ts"),
      "export function processPayment() {}",
    );
    fs.writeFileSync(
      path.join(dummyWorkspace, "controller.ts"),
      "import { processPayment } from './service';\nprocessPayment();",
    );

    const analyzer = new ImpactAnalyzer();
    const result = await analyzer.analyzeImpact(
      dummyWorkspace,
      ["processPayment"],
      ["service.ts"],
    );

    assert.strictEqual(result.impactedFiles.length, 1);
    assert.ok(result.impactedFiles[0].includes("controller.ts"));
    assert.ok(result.summary.includes("processPayment"));

    // Cleanup
    fs.rmSync(dummyWorkspace, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `node -r ts-node/register --test src/analyzer/impact.test.ts`
Expected: FAIL với lỗi Cannot find module './impact'

- [ ] **Step 3: Viết mã nguồn `src/analyzer/impact.ts`**

```typescript
// src/analyzer/impact.ts
import fs from "node:fs";
import path from "node:path";
import { isIgnoredFile } from "../utils/diff";

export interface ImpactReference {
  symbol: string;
  filePath: string;
  line: number;
  lineContent: string;
}

export interface ImpactAnalysisReport {
  modifiedSymbols: string[];
  impactedFiles: string[];
  references: ImpactReference[];
  summary: string;
}

/**
 * Trích xuất các symbol (function, class, const, interface, type) từ diff
 */
export function extractModifiedSymbolsFromDiff(rawDiff: string): string[] {
  const symbols = new Set<string>();
  const lines = rawDiff.split("\n");

  const symbolRegexes = [
    /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/,
    /(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/,
    /(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/,
    /(?:export\s+)?type\s+([a-zA-Z0-9_$]+)/,
    /(?:export\s+)?const\s+([a-zA-Z0-9_$]+)\s*=/i,
    /(?:export\s+)?let\s+([a-zA-Z0-9_$]+)\s*=/i,
  ];

  for (const line of lines) {
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;

    const content = line.slice(1).trim();
    for (const regex of symbolRegexes) {
      const match = content.match(regex);
      if (match && match[1]) {
        const name = match[1];
        if (
          name.length > 2 &&
          ![
            "if",
            "for",
            "while",
            "switch",
            "return",
            "true",
            "false",
            "null",
          ].includes(name)
        ) {
          symbols.add(name);
        }
      }
    }
  }

  return Array.from(symbols);
}

export class ImpactAnalyzer {
  private maxFilesToScan: number;
  private maxReferences: number;

  constructor(
    options: { maxFilesToScan?: number; maxReferences?: number } = {},
  ) {
    this.maxFilesToScan = options.maxFilesToScan || 500;
    this.maxReferences = options.maxReferences || 50;
  }

  private getAllFiles(dir: string, fileList: string[] = []): string[] {
    if (!fs.existsSync(dir) || fileList.length >= this.maxFilesToScan) {
      return fileList;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (fileList.length >= this.maxFilesToScan) break;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(dir, fullPath);

      if (isIgnoredFile(relativePath) || isIgnoredFile(entry.name)) {
        continue;
      }

      if (entry.isDirectory()) {
        this.getAllFiles(fullPath, fileList);
      } else if (entry.isFile()) {
        fileList.push(fullPath);
      }
    }

    return fileList;
  }

  public async analyzeImpact(
    workspaceDir: string,
    modifiedSymbols: string[],
    changedFilePaths: string[] = [],
  ): Promise<ImpactAnalysisReport> {
    if (!fs.existsSync(workspaceDir) || modifiedSymbols.length === 0) {
      return {
        modifiedSymbols,
        impactedFiles: [],
        references: [],
        summary:
          "Không phát hiện symbol thay đổi đáng chú ý hoặc không có workspace.",
      };
    }

    const allFiles = this.getAllFiles(workspaceDir);
    const references: ImpactReference[] = [];
    const impactedFilesSet = new Set<string>();

    const normalizedChangedFiles = changedFilePaths.map((p) =>
      path.normalize(p),
    );

    for (const filePath of allFiles) {
      if (references.length >= this.maxReferences) break;

      const relativeFilePath = path.relative(workspaceDir, filePath);
      // Bỏ qua chính các file đã bị thay đổi trong MR
      if (
        normalizedChangedFiles.some(
          (cf) =>
            relativeFilePath.endsWith(cf) || cf.endsWith(relativeFilePath),
        )
      ) {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const fileLines = content.split("\n");

        for (let idx = 0; idx < fileLines.length; idx++) {
          if (references.length >= this.maxReferences) break;
          const lineStr = fileLines[idx] || "";

          for (const symbol of modifiedSymbols) {
            // Kiểm tra symbol được dùng dưới dạng từ độc lập
            const symbolRegex = new RegExp(`\\b${symbol}\\b`);
            if (symbolRegex.test(lineStr)) {
              impactedFilesSet.add(relativeFilePath);
              references.push({
                symbol,
                filePath: relativeFilePath,
                line: idx + 1,
                lineContent: lineStr.trim(),
              });
              break;
            }
          }
        }
      } catch {
        // Bỏ qua file nhị phân hoặc unreadable
      }
    }

    const impactedFiles = Array.from(impactedFilesSet);

    let summary = "";
    if (impactedFiles.length === 0) {
      summary = `Đã rà soát ${modifiedSymbols.length} symbol (${modifiedSymbols.join(", ")}) trên toàn bộ repo: Không tìm thấy nơi gọi bên ngoài nào bị ảnh hưởng trực tiếp.`;
    } else {
      summary = `Phát hiện ${impactedFiles.length} file bên ngoài (${impactedFiles.slice(0, 5).join(", ")}${impactedFiles.length > 5 ? "..." : ""}) đang sử dụng các symbol bị thay đổi (${modifiedSymbols.slice(0, 5).join(", ")}). Cần chú ý kiểm tra tương thích và chạy regression test.`;
    }

    return {
      modifiedSymbols,
      impactedFiles,
      references,
      summary,
    };
  }
}
```

- [ ] **Step 4: Chạy test để xác nhận pass**

Run: `node -r ts-node/register --test src/analyzer/impact.test.ts`
Expected: PASS 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/analyzer/impact.ts src/analyzer/impact.test.ts
git commit -m "feat: add ImpactAnalyzer for symbol extraction and workspace callers scan"
```

---

### Task 3: Cập nhật `AIClient` & Prompt để Tích Hợp Commit Log & Impact Analysis

**Files:**

- Modify: `src/ai.ts`
- Modify: `src/roles/prompts.ts`
- Test: `src/ai.test.ts`

- [ ] **Step 1: Cập nhật `MRContext` và Prompt trong `src/ai.ts` & `src/roles/prompts.ts`**

Bổ sung trường `commits?: GitCommitInfo[]`, `impactReport?: ImpactAnalysisReport` vào `MRContext` và hiển thị trong prompt gửi AI.

```typescript
// Thêm vào MRContext trong src/ai.ts
import { ImpactAnalysisReport } from "./analyzer/impact";
import { GitCommitInfo } from "./workspace";

export interface MRContext {
  title: string;
  author: string;
  repoName: string;
  targetBranch: string;
  description?: string | undefined;
  customRules?: string | undefined;
  techStack?: string | undefined;
  commits?: GitCommitInfo[] | undefined;
  impactReport?: ImpactAnalysisReport | undefined;
}

export interface AIReviewResult {
  summary: string;
  verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  comments: AIReviewComment[];
  impactAssessment?: string | undefined;
}
```

- [ ] **Step 2: Cập nhật unit test trong `src/ai.test.ts` để kiểm tra context mới**

- [ ] **Step 3: Chạy test AIClient**

Run: `node -r ts-node/register --test src/ai.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/ai.ts src/roles/prompts.ts src/ai.test.ts
git commit -m "feat: enhance AIClient with commit history and impact analysis context"
```

---

### Task 4: Nâng Cấp `GoogleChatNotifier` Cards V2 với Section "💥 Phạm vi ảnh hưởng" và "Danh sách Commit"

**Files:**

- Modify: `src/notifier.ts`
- Test: `src/notifier.test.ts`

- [ ] **Step 1: Viết test cho `notifier.ts` với payload có impactReport & commits**

- [ ] **Step 2: Cập nhật Cards V2 widgets trong `src/notifier.ts`**
  - Section 1: Merge Request Overview (Title, Author, Branch, New Commits count & list)
  - Section 2: AI Verdict & Risk Badge
  - Section 3: 💥 Impact Analysis (Summary & danh sách file bị ảnh hưởng gián tiếp)
  - Section 4: AI Review Comments & Code Suggestions

- [ ] **Step 3: Chạy test notifier**

Run: `node -r ts-node/register --test src/notifier.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/notifier.ts src/notifier.test.ts
git commit -m "feat: display impact analysis and commit history in Google Chat Cards V2"
```

---

### Task 5: Kết Nối Toàn Bộ Flow Trong `src/index.ts` và Chạy E2E Verification

**Files:**

- Modify: `src/index.ts`

- [ ] **Step 1: Cập nhật `handleAIReview` và endpoint `/webhook`**
  - Nhận event MR từ GitLab.
  - Sử dụng `workspaceManager.syncAndGetMRDiff` để clone/fetch và checkout nhánh MR.
  - Chạy `extractModifiedSymbolsFromDiff` và `impactAnalyzer.analyzeImpact`.
  - Chuyển `diffs`, `commits`, `impactReport` sang `ai.reviewCode`.
  - Gửi thông báo Cards V2 qua `notifier.sendReviewNotification`.
  - Fallback an toàn sang `gitlab.getMergeRequestDiff` nếu có lỗi git cục bộ.

- [ ] **Step 2: Chạy toàn bộ test suite**

Run: `npm test`
Expected: Tất cả các test suites pass 100%.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate local workspace cloning and impact analysis in MR review pipeline"
```
