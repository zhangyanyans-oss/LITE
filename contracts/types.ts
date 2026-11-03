// 深学 Lite —— 前后端共享类型（DeepTutor 精简版）

/** 知识点类型（沿用 DeepTutor 分类） */
export type KnowledgeType = "memory" | "concept" | "procedure" | "design";

/** 课程目标（知识点） */
export type Objective = {
  id: string;
  title: string;
  /** 一句话说明这个知识点要学什么 */
  summary: string;
  /** 检索提示词：教学/出题时用它在知识库里捞原文片段 */
  query: string;
  /** 知识点类型：记忆 / 概念 / 程序 / 设计（旧课程可能没有） */
  type?: KnowledgeType;
};

export type CourseModule = {
  id: string;
  title: string;
  /** 能力契约：一句话说明学完这个模块后学习者能做什么（DeepTutor 原版逻辑） */
  objective?: string;
  /** 本模块覆盖的知识库文档名（逐字照抄），用于覆盖校验 */
  materials?: string[];
  objectives: Objective[];
};

export type CourseStructure = {
  title: string;
  goal: string;
  /** 一句有吸引力的路线描述 */
  description?: string;
  modules: CourseModule[];
};

export type QuestionType = "choice" | "short" | "code";

export type QuizQuestion = {
  id: string;
  type: QuestionType;
  stem: string;
  /** 选择题的 4 个选项（不含 A/B/C/D 前缀） */
  options?: string[];
  /** 选择题为标准答案字母（如 "B"）；简答题为参考答案；编程题为完整可运行的参考代码 */
  answer: string;
  explanation: string;
  /** 出题依据的知识库文档名 */
  source?: string;
  /** 编程题：预置的代码框架（含 #include <iostream> 与 main，核心部分留空） */
  starterCode?: string;
  /** 编程题：程序运行后的精确预期输出 */
  expectedOutput?: string;
};

/**
 * 程序输出归一化：统一换行、去掉每行末尾空白和整体首尾空白。
 * 前后端判别用同一套规则，避免 "多了个换行就判错"。
 */
export function normalizeProgramOutput(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .trim();
}

export type GradeResult = {
  questionId: string;
  correct: boolean;
  /** 0..1，简答允许部分分 */
  score: number;
  feedback: string;
  /** 错因分类：概念不清 / 审题偏差 / 计算错误 / 表达不完整 / 未掌握 */
  errorType?: string;
};

/** 错题变形卷：考点不变、情境全换的一道加练单选题（判分结果里附带，翻牌自测） */
export type QuizVariant = {
  stem: string;
  options: string[];
  answer: string;
  explanation: string;
};

export type ObjectiveStatus = "active" | "mastered" | "weak";

/** 三段式课堂的阶段：摸底 → 上课 → 结课测验 → 完成 */
export type ObjectiveStage = "diagnose" | "learn" | "final" | "done";

export type QuizPhase = "diagnostic" | "final";

export type LearnMessageKind = "teach" | "quiz" | "grade" | "lesson";

/** 交互式讲课文案（LLM 一次结构化生成） */
export type Lesson = {
  title: string;
  /** 开场白：一两句话，承接摸底结果 */
  intro: string;
  /** 分段讲解，2~4 段 */
  sections: Array<{ heading: string; content: string }>;
  /** 随堂快问：点一下立即知道对错 */
  quickCheck: {
    stem: string;
    options: string[];
    answer: string;
    explanation: string;
  };
  /** 本课要点速记，2~4 条 */
  takeaways: string[];
};

/** 学习页状态快照 */
export type LearnState = {
  courseId: number;
  title: string;
  goal: string;
  /** 一句有吸引力的路线描述 */
  description?: string;
  modules: Array<{
    id: string;
    title: string;
    /** 能力契约：学完这个模块能做什么 */
    objective?: string;
    objectives: Array<{
      id: string;
      title: string;
      summary: string;
      type?: KnowledgeType;
      mastery: number;
      attempts: number;
      status: ObjectiveStatus;
      stage: ObjectiveStage;
      /** 摸底得分 0..1，未摸底为 null */
      baseline: number | null;
      finalAttempts: number;
      current: boolean;
    }>;
  }>;
  totalObjectives: number;
  masteredObjectives: number;
};

/** 结课测验过关线 */
export const PASS_SCORE = 0.8;
/** 结课测验最多补考次数，超过后标记"待巩固"并放行（绝不死循环） */
export const MAX_FINAL_ATTEMPTS = 2;
/** 知识点"掌握"线：最近几次平均分达到这条线且考过规定次数，才允许进阶 */
export const MASTERY_THRESHOLD = 0.75;
/** 掌握判定要求的最少作答次数（考一次就过太偶然） */
export const MASTERY_MIN_ATTEMPTS = 2;
