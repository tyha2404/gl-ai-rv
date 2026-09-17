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
