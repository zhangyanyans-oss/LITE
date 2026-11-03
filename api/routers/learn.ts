import { z } from "zod";
import { asc, eq, and, gt, lt, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { deleteSessionMessages, markNewSession, sessionBounds, SESSION_KIND } from "../lib/chatSession";
import { courses, learnMessages, objectiveStates } from "@db/schema";
import type {
  CourseStructure,
  LearnState,
  Lesson,
  ObjectiveStage,
  ObjectiveStatus,
  QuizPhase,
  QuizQuestion,
  GradeResult,
  QuizVariant,
} from "@contracts/types";
import { PASS_SCORE, MAX_FINAL_ATTEMPTS } from "@contracts/types";
import { structuredCall } from "../lib/ai";
import { retrieve, formatChunks } from "../lib/retrieve";
import {
  questionSetSchema,
  gradeResultSchema,
  lessonSchema,
  QUIZ_SYSTEM_PROMPT,
  GRADE_SYSTEM_PROMPT,
  buildLessonSystemPrompt,
  assignQuestionIds,
  gradeCodeQuestion,
  svgVerifySchema,
  SVG_VERIFY_PROMPT,
  extractSvgBlocks,
  svgStructurallyOk,
  variantQuestionSchema,
  VARIANT_SYSTEM_PROMPT,
} from "../lib/quizlib";
import { processPlanBlocks, stripHandDrawnApparatus } from "../lib/diagram";
import { buildPlanPromptSection } from "../lib/diagram/prompt";
import { buildTikzPromptSection, processTikzBlocks, tikzAvailable } from "../lib/diagram/tikz";

type ObjectiveRef = { id: string; title: string; summary: string; query: string };
type StateRow = typeof objectiveStates.$inferSelect;

/** 阶段判定：已掌握/待巩固的历史数据一律视为 done */
function stageOf(row: StateRow | undefined): ObjectiveStage {
  if (!row) return "diagnose";
  if (row.status === "mastered" || row.status === "weak") return "done";
  return (row.stage as ObjectiveStage) ?? "diagnose";
}

/** 按 id 找知识点（跳跃学习用），返回它当前所处阶段 */
export function findObjectiveById(
  structure: CourseStructure,
  states: Map<string, StateRow>,
  objectiveId: string,
): { moduleTitle: string; objective: ObjectiveRef; stage: ObjectiveStage } | null {
  for (const m of structure.modules) {
    for (const o of m.objectives) {
      if (o.id === objectiveId) return { moduleTitle: m.title, objective: o, stage: stageOf(states.get(o.id)) };
    }
  }
  return null;
}

export function findCurrentObjective(
  structure: CourseStructure,
  states: Map<string, StateRow>,
): { moduleTitle: string; objective: ObjectiveRef; stage: ObjectiveStage } | null {
  for (const m of structure.modules) {
    for (const o of m.objectives) {
      const stage = stageOf(states.get(o.id));
      if (stage !== "done") return { moduleTitle: m.title, objective: o, stage };
    }
  }
  return null;
}

export async function loadCourse(courseId: number) {
  const db = getDb();
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) throw new Error("课程不存在");
  return course;
}

async function loadStates(courseId: number) {
  const db = getDb();
  const rows = await db.select().from(objectiveStates).where(eq(objectiveStates.courseId, courseId));
  return new Map(rows.map((r) => [r.objectiveId, r]));
}

async function upsertState(courseId: number, objectiveId: string, patch: Partial<StateRow>) {
  const db = getDb();
  const [prev] = await db
    .select()
    .from(objectiveStates)
    .where(and(eq(objectiveStates.courseId, courseId), eq(objectiveStates.objectiveId, objectiveId)))
    .limit(1);
  if (prev) {
    await db.update(objectiveStates).set(patch).where(eq(objectiveStates.id, prev.id));
  } else {
    await db.insert(objectiveStates).values({ courseId, objectiveId, ...patch });
  }
}

