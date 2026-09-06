import fs from "fs";
import path from "path";

/**
 * Trích xuất Tech Stack chính từ package.json hoặc cấu hình dự án
 * để cung cấp cho AI dưới dạng ngữ cảnh siêu gọn (<50 tokens).
 */
export function extractTechStackSummary(
  projectRoot: string = process.cwd(),
): string {
  try {
    const pkgPath = path.join(projectRoot, "package.json");
    if (!fs.existsSync(pkgPath)) {
      return "";
    }

    const pkgContent = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const keyDeps = Object.keys(deps);

    if (keyDeps.length === 0) {
      return "";
    }

    // Chọn lọc các framework, ORM, thư viện bảo mật và core utilities quan trọng
    const highlighted = keyDeps.filter((name) => {
      const lower = name.toLowerCase();
      return (
        lower.includes("express") ||
        lower.includes("nest") ||
        lower.includes("react") ||
        lower.includes("vue") ||
        lower.includes("next") ||
        lower.includes("prisma") ||
        lower.includes("typeorm") ||
        lower.includes("mongoose") ||
        lower.includes("zod") ||
        lower.includes("joi") ||
        lower.includes("jwt") ||
        lower.includes("auth") ||
        lower.includes("openai") ||
        lower.includes("typescript") ||
        lower.includes("fastify") ||
        lower.includes("axios") ||
        lower.includes("lodash") ||
        lower.includes("gitlab")
      );
    });

    const displayList =
      highlighted.length > 0 ? highlighted : keyDeps.slice(0, 10);
    return `Tech Stack: ${pkg.name || "App"} | Key Dependencies: ${displayList.join(", ")}`;
  } catch (err) {
    return "";
  }
}
