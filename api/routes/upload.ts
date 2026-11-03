/** 文档上传：multipart 接收 → 入库 pending → 后台解析/切块/embedding → 状态轮询 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { kbDocuments, kbChunks } from "@db/schema";
import { parseDocument } from "../lib/parse";
import { chunkText } from "../lib/chunk";
import { embedTexts } from "../lib/ai";
import { log } from "../lib/logger";

export const uploadRoutes = new Hono();

async function processDocument(docId: number, kbId: number, filename: string, data: Buffer) {
  const db = getDb();
  try {
    const text = await parseDocument(filename, data);
    if (text.length < 20)
      throw new Error(
        "这份 PDF 里没有可提取的文字（很可能是扫描件/图片型 PDF）。请上传文字版文件（Word / TXT / Markdown），或先 OCR 识别后再上传",
      );
    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error("没有切出有效文本块");
    const embeddings = await embedTexts(chunks);
    await db.insert(kbChunks).values(
      chunks.map((content, i) => ({ kbId, docId, seq: i, content, embedding: embeddings[i] })),
    );
    await db
      .update(kbDocuments)
      .set({ status: "ok", charCount: text.length, chunkCount: chunks.length })
      .where(eq(kbDocuments.id, docId));
  } catch (err) {
    log.error("document indexing failed", { docId, filename, error: err instanceof Error ? err.message : String(err) });
    await db
      .update(kbDocuments)
      .set({ status: "error", error: err instanceof Error ? err.message : String(err) })
      .where(eq(kbDocuments.id, docId));
  }
}

uploadRoutes.post(
  "/:kbId/documents",
  bodyLimit({ maxSize: 100 * 1024 * 1024, onError: (c) => c.json({ error: "文件太大" }, 413) }),
  async (c) => {
    const kbId = Number(c.req.param("kbId"));
    if (!Number.isFinite(kbId)) return c.json({ error: "参数错误" }, 400);
    const form = await c.req.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) return c.json({ error: "没有收到文件" }, 400);

    const db = getDb();
    const created: number[] = [];
    for (const file of files) {
      const data = Buffer.from(await file.arrayBuffer());
      const [row] = await db
        .insert(kbDocuments)
        .values({ kbId, filename: file.name, status: "pending" })
        .$returningId();
      created.push(row.id);
      // 后台索引，前端轮询状态；错误会落到文档的 error 字段
      void processDocument(row.id, kbId, file.name, data);
    }
    return c.json({ ids: created });
  },
);