/** 对话列表里的一句话预览：取这段的第一条消息，比"12 条消息"更容易认出来是哪次课 */
function previewOf(m: { role: string; kind: string; content: string }): string {
  const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 24);
  try {
    if (m.kind === "lesson") return clip("讲解 · " + (JSON.parse(m.content).title ?? ""));
    if (m.kind === "quiz") return clip("测验 · " + (JSON.parse(m.content).objectiveTitle ?? ""));
    if (m.kind === "grade") return clip("判分 · " + (JSON.parse(m.content).objectiveTitle ?? ""));
  } catch {
    /* 损坏消息按正文兜底 */
  }
  return clip((m.role === "user" ? "" : "老师说 · ") + m.content);
}

type QuizPayload = {
  phase: QuizPhase;
  objectiveId: string;
  objectiveTitle: string;
  questions: QuizQuestion[];
};

/** 找到该知识点该阶段里"还没判分"的题卡（幂等：重复点击返回原题卡而不是再出一份） */
async function findPendingQuiz(courseId: number, objectiveId: string, phase: QuizPhase) {
  const db = getDb();
  const msgs = await db
    .select()
    .from(learnMessages)
    .where(and(eq(learnMessages.courseId, courseId), eq(learnMessages.objectiveId, objectiveId)))
    .orderBy(asc(learnMessages.id))
    .limit(50);
  let pending: { id: number; payload: QuizPayload } | null = null;
  for (const m of msgs) {
    if (m.kind === "quiz") {
      try {
        const payload = JSON.parse(m.content) as QuizPayload;
        if (payload.phase === phase) pending = { id: m.id, payload };
      } catch {
        /* 忽略损坏消息 */
      }
    }
    if (m.kind === "grade") pending = null;
  }
  return pending;
}

