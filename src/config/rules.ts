import fs from "fs";
import path from "path";

/**
 * Đọc file custom rules từ thư mục gốc của project hoặc từ biến môi trường.
 */
export function loadProjectRules(projectRoot: string = process.cwd()): string {
  // 1. Kiểm tra biến môi trường
  if (process.env.AI_CUSTOM_RULES && process.env.AI_CUSTOM_RULES.trim()) {
    return process.env.AI_CUSTOM_RULES.trim();
  }

  // 2. Kiểm tra các tên file quy tắc phổ biến
  const candidateFiles = [
    ".ai-review-rules.md",
    ".ai-review-rules",
    "AI_REVIEW_RULES.md",
    ".ai-reviewer.json",
  ];

  for (const fileName of candidateFiles) {
    const filePath = path.join(projectRoot, fileName);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (content) {
          return content;
        }
      } catch (err) {
        console.warn(`[RulesLoader] Error reading ${filePath}:`, err);
      }
    }
  }

  return "";
}
