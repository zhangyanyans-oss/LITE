/**
 * TikZ 图示路线自检（Windows/Mac/Linux 通用）：
 *   node scripts/tikz-check.mjs
 *
 * 逐项检查：
 * 1. LaTeX 引擎（xelatex 或 tectonic）是否在 PATH；
 * 2. PDF→SVG 转换器（dvisvgm 或 pdftocairo）是否在 PATH；
 * 3. 真实编译一张样例图（纯 TikZ + ctex 中文标签；首次会联网下载宏包，可能花 1~3 分钟，属正常，之后秒级）。
 *
 * 全部通过 = TikZ 路线已启用；任何一项失败会告诉你缺什么、怎么装。
 * 服务运行时走的是同一套探测逻辑，这里过了，讲课页就一定会走 TikZ。
 */
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

let failed = false;
const ok = (name, extra = "") => console.log(`PASS ${name}${extra ? " | " + extra : ""}`);
const bad = (name, fix) => {
  console.log(`FAIL ${name}\n     解决：${fix}`);
  failed = true;
};

function hasBinary(cmd) {
  try {
    const r = spawnSync(cmd, ["--version"], { timeout: 8000, stdio: "ignore" });
    return !r.error;
  } catch {
    return false;
  }
}

// 1. 引擎
const engine = hasBinary("xelatex") ? "xelatex" : hasBinary("tectonic") ? "tectonic" : null;
if (engine) ok(`LaTeX 引擎：${engine}`);
else
  bad(
    "找不到 LaTeX 引擎（xelatex / tectonic）",
    "二选一：winget install tectonic（推荐，单文件）；或安装 MiKTeX https://miktex.org/download 。装完重开终端再跑本脚本。",
  );

// 2. 转换器
const converter = hasBinary("dvisvgm") ? "dvisvgm" : hasBinary("pdftocairo") ? "pdftocairo" : null;
if (converter) ok(`PDF→SVG 转换器：${converter}`);
else
  bad(
    "找不到 PDF→SVG 转换器（dvisvgm / pdftocairo）",
    "MiKTeX 用户：MiKTeX Console → Packages 搜 dvisvgm 安装。Tectonic 用户：下载 Poppler https://github.com/oschwartz10612/poppler-windows/releases ，解压后把 bin 目录加入 PATH。",
  );

// 3. 真实编译样例（极简纯 TikZ：酒精灯 + 倾斜试管 + 水槽，中文标签）
if (engine && converter) {
  const dir = mkdtempSync(path.join(tmpdir(), "tikzcheck-"));
  try {
    writeFileSync(
      path.join(dir, "main.tex"),
      [
        "\\documentclass[border=3pt]{standalone}",
        "\\usepackage{ctex}",
        "\\usepackage{tikz}",
        "\\usetikzlibrary{positioning, shapes.geometric}",
        "\\begin{document}",
        "\\begin{tikzpicture}[node distance=2cm, scale=0.55]",
        "\\tikzset{",
        "  tube/.style={draw, thick, rounded corners=5pt, minimum width=1.5cm, minimum height=4cm},",
        "  beaker/.style={draw, thick, minimum width=2cm, minimum height=2.5cm},",
        "  jar/.style={draw, thick, minimum width=1.5cm, minimum height=2cm},",
        "  burner/.style={draw, thick, minimum width=1cm, minimum height=1.5cm}",
        "}",
        "\\node[tube, rotate=-15, fill=cyan!10] (testtube) {KMnO4};",
        "\\node[burner, below=1.5cm of testtube, fill=orange!30] (burner) {酒精灯};",
        "\\node[beaker, right=4cm of testtube, fill=cyan!20] (trough) {水槽};",
        "\\node[jar, at=(trough.center), yshift=1cm, fill=white] (gasjar) {集气瓶};",
        "\\draw[thick, rounded corners=10pt] (testtube.east) -- ++(1,0) |- (gasjar.south);",
        "\\end{tikzpicture}",
        "\\end{document}",
        "",
      ].join("\n"),
      "utf8",
    );
    console.log("正在编译样例（首次需联网下载宏包，请耐心等待）……");
    if (engine === "xelatex")
      execFileSync("xelatex", ["-interaction=nonstopmode", "-halt-on-error", "main.tex"], { cwd: dir, timeout: 240_000, stdio: "ignore" });
    else execFileSync("tectonic", ["main.tex"], { cwd: dir, timeout: 240_000, stdio: "ignore" });
    if (converter === "dvisvgm") execFileSync("dvisvgm", ["--pdf", "main.pdf", "-o", "out.svg"], { cwd: dir, timeout: 45_000, stdio: "ignore" });
    else execFileSync("pdftocairo", ["-svg", "main.pdf", "out.svg"], { cwd: dir, timeout: 45_000, stdio: "ignore" });
    const svg = readFileSync(path.join(dir, "out.svg"), "utf8");
    if (svg.includes("<svg")) ok("样例编译成功，产出合法 SVG");
    else bad("编译产物不是 SVG", "把本输出截图反馈。");
  } catch (e) {
    const logPath = path.join(dir, "main.log");
    const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-600) : String(e);
    bad("样例编译失败", `错误尾部：\n${tail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failed ? "\n存在问题 ❌（修复后重跑本脚本；不装的话会自动走 plan 布局引擎，不影响使用）" : "\nTikZ 路线已就绪 ✅ 重启服务后，化学装置图将用极简纯 TikZ 渲染。");
process.exit(failed ? 1 : 0);
