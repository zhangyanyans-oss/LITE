/**
 * plan 管道编排：从讲课正文里抽出 ```plan 围栏 → 校验 →（必要时）最多两轮模型修正 → 渲染成 SVG 替换回正文。
 * 任何一步最终失败都删除该 plan 块并记日志，不让坏图进课堂。
 */
import { structuredCall } from "../ai";
import { log } from "../logger";
import { layoutPlanSchema, loadDiagramConfig, type LayoutPlan, type RegistryFile } from "./config";
import { buildFixFeedback, checkPlanSchema, validatePlan } from "./validate";
import { FEW_SHOT_PLAN } from "./prompt";
import { renderPlan } from "./render";
import { detectSubject, figureBlockFor, matchFigureForPlan, type AtlasSubject } from "./atlas";

export {
  buildFigurePromptSection,
  processFigureBlocks,
  getFigure,
  loadAtlas,
  libraryItems,
  matchFigureForPlan,
  detectSubject,
} from "./atlas";
export type { PlanFallbackQuery, PlanFallbackHit, AtlasSubject, FigureKind, AtlasItem } from "./atlas";

export function extractPlanBlocks(text: string): Array<{ full: string; json: string }> {
  const out: Array<{ full: string; json: string }> = [];
  const re = /```plan\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ full: m[0], json: m[1].trim() });
  return out;
}

/** 修正轮最多 2 次（主构架文档 maxRetries=2；加上最初生成共 3 次机会） */
const MAX_FIX_ROUNDS = 2;

const PLAN_FIX_SYSTEM = `你是布局计划修正器，同时具备顶尖化学实验室架构师的严谨。根据错误清单修正布局计划 JSON：只返回修正后的完整 JSON，保持 subject 和 canvas_hint 不变；不要输出坐标数字、SVG 或任何解释文字。expected_counts 必须与 devices 实际数量一致，connections 的 id 必须存在。
化学装置必须遵守：长颈漏斗 bottom_out 连到容器 liquid_inside（液封）；加热试管 params.tilted="down" 且导管从 mouth_open 引出；向上排空气法集气瓶 has_glass_plate=true 且导管接 bottom_in；排水法集气瓶 inverted=true 且导管接 bottom_in。
一个能通过全部校验的满分示例（高锰酸钾制氧气，排水法收集）：
${JSON.stringify(FEW_SHOT_PLAN)}`;

export interface PlanProcessContext {
  /** 给修正轮提供上下文：讲的是什么知识点 */
  topic: string;
}

/** 处理一段正文里的所有 plan 块（每小节最多 2 个），返回替换后的正文 */
export async function processPlanBlocks(content: string, ctx: PlanProcessContext): Promise<string> {
  const blocks = extractPlanBlocks(content);
  if (blocks.length === 0) return content;
  let out = content;
  // 模型自己在正文里引用过的图记下来，兜底时不再顶一张重复的（atlas/phy/phs/his/bio/geo-NNN）
  const usedFigures = new Set(content.match(/(?:atlas|phy|phs|his|bio|geo)-\d{3}/g) ?? []);

  for (const { full, json } of blocks.slice(0, 2)) {
    const built = await planToSvg(json, ctx).catch((e) => {
      log.warn("plan block processing failed", { error: e instanceof Error ? e.message : String(e) });
      return null;
    });
    if (built) {
      // 正向收紧：计划本身画得出来，但主题点名的就是图库里那台标准装置 → 直接用教材原图
      // （提示词里已经要求"图库有的不许再画"，这里在代码层兜住，模型不听话也不会退化成现画图）
      const std = standardFigureForPlan(built.plan, ctx.topic, [...usedFigures]);
      if (std) {
        usedFigures.add(std.id);
        log.info("standard plan replaced by atlas figure", { id: std.id, why: std.why, topic: ctx.topic });
        out = out.replace(full, () => std.block);
        continue;
      }
      out = out.replace(full, () => "```svg\n" + built.svg + "\n```");
      continue;
    }
    // 引擎画不出来：先看图库有没有同一个实验的教材原图，能顶上就不让学生这节课缺图
    const fig = planFallbackFigure(json, ctx.topic, [...usedFigures]);
    if (fig) {
      usedFigures.add(fig.id);
      log.info("plan failed, fallback to atlas figure", { id: fig.id, why: fig.why, topic: ctx.topic });
      out = out.replace(full, () => fig.block);
    } else {
      // 图库也没有：整块删掉（模型正文里通常还有文字讲解，宁缺不留坏图）
      out = out.replace(full, "");
    }
  }
  return out;
}

/**
 * 计划里出现"刻意与常规不同"的参数时，不要把教材标准图顶上去。
 * 这类 plan 通常是题目改造过的（管口不倾斜、不盖玻璃片、不放滤纸），
 * 换成教材原图等于把这个变体讲成了标准装置——比不换更糟。
 */
function variantMarker(plan: LayoutPlan): string | null {
  const hasBurner = plan.devices.some((d) => d.type === "burner");
  for (const d of plan.devices) {
    if (d.type === "test_tube" && hasBurner && d.params?.tilted === "none")
      return `${d.id} 加热试管未倾斜`;
    if (d.type === "test_tube" && d.params?.has_cotton === false) return `${d.id} 明确不塞棉花`;
    if (d.type === "funnel" && d.params?.has_filter_paper === false) return `${d.id} 明确不放滤纸`;
    if (d.type === "gas_jar" && d.params?.has_glass_plate === false) return `${d.id} 明确不盖玻璃片`;
  }
  return null;
}

/**
 * 正向收紧：plan 已经通过校验、也画得出来，但图库里有同一台标准装置时，改用教材原图。
 *
 * 比反向兜底更保守——只认"主题点名 + 整套器材对得上"，且计划里不能有变体参数；
 * 讲错例的段落（"反例""纠错""找错"）一律不换，否则会把用来找错的图换成标准图。
 */
export function standardFigureForPlan(
  plan: LayoutPlan,
  topic: string,
  exclude: string[] = [],
): { id: string; block: string; why: string } | null {
  // 图库只有化学和物理两科；生物/地理的 plan 走引擎现画
  const subject = plan.subject === "physics" ? "physics" : plan.subject === "chemistry" ? "chemistry" : null;
  if (!subject) return null;
  if (/反例|错误|纠错|找错|错在/.test(topic)) return null;
  const variant = variantMarker(plan);
  if (variant) {
    log.info("keep engine figure: plan has variant params", { variant, topic });
    return null;
  }

  let registry: RegistryFile | undefined;
  try {
    registry = loadDiagramConfig().registries[plan.subject];
  } catch {
    registry = undefined;
  }
  const devices = plan.devices
    .map((d) => {
      const name = registry?.types[d.type]?.display_name;
      return [...new Set([name, d.label].filter((s): s is string => !!s))].join("|");
    })
    .filter((s) => !!s);
  const hit = matchFigureForPlan({ topic, devices, text: JSON.stringify(plan), exclude, strict: true, subject });
  return hit ? { id: hit.item.id, block: figureBlockFor(hit.item), why: hit.why } : null;
}

/**
 * plan 走不通时的反向兜底：从图库里找同一个实验的教材原图顶上。
 *
 * 化学、物理各自只在本科图库里找（生物/地理没有图库，直接返回 null）：
 * 拿化学装置图去顶物理电路图必然张冠李戴。
 */
export function planFallbackFigure(
  planText: string,
  topic: string,
  exclude: string[] = [],
): { id: string; block: string; why: string } | null {
  let raw: unknown = null;
  try {
    raw = JSON.parse(planText);
  } catch {
    raw = null; // JSON 坏掉也可能救回来：靠主题里的实验名
  }
  const declared =
    raw && typeof raw === "object" && typeof (raw as { subject?: unknown }).subject === "string"
      ? (raw as { subject: string }).subject
      : null;
  // 计划自己写了学科就按它来；JSON 坏掉时按主题猜（物理题几乎不会写出化学器材清单）
  const subject: AtlasSubject | "physics-all" | null =
    declared === "chemistry" || declared === "physics" || declared === "physics-hs"
      ? declared
      : (detectSubject(topic) ?? null);
  if (!subject) return null;
  // 学科对不上就明说：plan 说是生物、主题却是化学，两边的证据都不硬，宁可不顶图
  const detected = detectSubject(topic);
  if (declared && detected && detected !== "physics-all" && declared !== detected) return null;

  let registry: RegistryFile | undefined;
  try {
    registry = loadDiagramConfig().registries[subject];
  } catch {
    registry = undefined;
  }

  // 器材中文名：优先按注册表 display_name 换算，类型是模型编的时退回它自己写的 label；
  // 两个名字一起给（"试剂瓶|锥形瓶"），图库里叫哪个都能对上
  const devices: string[] = [];
  const list = raw && typeof raw === "object" ? (raw as { devices?: unknown }).devices : null;
  if (Array.isArray(list)) {
    for (const d of list) {
      if (!d || typeof d !== "object") continue;
      const type = (d as { type?: unknown }).type;
      const label = (d as { label?: unknown }).label;
      const name = typeof type === "string" ? registry?.types[type]?.display_name : undefined;
      const tag = typeof label === "string" ? label.trim() : "";
      const parts = [name, tag].filter((s): s is string => !!s && s.length > 0);
      const uniq = [...new Set(parts)];
      if (uniq.length > 0) devices.push(uniq.join("|"));
    }
  }

  const hit = matchFigureForPlan({ topic, devices, text: planText, exclude, subject });
  return hit ? { id: hit.item.id, block: figureBlockFor(hit.item), why: hit.why } : null;
}

/** 校验一个候选计划；通过返回 plan，否则返回给模型可读的错误反馈 */function checkCandidate(
  raw: unknown,
  cfg: ReturnType<typeof loadDiagramConfig>,
): { plan: LayoutPlan } | { feedback: string } {
  const checked = checkPlanSchema(raw);
  if (!("plan" in checked)) return { feedback: buildFixFeedback(checked.errors) };
  const registry = cfg.registries[checked.plan.subject];
  const rules = cfg.rules[checked.plan.subject] ?? [];
  const errors = validatePlan(checked.plan, registry, rules);
  for (const e of errors.filter((e) => !e.fatal)) log.warn("plan warning", { code: e.code, message: e.message });
  if (errors.filter((e) => e.fatal).length === 0) return { plan: checked.plan };
  return { feedback: buildFixFeedback(errors) };
}

async function planToSvg(
  json: string,
  ctx: PlanProcessContext,
): Promise<{ svg: string; plan: LayoutPlan } | null> {
  const cfg = loadDiagramConfig();

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = null;
  }

  let feedback =
    raw === null ? "上一轮输出的不是合法 JSON，请重新输出完整的布局计划 JSON：" : null;
  let plan: LayoutPlan | null = null;
  if (raw !== null) {
    const r = checkCandidate(raw, cfg);
    if ("plan" in r) plan = r.plan;
    else feedback = r.feedback;
  }

  // 自检-纠错回环：把具体错误码和涉及的 id 喂回模型，最多修正 MAX_FIX_ROUNDS 轮
  for (let round = 1; !plan && feedback && round <= MAX_FIX_ROUNDS; round++) {
    const fixed = await structuredCall({
      schema: layoutPlanSchema,
      system: PLAN_FIX_SYSTEM,
      prompt: `${feedback}\n\n【图示主题】${ctx.topic}\n\n【上一轮的计划】\n${json.slice(0, 3000)}`,
      maxTokens: 4096,
    }).catch(() => null);
    if (!fixed) break;
    const r = checkCandidate(fixed, cfg);
    if ("plan" in r) plan = r.plan;
    else {
      feedback = r.feedback;
      log.warn(`plan fix round ${round} still has fatal errors`);
    }
  }

  if (!plan) return null;
  return { svg: renderPlan(plan, cfg.registries[plan.subject]), plan };
}

/* ── 手写装置图的闸门 ───────────────────────────────── */

/** 器材名词表：来自注册表里标了 apparatus 的类型，学科新增类型自动生效 */
let apparatusWords: string[] | null = null;
function apparatusVocabulary(): string[] {
  if (apparatusWords) return apparatusWords;
  const cfg = loadDiagramConfig();
  const set = new Set<string>();
  for (const reg of Object.values(cfg.registries)) {
    for (const def of Object.values(reg.types)) {
      if (def.apparatus) set.add(def.display_name);
    }
  }
  apparatusWords = [...set].sort((a, b) => b.length - a.length);
  return apparatusWords;
}

/**
 * 丢弃"手绘的实验装置图"。
 *
 * 走 plan/tikz 通道的图由引擎产出，插进去时会带上 data-dg 标记，这里一律放过；
 * 没有标记、画面里又出现器材名的 svg，是模型绕开布局引擎直接画的——没有任何几何约束，
 * 于是出现"燃烧匙从玻璃片中间穿过去""试管悬在水槽上方"这种错误。宁可这节课没有图，也不能让错图进课堂。
 */
export function stripHandDrawnApparatus(content: string): { content: string; dropped: number } {
  const words = apparatusVocabulary();
  let dropped = 0;
  const judge = (svg: string): boolean => {
    if (/data-dg=/.test(svg)) return false; // 引擎/TikZ 产物
    const hits = words.filter((w) => svg.includes(w));
    if (hits.length === 0) return false; // 纯几何/电路等抽象图，允许手绘
    dropped++;
    log.warn("dropped hand-drawn apparatus svg", { hits: hits.slice(0, 5), size: svg.length });
    return true;
  };
  let out = content.replace(/```svg\s*([\s\S]*?)```/g, (full, svg: string) => (judge(svg) ? "" : full));
  // 模型有时连围栏都省了，直接甩一个裸 <svg>（前端也认），这里一并拦下
  out = out.replace(/<svg[\s\S]*?<\/svg>/g, (full) => (judge(full) ? "" : full));
  return { content: out, dropped };
}
