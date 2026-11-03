/**
 * LLM 访问层 —— DeepSeek 写死，向量接口可配。
 *
 * 反循环/反"只思考不输出"的三条硬规则都在这里：
 * 1. 没有任何 agent 循环：一次业务动作 = 一次 LLM 调用。
 * 2. 结构化产出走 generateObject + zod schema，模型必须交出 JSON；
 *    解析失败只允许重试一次，再失败就把错误抛给用户，绝不无限重试。
 * 3. 每次调用都有硬超时，到点即断，错误原样上报。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, embedMany, zodSchema } from "ai";
import type { ZodType } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { settings } from "@db/schema";

// 对外行为固定为 DeepSeek；环境变量仅供开发自测时临时改道
export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

/** 向量接口默认值（DeepSeek 没有 embedding 服务，推荐硅基流动的免费模型） */
export const DEFAULT_EMBED_BASE_URL = "https://api.siliconflow.cn/v1";
export const DEFAULT_EMBED_MODEL = "BAAI/bge-m3";

const LLM_TIMEOUT_MS = 120_000;
const EMBED_BATCH = 24;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type AppSettings = {
  deepseekApiKey: string;
  embedBaseUrl: string;
  embedApiKey: string;
  embedModel: string;
};

export async function getSettings(): Promise<AppSettings> {
  const db = getDb();
  const rows = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  const row = rows[0];
  return {
    deepseekApiKey: row?.deepseekApiKey ?? "",
    embedBaseUrl: row?.embedBaseUrl || DEFAULT_EMBED_BASE_URL,
    embedApiKey: row?.embedApiKey ?? "",
    embedModel: row?.embedModel || DEFAULT_EMBED_MODEL,
  };
}

export async function saveSettings(input: Partial<AppSettings>): Promise<void> {
  const db = getDb();
  const existing = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  if (existing.length === 0) {
    await db.insert(settings).values({
      id: 1 as never,
      deepseekApiKey: input.deepseekApiKey ?? null,
      embedBaseUrl: input.embedBaseUrl ?? null,
      embedApiKey: input.embedApiKey ?? null,
      embedModel: input.embedModel ?? null,
    });
    return;
  }
  const patch: Record<string, string | null> = {};
  if (input.deepseekApiKey !== undefined) patch.deepseekApiKey = input.deepseekApiKey || null;
  if (input.embedBaseUrl !== undefined) patch.embedBaseUrl = input.embedBaseUrl || null;
  if (input.embedApiKey !== undefined) patch.embedApiKey = input.embedApiKey || null;
  if (input.embedModel !== undefined) patch.embedModel = input.embedModel || null;
  await db.update(settings).set(patch).where(eq(settings.id, 1));
}

export async function getChatModel() {
  const s = await getSettings();
  if (!s.deepseekApiKey) {
    throw new ConfigError("还没有配置 DeepSeek API Key，请到「设置」页填写后再试。");
  }
  const provider = createOpenAICompatible({
    name: "deepseek",
    baseURL: DEEPSEEK_BASE_URL,
    apiKey: s.deepseekApiKey,
  });
  return provider.chatModel(DEEPSEEK_MODEL);
}

export async function getEmbedModel() {
  const s = await getSettings();
  if (!s.embedApiKey) {
    throw new ConfigError(
      "还没有配置向量接口。DeepSeek 不提供向量服务，请到「设置」页填写一个 OpenAI 兼容的向量接口（默认已填好硅基流动的地址，只需补 Key）。",
    );
  }
  const provider = createOpenAICompatible({
    name: "embed",
    baseURL: s.embedBaseUrl,
    apiKey: s.embedApiKey,
  });
  return provider.textEmbeddingModel(s.embedModel);
}

/** 批量 embedding，分批调用避免一次请求过大 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const model = await getEmbedModel();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const { embeddings } = await embedMany({
      model,
      values: batch,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      maxRetries: 1,
    });
    out.push(...embeddings);
  }
  return out;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text]);
  return vec;
}

/** 从模型输出里抢救出一个 JSON 对象（截取首个 { 到末个 }，截断时尝试补齐） */
function extractJson(text: string): unknown {
  // 只剥包裹整个 JSON 的最外层围栏；字符串值内部的围栏（比如讲课正文里的 ```svg 示意图块）必须原样保留
  const cleaned = text.trim().replace(/^```(?:json)?\s*\r?\n?/, "").replace(/\r?\n?```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有输出 JSON");
  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    const repaired = repairTruncatedJson(slice);
    if (repaired !== null) return repaired;
    throw new Error("模型输出的 JSON 不完整");
  }
}

/** 输出被 maxTokens 截断时的兜底修复：去掉末尾不完整的键/值，补齐未闭合的引号和括号 */
function repairTruncatedJson(s: string): unknown | null {
  let out = s;
  // 逐次砍掉末尾不完整的部分：半个键、悬空的冒号、悬空的逗号
  for (;;) {
    const next = out
      .replace(/,\s*"[^"]*$/, "") // 半个键：, "ste
      .replace(/:\s*$/, "") // 悬空冒号："stem":
      .replace(/,\s*$/, ""); // 悬空逗号
    if (next === out) break;
    out = next;
    // 若上一步砍完后又露出新的悬空尾，继续砍
  }
  // 追踪未闭合的字符串与括号
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of out) {
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) out += '"';
  // 字符串闭合后可能又留下半个键（如 "abc" 没有值），再清一轮
  out = out.replace(/,\s*"[^"]*"$/, "").replace(/,\s*$/, "");
  out = out + stack.reverse().join("");
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * 结构化 LLM 调用：把 JSON Schema 明文写进 prompt，自由生成 + 代码侧 zod 校验。
 * 不依赖各家厂商参差不齐的 response_format 实现——DeepSeek、网关、任何
 * OpenAI 兼容端点都走同一条路。最多 2 次尝试（第二次附带纠错提示），
 * 失败即抛错给用户，绝不无限重试。这就是"说出题就必出题"的保证。
 */
export async function structuredCall<T>(opts: {
  schema: ZodType<T>;
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<T> {
  const model = await getChatModel();
  const jsonSchema = JSON.stringify(zodSchema(opts.schema).jsonSchema);
  const system =
    opts.system +
    `\n\n只输出一个符合以下 JSON Schema 的 JSON 对象（不要用 markdown 代码块包裹，不要输出任何解释文字）：\n${jsonSchema}`;
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await generateText({
        model,
        system,
        prompt: attempt === 0 ? opts.prompt : `${opts.prompt}\n\n（上次输出格式错误，这次请严格按 JSON Schema 输出。）`,
        maxOutputTokens: opts.maxTokens ?? 8192,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      return opts.schema.parse(extractJson(text));
    } catch (err) {
      lastError = err;
      if (err instanceof ConfigError) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
