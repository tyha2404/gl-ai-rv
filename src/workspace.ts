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
  baseDir?: string | undefined;
  gitlabUrl?: string | undefined;
  gitlabToken?: string | undefined;
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
    const lines = rawLog
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const commits: GitCommitInfo[] = [];

    for (const line of lines) {
      const match = line.match(/^([a-zA-Z0-9]+)\s+-\s+(.*?)\s*\(([^()]+)\)$/);
      if (match && match[1] && match[2] && match[3]) {
        commits.push({
          hash: match[1].trim(),
          message: match[2].trim(),
          author: match[3].trim(),
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
