import {
  mysqlTable,
  serial,
  varchar,
  text,
  json,
  int,
  double,
  bigint,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/mysql-core";

/** 单行配置表（id 固定为 1）：DeepSeek 写死，只存密钥；向量接口可配 */
export const settings = mysqlTable("settings", {
  id: serial("id").primaryKey(),
  deepseekApiKey: varchar("deepseek_api_key", { length: 255 }),
  embedBaseUrl: varchar("embed_base_url", { length: 255 }),
  embedApiKey: varchar("embed_api_key", { length: 255 }),
  embedModel: varchar("embed_model", { length: 255 }),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

export const knowledgeBases = mysqlTable("knowledge_bases", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const kbDocuments = mysqlTable(
  "kb_documents",
  {
    id: serial("id").primaryKey(),
    kbId: bigint("kb_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    filename: varchar("filename", { length: 255 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"), // pending | ok | error
    error: text("error"),
    charCount: int("char_count").notNull().default(0),
    chunkCount: int("chunk_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_doc_kb").on(t.kbId)],
);

/** 索引块：教学/出题只从这里搬文字，永不回读原 PDF/图片 */
export const kbChunks = mysqlTable(
  "kb_chunks",
  {
    id: serial("id").primaryKey(),
    kbId: bigint("kb_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    docId: bigint("doc_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => kbDocuments.id, { onDelete: "cascade" }),
    seq: int("seq").notNull(),
    content: text("content").notNull(),
    /** number[] 余弦检索用 */
    embedding: json("embedding").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_chunk_kb").on(t.kbId)],
);

export const courses = mysqlTable("courses", {
  id: serial("id").primaryKey(),
  kbId: bigint("kb_id", { mode: "number", unsigned: true })
    .notNull()
    .references(() => knowledgeBases.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 200 }).notNull(),
  goal: text("goal").notNull(),
  /** CourseStructure JSON：模块 → 知识点 */
  structure: json("structure").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** 掌握度引擎的唯一事实来源：进阶判定完全由这里的数据决定 */
export const objectiveStates = mysqlTable(
  "objective_states",
  {
    id: serial("id").primaryKey(),
    courseId: bigint("course_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    objectiveId: varchar("objective_id", { length: 64 }).notNull(),
    /** 最近判分的滑动平均，0..1 */
    mastery: double("mastery").notNull().default(0),
    attempts: int("attempts").notNull().default(0),
    status: varchar("status", { length: 16 }).notNull().default("active"), // active | mastered | weak(待巩固)
    /** 三段式阶段：diagnose 摸底 | learn 上课 | final 结课测验 | done 完成 */
    stage: varchar("stage", { length: 16 }).notNull().default("diagnose"),
    /** 摸底得分 0..1 */
    baseline: double("baseline"),
    /** 结课测验已考次数（超过上限标记待巩固并放行） */
    finalAttempts: int("final_attempts").notNull().default(0),
    lastFeedback: text("last_feedback"),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [
    uniqueIndex("uq_course_objective").on(t.courseId, t.objectiveId),
    index("idx_state_course").on(t.courseId),
  ],
);

/** 学习页消息：teach=导师讲授 / quiz=关卡题卡 / grade=判分结果 */
export const learnMessages = mysqlTable(
  "learn_messages",
  {
    id: serial("id").primaryKey(),
    courseId: bigint("course_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull(), // user | assistant
    kind: varchar("kind", { length: 16 }).notNull().default("teach"),
    objectiveId: varchar("objective_id", { length: 64 }),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_msg_course").on(t.courseId)],
);

export const quizzes = mysqlTable("quizzes", {
  id: serial("id").primaryKey(),
  kbId: bigint("kb_id", { mode: "number", unsigned: true }).references(
    () => knowledgeBases.id,
    { onDelete: "set null" },
  ),
  topic: varchar("topic", { length: 255 }).notNull(),
  /** QuizQuestion[] JSON —— 生成即落库，绝不"只思考不出题" */
  questions: json("questions").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const quizAttempts = mysqlTable(
  "quiz_attempts",
  {
    id: serial("id").primaryKey(),
    quizId: bigint("quiz_id", { mode: "number", unsigned: true })
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    /** { questionId: answer } */
    answers: json("answers").notNull(),
    /** GradeResult[] */
    results: json("results").notNull(),
    score: double("score").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_attempt_quiz").on(t.quizId)],
);
