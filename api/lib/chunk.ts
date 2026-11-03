/** 文本切块：按段落聚合，目标 ~500 字，重叠 60 字，保证检索片段语义完整 */

const TARGET = 500;
const MAX = 800;
const OVERLAP = 60;

export function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n{1,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const piece = current.trim();
    if (piece.length > 0) chunks.push(piece);
    current = "";
  };

  for (const para of paragraphs) {
    if (para.length > MAX) {
      // 超长段落：硬切
      flush();
      for (let i = 0; i < para.length; i += MAX - OVERLAP) {
        chunks.push(para.slice(i, i + MAX));
      }
      continue;
    }
    if (current.length + para.length + 1 > TARGET && current.length > 0) {
      const tail = current.slice(-OVERLAP);
      flush();
      current = tail;
    }
    current = current ? `${current}\n${para}` : para;
  }
  flush();
  return chunks.filter((c) => c.length >= 20);
}
