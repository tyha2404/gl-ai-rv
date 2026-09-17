export const DEFAULT_IGNORED_PATTERNS = [
  // Package locks & env
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  ".env",
  ".env.",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",

  // Build & dependency directories
  "dist/",
  "build/",
  "out/",
  "node_modules/",
  ".next/",
  ".nuxt/",
  "vendor/",
  ".git/",
  "coverage/",
  ".nyc_output/",
  ".turbo/",

  // Documentation & text files
  "*.md",
  "*.txt",
  "docs/",
  "LICENSE",

  // Test & mock files (non-business logic)
  "*.test.ts",
  "*.test.js",
  "*.test.tsx",
  "*.test.jsx",
  "*.spec.ts",
  "*.spec.js",
  "*.spec.tsx",
  "*.spec.jsx",
  "__tests__/",
  "__mocks__/",
  "tests/",
  "test/",
  "fixtures/",
  "mocks/",

  // Configuration files (non-business logic)
  "tsconfig*.json",
  "*.config.js",
  "*.config.ts",
  "*.config.cjs",
  "*.config.mjs",
  ".eslintrc*",
  "eslint*",
  ".prettierrc*",
  "jest.config.*",
  "vite.config.*",
  "webpack.config.*",
  "babel.config.*",
  "pm2*",
  "ecosystem.config.*",

  // Docker & CI/CD
  "Dockerfile*",
  "docker-compose*",
  ".gitlab-ci.yml",
  ".github/",
  ".husky/",

  // Static assets & Media
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.svg",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.ico",
  "*.pdf",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
  "*.mp4",
  "*.webp",
  "*.csv",
  "*.xlsx",
];

export interface GitLabDiffItem {
  old_path?: string;
  new_path?: string;
  diff?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
}

export interface FormattedFileDiff {
  filePath: string;
  formattedDiff: string;
  lineCount: number;
}

export interface DiffBatch {
  batchIndex: number;
  totalBatches: number;
  files: FormattedFileDiff[];
  formattedDiffText: string;
}

/**
 * Kiểm tra file có nằm trong danh sách ignore không
 */
export function isIgnoredFile(
  filePath: string,
  customPatterns: string[] = [],
): boolean {
  const allPatterns = [...DEFAULT_IGNORED_PATTERNS, ...customPatterns];
  const normalizedPath = filePath.replace(/\\/g, "/");

  return allPatterns.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      return normalizedPath.endsWith(ext);
    }
    if (pattern.endsWith("/")) {
      const dirName = pattern.slice(0, -1);
      return (
        normalizedPath.startsWith(pattern) ||
        normalizedPath.includes(`/${pattern}`) ||
        normalizedPath.startsWith(dirName) ||
        normalizedPath.split("/").includes(dirName)
      );
    }
    return (
      normalizedPath.includes(pattern) ||
      normalizedPath.split("/").pop() === pattern
    );
  });
}

/**
 * Lọc bỏ các file diff không cần thiết
 */
export function filterDiffs(
  diffs: GitLabDiffItem[],
  customPatterns: string[] = [],
): GitLabDiffItem[] {
  return diffs.filter((diff) => {
    if (diff.deleted_file) return false;
    const path = diff.new_path || diff.old_path || "";
    if (!path) return false;
    return !isIgnoredFile(path, customPatterns);
  });
}

/**
 * Format 1 file diff kèm theo số dòng mới chính xác
 */
export function formatSingleFileDiff(
  diff: GitLabDiffItem,
  maxLinesPerFile: number = 400,
): FormattedFileDiff {
  const filePath = diff.new_path || diff.old_path || "unknown";
  if (!diff.diff) {
    return { filePath, formattedDiff: "", lineCount: 0 };
  }

  const lines = diff.diff.split("\n");
  const formattedLines: string[] = [];
  let currentNewLine = 0;

  for (let i = 0; i < lines.length; i++) {
    if (formattedLines.length >= maxLinesPerFile) {
      formattedLines.push(
        `\n... [DIFF ĐÃ ĐƯỢC CẮT BỚT VÌ VƯỢT QUÁ ${maxLinesPerFile} DÒNG] ...`,
      );
      break;
    }

    const line = lines[i];
    if (line === undefined) continue;

    // Hunk header: @@ -old_start,old_count +new_start,new_count @@
    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch && hunkMatch[1]) {
      currentNewLine = parseInt(hunkMatch[1], 10);
      formattedLines.push(
        `\n--- Hunk Context (Starts at line ${currentNewLine}) ---`,
      );
      continue;
    }

    if (line.startsWith("+")) {
      formattedLines.push(`Line ${currentNewLine}: + ${line.slice(1)}`);
      currentNewLine++;
    } else if (line.startsWith("-")) {
      formattedLines.push(`         - ${line.slice(1)}`);
    } else {
      if (currentNewLine > 0) {
        formattedLines.push(
          `Line ${currentNewLine}:   ${line.startsWith(" ") ? line.slice(1) : line}`,
        );
        currentNewLine++;
      } else {
        formattedLines.push(`         ${line}`);
      }
    }
  }

  const formattedDiff = `=== FILE: ${filePath} ===\n${formattedLines.join("\n")}`;

  return {
    filePath,
    formattedDiff,
    lineCount: formattedLines.length,
  };
}

/**
 * Gom nhóm các file diff thành các batch hợp lý (để tránh tràn context / lost in the middle)
 */
export function chunkDiffs(
  diffs: GitLabDiffItem[],
  maxLinesPerBatch: number = 500,
  maxFilesPerBatch: number = 5,
): DiffBatch[] {
  const filtered = filterDiffs(diffs);
  const formattedFiles: FormattedFileDiff[] = [];

  for (const diff of filtered) {
    const formatted = formatSingleFileDiff(diff);
    if (formatted.formattedDiff.trim()) {
      formattedFiles.push(formatted);
    }
  }

  if (formattedFiles.length === 0) {
    return [];
  }

  const batches: DiffBatch[] = [];
  let currentBatchFiles: FormattedFileDiff[] = [];
  let currentBatchLines = 0;

  for (const file of formattedFiles) {
    // Nếu thêm file này vào mà vượt quá maxLines hoặc maxFiles và currentBatch đã có file -> ngắt batch
    if (
      currentBatchFiles.length > 0 &&
      (currentBatchLines + file.lineCount > maxLinesPerBatch ||
        currentBatchFiles.length >= maxFilesPerBatch)
    ) {
      batches.push({
        batchIndex: batches.length + 1,
        totalBatches: 0,
        files: currentBatchFiles,
        formattedDiffText: currentBatchFiles
          .map((f) => f.formattedDiff)
          .join("\n\n"),
      });
      currentBatchFiles = [];
      currentBatchLines = 0;
    }

    currentBatchFiles.push(file);
    currentBatchLines += file.lineCount;
  }

  if (currentBatchFiles.length > 0) {
    batches.push({
      batchIndex: batches.length + 1,
      totalBatches: 0,
      files: currentBatchFiles,
      formattedDiffText: currentBatchFiles
        .map((f) => f.formattedDiff)
        .join("\n\n"),
    });
  }

  // Cập nhật lại totalBatches
  for (const batch of batches) {
    batch.totalBatches = batches.length;
  }

  return batches;
}
