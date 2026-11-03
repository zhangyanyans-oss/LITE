/**
 * 极简纯 TikZ 图示路线：模型输出基础几何 TikZ 命令（\draw/\fill/\node）→ 本地 LaTeX 编译 → PDF → SVG。
 *
 * 不用任何第三方化学宏包——装置全部用线、矩形、圆等基础图形拼装，风格极简干净；
 * \node 标签支持中文（文档骨架已加载 ctex）。
 *
 * 与 plan 路线的关系：
 * - 本机装了 LaTeX 工具链（xelatex 或 tectonic，加 dvisvgm 或 pdftocairo）时，化学装置图走这条路；
 * - 没装工具链时自动回落到 plan 布局引擎（提示词里根本不会出现 tikz 选项，模型不会误用）。
 *
 * 安全约束：禁止模型代码里的文件读写/shell 逃逸/宏定义类命令；编译不开 shell-escape；
 * 临时目录隔离；编译 180s、转换 45s 硬超时。
 */
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { z } from "zod";
import { structuredCall } from "../ai";
import { log } from "../logger";

/* ── 工具链探测（带缓存） ───────────── */

interface Toolchain {
  engine: "xelatex" | "tectonic" | null;
  converter: "dvisvgm" | "pdftocairo" | null;
}

let toolchainCache: Toolchain | null = null;

function hasBinary(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ["--version"], { timeout: 5000, stdio: "ignore" });
    return !r.error;
  } catch {
    return false;
  }
}

/** 探测本机 LaTeX 工具链。DIAGRAM_TIKZ=0 可强制关闭 tikz 路线（回落 plan）。 */
export function tikzToolchain(): Toolchain {
  if (toolchainCache) return toolchainCache;
  if (process.env.DIAGRAM_TIKZ === "0") {
    toolchainCache = { engine: null, converter: null };
    return toolchainCache;
  }
  const engine = hasBinary("xelatex") ? "xelatex" : hasBinary("tectonic") ? "tectonic" : null;
  const converter = hasBinary("dvisvgm") ? "dvisvgm" : hasBinary("pdftocairo") ? "pdftocairo" : null;
  toolchainCache = { engine, converter };
  if (engine && converter) log.info("tikz 图示路线可用", { engine, converter });
  else log.info("tikz 工具链不可用，化学装置图走 plan 布局引擎", { engine, converter });
  return toolchainCache;
}

export function tikzAvailable(): boolean {
  const t = tikzToolchain();
  return t.engine !== null && t.converter !== null;
}

/** 测试用：清除工具链缓存强制重探 */
export function _resetTikzToolchainCache() {
  toolchainCache = null;
}

/* ── 围栏提取与安全清洗 ───────────── */

