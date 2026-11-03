/** 文档解析：上传时一次性解析成纯文本，之后系统只使用这些文本 */
import { extractText } from "unpdf";
import mammoth from "mammoth";

export const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"];

export async function parseDocument(filename: string, data: Buffer): Promise<string> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const { text } = await extractText(new Uint8Array(data), { mergePages: true });
    return clean(text);
  }
  if (lower.endsWith(".docx")) {
    const { value } = await mammoth.extractRawText({ buffer: data });
    return clean(value);
  }
  if (lower.endsWith(".txt") || lower.endsWith(".md")) {
    return clean(data.toString("utf-8"));
  }
  throw new Error(`不支持的文件类型：${filename}（支持 ${SUPPORTED_EXTENSIONS.join(" / ")}）`);
}

function clean(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
