import { z } from "zod";
import { eq, desc, sql, count } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  knowledgeBases,
  kbDocuments,
  kbChunks,
  courses,
  objectiveStates,
  quizzes,
} from "@db/schema";

export const kbRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    const kbs = await db.select().from(knowledgeBases).orderBy(desc(knowledgeBases.createdAt));
    const docCounts = await db
      .select({ kbId: kbDocuments.kbId, docs: count(), chunks: sql<number>`COALESCE(SUM(${kbDocuments.chunkCount}),0)` })
      .from(kbDocuments)
      .groupBy(kbDocuments.kbId);
    const statOf = new Map(docCounts.map((r) => [r.kbId, r]));
    return kbs.map((kb) => ({
      ...kb,
      docCount: statOf.get(kb.id)?.docs ?? 0,
      chunkCount: Number(statOf.get(kb.id)?.chunks ?? 0),
    }));
  }),

  create: publicQuery
    .input(z.object({ name: z.string().min(1).max(120), description: z.string().max(500).optional() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const [row] = await db
        .insert(knowledgeBases)
        .values({ name: input.name.trim(), description: input.description?.trim() || null })
        .$returningId();
      return { id: row.id };
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(knowledgeBases).where(eq(knowledgeBases.id, input.id));
    return { ok: true };
  }),

  documents: publicQuery.input(z.object({ kbId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    return db
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.kbId, input.kbId))
      .orderBy(desc(kbDocuments.createdAt));
  }),

  deleteDocument: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(kbChunks).where(eq(kbChunks.docId, input.id));
    await db.delete(kbDocuments).where(eq(kbDocuments.id, input.id));
    return { ok: true };
  }),

  /** 工作台统计 */
  overview: publicQuery.query(async () => {
    const db = getDb();
    const [kbCount] = await db.select({ n: count() }).from(knowledgeBases);
    const [chunkCount] = await db.select({ n: count() }).from(kbChunks);
    const [courseCount] = await db.select({ n: count() }).from(courses);
    const [quizCount] = await db.select({ n: count() }).from(quizzes);
    const [mastered] = await db
      .select({ n: count() })
      .from(objectiveStates)
      .where(eq(objectiveStates.status, "mastered"));
    return {
      kbs: kbCount.n,
      chunks: chunkCount.n,
      courses: courseCount.n,
      quizzes: quizCount.n,
      mastered: mastered.n,
    };
  }),
});
