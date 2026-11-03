/** E2E：极简纯 TikZ 图示管道——工具链探测、安全清洗、编译成 SVG、正文替换、坏代码兜底 */
import {
  extractTikzBlocks,
  rescueTikz,
  sanitizeTikz,
  tikzToolchain,
  tikzAvailable,
  compileTikzToSvg,
  normalizeSvgOutput,
  compiledSvgOk,
  processTikzBlocks,
  buildTikzPromptSection,
} from "../api/lib/diagram/tikz";
import { extractSvgBlocks, svgStructurallyOk } from "../api/lib/quizlib";

let failed = false;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " | " + extra : ""}`);
  if (!ok) failed = true;
};

const GOOD = `\\tikzset{
    tube/.style={draw, thick, rounded corners=5pt, minimum width=1.5cm, minimum height=4cm},
    beaker/.style={draw, thick, minimum width=2cm, minimum height=2.5cm},
    jar/.style={draw, thick, minimum width=1.5cm, minimum height=2cm},
    burner/.style={draw, thick, minimum width=1cm, minimum height=1.5cm}
}
\\node[tube, rotate=-15, fill=cyan!10] (testtube) {KMnO4};
\\node[burner, below=1.5cm of testtube, fill=orange!30] (burner) {酒精灯};
\\node[beaker, right=4cm of testtube, fill=cyan!20] (trough) {水槽};
\\node[jar, at=(trough.center), yshift=1cm, fill=white] (gasjar) {集气瓶};
\\draw[thick, rounded corners=10pt] (testtube.east) -- ++(1,0) |- (gasjar.south);`;

// 1. 围栏提取
{
  const blocks = extractTikzBlocks(`前文\n\n\`\`\`tikz\n${GOOD}\n\`\`\`\n\n后文`);
  check("tikz 围栏提取", blocks.length === 1 && blocks[0].code.includes("testtube"));
}
{
  // 模型常把围栏标成 latex / tex，也要能识别
  const a = extractTikzBlocks(`\`\`\`latex\n${GOOD}\n\`\`\``);
  const b = extractTikzBlocks(`\`\`\`tex\n${GOOD}\n\`\`\``);
  check("latex/tex 围栏同样识别", a.length === 1 && b.length === 1);
}

// 1b. 完整 LaTeX 文档的抢救：剥骨架、剥导言区命令、剥中文注释
{
  const messy = `\\documentclass[tikz,border=10pt]{standalone}
\\usepackage{ctex}
\\usetikzlibrary{patterns}
\\begin{document}
\\begin{tikzpicture}[scale=1.0, thick]
% ===== 铁架台 =====
\\draw[line width=2.5pt] (0,0.3) -- (0,7.2);
\\tkzTestTube[glassType=tube] % 大试管
\\end{tikzpicture}
\\end{document}`;
  const r = rescueTikz(messy);
  check(
    "抢救完整文档：去骨架去注释",
    !/documentclass|usepackage|usetikzlibrary|tikzpicture|铁架台|大试管/.test(r) &&
      r.includes("\\draw") &&
      r.includes("\\tkzTestTube"),
  );
  check("抢救后能通过清洗", sanitizeTikz(r) === null);
  // 没有 tikzpicture 环境时退到 document 环境正文
  const r2 = rescueTikz(`\\documentclass{standalone}\n\\begin{document}\n\\tkzTestTube[glassType=beaker]\n\\end{document}`);
  check("无 tikzpicture 时取 document 正文", r2 === "\\tkzTestTube[glassType=beaker]");
}

// 1c. SVG 产出规范化：dvisvgm 的 DOCTYPE / xml 声明都要剥掉
{
  const dvisvgmStyle = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="10" height="10"/></svg>\n`;
  const n = normalizeSvgOutput(dvisvgmStyle);
  check("dvisvgm 带 DOCTYPE 的产出能通过结构检查", svgStructurallyOk(n));
  const pdftocairoStyle = `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><line x1="0" y1="0" x2="1" y2="1"/></svg>`;
  check("pdftocairo 产出兼容", svgStructurallyOk(normalizeSvgOutput(pdftocairoStyle)));
  // pdftocairo 的文字是 <symbol>+<use> 内部字形引用：编译产物检查要放行内部 <use>、拒绝外部 <use>
  const glyphStyle = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><symbol id="glyph0-0"><path d="M0 0L1 1"/></symbol></defs><use xlink:href="#glyph0-0" x="1" y="2"/></svg>`;
  check("编译产物放行内部 <use> 字形引用", compiledSvgOk(glyphStyle));
  check("编译产物拒绝外部 <use> 引用", !compiledSvgOk(`<svg viewBox="0 0 1 1"><use href="https://evil.com/x.svg#y"/></svg>`));
}

