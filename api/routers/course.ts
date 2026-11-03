import { z } from "zod";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { courses, knowledgeBases, kbDocuments, kbChunks, learnMessages, objectiveStates } from "@db/schema";
import { structuredCall } from "../lib/ai";
import { retrieve, formatChunks } from "../lib/retrieve";
import type { CourseStructure } from "@contracts/types";
import {
  courseSkeletonSchema,
  objectiveDetailSchema,
  outlineSchema,
  moduleLimitFor,
  coverageReport,
  outlineCoverageReport,
  TOPIC_SYSTEM_PROMPT,
  DETAIL_SYSTEM_PROMPT,
  OUTLINE_SYSTEM_PROMPT,
  topicUserPrompt,
  MAX_MODULE_LIMIT,
  type CourseSkeleton,
  type CourseGenerationPlan,
  type CourseOutline,
} from "../lib/courselib";

export const courseRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    const rows = await db
      .select({ course: courses, kbName: knowledgeBases.name })
      .from(courses)
      .innerJoin(knowledgeBases, eq(courses.kbId, knowledgeBases.id))
      .orderBy(desc(courses.createdAt));
    return rows.map(({ course, kbName }) => {
      const structure = course.structure as CourseStructure;
      return {
        id: course.id,
        title: course.title,
        goal: course.goal,
        description: structure.description,
        kbName,
        kbId: course.kbId,
        moduleCount: structure.modules.length,
        objectiveCount: structure.modules.reduce((n, m) => n + m.objectives.length, 0),
        createdAt: course.createdAt,
      };
    });
  }),

  get: publicQuery.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const [row] = await db
      .select({ course: courses, kbName: knowledgeBases.name })
      .from(courses)
      .innerJoin(knowledgeBases, eq(courses.kbId, knowledgeBases.id))
      .where(eq(courses.id, input.id))
      .limit(1);
    if (!row) throw new Error("课程不存在");
    return {
      id: row.course.id,
      title: row.course.title,
      goal: row.course.goal,
      kbId: row.course.kbId,
      kbName: row.kbName,
      structure: row.course.structure as CourseStructure,
      createdAt: row.course.createdAt,
    };
  }),

  /**
   * 课程分解：一次结构化调用生成整条学习路线（覆盖漏文件时自动补课重生成一次）。
   * 输入 = 学习目标 + 知识库文档清单 + 每篇文档的摘录 + 按目标检索出的原文片段
   * （全部来自索引，不读原件）。移植 DeepTutor topic_generation 的关键契约：
   * 能力式模块目标、知识点分类、材料归属、覆盖校验、模块数随材料伸缩。
   */
  generate: publicQuery
    .input(
      z.object({
        kbId: z.number(),
        goal: z.string().min(2).max(500),
        /** 手动指定模块数目标；不传则按文档数/内容体量/目录章数/时间安排自动算 */
        moduleLimit: z.number().min(3).max(MAX_MODULE_LIMIT).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [kb] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, input.kbId)).limit(1);
      if (!kb) throw new Error("知识库不存在");

      const docs = await db
        .select({ id: kbDocuments.id, filename: kbDocuments.filename })
        .from(kbDocuments)
        .where(and(eq(kbDocuments.kbId, input.kbId), eq(kbDocuments.status, "ok")))
        .orderBy(asc(kbDocuments.id));
      if (docs.length === 0) throw new Error("这个知识库还没有可用的文档，请先上传并等待索引完成。");

      const docNames = docs.map((d) => d.filename);
      const counts = await db
        .select({ docId: kbChunks.docId, cnt: sql<number>`count(*)` })
        .from(kbChunks)
        .where(eq(kbChunks.kbId, input.kbId))
        .groupBy(kbChunks.docId);
      const countOf = new Map(counts.map((c) => [c.docId, Number(c.cnt)]));
      const totalChunks = [...countOf.values()].reduce((a, b) => a + b, 0);

      // 资料载荷（原版 _source_payload：总量 ~24000 字，每篇文档都要有露脸机会）：
      // 按目标检索的片段 + 基准资料的密集采样（还原目录用）+ 其它文档的稀疏采样
      const BUDGET = 24_000;
      let remaining = BUDGET;
      const goalChunks = await retrieve(input.kbId, input.goal, 6);
      const goalText = formatChunks(goalChunks, Math.min(3000, remaining));
      remaining -= goalText.length;

      // 均匀取 N 个采样点（按 seq 升序 = 原文先后顺序）
      async function sampleDoc(docId: number, samples: number, perSample: number): Promise<string> {
        const n = countOf.get(docId) ?? 1;
        const seqs = [
          ...new Set(
            Array.from({ length: Math.min(samples, n) }, (_, k) =>
              Math.floor((k * (n - 1)) / Math.max(Math.min(samples, n) - 1, 1)),
            ),
          ),
        ].sort((a, b) => a - b);
        const parts: string[] = [];
        for (const seq of seqs) {
          const [c] = await db
            .select({ content: kbChunks.content })
            .from(kbChunks)
            .where(and(eq(kbChunks.kbId, input.kbId), eq(kbChunks.docId, docId), eq(kbChunks.seq, seq)))
            .limit(1);
          if (c) parts.push(c.content.slice(0, perSample));
        }
        return parts.join("\n……（中略，顺序不变）……\n");
      }

      // 基准资料：学习目标里点名了某份文档（文件名去掉扩展名后出现在目标里）——
      // 对它密集采样还原完整目录，课程的完整性和顺序才有依据（治"课程不全"）
      const stripExt = (n: string) => n.replace(/\.[a-z0-9]+$/i, "");
      const baseDoc = docs.find((d) => {
        const stem = stripExt(d.filename).trim();
        return stem.length >= 2 && input.goal.includes(stem);
      });
      let outline: CourseOutline | undefined;
      let baseBlock = "";
      if (baseDoc) {
        const n = countOf.get(baseDoc.id) ?? 1;
        const samples = Math.min(40, n);
        const baseExcerpt = await sampleDoc(baseDoc.id, samples, Math.floor(16_000 / samples));
        remaining -= baseExcerpt.length;
        baseBlock = `【基准资料：${baseDoc.filename}】（以下为按原文先后顺序的密集摘录，课程主线以此为准）\n${baseExcerpt}`;
        // 第零段：还原目录。失败不阻塞——退回没有目录的老路
        try {
          outline = await structuredCall({
            schema: outlineSchema,
            system: OUTLINE_SYSTEM_PROMPT,
            prompt: `资料名：${baseDoc.filename}\n\n【按原文先后顺序的密集摘录】\n${baseExcerpt}`,
            maxTokens: 4096,
          });
        } catch {
          outline = undefined;
        }
      }

      // 其它文档按行文顺序抽多块（开头/中间/结尾），让模型看到文档内部的先后脉络。
      // 不设 15 份的硬上限——预算（remaining）耗尽自然停；没轮到摘录的文档照样列名进提示词，
      // 否则模型看不到它、覆盖校验却要求它，只能靠文件名瞎猜。
      const otherDocs = docs.filter((d) => d.id !== baseDoc?.id);
      const samplesPerDoc = otherDocs.length <= 4 ? 4 : otherDocs.length <= 8 ? 3 : 2;
      const perSample = Math.max(300, Math.floor(remaining / Math.max(otherDocs.length * samplesPerDoc, 1)));
      const docExcerpts: string[] = [];
      const excerpted = new Set<string>();
      for (const doc of otherDocs) {
        if (remaining <= 0) break;
        const excerpt = await sampleDoc(doc.id, samplesPerDoc, Math.min(perSample, remaining));
        remaining -= excerpt.length;
        if (excerpt) excerpted.add(doc.filename);
        docExcerpts.push(`【文档 ${docExcerpts.length + 1}：${doc.filename}】（以下为按原文先后顺序的摘录）\n${excerpt}`);
      }
      // 没轮到摘录的文档：只列名字，模型至少知道它们存在、该安排位置
      const restDocs = docNames.filter((n) => !excerpted.has(n));
      const restBlock =
        restDocs.length > 0
          ? `【其余文档清单】（因篇幅未附摘录，但同样要安排进路线，不能丢）：\n${restDocs.map((n) => `- ${n}`).join("\n")}\n\n`
          : "";
      const sourcesJson = [
        `【按学习目标检索到的相关片段】\n${goalText}`,
        ...(baseBlock ? [baseBlock] : []),
        ...docExcerpts,
        ...(restBlock ? [restBlock.trim()] : []),
      ].join("\n\n---\n\n");

      // 模块数目标 = max(文档数, 内容体量, 目录章数, 时间安排)，取整到提示词里当"目标值"；
      // 手动滑杆（input.moduleLimit）直接当目标值用。真正硬顶只有 MAX_MODULE_LIMIT。
      const moduleTarget = Math.max(
        3,
        Math.min(
          MAX_MODULE_LIMIT,
          input.moduleLimit ?? moduleLimitFor({ docCount: docs.length, totalChunks, chapterCount: outline?.outline.length, goal: input.goal }),
        ),
      );
      const moduleHardLimit = Math.min(MAX_MODULE_LIMIT, moduleTarget + 4);

      // 两阶段生成：先骨架（模块+知识点标题），再分批补 summary/query。
      // 长课程一次生成完整 JSON 会超 8192 输出上限被截断，分批后每次输出都很小。
      async function callSkeleton(mustCover?: string[], mustCoverSections?: Array<{ chapter: string; section: string }>): Promise<CourseSkeleton> {
        return structuredCall({
          schema: courseSkeletonSchema,
          system: TOPIC_SYSTEM_PROMPT.replaceAll("{module_target}", String(moduleTarget)).replaceAll(
            "{module_limit}",
            String(moduleHardLimit),
          ),
          prompt: topicUserPrompt({
            name: kb.name,
            goal: input.goal,
            sourcesJson,
            mustCover,
            mustCoverSections,
            outline,
            moduleTarget,
          }),
          maxTokens: 8192,
        });
      }

      let skeleton = await callSkeleton();
      // 覆盖校验（文件 + 目录小节两条线）：漏了触发一次"补课"重生成（原版 must_cover 机制）
      const coverage = coverageReport(docNames, skeleton.modules);
      let secMissing: Array<{ chapter: string; section: string }> = [];
      if (outline) {
        const secCoverage = outlineCoverageReport(outline, skeleton.modules);
        // OCR 小节名会有轻微变体导致误报，漏 10% 以上（或至少 2 节）才触发补课
        if (secCoverage.missing.length >= 2 && secCoverage.missing.length >= Math.ceil(secCoverage.total * 0.1)) {
          secMissing = secCoverage.missing;
        }
      }
      if (coverage.missing.length > 0 || secMissing.length > 0) {
        skeleton = await callSkeleton(coverage.missing, secMissing);
      }

      // 第二阶段：每批 8 个模块并行补齐 summary/query；某批失败就用标题兜底，不让整门课失败
      const sourcesBrief = sourcesJson.slice(0, 8000);
      const batches: CourseSkeleton["modules"][] = [];
      for (let i = 0; i < skeleton.modules.length; i += 8) batches.push(skeleton.modules.slice(i, i + 8));
      const details = await Promise.all(
        batches.map((batch) =>
          structuredCall({
            schema: objectiveDetailSchema,
            system: DETAIL_SYSTEM_PROMPT,
            prompt: `课程目标：${input.goal}\n\n请为以下模块的知识点补 summary 和 query：\n${JSON.stringify(
              batch.map((m) => ({ title: m.title, objective: m.objective, objectives: m.objectives })),
            )}\n\n<learning_sources>\n${sourcesBrief}\n</learning_sources>`,
            maxTokens: 4096,
          }).catch(() => null),
        ),
      );

      const plan: CourseGenerationPlan = {
        title: skeleton.title,
        description: skeleton.description,
        modules: skeleton.modules.map((m) => {
          const detail = details.filter(Boolean).flatMap((d) => d!.modules).find((dm) => dm.title === m.title);
          return {
            title: m.title,
            objective: m.objective,
            materials: m.materials ?? [],
            objectives: m.objectives.map((o) => {
              const dObj = detail?.objectives.find((x) => x.title === o.title);
              return { title: o.title, type: o.type, summary: dObj?.summary ?? o.title, query: dObj?.query ?? o.title };
            }),
          };
        }),
      };

      // 服务端统一发号，模块/知识点 id 由代码生成。
      // 不做 slice 截断：schema 层已保证模块 ≤60、每模块目标 ≤7，这里截了反而无声丢内容
      const structure: CourseStructure = {
        title: plan.title,
        goal: input.goal,
        description: plan.description,
        modules: plan.modules.map((m, mi) => ({
          id: `m${mi + 1}`,
          title: m.title,
          objective: m.objective,
          materials: (m.materials ?? []).filter((n) => docNames.some((d) => d === n || d.includes(n) || n.includes(d))),
          objectives: m.objectives.map((o, oi) => ({
            id: `m${mi + 1}o${oi + 1}`,
            title: o.title,
            summary: o.summary,
            query: o.query,
            type: o.type,
          })),
        })),
      };

      const [row] = await db
        .insert(courses)
        .values({ kbId: input.kbId, title: structure.title, goal: input.goal, structure })
        .$returningId();
      return { id: row.id };
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    // 级联删除：先把这门课的课程级数据清掉，再删课程行本身。
    // （schema 里外键标了 onDelete cascade，但 DB 是否真生效取决于迁移；这里显式删更稳，
    //  且不依赖 DB 级联——即便外键没建也不会留下孤儿记录。）
    await db.delete(learnMessages).where(eq(learnMessages.courseId, input.id));
    await db.delete(objectiveStates).where(eq(objectiveStates.courseId, input.id));
    await db.delete(courses).where(eq(courses.id, input.id));
    return { ok: true };
  }),
});
