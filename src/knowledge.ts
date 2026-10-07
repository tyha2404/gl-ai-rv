import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_CHARS = 12_000;

/** Tên thư mục an toàn cho một project, dùng chung quy tắc với workspace. */
export function projectKey(projectPathWithNamespace: string): string {
  return (
    projectPathWithNamespace
      .replace(/[\/\\:]/g, "_")
      .replace(/[^a-zA-Z0-9._-]/g, "") || "unknown"
  );
}

/**
 * Chặn bản kiến thức mới bị hỏng: rỗng, phình quá cỡ, hoặc mất phần lớn nội dung cũ
 * (model "quên" mà không chủ ý gộp).
 */
export function isAcceptableUpdate(
  previous: string,
  next: string,
  maxChars: number,
): { ok: boolean; reason?: string } {
  const trimmed = next.trim();
  if (trimmed.length < 200) return { ok: false, reason: "quá ngắn" };
  if (trimmed.length > maxChars * 1.5) {
    return { ok: false, reason: "vượt quá giới hạn kích thước" };
  }
  if (previous.length > 1500 && trimmed.length < previous.length * 0.5) {
    return { ok: false, reason: "mất hơn nửa nội dung cũ" };
  }
  return { ok: true };
}

/**
 * Bộ nhớ kiến thức theo từng project: 1 file markdown dễ đọc và sửa tay
 * (`<dir>/<project>/knowledge.md`). Nằm ngoài thư mục source để không bị
 * `git clean` của lần deploy xóa mất.
 */
export class KnowledgeStore {
  private baseDir: string;
  readonly maxChars: number;
  private locks = new Map<string, Promise<unknown>>();

  constructor(baseDir?: string, maxChars?: number) {
    this.baseDir =
      baseDir ||
      process.env.KNOWLEDGE_DIR ||
      path.join(os.homedir(), "gl-ai-reviewer-knowledge");
    this.maxChars =
      maxChars || Number(process.env.KNOWLEDGE_MAX_CHARS) || DEFAULT_MAX_CHARS;
  }

  public filePath(project: string): string {
    return path.join(this.baseDir, projectKey(project), "knowledge.md");
  }

  public load(project: string): string {
    try {
      return fs.readFileSync(this.filePath(project), "utf-8").trim();
    } catch {
      return "";
    }
  }

  /** Ghi nguyên tử, giữ bản trước đó ở knowledge.prev.md. Trả về false nếu bị từ chối. */
  public save(project: string, content: string): boolean {
    const previous = this.load(project);
    const verdict = isAcceptableUpdate(previous, content, this.maxChars);
    if (!verdict.ok) {
      console.warn(
        `[Knowledge] Rejected update for ${project}: ${verdict.reason}`,
      );
      return false;
    }

    const file = this.filePath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (previous) {
      fs.writeFileSync(
        path.join(path.dirname(file), "knowledge.prev.md"),
        previous,
      );
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content.trim() + "\n");
    fs.renameSync(tmp, file);
    return true;
  }

  /** Tuần tự hóa các lần học của cùng một project để không ghi đè lẫn nhau. */
  public withLock<T>(project: string, task: () => Promise<T>): Promise<T> {
    const key = projectKey(project);
    const run = (this.locks.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(task);
    this.locks.set(key, run);
    return run.finally(() => {
      if (this.locks.get(key) === run) this.locks.delete(key);
    });
  }
}