// 2. 安全清洗
check("合法代码通过清洗", sanitizeTikz(GOOD) === null);
check("允许中文标签", sanitizeTikz("\\node at (0,0) {发生装置};") === null);
check("拒绝 \\input 文件读取", sanitizeTikz("\\input{/etc/passwd}") !== null);
check("拒绝 tikzpicture 环境", sanitizeTikz("\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}") !== null);
check("拒绝 \\usepackage", sanitizeTikz("\\usepackage{foo}\n\\draw (0,0)--(1,1);") !== null);
check("拒绝宏定义", sanitizeTikz("\\newcommand{\\x}{1}\n\\draw (0,0)--(1,1);") !== null);
check("拒绝空代码", sanitizeTikz("") !== null);
check("拒绝无绘图命令", sanitizeTikz("hello world") !== null);

// 3. 工具链探测
const tc = tikzToolchain();
check("工具链探测返回合法形状", [null, "xelatex", "tectonic"].includes(tc.engine) && [null, "dvisvgm", "pdftocairo"].includes(tc.converter));
console.log(`  工具链: engine=${tc.engine} converter=${tc.converter} available=${tikzAvailable()}`);

// 4. 提示词段落包含套路库与铁律
const section = buildTikzPromptSection();
check(
  "tikz 提示词含铁律与范例",
  section.includes("相对定位") && section.includes("rounded corners") && section.includes("cyan!20") && section.includes("液面以下") && section.includes("tikzset"),
);

// 5. 真实编译（有工具链时）
if (tikzAvailable()) {
  const r = compileTikzToSvg(GOOD);
  if ("svg" in r) {
    check("tikz 编译产出合法 SVG", compiledSvgOk(r.svg));
    check("SVG 无坏数值", !/NaN|undefined|null/.test(r.svg));
  } else {
    check("tikz 编译产出合法 SVG", false, r.error.slice(0, 120));
  }

  // 6. 完整管道：正文里的 ```tikz 块被编译成 ```svg 块（好代码无需模型纠错，离线可跑）
  const lesson = `制取二氧化碳的装置：\n\n\`\`\`tikz\n${GOOD}\n\`\`\`\n\n注意液封。`;
  const processed = await processTikzBlocks(lesson, { topic: "二氧化碳制取" });
  const svgBlocks = extractSvgBlocks(processed);
  check("tikz 块被替换成 svg 块", svgBlocks.length === 1 && compiledSvgOk(svgBlocks[0].svg));
  check("正文文字保留", processed.includes("注意液封"));

  // 7. 坏代码（不存在的宏）：编译失败 → 模型纠错（沙箱离线必失败）→ 优雅删除
  const badLesson = `装置：\n\n\`\`\`tikz\n\\tkzBeaker[liquid=50]\n\`\`\`\n\n完。`;
  const t0 = Date.now();
  const processedBad = await processTikzBlocks(badLesson, { topic: "测试" });
  check("坏 tikz 块被优雅移除", !processedBad.includes("```tikz"), `耗时 ${(Date.now() - t0) / 1000}s`);
} else {
  console.log("SKIP 编译相关测试（本机无 LaTeX 工具链，运行时自动回落 plan 引擎）");
  // 无工具链时 tikz 块应原样删除（模型在没工具链时本就不会被引导输出 tikz）
  const processed = await processTikzBlocks(`装置：\n\n\`\`\`tikz\n${GOOD}\n\`\`\`\n\n完。`, { topic: "测试" });
  check("无工具链时 tikz 块被移除", !processed.includes("```tikz"));
}

console.log(failed ? "\n有失败项 ❌" : "\n全部通过 ✅");
process.exit(failed ? 1 : 0);
