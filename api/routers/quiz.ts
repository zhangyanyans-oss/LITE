import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { quizzes, quizAttempts, knowledgeBases } from "@db/schema";
import type { QuizQuestion, GradeResult } from "@contracts/types";
import { structuredCall } from "../lib/ai";
import { retrieve, formatChunks } from "../lib/retrieve";
import {
  questionSetSchema,
  gradeResultSchema,
  QUIZ_SYSTEM_PROMPT,
  GRADE_SYSTEM_PROMPT,
  assignQuestionIds,
  gradeCodeQuestion,
} from "../lib/quizlib";

export const quizRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    const rows = await db
      .select({ quiz: quizzes, kbName: knowledgeBases.name })
      .from(quizzes)
      .leftJoin(knowledgeBases, eq(quizzes.kbId, knowledgeBases.id))
      .orderBy(desc(quizzes.createdAt));
    return rows.map(({ quiz, kbName }) => ({
      id: quiz.id,
      topic: quiz.topic,
      kbName,
      questionCount: (quiz.questions as QuizQuestion[]).length,
      createdAt: quiz.createdAt,
    }));
  }),

  get: publicQuery.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, input.id)).limit(1);
    if (!quiz) throw new Error("试卷不存在");
    const attempts = await db
      .select()
      .from(quizAttempts)
      .where(eq(quizAttempts.quizId, input.id))
      .orderBy(desc(quizAttempts.createdAt))
      .limit(10);
    return { ...quiz, questions: quiz.questions as QuizQuestion[], attempts };
  }),

  /**
   * 专题出题：一次结构化调用 → 落库 → 返回完整试卷。
   * 没有 agent 循环，没有"正在思考"的假动作——要么出题，要么报错。
   */
  generate: publicQuery
    .input(
      z.object({
        topic: z.string().min(2).max(200),
        kbId: z.number().optional(),
        count: z.number().min(2).max(10).default(5),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      let materials = "";
      if (input.kbId) {
        const chunks = await retrieve(input.kbId, input.topic, 8);
        if (chunks.length > 0) materials = formatChunks(chunks, 6000);
      }

      const choiceCount = Math.ceil(input.count / 2);
      const { questions } = await structuredCall({
        schema: questionSetSchema,
        system: QUIZ_SYSTEM_PROMPT,
        prompt: `请围绕主题「${input.topic}」出 ${input.count} 道题（约 ${choiceCount} 道单选，其余简答）。如果主题涉及编程/C++，把 1~2 道简答题换成 code 编程题。
${materials ? `\n资料片段（来自知识库索引）：\n${materials}` : "\n（未关联知识库，依据通识出题，仍需保证题目质量。）"}`,
        maxTokens: 8192,
      });

      const finalQuestions = assignQuestionIds(questions.slice(0, input.count));
      const [row] = await db
        .insert(quizzes)
        .values({ kbId: input.kbId ?? null, topic: input.topic, questions: finalQuestions })
        .$returningId();
      return { id: row.id, questionCount: finalQuestions.length };
    }),

  submit: publicQuery
    .input(
      z.object({
        quizId: z.number(),
        answers: z.record(z.string(), z.string()),
        /** 编程题：浏览器里运行出的实际输出，用于确定性判别 */
        runOutputs: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, input.quizId)).limit(1);
      if (!quiz) throw new Error("试卷不存在");
      const questions = quiz.questions as QuizQuestion[];

      const results: GradeResult[] = [];
      const shortToGrade: Array<{ question: QuizQuestion; userAnswer: string }> = [];
      for (const q of questions) {
        const userAnswer = (input.answers[q.id] ?? "").trim();
        if (q.type === "code") {
          results.push(gradeCodeQuestion(q, input.runOutputs?.[q.id]));
        } else if (q.type === "choice") {
          const correct =
            userAnswer.toUpperCase().charAt(0) === q.answer.trim().toUpperCase().charAt(0) &&
            userAnswer.length > 0;
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
          maxTokens: 4096,
        });
        results.push(...graded);
      }

      const score = results.reduce((s, r) => s + r.score, 0) / Math.max(results.length, 1);
      await db.insert(quizAttempts).values({
        quizId: input.quizId,
        answers: input.answers,
        results,
        score,
      });
      return { results, score };
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(quizzes).where(eq(quizzes.id, input.id));
    return { ok: true };
  }),
});
