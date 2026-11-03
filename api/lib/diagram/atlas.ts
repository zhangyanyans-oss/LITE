/**
 * 教材插图库：讲解装置（化学）/装置与光路原理图（物理）时直接引用教材原图，而不是让引擎现画。
 *
 * 为什么要有这条通道：布局引擎（render.ts）保证的是"装配关系不违反规则"，
 * 但它只有几十种简化图元，画出来的线条、比例、玻璃质感都达不到教材插图的水准；
 * 而教材原图里的装配（导管插入深度、塞子开孔、铁夹位置）本身就是人画准的。
 * 物理更极端：注册表里只有 10 类器材（斜面、滑轮、电池……），根本画不出光路、成像、
 * 液体压强这些图，所以物理几乎全靠这条通道。
 *
 * 一个学科一份清单，互不串台（化学课不该收到物理光路图的 id 清单，反过来也一样）：
 *   config/diagram/atlas/library.json  化学：《初中图库常用大全.doc》矢量图 400dpi 切分
 *   config/diagram/atlas/physics.json  物理：实验专题讲义（扫描 89 页）+ 光路图大全（表格切格）
 * 只收录画得完整、能当教学插图的图；画残的、裁掉零件的都没进清单。
 */
import { readFileSync } from "fs";
import path from "path";
import { log } from "../logger";

export type FigureKind = "setup" | "part" | "wrong" | "principle";
export type AtlasSubject =
  | "chemistry"
  | "physics"
  | "physics-hs"
  | "history"
  | "biology"
  | "geography";

export interface AtlasItem {
  id: string;
  file: string;
  name: string;
  kind: FigureKind;
  aliases: string[];
  tags: string[];
  devices: string[];
  /** 装配要点：这张图为什么画成这样，讲课时可照着说 */
  assembly: string;
  width: number;
  height: number;
  note?: string;
  /** 所属学科（由清单文件决定，不靠条目自己声明） */
  subject: AtlasSubject;
}

interface AtlasLibrary {
  baseUrl: string;
  items: AtlasItem[];
  byId: Map<string, AtlasItem>;
  bySubject: Map<AtlasSubject, AtlasItem[]>;
}

/** 一个学科一份清单；新增学科只要往这里加一行，其余逻辑不用改 */
const LIBRARY_FILES: Array<{ subject: AtlasSubject; file: string }> = [
  { subject: "chemistry", file: "library.json" },
  { subject: "physics", file: "physics.json" },
  { subject: "physics-hs", file: "physics-hs.json" },
  { subject: "history", file: "history.json" },
  { subject: "biology", file: "biology.json" },
  { subject: "geography", file: "geography.json" },
];

let cache: AtlasLibrary | null = null;

