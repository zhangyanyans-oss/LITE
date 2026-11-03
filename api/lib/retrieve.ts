/** 向量检索：余弦相似度 top-k，在代码里完成，不经 LLM */
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { kbChunks, kbDocuments } from "@db/schema";
import { embedQuery } from "./ai";

export type RetrievedChunk = {
  content: string;
  docName: string;
  score: number;
};

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function retrieve(kbId: number, query: string, topK = 6): Promise<RetrievedChunk[]> {
  const db = getDb();
  const rows = await db
    .select({
      content: kbChunks.content,
      embedding: kbChunks.embedding,
      docId: kbChunks.docId,
    })
    .from(kbChunks)
    .where(eq(kbChunks.kbId, kbId));
  if (rows.length === 0) return [];

  const queryVec = await embedQuery(query);
  const scored = rows
    .map((row) => ({
      content: row.content,
      docId: row.docId,
      score: cosine(queryVec, row.embedding as number[]),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const docIds = [...new Set(scored.map((s) => s.docId))];
  const docs = await db
    .select({ id: kbDocuments.id, filename: kbDocuments.filename })
    .from(kbDocuments)
    .where(inArray(kbDocuments.id, docIds));
  const nameOf = new Map(docs.map((d) => [d.id, d.filename]));

  return scored.map((s) => ({
    content: s.content,
    docName: nameOf.get(s.docId) ?? "未知文档",
    score: s.score,
  }));
}

/** 供 prompt 使用：把检索片段拼成带来源标注的文本块 */
export function formatChunks(chunks: RetrievedChunk[], totalLimit = 6000): string {
  let remaining = totalLimit;
  const blocks: string[] = [];
  for (const c of chunks) {
    const piece = c.content.slice(0, Math.min(1200, remaining));
    if (piece.length === 0) break;
    blocks.push(`【来源：${c.docName}】\n${piece}`);
    remaining -= piece.length;
    if (remaining <= 0) break;
  }
  return blocks.join("\n\n---\n\n");
}