export const learnRouter = createRouter({
  /** 学习页状态快照 */
  state: publicQuery.input(z.object({ courseId: z.number() })).query(async ({ input }): Promise<LearnState> => {
    const course = await loadCourse(input.courseId);
    const structure = course.structure as CourseStructure;
    const states = await loadStates(input.courseId);
    const current = findCurrentObjective(structure, states);

    const modules = structure.modules.map((m) => ({
      id: m.id,
      title: m.title,
      objective: m.objective,
      objectives: m.objectives.map((o) => {
        const st = states.get(o.id);
        return {
          id: o.id,
          title: o.title,
          summary: o.summary,
          type: o.type,
          mastery: st?.mastery ?? 0,
          attempts: st?.attempts ?? 0,
          status: (st?.status ?? "active") as ObjectiveStatus,
          stage: stageOf(st),
          baseline: st?.baseline ?? null,
          finalAttempts: st?.finalAttempts ?? 0,
          current: current?.objective.id === o.id,
        };
      }),
    }));
    const total = structure.modules.reduce((n, m) => n + m.objectives.length, 0);
    const done = structure.modules
      .flatMap((m) => m.objectives)
      .filter((o) => stageOf(states.get(o.id)) === "done").length;
    return {
      courseId: course.id,
      title: course.title,
      goal: course.goal,
      description: structure.description,
      modules,
      totalObjectives: total,
      masteredObjectives: done,
    };
  }),

  /**
   * 一段对话的消息。默认是"当前这段"（最后一条「新对话」标记之后）；
   * 传 sessionId 则回看那一段历史（只读由前端控制）。标记之前的老消息属于最老的一段，id 记为 0。
   */
  messages: publicQuery
    .input(z.object({ courseId: z.number(), sessionId: z.number().nullish() }))
    .query(async ({ input }) => {
      const db = getDb();
      const { start, end } = await sessionBounds(input.courseId, input.sessionId);
      const conds = [eq(learnMessages.courseId, input.courseId), gt(learnMessages.id, start)];
      if (end != null) conds.push(lt(learnMessages.id, end));
      return db
        .select()
        .from(learnMessages)
        .where(and(...conds))
        .orderBy(asc(learnMessages.createdAt), asc(learnMessages.id))
        .limit(300);
    }),

  /** 对话列表（新→旧）：每段一条预览，current 标记当前正在聊的那段 */
  sessions: publicQuery.input(z.object({ courseId: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const rows = await db
      .select({
        id: learnMessages.id,
        role: learnMessages.role,
        kind: learnMessages.kind,
        content: learnMessages.content,
        // 直接让 MySQL 按库里的墙钟时间格式化：绕开 Date/时区往返，前端拿到什么就显示什么
        startedAt: sql<string>`DATE_FORMAT(${learnMessages.createdAt}, '%m-%d %H:%i')`,
      })
      .from(learnMessages)
      .where(eq(learnMessages.courseId, input.courseId))
      .orderBy(asc(learnMessages.id))
      .limit(2000);

    const segs: Array<{ id: number; startedAt: string | null; count: number; preview: string }> = [];
    let cur: { id: number; startedAt: string | null; count: number; preview: string } = {
      id: 0,
      startedAt: null,
      count: 0,
      preview: "",
    };
    let seenMarker = false;
    for (const m of rows) {
      if (m.kind === SESSION_KIND) {
        // 空段落只有"当前这段"值得列出来（刚点完新对话，总得有个回得去的入口）
        if (cur.count > 0 || seenMarker) segs.push(cur);
        seenMarker = true;
        cur = { id: m.id, startedAt: m.startedAt, count: 0, preview: "" };
        continue;
      }
      cur.count++;
      if (!cur.preview) cur.preview = previewOf(m);
    }
    if (cur.count > 0 || seenMarker) segs.push(cur);
    const currentId = segs.length > 0 ? segs[segs.length - 1].id : null;
    return segs
      .filter((s) => s.count > 0 || s.id === currentId)
      .slice()
      .reverse()
      .map((s) => ({ ...s, current: s.id === currentId }));
  }),

  /**
   * 阶段推进的统一入口：一次调用 = 一次结构化 LLM 生成，绝无循环。
   * phase=diagnostic 出摸底卷 | lesson 生成讲课文案 | final 出结课测验卷
   */
  startPhase: publicQuery
    .input(
      z.object({
        courseId: z.number(),
        phase: z.enum(["diagnostic", "lesson", "final"]),
        /** 给讲课阶段的上下文：错因/“没听懂”等，用于定向重讲 */
        focus: z.string().max(500).optional(),
        /** 跳跃学习：指定知识点 id；不传则学进度条上的当前课 */
        objectiveId: z.string().max(64).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const course = await loadCourse(input.courseId);
      const structure = course.structure as CourseStructure;
      const states = await loadStates(input.courseId);
      const current = input.objectiveId
        ? findObjectiveById(structure, states, input.objectiveId)
        : findCurrentObjective(structure, states);
      if (!current)
        throw new Error(
          input.objectiveId ? "没找到这个知识点。" : "这门课已经全部学完了，去「出题」页做套综合卷巩固一下吧！",
        );
      const { objective } = current;
      const reviewingDone = current.stage === "done";

      const chunks = await retrieve(course.kbId, objective.query, 6);
      if (chunks.length === 0) throw new Error("知识库里检索不到相关内容，无法继续。");

      // 摸底 / 结课测验：有未判分的题卡就直接续用，保证幂等
      if (input.phase !== "lesson") {
        const pending = await findPendingQuiz(input.courseId, objective.id, input.phase);
        if (pending) return { reused: true, messageId: pending.id };
      }

      if (input.phase === "lesson") {
        const prev = states.get(objective.id);
        const focusParts: string[] = [];
        if (prev?.baseline != null)
          focusParts.push(`学生的摸底得分 ${Math.round(prev.baseline * 100)} 分（满分 100）。`);
        if (prev?.lastFeedback) focusParts.push(`摸底/上次测验的薄弱点：${prev.lastFeedback}`);
        if (input.focus) focusParts.push(`学生最新反馈：${input.focus}`);

        // 奇点·回马枪：把最近已完成的知识点带进 prompt，让新课开场不动声色地偷袭复习旧知
        const recentDone = structure.modules
          .flatMap((m) => m.objectives)
          .filter((o) => o.id !== objective.id && stageOf(states.get(o.id)) === "done")
          .slice(-6)
          .map((o) => o.title);

        const materials = formatChunks(chunks, 4000);
        // 化学装置图：本机有 LaTeX 工具链时走极简纯 TikZ 编译，否则回落 plan 布局引擎
        const diagramSection = tikzAvailable()
          ? `${buildTikzPromptSection()}\n\n${buildPlanPromptSection()}`
          : buildPlanPromptSection();
        const lesson = await structuredCall({
          schema: lessonSchema,
          system: buildLessonSystemPrompt(diagramSection),
          prompt: `请讲解知识点「${objective.title}」（${objective.summary}）。
${focusParts.length > 0 ? `\n【学生情况】\n${focusParts.join("\n")}\n` : ""}${
            recentDone.length > 0 ? `\n【最近学过的知识点】${recentDone.join("、")}\n` : ""
          }
资料片段（来自知识库索引）：
${materials}`,
          maxTokens: 8192,
        });

        // 图示后处理：
        // 1) 先记住模型手写的 svg 块——tikz/plan 渲染出的 svg 是确定性产物，不参与自检；
        // 2) tikz 管道（化学装置，本机有 LaTeX 工具链时才有此围栏）：清洗 → 编译 →（必要时）一轮修正；
        // 3) plan 管道：校验 →（必要时）最多两轮修正 → 布局引擎渲染成 svg 替换回正文；
        // 4) 手写 svg 自检：程序查结构 + 模型对照资料复核事实，有错用修正版替换。一次兜底不循环。
        for (const section of lesson.sections) {
          const blocks = extractSvgBlocks(section.content).slice(0, 3);
          section.content = await processTikzBlocks(section.content, {
            topic: `${objective.title}（${objective.summary}）`,
          });
          section.content = await processPlanBlocks(section.content, {
            topic: `${objective.title}（${objective.summary}）`,
          });
          section.content = stripHandDrawnApparatus(section.content).content;
          if (blocks.length === 0) continue;
          const fixed = await Promise.all(
            blocks.map(async ({ full, svg }) => {
              if (!svgStructurallyOk(svg)) return null; // 结构都不合法的交给前端兜底成代码块展示
              try {
                const verdict = await structuredCall({
                  schema: svgVerifySchema,
                  system: SVG_VERIFY_PROMPT,
                  prompt: `知识点：${objective.title}（${objective.summary}）

资料原文：
${formatChunks(chunks, 3000)}

待审校的 SVG：
${svg}`,
                  maxTokens: 4096,
                });
                if (verdict.ok) return null;
                const fixedSvg = verdict.fixedSvg.trim();
                return svgStructurallyOk(fixedSvg) ? { full, fixedSvg } : null;
              } catch {
                return null; // 审校失败保留原图，不阻断讲课
              }
            }),
          );
          for (const item of fixed) {
            if (item) section.content = section.content.replace(item.full, "```svg\n" + item.fixedSvg + "\n```");
          }
        }

        // 已完成的知识点是复习模式：出讲课文案但不重置它的掌握状态
        if (!reviewingDone) {
          await upsertState(input.courseId, objective.id, { stage: "learn", status: "active" });
        }
        const [msg] = await db
          .insert(learnMessages)
          .values({
            courseId: input.courseId,
            role: "assistant",
            kind: "lesson",
            objectiveId: objective.id,
            content: JSON.stringify(lesson satisfies Lesson),
          })
          .$returningId();
        return { reused: false, messageId: msg.id };
      }

      // 出题：摸底 3 题（2 选 1 简答），结课测验 4 题（2 选 2 简答）
      const isDiag = input.phase === "diagnostic";
      const { questions } = await structuredCall({
        schema: questionSetSchema,
        system: QUIZ_SYSTEM_PROMPT,
        prompt: isDiag
          ? `请针对知识点「${objective.title}」（${objective.summary}）出 3 道摸底题：2 道单选题 + 1 道简答题。目的是了解学生现有基础，难度从基础到中等。如果这个知识点涉及编程/C++ 代码实践，把简答题换成 1 道 code 编程题；纯概念知识点不要硬出编程题。

资料片段（来自知识库索引）：
${formatChunks(chunks, 4000)}`
          : `请针对知识点「${objective.title}」（${objective.summary}）出 4 道结课测验题：2 道单选题 + 2 道简答题。目的是检验学习效果，覆盖核心概念与简单应用。如果这个知识点涉及编程/C++ 代码实践，把其中 1 道简答题换成 code 编程题；纯概念知识点不要硬出编程题。

资料片段（来自知识库索引）：
${formatChunks(chunks, 4000)}`,
        maxTokens: 6144,
      });

      const payload: QuizPayload = {
        phase: input.phase,
        objectiveId: objective.id,
        objectiveTitle: objective.title,
        questions: assignQuestionIds(questions.slice(0, isDiag ? 3 : 4)),
      };
      await upsertState(input.courseId, objective.id, {
        stage: isDiag ? "diagnose" : "final",
        status: "active",
      });
      const [msg] = await db
        .insert(learnMessages)
        .values({
          courseId: input.courseId,
          role: "assistant",
          kind: "quiz",
          objectiveId: objective.id,
          content: JSON.stringify(payload),
        })
        .$returningId();
      return { reused: false, messageId: msg.id };
    }),

  /** 判分：选择题代码判分（确定性），简答题 LLM 评分；阶段推进由引擎决定，绝不循环 */
  grade: publicQuery
    .input(
      z.object({
        courseId: z.number(),
        messageId: z.number(),
        answers: z.array(
          z.object({ questionId: z.string(), answer: z.string(), runOutput: z.string().optional() }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [msg] = await db.select().from(learnMessages).where(eq(learnMessages.id, input.messageId)).limit(1);
      if (!msg || msg.kind !== "quiz") throw new Error("题卡不存在");
      const payload = JSON.parse(msg.content) as QuizPayload;
      const isDiag = payload.phase === "diagnostic";

      // 选择题、编程题代码判分（确定性），简答题交给 LLM
      const answerOf = new Map(input.answers.map((a) => [a.questionId, a.answer.trim()]));
      const runOf = new Map(input.answers.map((a) => [a.questionId, a.runOutput]));
      const results: GradeResult[] = [];
      const shortToGrade: Array<{ question: QuizQuestion; userAnswer: string }> = [];

      for (const q of payload.questions) {
        const userAnswer = answerOf.get(q.id) ?? "";
        if (q.type === "code") {
          results.push(gradeCodeQuestion(q, runOf.get(q.id)));
        } else if (q.type === "choice") {
          const correct = userAnswer.toUpperCase().startsWith(q.answer.trim().toUpperCase().charAt(0));
          results.push({
            questionId: q.id,
            correct,
            score: correct ? 1 : 0,
            feedback: correct ? "回答正确。" : `正确答案是 ${q.answer}。${q.explanation}`,
            errorType: correct ? undefined : "未掌握",
          });
        } else {
          shortToGrade.push({ question: q, userAnswer });
        }
      }

      if (shortToGrade.length > 0) {
        const { results: graded } = await structuredCall({
          schema: gradeResultSchema,
          system: GRADE_SYSTEM_PROMPT,
          prompt: shortToGrade
            .map(
              ({ question, userAnswer }, i) =>
                `【题目 ${i + 1}】questionId=${question.id}\n题干：${question.stem}\n参考答案：${question.answer}\n评分要点：${question.explanation}\n学生答案：${userAnswer || "（未作答）"}`,
            )
            .join("\n\n"),
          maxTokens: 2048,
        });
        results.push(...graded);
      }

      const score = results.reduce((sum, r) => sum + r.score, 0) / Math.max(results.length, 1);
      const wrongSummary = results
        .filter((r) => !r.correct)
        .map((r) => `${r.feedback}${r.errorType ? `（${r.errorType}）` : ""}`)
        .join("；")
        .slice(0, 400);

      if (isDiag) {
        // 摸底：只记基线。全对说明没有不懂的，跳过讲课直接进结课测验；否则进入上课阶段
        const allRight = score >= 0.999;
        await upsertState(input.courseId, payload.objectiveId, {
          stage: allRight ? "final" : "learn",
          status: "active",
          baseline: score,
          mastery: score,
          lastFeedback: wrongSummary || "摸底全对，基础不错",
        });
        await db.insert(learnMessages).values({
          courseId: input.courseId,
          role: "assistant",
          kind: "grade",
          objectiveId: payload.objectiveId,
          content: JSON.stringify({
            phase: "diagnostic",
            objectiveTitle: payload.objectiveTitle,
            results,
            score,
            outcome: "baseline",
          }),
        });
        return { phase: "diagnostic" as const, results, score, outcome: "baseline" as const, focus: wrongSummary, objectiveTitle: payload.objectiveTitle };
      }

      // 结课测验：过关 mastered / 补考 / 超次数标记待巩固放行
      const prevStates = await loadStates(input.courseId);
      const prevRow = prevStates.get(payload.objectiveId);
      const finalAttempts = (prevRow?.finalAttempts ?? 0) + 1;
      const attempts = (prevRow?.attempts ?? 0) + 1;
      const passed = score >= PASS_SCORE;
      const giveUp = !passed && finalAttempts >= MAX_FINAL_ATTEMPTS;
      const outcome = passed ? ("passed" as const) : giveUp ? ("weak" as const) : ("retry" as const);

      // 奇点·错题变形卷：有错题时基于第一道错题出一道"变形加练"（考点不变、情境全换），
      // 跟判分卡一起下发，翻牌自测。生成失败不阻断判分。
      let variant: QuizVariant | undefined;
      const firstWrong = results.find((r) => !r.correct);
      if (firstWrong) {
        const srcQ = payload.questions.find((q) => q.id === firstWrong.questionId);
        if (srcQ && srcQ.type !== "code") {
          try {
            variant = await structuredCall({
              schema: variantQuestionSchema,
              system: VARIANT_SYSTEM_PROMPT,
              prompt: `学生做错的题：
题干：${srcQ.stem}
${srcQ.type === "choice" && srcQ.options ? `选项：${srcQ.options.join(" | ")}\n` : ""}参考答案：${srcQ.answer}
解析：${srcQ.explanation}
学生答案：${answerOf.get(srcQ.id) || "（未作答）"}
判分反馈：${firstWrong.feedback}`,
              maxTokens: 2048,
            });
          } catch {
            variant = undefined;
          }
        }
      }

      await upsertState(input.courseId, payload.objectiveId, {
        stage: outcome === "retry" ? "learn" : "done",
        status: passed ? "mastered" : giveUp ? "weak" : "active",
        mastery: score,
        attempts,
        finalAttempts,
        lastFeedback: wrongSummary || "测验全对",
      });

      await db.insert(learnMessages).values({
        courseId: input.courseId,
        role: "assistant",
        kind: "grade",
        objectiveId: payload.objectiveId,
        content: JSON.stringify({
          phase: "final",
          objectiveTitle: payload.objectiveTitle,
          results,
          score,
          outcome,
          finalAttempts,
          ...(variant ? { variant } : {}),
        }),
      });

      return {
        phase: "final" as const,
        results,
        score,
        outcome,
        finalAttempts,
        focus: wrongSummary,
        objectiveTitle: payload.objectiveTitle,
      };
    }),

  /** 开始新对话：只打一条分隔标记，页面从此只显示新消息；学习进度（objective_states）原样保留 */
  newSession: publicQuery.input(z.object({ courseId: z.number() })).mutation(async ({ input }) => {
    await markNewSession(input.courseId);
    return { ok: true };
  }),

  /** 删除一段对话：默认删当前这段（分隔标记保留，历史各段不动）；传 sessionId 可删某段历史 */
  deleteSession: publicQuery
    .input(z.object({ courseId: z.number(), sessionId: z.number().nullish() }))
    .mutation(async ({ input }) => {
      await deleteSessionMessages(input.courseId, input.sessionId);
      return { ok: true };
    }),

  /** 清空这门课的全部对话记录（含历史各段），学习进度不动 */
  clearMessages: publicQuery.input(z.object({ courseId: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(learnMessages).where(eq(learnMessages.courseId, input.courseId));
    return { ok: true };
  }),
});
