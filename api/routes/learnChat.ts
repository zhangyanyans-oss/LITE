/** 学习对话：单次流式调用。无工具、无循环——检索在代码里完成，模型只负责讲。 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq, desc, and, gt } from "drizzle-orm";
import { streamText } from "ai";
import { getDb } from "../queries/connection";
import { learnMessages, objectiveStates, courses } from "@db/schema";
import type { CourseStructure } from "@contracts/types";
import { getChatModel } from "../lib/ai";
import { retrieve, formatChunks } from "../lib/retrieve";
import { sessionStartId } from "../lib/chatSession";
import { findCurrentObjective, findObjectiveById } from "../routers/learn";
import { log } from "../lib/logger";
import { processPlanBlocks, processFigureBlocks, buildFigurePromptSection, detectSubject, stripHandDrawnApparatus } from "../lib/diagram";
import { buildPlanPromptSection } from "../lib/diagram/prompt";
import { buildTikzPromptSection, processTikzBlocks, tikzAvailable } from "../lib/diagram/tikz";

export const learnChatRoutes = new Hono();

export const TUTOR_SYSTEM = `你是「深学」的私教老师，正在带学生按课程路线学习。

教学规则（严格遵守）：
1. 讲授严格依据下方【资料片段】（取自学生知识库的文本索引）。可以补充通识性解释帮助理解，但不得与资料矛盾，不得编造假引用。
2. 不要让学生去翻 PDF 原书页码或图片——所有要学的内容都在资料片段里，直接用大白话讲清楚。
3. 一次只讲一个小点，400 字以内，口语化，多举例子。
4. 排版用简洁 Markdown：重点用 **加粗** 标出，并列要点用 - 列表，数学用 $...$ 写行内公式（如 $\\frac{2}{7}$），不要把公式放进反引号，也不要裸写 \\frac 这类命令——学生只会看到源码。
5. 你不出题、不发试卷。每个知识点按「摸底 → 上课 → 结课测验」的流程走，测验由系统按钮自动出卷；学生想检验时，提醒他点页面上方的阶段按钮。
6. 学生答错或理解偏了，直接指出，不要迎合。
7. 需要图示时，按下面的顺序选通道（这是硬规则，不要跳步）：
   - **第一步：查【教材图库】。** 讲到装置、光路、成像、压强、电路这类图时，先看下方【教材图库】清单里有没有对应实验/原理图；有就用 \`\`\`figure <id> 围栏（id 见清单）引用教材原图，**不要再写 plan**。化学装置图、物理光路/成像图的装配（导管插入深度、塞子、铁夹、加热位置、法线、光线方向）是人画准的，引擎现画达不到这个精度。
   - **第二步：图库确实没有**（题目临时改造的、多件组合的、要突出某个局部变化的装置），才按【图示规则】用 \`\`\`plan 写布局计划（本机有 LaTeX 时也可用 \`\`\`tikz）。
   - 完全不涉及器材的抽象图（几何图形、函数图像、受力分析、电路原理图）才可以用 \`\`\`svg 代码块：一个完整的 <svg viewBox="0 0 宽 高">，只用 line/circle/rect/path/polygon/text 等基本元素，线条 stroke="#222"、强调用 "#b91c1c"、标注用 <text>，宽不超过 480、高不超过 320，不要脚本和外链。
   - **绝不允许**用 \`\`\`svg 手绘实验器材（试管、烧瓶、烧杯、集气瓶、水槽、漏斗、铁架台、酒精灯、燃烧匙、电极、导管……）：手绘图没有几何校验，杆子穿过玻璃片、试管悬空在水槽上方这类错误会直接进课堂。画示意图前先核对事实：原子个数与分子式一致、电荷正负、方向标注与图形对应，宁可不画也不要画错。代码示例用 \`\`\`cpp 代码块。能文字说清的就不必画。`;

learnChatRoutes.post(
  "/",
  bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.body(null, 413) }),
  async (c) => {
    try {
      const body = (await c.req.json()) as { courseId?: number; message?: string; objectiveId?: string };
      const courseId = Number(body.courseId);
      const message = String(body.message ?? "").trim();
      const wantedObjectiveId = typeof body.objectiveId === "string" && body.objectiveId ? body.objectiveId : null;
      if (!Number.isFinite(courseId) || !message) {
        return c.json({ error: "参数错误" }, 400);
      }

      const db = getDb();
      const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
      if (!course) return c.json({ error: "课程不存在" }, 404);
      const structure = course.structure as CourseStructure;

      const states = await db.select().from(objectiveStates).where(eq(objectiveStates.courseId, courseId));
      const stateMap = new Map(states.map((s) => [s.objectiveId, s]));
      // 跳跃学习：学生点名某个知识点就围绕它聊；否则跟当前进度走
      const current =
        (wantedObjectiveId ? findObjectiveById(structure, stateMap, wantedObjectiveId) : null) ??
        findCurrentObjective(structure, stateMap);
      if (!current) {
        return c.json({ error: "恭喜，这门课已经全部通关！可以去「出题」页综合检验一下。" }, 400);
      }

      // 代码内检索：当前知识点 + 学生的问题
      const chunks = await retrieve(course.kbId, `${current.objective.query}\n${message}`, 5);
      const materials = chunks.length > 0 ? formatChunks(chunks, 4000) : "（本次没有检索到相关片段，依据通识回答，并提示学生知识库可能缺少这部分材料。）";

      // 近期对话作为上下文（teach 类消息）。只取本段对话——学生按了「开始新对话」就不再喂旧上下文
      const startId = await sessionStartId(courseId);
      const history = await db
        .select()
        .from(learnMessages)
        .where(and(eq(learnMessages.courseId, courseId), gt(learnMessages.id, startId)))
        .orderBy(desc(learnMessages.id))
        .limit(10);
      const chatHistory = history
        .reverse()
        .filter((m) => m.kind === "teach")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 1000) }));

      await db.insert(learnMessages).values({
        courseId,
        role: "user",
        kind: "teach",
        objectiveId: current.objective.id,
        content: message,
      });

      // 图示通道优先级：教材图库原图 > plan 布局引擎（本机有 LaTeX 时再叠 TikZ）
      // 先按课程/知识点/提问猜学科，只给对应学科的图库清单——化学课不该收到物理光路图的 id
      const subjectHint = `${course.title} ${course.goal} ${current.objective.title} ${current.objective.summary} ${message}`;
      const subject = detectSubject(subjectHint);
      const figureSection = buildFigurePromptSection(subject);
      const diagramSection = tikzAvailable()
        ? `${figureSection}\n\n${buildTikzPromptSection()}\n\n${buildPlanPromptSection()}`
        : `${figureSection}\n\n${buildPlanPromptSection()}`;

      const model = await getChatModel();
      const result = streamText({
        model,
        system: `${TUTOR_SYSTEM}

${diagramSection}

课程：${course.title}（目标：${course.goal}）
当前模块：${current.moduleTitle}
当前知识点：${current.objective.title} —— ${current.objective.summary}

【资料片段】
${materials}`,
        messages: [...chatHistory, { role: "user" as const, content: message }],
        maxOutputTokens: 3000,
        abortSignal: c.req.raw.signal,
        onFinish: async ({ text }) => {
          try {
            // 落库前把 figure/tikz/plan 围栏编译渲染成图——学生看到的一直是图，不是代码
            const topic = `${current.objective.title}（${current.objective.summary}）`;
            // 图库引用先落地：它不依赖模型，纯查表替换
            const fig = processFigureBlocks(text);
            if (fig.used.length > 0) log.info("figure blocks resolved", { ids: fig.used.slice(0, 3), courseId });
            let content = await processTikzBlocks(fig.content, { topic });
            content = await processPlanBlocks(content, { topic });
            content = stripHandDrawnApparatus(content).content;
            await db.insert(learnMessages).values({
              courseId,
              role: "assistant",
              kind: "teach",
              objectiveId: current.objective.id,
              content,
            });
          } catch (err) {
            log.error("save tutor message failed", { courseId, error: err instanceof Error ? err.message : String(err) });
          }
        },
      });
      return result.toTextStreamResponse();
    } catch (err) {
      log.error("learn chat failed", { error: err instanceof Error ? err.message : String(err) });
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  },
);
