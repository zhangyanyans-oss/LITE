/** 出题/判分的公共 schema 与 prompt —— 学习关卡和专题出题共用同一套 */
import { z } from "zod";
import { normalizeProgramOutput, type GradeResult, type QuizQuestion } from "@contracts/types";

export const questionSchema = z.object({
  type: z.enum(["choice", "short", "code"]).describe("choice=单选，short=简答，code=编程题（学生要在内置代码框里写 C++ 并运行）"),
  stem: z.string().describe("题干；编程题写清题目要求，包括要输出的内容"),
  options: z.array(z.string()).optional().describe("选择题必须给且只给 4 个选项内容，不含 ABCD 前缀；简答题/编程题不要填这个字段"),
  answer: z.string().describe("选择题填正确选项字母（A/B/C/D）；简答题填参考答案；编程题填完整可运行的参考代码"),
  explanation: z.string().describe("解析：为什么是这个答案"),
  source: z.string().optional().describe("出题依据的文档名"),
  starterCode: z
    .string()
    .optional()
    .describe("编程题必填：预置代码框架，含 #include <iostream> 和 int main()，核心部分留空并用注释 // 在这里写代码 标明"),
  expectedOutput: z.string().optional().describe("编程题必填：程序运行后的精确标准输出（用于自动判别）"),
}).superRefine((q, ctx) => {
  // 只有选择题强制 4 个选项；简答/编程题即使模型手滑给了 options 也忽略，不卡整卷
  if (q.type === "choice" && (q.options?.length ?? 0) !== 4) {
    ctx.addIssue({ code: "custom", message: "选择题必须恰好 4 个选项", path: ["options"] });
  }
  if (q.type === "code" && !q.starterCode) {
    ctx.addIssue({ code: "custom", message: "编程题必须给 starterCode", path: ["starterCode"] });
  }
});

export const questionSetSchema = z.object({
  questions: z.array(questionSchema).min(1).max(12),
});

export const gradeResultSchema = z.object({
  results: z.array(
    z.object({
      questionId: z.string(),
      correct: z.boolean(),
      score: z.number().min(0).max(1),
      feedback: z.string().describe("给学生的反馈，一两句话"),
      errorType: z.string().optional().describe("错因分类，答对可不填"),
    }),
  ),
});

export const QUIZ_SYSTEM_PROMPT = `你是一位严谨的出题老师。规则：
1. 只依据给出的【资料片段】出题，绝不编造资料里没有的知识点；资料不够时宁可少出，也不要脱离材料。
2. 题目要考察理解与应用，不要考死记硬背的字眼。
3. 选择题必须有且只有 4 个选项，干扰项要合理；answer 只填一个字母。
4. 简答题的 answer 是 100 字以内的参考答案，explanation 说明评分要点。
5. source 填出题主要依据的文档名（资料片段开头有标注）。
6. 编程题（type=code）只在资料涉及编程/C++ 代码实践时才出，纯概念内容不要硬出。编程题必须遵守：
   - starterCode 是能直接编译的框架：含 #include <iostream>、int main() 骨架，把学生要完成的部分留空，用注释标明「// 在这里写代码」；
   - 程序只用 cout 输出结果，**禁止 cin、随机数、文件读写**（运行环境是浏览器内的 JSCPP 解释器，支持有限，尽量只用 iostream，避免 vector 等 STL 容器）；
   - expectedOutput 必须是确定不变的精确文本（每行结尾不要留空格，最后一行可有可无几换行都行），不能涉及地址、随机值、浮点精度问题——输出判别有程序自动逐字比对；
   - 难度贴合初一零基础入门：变量、输出、简单计算、分支循环这个量级。
7. 直接按要求的结构输出，不要输出任何额外文字。`;

export const GRADE_SYSTEM_PROMPT = `你是一位严格但友善的阅卷老师。逐题判分：
1. 对照参考答案判断学生答案，简答题允许部分分（score 0~1），意思对即可给分，不必逐字相同。
2. feedback 用一两句话说明判分理由；答错时指出正确的思路和错因分类（概念不清/审题偏差/计算错误/表达不完整）。
3. 直接按要求的结构输出，questionId 必须与题目一一对应。`;

/** 错题变形卷：考点不变、情境数字全换，专测同一个易错点 */
export const variantQuestionSchema = z.object({
  stem: z.string().describe("变形题题干：考点与原题相同，但情境/数字/问法全部换新"),
  options: z.array(z.string()).length(4).describe("4 个选项，不含 ABCD 前缀"),
  answer: z.string().describe("正确选项字母 A/B/C/D"),
  explanation: z.string().describe("解析：先给思路，再点明这道题和原题考的是同一个易错点"),
});