export function loadAtlas(): AtlasLibrary {
  if (cache) return cache;
  const dir = path.resolve(process.cwd(), "config", "diagram", "atlas");
  const items: AtlasItem[] = [];
  let baseUrl = "/atlas/";

  for (const spec of LIBRARY_FILES) {
    let raw: { baseUrl?: string; items?: AtlasItem[] };
    try {
      raw = JSON.parse(readFileSync(path.join(dir, spec.file), "utf8"));
    } catch (e) {
      // 一个学科的清单坏了不能拖垮另一个：跳过它，课堂上少一类图而已
      log.warn("atlas library unavailable", {
        subject: spec.subject,
        file: spec.file,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const list = Array.isArray(raw.items) ? raw.items : [];
    if (raw.baseUrl) baseUrl = raw.baseUrl;
    for (const it of list) items.push({ ...it, subject: spec.subject });
  }

  if (items.length === 0) throw new Error("图库为空：config/diagram/atlas 下没有任何可用的清单");
  const bySubject = new Map<AtlasSubject, AtlasItem[]>();
  for (const it of items) {
    const arr = bySubject.get(it.subject);
    if (arr) arr.push(it);
    else bySubject.set(it.subject, [it]);
  }
  cache = {
    baseUrl,
    items,
    byId: new Map(items.map((it) => [it.id, it])),
    bySubject,
  };
  return cache;
}

/** 取某学科的图；不传学科就返回全部（跨库查 id 时用） */
export function libraryItems(subject?: AtlasSubject): AtlasItem[] {
  const lib = loadAtlas();
  return subject ? (lib.bySubject.get(subject) ?? []) : lib.items;
}

/** 按 id 取图；不存在返回 null（模型可能编造 id，调用方据此丢弃该块） */
export function getFigure(id: string): AtlasItem | null {
  return loadAtlas().byId.get(id.trim()) ?? null;
}

export function figureUrl(item: AtlasItem): string {
  return `${loadAtlas().baseUrl}${item.file}`;
}

/* ── 提示词：把图库清单交给模型 ─────────────────────────── */

/** 装配要点压到一行，避免清单吃掉太多上下文 */
function brief(text: string, max = 42): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 每个学科的清单措辞不一样：化学讲"装配关系"，物理讲"图上要素" */
const SUBJECT_PROMPT: Record<
  AtlasSubject,
  {
    title: string;
    intro: string;
    hint: string;
    example: string;
    /** 清单分组标题：不同学科的"装置图/原理图"叫法不一样 */
    setupLabel?: string;
    principleLabel?: string;
  }
> = {
  chemistry: {
    title: "教材装置图库（优先使用）",
    intro:
      "讲到下面这些实验的**装置**时，直接引用图库里的教材原图，**不要再写 plan**——现画的图装配关系不如教材原图可靠，学生也更容易对上课本。",
    hint: "引用后要在正文里说明这张图的**关键装配关系**（导管插到哪、塞子在哪、铁夹夹在哪、加热位置），不要只甩一张图。",
    example: "atlas-123",
  },
  physics: {
    title: "教材插图库（实验装置图＋光路原理图）",
    intro:
      "讲到下面这些实验的装置，或光路、成像、压强、电路这类原理图时，直接引用图库里的原图，**不要再写 plan**——物理引擎只有 10 类器材图元（斜面、滑轮、电池、电表…），画不出光线、成像和液柱，硬画出来只会错。",
    hint: "引用后要在正文里点出图上的**关键要素**（法线怎么画、角从哪量、光线往哪走、器材怎么连/插到哪），不要只甩一张图。",
    example: "phy-101",
  },
  "physics-hs": {
    title: "高中物理插图库（实验装置图＋场/路/图像）",
    intro:
      "讲到下面这些高中实验的装置，或电场/磁场分布、电路连接、v-t / F-x 等图像、光路这类图时，直接引用图库里的原图，**不要再写 plan**——物理引擎只有 10 类初中器材图元，画不出高中才有的场线、波形和函数图像，硬画出来只会错。",
    hint: "引用后要在正文里点出图上的**关键要素**（坐标轴含义、场线方向、连线的串并联关系、图像斜率/截距的物理意义），不要只甩一张图。",
    example: "phs-101",
  },
  history: {
    title: "初中历史插图库（历史地图＋示意图）",
    intro:
      "讲到下面这些历史地图（疆域、形势、路线）、遗址分布或历史场景示意图时，直接引用图库里的原图——历史地图上的疆域界线、都城与遗址位置、进军路线，现画必错。",
    hint: "引用后要在正文里点出图上的**关键要素**（疆域范围、都城/遗址位置、路线走向、对应的时间），不要只甩一张图。",
    example: "his-001",
    setupLabel: "可选历史场景/示意图",
    principleLabel: "可选历史地图与示意图",
  },
  biology: {
    title: "初中生物插图库（结构示意图＋实验图）",
    intro:
      "讲到下面这些生物结构示意图（细胞、器官、系统）、实验或观察图时，直接引用图库里的原图——微观结构、解剖层次和实验步骤，现画必错。",
    hint: "引用后要在正文里点出图中**关键结构的名称与功能对应**（或实验的步骤与观察要点），不要只甩一张图。",
    example: "bio-001",
    setupLabel: "可选实验/观察图",
    principleLabel: "可选结构示意图",
  },
  geography: {
    title: "初中地理插图库（地图＋示意图＋图像）",
    intro:
      "讲到下面这些地理示意图、地图、曲线图/柱状图时，直接引用图库里的原图——地理图形的轮廓形状、要素分布和数据关系，现画必错。",
    hint: "引用后要在正文里点出图中**关键要素**（方向与比例、分布特征、数值变化、区域差异），不要只甩一张图。",
    example: "geo-001",
    setupLabel: "可选要素关系示意图",
    principleLabel: "可选地图与示意图",
  },
};

function renderSection(subject: AtlasSubject, items: AtlasItem[]): string {
  const meta = SUBJECT_PROMPT[subject];
  const setup = items.filter((i) => i.kind === "setup");
  const principle = items.filter((i) => i.kind === "principle");
  const wrong = items.filter((i) => i.kind === "wrong");
  const line = (i: AtlasItem) => `- ${i.id}｜${i.name}｜${brief(i.assembly)}`;

  const blocks: string[] = [`【${meta.title}】`, meta.intro, ""];
  blocks.push(
    `引用写法：正文里单独占一行，把 id 放进 figure 围栏，例如：\n\`\`\`figure ${meta.example}\n\`\`\``,
    `引擎会把它替换成插图。一次讲解最多引 2 张；${meta.hint}`,
    "",
  );
  if (setup.length > 0) {
    blocks.push(`${meta.setupLabel ?? "可选装置图"}（id｜名称｜讲解要点）：`, setup.map(line).join("\n"), "");
  }
  if (principle.length > 0) {
    blocks.push(
      `${meta.principleLabel ?? "可选原理图 / 光路图"}（id｜名称｜讲解要点）：`,
      principle.map(line).join("\n"),
      "",
    );
  }
  if (wrong.length > 0) {
    blocks.push(
      "反例图（只有讲\"错在哪\"时才引用，引用后必须在正文明确指出错误点，绝不能当成正确装置讲）：",
      wrong.map(line).join("\n"),
      "",
    );
  }
  blocks.push(
    subject === "physics" || subject === "physics-hs"
      ? "**优先级铁律**：清单里有的装置、光路、成像、场、电路、图像图，一律引用原图；只有清单里确实没有的（题目改造的、要突出某个局部变化的），才写 plan 让引擎现画。"
      : "**优先级铁律**：上面清单里有的图，一律引用原图；清单里确实没有的（题目临时改造的、需要突出某个局部变化的、引擎能画的），才写 plan 让引擎现画。",
  );
  return blocks.join("\n");
}

/**
 * 拼提示词里的图库清单。
 * 传了学科就只给这一科的清单——化学课收到物理光路图的 id，只会增加乱引用的机会。
 * 传 "physics-all" 表示"物理但没说年级"，初中+高中两套物理清单都给；不传就全部学科都给。
 */
export function buildFigurePromptSection(subject?: AtlasSubject | "physics-all"): string {
  // 图库只是"锦上添花"的通道：配置读坏了也不能把整节课带崩，退化成没有图库清单即可
  let all: AtlasItem[];
  try {
    all = libraryItems();
  } catch (e) {
    log.warn("atlas library unavailable, prompting without figures", {
      error: e instanceof Error ? e.message : String(e),
    });
    return "";
  }
  let subjects: AtlasSubject[];
  if (subject === "physics-all") {
    subjects = (["physics", "physics-hs"] as AtlasSubject[]).filter((s) => all.some((i) => i.subject === s));
  } else if (subject) {
    subjects = [subject];
  } else {
    subjects = (
      ["chemistry", "physics", "physics-hs", "history", "biology", "geography"] as AtlasSubject[]
    ).filter((s) => all.some((i) => i.subject === s));
  }

  return subjects
    .map((s) => {
      const items = all.filter((i) => i.subject === s);
      return items.length > 0 ? renderSection(s, items) : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 从课程/知识点/提问里猜学科，决定给模型哪一科的图库清单。
 *
 * 不用数据库字段（courses 表没有学科列，标题是老师自己写的自由文本），
 * 而是先认强标志（标题里写了"物理""化学"、以及年级），再用术语打分兜底；拿不准就不限制，
 * 两科/三科清单都给——模型看到不相关的清单不会硬引，但漏掉清单就必然缺图。
 *
 * 返回 "physics-all" 表示"提到了物理但没说年级"：初中+高中两套物理清单都给，避免漏图。
 */
export function detectSubject(text: string): AtlasSubject | "physics-all" | undefined {
  const t = text ?? "";
  // 化学优先（高中化学也是 chemistry，不分年级）
  if (/化学/.test(t)) return "chemistry";
  // 学科专属词先认：必须抢在年级标志前面，否则"初中历史/高中生物"会被年级规则误判成物理
  if (/历史|朝代|文物|遗址|史前|丝绸之路|甲午|鸦片战争|辛亥|抗战|解放战争|疆域|都城|朝代更替/.test(t)) return "history";
  if (/生物|细胞|光合|呼吸作用|遗传|变异|进化|显微镜|食物链|生态系统|病毒|细菌|真菌|基因|消化系统|神经元|染色体/.test(t)) return "biology";
  if (/地理|地图|地形|气候|降水|季风|经纬|纬线|经线|半球|河流|水资源|板块|大洲|行政区划|盆地|高原|聚落/.test(t)) return "geography";
  // 年级强标志：明确是高中物理
  if (/高中|高一|高二|高三|必修|选修|高考|会考|学业水平/.test(t)) return "physics-hs";
  // 年级强标志：明确是初中物理
  if (/初中|八年级|九年级|初一|初二|初三|七年级/.test(t)) return "physics";
  // 只写了"物理"没写年级：两套物理清单都给，不漏图
  if (/物理|运动学|力学|电磁|光学|热学|原子|量子|相对论|牛顿|天体|动量|机械波/.test(t)) return "physics-all";

  const physics = [
    "力学", "运动", "速度", "路程", "压强", "浮力", "密度", "杠杆", "滑轮", "机械效率",
    "摩擦力", "二力平衡", "牛顿", "惯性", "动能", "势能", "功率", "声", "音调", "响度",
    "沸腾", "熔化", "比热容", "内能", "热量", "电阻", "电压", "电流", "电路", "欧姆",
    "电功率", "电磁", "磁场", "通电", "光路", "折射", "反射", "透镜", "平面镜", "色散",
    "小孔成像", "影子", "温度计读数",
  ];
  const chemistry = [
    "溶液", "反应", "制取", "收集", "气体制备", "酸", "碱", "盐", "氧化", "还原",
    "离子", "方程式", "摩尔", "元素", "化合价", "电解质", "蒸馏", "过滤", "蒸发结晶",
    "沉淀", "指示剂", "燃烧", "溶解", "催化剂", "焰色", "质量守恒",
  ];
  const count = (words: string[]) => words.filter((w) => t.includes(w)).length;
  const p = count(physics);
  const c = count(chemistry);
  if (p === 0 && c === 0) return undefined;
  return p >= c ? "physics-all" : "chemistry";
}

/* ── 正文里的 figure 围栏 → 前端可直接渲染的图卡片 ───────── */

/** 匹配 ```figure <id>``` 或 ```figure {"id":"..."}```，body 只取第一行 */
const FIGURE_RE = /```figure\s*([^\n`]*)\n?([\s\S]*?)```/g;

/** 图库 id 形如 atlas-123（化学）/ phy-101（初中物理）/ phs-001（高中物理）/ his|bio|geo-001（史地生）；前缀就是清单文件里的学科 */
export const FIGURE_ID_RE = /(?:atlas|phy|phs|his|bio|geo)-\d{3}/;

/** 从围栏 body 里抽出 id：支持裸 id、JSON、以及 "atlas-110 名称" 这种带尾巴的写法 */
function parseFigureId(body: string): string | null {
  const t = body.trim();
  if (!t) return null;
  if (t.startsWith("{")) {
    try {
      const o = JSON.parse(t) as { id?: unknown };
      return typeof o.id === "string" ? o.id : null;
    } catch {
      return null;
    }
  }
  const m = t.match(FIGURE_ID_RE);
  return m ? m[0] : null;
}

/** 一条图库记录 → 前端认的 figure 卡片（JSON 围栏）；plan 兜底和正常引用共用 */
export function figureBlockFor(item: AtlasItem): string {
  const payload = {
    src: figureUrl(item),
    id: item.id,
    name: item.name,
    kind: item.kind,
    width: item.width,
    height: item.height,
    ...(item.note ? { note: item.note } : {}),
  };
  return "```figure\n" + JSON.stringify(payload) + "\n```";
}

/**
 * 把 figure 围栏规范化成一段 JSON 交前端渲染。
 * id 不存在就整块删掉——宁可没有图，也不能给一张对不上内容的图。
 */
export function processFigureBlocks(content: string): { content: string; used: string[] } {
  const used: string[] = [];
  // 图库不可用时把 figure 围栏整块去掉：学生看到的是一段代码，不如什么都不显示
  let available = true;
  try {
    loadAtlas();
  } catch {
    available = false;
  }
  if (!available) return { content: content.replace(FIGURE_RE, ""), used };
  const out = content.replace(FIGURE_RE, (_full, head: string, tail: string) => {
    const id = parseFigureId(`${head}\n${tail}`);
    if (!id) return "";
    const item = getFigure(id);
    if (!item) {
      log.warn("figure block references unknown atlas id", { id });
      return "";
    }
    used.push(id);
    return figureBlockFor(item);
  });
  return { content: out, used };
}

/** 给修正轮/自检用的图库摘要（只列 id 与名称，短） */
export function atlasIndexLine(): string {
  const { items } = loadAtlas();
  return items.map((i) => `${i.id}=${i.name}`).join("；");
}

/* ── plan 失败时的反向兜底：从图库里找回同一个实验的教材原图 ─────────
 *
 * 布局引擎失败有两种：JSON 根本解析不出来，或者校验报 fatal（长颈漏斗没液封、导管从管壁穿出、
 * 排空气法导管插到底……）。这时正文里已经没有任何图了，而模型想画的那个实验，图库里往往就有
 * 现成的教材插图——查一次表把原图顶上，比"这节课没图"好得多。
 *
 * 但反查必须保守：宁可缺图，也不能把"排水法"的图当成"向上排空气法"发给学生。
 * 所以看两条独立证据（主题里的实验名、器材集合的重合度），还要过关键器材的硬冲突检查。
 */

export interface PlanFallbackQuery {
  /** 知识点主题（含小结）：判断"是哪个实验"的第一线索 */
  topic: string;
  /** 计划里的器材中文名（由注册表 display_name 换算）；JSON 坏掉时为空 */
  devices?: string[];
  /** 计划原文：解析失败时仍能从中捞出 label/note 里的中文线索 */
  text?: string;
  /** 已经用过的图（同一节课不重复贴同一张） */
  exclude?: string[];
  /** 只在某一科的图里找：化学课不该被物理光路图顶上，反过来也一样；"physics-all" 搜两套物理清单 */
  subject?: AtlasSubject | "physics-all";
  /**
   * 严格模式：只认"主题点名 + 整套器材几乎完全对得上"的图。
   * 用于正向收紧——计划本身能画出来，但图库有同一台标准装置时优先用原图；
   * 这种情况必须比兜底更保守，否则会把"题目改造过的装置"讲成教材标准装置。
   */
  strict?: boolean;
}

export interface PlanFallbackHit {
  item: AtlasItem;
  score: number;
  /** 为什么选它，写日志用 */
  why: string;
}

/** 同一件器材的不同叫法；只归一会改变装配判断的，不做无根据的合并 */
const DEVICE_SYNONYMS: Record<string, string> = {
  单孔塞: "橡胶塞",
  双孔塞: "橡胶塞",
  橡皮塞: "橡胶塞",
  单孔橡皮塞: "橡胶塞",
  球形干燥管: "干燥管",
};

/** 去掉空白与标点：中文没有词边界，判断包含关系只能整串比 */
function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s·．.，,。、；;：:！!？?（）()【】[\]「」《》“”"'‘’—\-_/\\|]/g, "");
}

function canonDevice(name: string): string {
  const n = name.replace(/[（(][^）)]*[）)]/g, "").trim();
  return DEVICE_SYNONYMS[n] ?? n;
}

/** 两件器材是否同一件（归一后相等，或一方包含另一方，如"集气瓶"⊂"倒扣集气瓶"） */
function sameDevice(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));
}

/**
 * 会改变实验性质的器材：计划里有、图里没有（或反过来）就说明不是同一个装置。
 * 排水法与排空气法差一个水槽，长颈漏斗与分液漏斗差一种液封/滴加方式——都是装配关系级别的差异。
 */
const KEY_GROUPS: string[][] = [["酒精灯"], ["水槽"], ["长颈漏斗"], ["分液漏斗"]];

/** 最长公共子串长度：主题"实验室制取二氧化碳"与名称"二氧化碳的制取与收集"共 4 个字 */
function lcsLength(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let last = 0;
    for (let j = 1; j <= b.length; j++) {
      const cur = prev[j];
      if (a[i - 1] === b[j - 1]) {
        prev[j] = last + 1;
        if (prev[j] > best) best = prev[j];
      } else prev[j] = 0;
      last = cur;
    }
  }
  return best;
}

/**
 * 文字线索分级：2 = 主题里出现了完整名称/别名（"加热高锰酸钾制氧气"）；
 * 1 = 主题比别名短或只是共享一段实词（"蒸馏" vs "简易蒸馏装置"），需要器材佐证。
 * len 是命中的那串字有多长——同为"点名"时，"高锰酸钾制氧气"比"排水法收集"更能确定是哪个实验。
 */
function textSignal(item: AtlasItem, topicN: string, planN: string): { level: number; hit: string; len: number } {
  let best = { level: 0, hit: "", len: 0 };
  const names = [item.name, ...item.aliases];
  for (const raw of names) {
    const n = normText(raw);
    if (n.length < 2) continue;
    let level = 0;
    let matchedLen = 0;
    if (topicN.includes(n)) {
      level = n.length >= 4 ? 2 : 1;
      matchedLen = n.length;
    } else if (n.includes(topicN) && topicN.length >= 3) {
      level = 1;
      matchedLen = topicN.length;
    } else if (planN.includes(n)) {
      level = n.length >= 4 ? 1 : 0;
      matchedLen = n.length;
    } else {
      // 共用一段实词：主题"加热高锰酸钾制取氧气"与名称"加热高锰酸钾制氧气·排水法"共 7 个字，
      // 差一个"取"字不该判成两个实验；共 6 个字以上算点名，否则只是弱线索
      const lcs = lcsLength(normText(item.name), topicN);
      if (lcs >= 4) {
        level = lcs >= 6 ? 2 : 1;
        matchedLen = lcs;
      }
    }
    if (level > best.level || (level === best.level && level > 0 && matchedLen > best.len))
      best = { level, hit: raw, len: level > 0 ? matchedLen : 0 };
  }
  return best;
}

/**
 * 一条计划器材可能带多个候选名（注册表显示名｜模型自己写的 label），用 "|" 分隔。
 * 任一对上就算这件器材对上——"bottle" 注册表叫"试剂瓶"，模型在制 CO₂ 时写的是"锥形瓶"，
 * 只认显示名会把这套装置判成"对不上"。
 */
function candidateNames(entry: string): string[] {
  return entry
    .split("|")
    .map((x) => canonDevice(x.trim()))
    .filter(Boolean);
}

function overlap(qDevs: string[], item: AtlasItem): { recall: number; precision: number; matched: number } {
  const plan = qDevs.map(candidateNames);
  const fig = item.devices.map(canonDevice);
  const matched = plan.filter((cands) => fig.some((x) => cands.some((c) => sameDevice(c, x)))).length;
  const covered = fig.filter((x) => plan.some((cands) => cands.some((c) => sameDevice(c, x)))).length;
  return {
    recall: plan.length ? matched / plan.length : 0,
    precision: fig.length ? covered / fig.length : 0,
    matched,
  };
}

/**
 * 关键器材硬冲突。
 *
 * 水槽两向都算冲突：排水法与排空气法差的就是这个水槽，配错了等于把收集方法讲反。
 * 其余只查"计划里有、图里没有"：计划常常只画装置的一部分（只写集气瓶和导管），
 * 缺长颈漏斗不代表装置错；但计划明明要液封，图上却没有漏斗，那是另一套装置。
 */
function keyConflict(qDevs: string[], item: AtlasItem): string | null {
  const plan = qDevs.map(candidateNames);
  const fig = item.devices.map(canonDevice);
  for (const group of KEY_GROUPS) {
    const inPlan = plan.some((cands) => group.some((k) => cands.some((c) => sameDevice(c, k))));
    const inFig = fig.some((d) => group.some((k) => sameDevice(d, k)));
    if (group.includes("水槽") ? inPlan !== inFig : inPlan && !inFig) return group.join("/");
  }
  return null;
}

/**
 * 给一个失败的 plan 找一张对得上的教材原图。找不到就返回 null（调用方照旧删块）。
 * 反例图（kind=wrong）永远不参与——那是要学生找错的图，顶上去等于把错装置当正解。
 */
export function matchFigureForPlan(q: PlanFallbackQuery): PlanFallbackHit | null {
  let items: AtlasItem[];
  try {
    items =
      q.subject === "physics-all"
        ? [...libraryItems("physics"), ...libraryItems("physics-hs")]
        : libraryItems(q.subject);
  } catch {
    return null;
  }
  // 按学科取图：化学课不会被物理光路图顶上，反过来也一样
  if ((q.subject === "physics" || q.subject === "physics-hs") && items.length === 0) return null;
  const qDevs = (q.devices ?? []).map((d) => d.trim()).filter(Boolean);
  const topicN = normText(q.topic ?? "");
  const planN = normText(q.text ?? "");
  const exclude = new Set(q.exclude ?? []);
  const hits: Array<PlanFallbackHit & { level: number; len: number; recall: number; precision: number }> = [];

  for (const item of items) {
    if (item.kind === "wrong" || exclude.has(item.id)) continue;
    // 只有两件以下器材时说不上"成套"，关键器材冲突不具判别力，跳过检查
    if (qDevs.length >= 2 && keyConflict(qDevs, item)) continue;

    const { level, hit, len } = textSignal(item, topicN, planN);
    const { recall, precision, matched } = overlap(qDevs, item);
    // 严格模式（正向收紧）：主题必须点名，器材必须几乎一一对应，任何一条不满足就不顶替
    if (q.strict && (level < 2 || recall < 0.85 || precision < 0.6)) continue;
    // 三条准入线：主题点名了这个实验 / 主题有弱线索且器材大半对得上 / 整套器材对得上
    const named = level >= 2 && (qDevs.length === 0 || recall >= 0.35);
    const hinted = level === 1 && recall >= 0.6;
    const whole = level === 0 && qDevs.length >= 4 && recall >= 0.85 && precision >= 0.4;
    if (!named && !hinted && !whole) continue;

    hits.push({
      item,
      level,
      len,
      recall,
      precision,
      score: 3 * level + 2 * recall + precision,
      why: `${named ? "主题点名" : hinted ? "主题弱线索" : "整套器材"}:${hit || "-"} 器材${matched}/${qDevs.length}`,
    });
  }

  if (hits.length === 0) return null;
  /** 教材标准版优先于"变体/彩色版"：同一实验有多张图时，别把彩色改版当主图 */
  const variantRank = (i: AtlasItem) => (/变体|彩色/.test(i.name) ? 1 : 0);
  hits.sort(
    (a, b) =>
      // 先看主题证据有多硬，再看这串字有多具体（"高锰酸钾制氧气"胜过"排水法收集"），
      // 然后才是器材吻合度；同分优先成套图（part 只有零件，讲课不够用），最后按 id 稳定排序
      b.level - a.level ||
      b.len - a.len ||
      b.recall - a.recall ||
      (a.item.kind === "setup" ? 0 : 1) - (b.item.kind === "setup" ? 0 : 1) ||
      variantRank(a.item) - variantRank(b.item) ||
      b.precision - a.precision ||
      a.item.id.localeCompare(b.item.id),
  );
  const { item, score, why } = hits[0];
  return { item, score, why };
}
