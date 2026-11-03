import { z } from "zod";
import { generateText } from "ai";
import { createRouter, publicQuery } from "../middleware";
import {
  getSettings,
  saveSettings,
  getChatModel,
  embedQuery,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  DEFAULT_EMBED_BASE_URL,
  DEFAULT_EMBED_MODEL,
} from "../lib/ai";

function mask(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export const settingsRouter = createRouter({
  get: publicQuery.query(async () => {
    const s = await getSettings();
    return {
      deepseekBaseUrl: DEEPSEEK_BASE_URL,
      deepseekModel: DEEPSEEK_MODEL,
      hasDeepseekKey: Boolean(s.deepseekApiKey),
      deepseekKeyMasked: mask(s.deepseekApiKey),
      embedBaseUrl: s.embedBaseUrl,
      embedModel: s.embedModel,
      hasEmbedKey: Boolean(s.embedApiKey),
      embedKeyMasked: mask(s.embedApiKey),
      defaultEmbedBaseUrl: DEFAULT_EMBED_BASE_URL,
      defaultEmbedModel: DEFAULT_EMBED_MODEL,
    };
  }),

  update: publicQuery
    .input(
      z.object({
        deepseekApiKey: z.string().max(255).optional(),
        embedBaseUrl: z.string().max(255).optional(),
        embedApiKey: z.string().max(255).optional(),
        embedModel: z.string().max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // 空字符串 = 用户没动这个字段，保留旧值
      const patch: Record<string, string> = {};
      if (input.deepseekApiKey?.trim()) patch.deepseekApiKey = input.deepseekApiKey.trim();
      if (input.embedApiKey?.trim()) patch.embedApiKey = input.embedApiKey.trim();
      if (input.embedBaseUrl !== undefined) patch.embedBaseUrl = input.embedBaseUrl.trim();
      if (input.embedModel !== undefined) patch.embedModel = input.embedModel.trim();
      await saveSettings(patch);
      return { ok: true };
    }),

  /** 各发一次真实小请求验证配置 */
  test: publicQuery.mutation(async () => {
    const result: { chat: string; embed: string } = { chat: "", embed: "" };
    try {
      const model = await getChatModel();
      await generateText({
        model,
        prompt: "只回复一个字：好",
        maxOutputTokens: 10,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(30_000),
      });
      result.chat = "ok";
    } catch (err) {
      result.chat = err instanceof Error ? err.message : String(err);
    }
    try {
      await embedQuery("测试");
      result.embed = "ok";
    } catch (err) {
      result.embed = err instanceof Error ? err.message : String(err);
    }
    return result;
  }),
});