export const VARIANT_SYSTEM_PROMPT = `你是会"变形"的出题老师。给你一道学生刚做错的选择题和他的得分反馈，请出一道变形加练题：
1. 考点不变——专测同一个易错点，但数字、情境、问法全部换新，绝不是原题改个数字；
2. 难度与原题相当，只依据题干和解析里体现的知识点出题，不要引入新知识点；
3. 4 个选项的干扰项要合理，错误选项应各自对应一种典型误解；
4. 只返回 JSON。`;

/** 交互式讲课的结构化输出 */
export const lessonSchema = z.object({
  title: z.string().describe("本课标题"),
  intro: z.string().describe("开场白，一两句话，亲切自然"),
  sections: z
    .array(
      z.object({
        heading: z.string().describe("小节标题"),
        content: z
          .string()
          .describe("讲解正文，300~500 字，用 Markdown 排版：**加粗**核心概念和结论，并列要点用 - 列表，数学公式用 $...$（如 $\\frac{2}{7}$）；适合图示的内容可在正文中插图：实验装置/地图要素按 system 里的图示规则用 ```tikz 或 ```plan 围栏代码块，其它示意图用 ```svg 围栏代码块"),
      }),
    )
    .min(3)
    .max(5),
  quickCheck: z.object({
    stem: z.string().describe("随堂快问题干，考察本课最核心的点"),
    options: z.array(z.string()).length(4).describe("4 个选项，不含 ABCD 前缀"),
    answer: z.string().describe("正确选项字母 A/B/C/D"),
    explanation: z.string().describe("一两句话解释"),
  }),
  takeaways: z.array(z.string()).min(3).max(5).describe("本课要点速记，每条一句话"),
});

export const LESSON_SYSTEM_PROMPT = `你是一位耐心专业的老师，正在给学生讲一个知识点。规则：
1. 只依据给出的【资料片段】讲解，绝不编造资料里没有的内容；不需要学生去看原文。
2. 每节课的讲解结构要有意识地包含这些要素（来自 DeepTutor 原版讲解规范，并做了强化）：
   - **反直觉开场**：用本知识点里最违反直觉的事实、最容易答错的问题或最出人意料的结论开场（如"0.9的循环其实等于1"），先制造认知冲突，勾住学生——不要用"今天我们来学习……"这种开场；
   - 给出核心概念的准确定义，再用生活化比喻把定义讲透；
   - 提供 1-2 个具体例子，最好取自资料片段；
   - 指出这个知识点上学生最常见的误解，并说明为什么错。
3. **回马枪复习**：如果给出了【最近学过的知识点】，在讲解前段不动声色地安排一次"偷袭复习"——把其中一条旧知揉进新知的例子里或反直觉开场里（绝不宣布"现在复习前面学过的"），让学生在新课中自然把旧知再过一遍。没有【最近学过的知识点】就跳过这条。
4. 讲解要口语化、像真人老师，避免照本宣科；每段 300~500 字，整课正文不少于 1200 字，把知识点讲透而不是点到为止；不堆术语。
5. 排版用简洁 Markdown：核心概念、规则、结论用 **加粗** 标出；并列要点用 - 列表；数学一律用 $...$ 写行内公式（如 $\\frac{2}{7}$、$\\times$），不要裸写 \\frac 这类命令。
6. 如果给出了【学生情况】，开头要点出他的薄弱处，**讲解重点放在他不懂、答错的部分**——这些给足篇幅、配例子讲透；他已经掌握的内容一笔带过（一句话确认即可），不要平均用力。
7. 如果学生反馈没听懂或给了错题，换一种全新的讲法，不要重复之前的表述。
8. 需要图示时，在该小节正文里插图，按内容选两种方式之一：
   a) 实验装置图 / 地图要素图（化学、物理、生物的装置器材组合，地理的地图要素）→ 按下方【图示规则】指定的围栏格式输出（系统支持 LaTeX 时化学装置用 \`\`\`tikz，其余用 \`\`\`plan 布局计划 JSON）。**装置图绝不允许用 \`\`\`svg 手绘**——svg 画出来的装置会被系统当作错误直接删除；
   b) 其它自由图形（函数图像、几何关系、受力分析、电路、结构关系、流程等）→ 用 \`\`\`svg 围栏代码块，里面是一个完整的 <svg viewBox="0 0 宽 高">…</svg>，只用 line、circle、rect、ellipse、path、polygon、text 这些基本元素；线条用深色 stroke="#222"，强调用 stroke="#b91c1c"；中文标注用 <text>（font-size 13 左右，fill="#333"）；必须有 viewBox，宽不超过 480、高不超过 320；绝不包含脚本、事件属性、外部链接或图片引用。画之前先在心里核对事实：原子个数要和分子式一致（如 H₂O 是 2 个氢 + 1 个氧）、电荷正负不能反、方向和标注必须和图形一一对应，宁可不画也不要画错。
   一节课图示（tikz + plan + svg 合计）最多 2 张，只在真的帮助理解时才画——纯文字能讲清的不要硬画。
9. 直接按要求的结构输出，不要输出任何额外文字。`;