export function extractTikzBlocks(text: string): Array<{ full: string; code: string }> {
  const out: Array<{ full: string; code: string }> = [];
  // 模型常把围栏标成 latex/tex，一并识别（本系统里这三种围栏只可能是装置图）
  const re = /```(?:tikz|latex|tex)\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ full: m[0], code: m[1].trim() });
  return out;
}

/**
 * 抢救模型的"完整 LaTeX 文档"式输出：剥掉文档骨架与中文注释，只留绘图命令。
 * 模型经常无视规则输出 \documentclass...\begin{document} 整篇——直接拒掉太浪费，
 * 抽出 tikzpicture/document 环境正文、删掉注释行后，往往就是可编译的纯绘图代码。
 */
export function rescueTikz(code: string): string {
  let s = code;
  // 1) 抽出 tikzpicture 环境正文；没有则试 document 环境正文
  const tp = s.match(/\\begin\{tikzpicture\}[^\]]*(?:\[[^\]]*\])?([\s\S]*?)\\end\{tikzpicture\}/);
  if (tp) s = tp[1];
  else {
    const doc = s.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
    if (doc) s = doc[1];
  }
  // 2) 剥掉只能出现在导言区的行（文档骨架由系统包裹）
  s = s
    .split("\n")
    .filter((line) => !/^\s*\\(documentclass|usepackage|usetikzlibrary)\b/.test(line))
    .join("\n");
  // 3) 去注释：删掉 % 到行尾（保留转义的 \%），注释是中文重灾区
  s = s.replace(/(?<!\\)%.*/g, "");
  return s.trim();
}

/** 危险命令黑名单：文件读写、shell 逃逸、宏定义、文档结构（文档骨架由我们包） */
const FORBIDDEN =
  /\\(input|include|includegraphics|write18|write|openout|openin|read|immediate|csname|usepackage|documentclass|catcode|def|gdef|edef|xdef|newcommand|renewcommand|loop|special|verbatiminput|lstinputlisting)\b/;

/**
 * 清洗模型输出的 TikZ 代码。返回 null 表示通过，否则返回给模型可读的错误描述。
 * 通过 = 纯绘图命令：\draw、\fill、\node（中文标签允许，骨架已加载 ctex）、\begin/end{scope} 等。
 */
export function sanitizeTikz(code: string): string | null {
  if (code.length === 0) return "代码为空";
  if (code.length > 4000) return "代码过长（超过 4000 字符）";
  const bad = code.match(FORBIDDEN);
  if (bad) return `代码包含禁止的命令 \\${bad[1]}（文件读写/宏定义/文档结构类命令一律禁止）`;
  if (/tikzpicture/.test(code)) return "不要自己写 \\begin{tikzpicture}，只输出内部绘图命令";
  if (!/\\(tkz|draw|node|begin|fill|path)/.test(code)) return "代码里没有 TikZ 绘图命令";
  return null;
}

/* ── 编译管线 ───────────── */

function wrapDocument(body: string): string {
  return [
    "\\documentclass[border=3pt]{standalone}",
    "\\usepackage{ctex}", // 支持 \node 中文标签（xelatex/tectonic 自动选系统中文字体）
    "\\usepackage{tikz}", // 只用 tikz 本体，不加载任何第三方化学宏包
    "\\usetikzlibrary{positioning, shapes.geometric}", // v3 规范：节点相对定位必须
    "\\begin{document}",
    "\\begin{tikzpicture}[scale=0.55]",
    body,
    "\\end{tikzpicture}",
    "\\end{document}",
    "",
  ].join("\n");
}

export type CompileResult = { svg: string } | { error: string };

/**
 * 规范化转换器的 SVG 输出：剥掉 xml 声明、DOCTYPE、注释等前置内容。
 * dvisvgm 会输出 <!DOCTYPE svg PUBLIC ...>，pdftocairo 不会——直接从第一个 <svg 标签截起，通吃。
 */
export function normalizeSvgOutput(raw: string): string {
  const start = raw.indexOf("<svg");
  return start >= 0 ? raw.slice(start).trim() : raw.trim();
}

/**
 * 编译产物的结构检查（比模型手绘 SVG 的 svgStructurallyOk 放宽一点）：
 * pdftocairo 会把文字渲染成 <symbol> 字形 + <use xlink:href="#glyph…"> 内部引用，安全且必需。
 * 但 <use> 只允许指向本文档内部 id（# 开头），外部引用一律拒绝。
 */
export function compiledSvgOk(svg: string): boolean {
  const s = svg.trim();
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return false;
  if (!/viewBox\s*=/i.test(s)) return false;
  if (/<\s*(script|foreignObject|iframe|object|embed|image|audio|video|link|meta)\b/i.test(s)) return false;
  if (/\son[a-z]+\s*=/i.test(s)) return false;
  if (/javascript:/i.test(s)) return false;
  if (/NaN|undefined|null/.test(s)) return false;
  const useTags = s.match(/<use\b[^>]*>/gi) ?? [];
  for (const tag of useTags) {
    const href = /(?:xlink:)?href\s*=\s*"([^"]*)"/i.exec(tag) ?? /(?:xlink:)?href\s*=\s*'([^']*)'/i.exec(tag);
    if (!href || !href[1].startsWith("#")) return false;
  }
  return true;
}

/** 编译 TikZ 代码为 SVG。调用前必须 tikzAvailable()。 */
export function compileTikzToSvg(code: string): CompileResult {
  const t = tikzToolchain();
  if (!t.engine || !t.converter) return { error: "工具链不可用" };

  const dir = mkdtempSync(path.join(tmpdir(), "tikzfig-"));
  try {
    writeFileSync(path.join(dir, "main.tex"), wrapDocument(code), "utf8");

    // 引擎首次编译要联网下载宏包（tectonic/MiKTeX 都会），超时放宽到 3 分钟；转换器是本地操作，45s 足够
    const run = (cmd: string, args: string[], timeout = 45_000) =>
      execFileSync(cmd, args, { cwd: dir, timeout, stdio: ["ignore", "pipe", "pipe"] });

    try {
      if (t.engine === "xelatex") run("xelatex", ["-interaction=nonstopmode", "-halt-on-error", "main.tex"], 180_000);
      else run("tectonic", ["--keep-logs", "main.tex"], 180_000);
    } catch {
      const logPath = path.join(dir, "main.log");
      const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-900) : "LaTeX 编译失败且无日志";
      return { error: `LaTeX 编译失败，日志尾部：\n${tail}` };
    }
    if (!existsSync(path.join(dir, "main.pdf"))) return { error: "LaTeX 编译未产出 PDF" };

    try {
      if (t.converter === "dvisvgm") run("dvisvgm", ["--pdf", "main.pdf", "-o", "diagram.svg"]);
      else run("pdftocairo", ["-svg", "main.pdf", "diagram.svg"]);
    } catch {
      return { error: `${t.converter} 转 SVG 失败` };
    }
    const svgPath = path.join(dir, "diagram.svg");
    if (!existsSync(svgPath)) return { error: "转换未产出 SVG" };

    const svg = normalizeSvgOutput(readFileSync(svgPath, "utf8"));
    if (!compiledSvgOk(svg)) return { error: "产出的 SVG 未通过结构检查" };
    return { svg };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 模型纠错与正文管道 ───────────── */

const TIKZ_FIX_SYSTEM = `你是 TikZ 代码修正器。根据 LaTeX 编译错误修正"节点+相对定位"风格的纯 TikZ 化学装置图：只返回修正后的绘图命令本身，不要 tikzpicture 环境、\\documentclass、\\usepackage、\\usetikzlibrary 或任何解释文字。
铁律：禁用一切第三方化学宏包命令；禁止硬编码绝对坐标（如 (0,0)、(5,2)）——必须用 \\node 定义带名字的节点，再用 right=/below=/left=/above= 距离 of 节点名 相对定位；导管用 \\draw 连接节点锚点（testtube.east、gasjar.south 等），配合 -- ++(x,y) 和 |- 折线，带 rounded corners=10pt。
基础形状用 \\tikzset 定义样式：tube（圆角矩形）、beaker、jar、burner，均为 draw, thick 加 minimum width/height。节点文字可用中文。
化学常识：加热试管管口向下倾斜（rotate=负角度）；排水法集气瓶倒扣在水槽中、导管伸到瓶口；长颈漏斗末端伸入液面以下；气体通入试管时（H2 还原 CuO），导管从管口锚点往管内画进去、管口停在管底固体上方，不能只停在管口外；过滤时漏斗里要有滤纸（锥内画一条折线表示）、漏斗颈贴着烧杯内壁；蒸发皿架在三脚架上、下面放酒精灯。`;

const fixSchema = z.object({ code: z.string().describe("修正后的完整 TikZ 绘图代码") });

export interface TikzProcessContext {
  topic: string;
}

/** 处理一段正文里的所有 tikz 块（每小节最多 2 个）：清洗 → 编译 →（失败时）一轮模型纠错 → 替换成 svg 围栏 */
export async function processTikzBlocks(content: string, ctx: TikzProcessContext): Promise<string> {
  const blocks = extractTikzBlocks(content);
  if (blocks.length === 0) return content;
  let out = content;

  for (const { full, code } of blocks.slice(0, 2)) {
    const svg = await tikzToSvg(code, ctx).catch((e) => {
      log.warn("tikz block processing failed", { error: e instanceof Error ? e.message : String(e) });
      return null;
    });
    // 失败就整块删掉（不让坏图进课堂；正文里通常还有文字讲解）
    out = svg ? out.replace(full, "```svg\n" + svg.replace(/^<svg/i, '<svg data-dg="tikz"') + "\n```") : out.replace(full, "");
  }
  return out;
}

async function tikzToSvg(code: string, ctx: TikzProcessContext): Promise<string | null> {
  if (!tikzAvailable()) return null;

  // 先抢救：剥掉模型常带的 \documentclass/usepackage 骨架和中文注释，再进清洗
  const rescued = rescueTikz(code);
  let feedback = sanitizeTikz(rescued);
  const current = rescued;
  if (!feedback) {
    const r = compileTikzToSvg(current);
    if ("svg" in r) return r.svg;
    feedback = r.error;
    log.warn("tikz compile failed, asking model to fix", { error: feedback.slice(0, 200) });
  }

  // 一轮模型纠错：把编译错误日志尾部喂回模型
  const fixed = await structuredCall({
    schema: fixSchema,
    system: TIKZ_FIX_SYSTEM,
    prompt: `以下 TikZ 装置图代码有问题：\n${feedback}\n\n【图示主题】${ctx.topic}\n\n【问题代码】\n${current.slice(0, 3000)}`,
    maxTokens: 4096,
  }).catch(() => null);
  if (!fixed) return null;
  const err = sanitizeTikz(fixed.code);
  if (err) {
    log.warn("tikz fix round still invalid", { error: err });
    return null;
  }
  const r2 = compileTikzToSvg(fixed.code);
  if ("svg" in r2) return r2.svg;
  log.warn("tikz fix round still fails to compile", { error: r2.error.slice(0, 200) });
  return null;
}

/* ── 提示词段落（仅在工具链可用时注入讲课 prompt） ───────────── */

/** 满分范例：高锰酸钾制氧 · 排水法（节点+相对定位搭积木）——模型严格模仿这个风格 */
const TIKZ_FEW_SHOT = `% 基础形状样式（直接复制这段，按需要微调尺寸）
\\tikzset{
    tube/.style={draw, thick, rounded corners=5pt, minimum width=1.5cm, minimum height=4cm},
    beaker/.style={draw, thick, minimum width=2cm, minimum height=2.5cm},
    jar/.style={draw, thick, minimum width=1.5cm, minimum height=2cm},
    burner/.style={draw, thick, minimum width=1cm, minimum height=1.5cm}
}
% 1. 放置左侧的加热试管（作为基准点）
\\node[tube, rotate=-15, fill=cyan!10] (testtube) {KMnO4};
% 2. 酒精灯必须在试管下方
\\node[burner, below=1.5cm of testtube, fill=orange!30] (burner) {酒精灯};
% 3. 右侧放水槽
\\node[beaker, right=4cm of testtube, fill=cyan!20] (trough) {水槽};
% 4. 集气瓶倒扣在水槽里面（相对水槽中心定位）
\\node[jar, at=(trough.center), yshift=1cm, fill=white] (gasjar) {集气瓶};
% 5. 画导管（用节点锚点连接，自动吸附）
\\draw[thick, rounded corners=10pt] (testtube.east) -- ++(1,0) |- (gasjar.south);`;

/** 化学装置图的 tikz 规则段落：节点+相对定位纯 TikZ，中文标签由 ctex 支持 */
export function buildTikzPromptSection(): string {
  return `【化学实验装置图：用 \`\`\`tikz 围栏，节点+相对定位纯 TikZ】
本系统装有 LaTeX 环境（已加载 ctex 和 positioning、shapes.geometric 库，\\node 标签支持中文）。涉及化学实验装置时，输出一个 \`\`\`tikz 围栏代码块，内容是纯 TikZ 绘图命令，系统自动编译成矢量图直接显示给学生。物理/生物/地理的装置与地图要素仍用 \`\`\`plan。
绝对铁律（违反即失败）：
0. 化学装置图**只能**用 \`\`\`tikz 围栏，**严禁用 \`\`\`svg 手绘装置、严禁输出完整 LaTeX 文档**。手绘装置会被系统删除。**绝对不要对学生说"这里无法编译/显示 TikZ"**——你输出的 \`\`\`tikz 代码会被系统自动编译成图，这是本系统的内置能力。
1. **绝对禁止硬编码绝对坐标**（如 (0,0)、(5,2)）。必须且只能这样搭积木：先用 \\node[样式] (名字) {标签}; 定义带名字的节点，再用 right=距离 of 名字 / below=距离 of 名字 / at=(名字.center) 相对定位。
2. **绝对不用任何第三方化学宏包命令**。基础形状用 \\tikzset 定义样式：tube（圆角矩形试管）、beaker（烧杯/水槽）、jar（集气瓶）、burner（酒精灯），均为 draw, thick 加 minimum width/height。
3. 不要写 \\documentclass、\\usepackage、\\usetikzlibrary、\\begin{tikzpicture}（骨架由系统包裹）。代码总长控制在 2500 字符以内。
4. 导管：\\draw[thick, rounded corners=10pt] 连接节点锚点（如 testtube.east、gasjar.south），用 -- ++(x,y) 延伸和 |- 折线转弯，绝不穿模。
5. 化学常识（违反会被打回）：加热试管管口向下倾斜（rotate=负角度）；排水法集气瓶倒扣在水槽中、导管伸到瓶口；向上排空气法导管伸到集气瓶底部；长颈漏斗末端伸入液面以下。**气体通入试管**（H2 还原 CuO、CO 还原金属氧化物等）：导管必须从管口锚点（如 testtube.east）**向管内画进去一截，管口停在管底固体药品上方**，绝不能只停在管口外侧——那是气体进门就跑的画法；固体药品画在试管底部（靠近管底那一端）。**过滤**：漏斗里必须画滤纸（锥形内画折线或三角形），漏斗颈贴着烧杯内壁。**蒸发**：蒸发皿架在三脚架上，酒精灯在三脚架下方加热皿底。
6. 节点里写中文标签（如 {酒精灯}、{水槽}），液体 fill=cyan!20、加热 fill=orange!30。
满分范例（高锰酸钾制氧气 · 排水法收集——严格模仿这种搭积木方式）：
\`\`\`tikz
${TIKZ_FEW_SHOT}
\`\`\``;
}