/** 讲课 system prompt 构建器：把 plan 图示规则（从配置动态生成）拼进基础规则 */
export function buildLessonSystemPrompt(planSection: string): string {
  return `${LESSON_SYSTEM_PROMPT}\n\n${planSection}`;
}

let counter = 0;
export function assignQuestionIds(questions: Array<Omit<QuizQuestion, "id">>): QuizQuestion[] {
  return questions.map((q) => ({ ...q, id: `q${Date.now().toString(36)}_${counter++}` }));
}

/** ── SVG 示意图自检 ─────────────────────────────────── */

export const svgVerifySchema = z.object({
  ok: z.boolean().describe("示意图是否事实正确、图文一致"),
  fixedSvg: z.string().describe("修正后的完整 SVG（从 <svg 到 </svg>）；本来就没问题就原样返回"),
  note: z.string().describe("一句话说明检查/修了什么，30 字以内"),
});

export const SVG_VERIFY_PROMPT = `你是理科课堂插图的审校老师。给你一段示意图的 SVG 代码、它要讲解的知识点和资料原文，请逐项核对：
1. 事实正确：数量（如分子式 H₂O 必须画 2 个氢原子 + 1 个氧原子）、电荷正负、方向（力的方向、电流方向、坐标轴朝向）、比例关系，必须与资料原文和科学事实一致；
2. 图文一致：每个 <text> 标注必须指向正确的图形元素；图上的数值要自己验算一遍（如标注直线 y=2x+1 上的点，坐标必须真的满足方程）；
3. 结构可读：元素不重叠、不超出 viewBox 范围，标注文字不压线。
只返回 JSON：没问题就 ok=true、fixedSvg 原样照抄；有任何错误就 ok=false，fixedSvg 返回修正后的完整 SVG（保持原有 viewBox 和整体布局，只修错的部分，不要重画风格）。`;

/** 从正文里抽出所有 ```svg 围栏块（full=含围栏的完整文本，用于替换回去） */
export function extractSvgBlocks(text: string): Array<{ full: string; svg: string }> {
  const out: Array<{ full: string; svg: string }> = [];
  const re = /```svg\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ full: m[0], svg: m[1].trim() });
  return out;
}

/** 程序化结构检查：单个 <svg> 根、带 viewBox、无脚本/事件/外部引用/坏数值 */
export function svgStructurallyOk(svg: string): boolean {
  const s = svg.trim();
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return false;
  if (!/viewBox\s*=/i.test(s)) return false;
  if (/<\s*(script|foreignObject|iframe|object|embed|image|use|audio|video|link|meta)\b/i.test(s)) return false;
  if (/\son[a-z]+\s*=/i.test(s)) return false;
  if (/javascript:/i.test(s)) return false;
  if (/NaN|undefined|null/.test(s)) return false;
  return true;
}

/** 编程题确定性判分：浏览器里跑出来的输出与预期逐字比对（归一化后），不经过 LLM */
export function gradeCodeQuestion(q: QuizQuestion, runOutput: string | undefined): GradeResult {
  if (runOutput === undefined) {
    return {
      questionId: q.id,
      correct: false,
      score: 0,
      feedback: "还没有运行代码——先点「运行」看看输出，再提交判分。",
      errorType: "未运行",
    };
  }
  const expected = normalizeProgramOutput(q.expectedOutput ?? "");
  const actual = normalizeProgramOutput(runOutput);
  if (!expected) {
    const ok = actual.length > 0;
    return {
      questionId: q.id,
      correct: ok,
      score: ok ? 1 : 0,
      feedback: ok ? "程序成功跑通并产出了输出。" : `程序没有任何输出。${q.explanation}`,
      errorType: ok ? undefined : "代码实现有误",
    };
  }
  const correct = actual === expected;
  return {
    questionId: q.id,
    correct,
    score: correct ? 1 : 0,
    feedback: correct
      ? "运行结果与预期完全一致，漂亮！"
      : `输出和预期不一致。\n预期输出：\n${expected}\n实际输出：\n${actual || "（什么都没有输出）"}\n提示：${q.explanation}`,
    errorType: correct ? undefined : "代码实现有误",
  };
}
