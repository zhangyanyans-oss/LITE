/**
 * 图库构建：把「自动切分结果 index.json」与「人工标注 labels.json」合成一份可用的图库目录，
 * 并输出一个能直接浏览的 HTML 总览页；同时对照装置注册表，列出还缺哪些器材类型。
 *
 * 用法：node scripts/atlas-build.mjs
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";

const ROOT = process.cwd();
const ATLAS = path.join(ROOT, "config/diagram/atlas");
const index = JSON.parse(readFileSync(path.join(ATLAS, "index.json"), "utf8"));
const labels = JSON.parse(readFileSync(path.join(ATLAS, "labels.json"), "utf8"));
const library = JSON.parse(readFileSync(path.join(ATLAS, "library.json"), "utf8"));
const libById = new Map(library.items.map((i) => [i.id, i]));
// 物理图库（初中：实验装置 + 光路/成像原理图；高中：实验装置 + 场/路/图像）直接来自人工标注好的
// physics.json / physics-hs.json，复用上面的 card 布局
const mapPhys = (file, categoryCnOf) =>
  JSON.parse(readFileSync(path.join(ATLAS, file), "utf8")).items.map((it) => ({
    id: it.id,
    file: it.file,
    name: it.name,
    categoryCn: categoryCnOf(it),
    inLibrary: true,
    kind: it.kind === "setup" ? "setup" : it.kind === "principle" ? "principle" : "part",
    assembly: it.assembly ?? null,
    aliases: it.aliases ?? [],
    devicesCn: it.devices ?? [],
    devices: it.devices ?? [],
    size: [it.width, it.height],
    page: it.page ?? "",
    missing: [],
    note: it.note ?? null,
    chapter: it.chapter ?? "",
    source: it.source ?? "",
  }));
const physItems = mapPhys("physics.json", (it) =>
  it.kind === "principle" ? "光路/成像原理图" : "实验装置",
);
const physHsItems = mapPhys("physics-hs.json", (it) =>
  it.kind === "setup" ? "实验装置/原理图" : "示意图/图像",
);
const histItems = mapPhys("history.json", () => "历史地图/示意图");
const bioItems = mapPhys("biology.json", (it) => (it.kind === "setup" ? "实验/观察图" : "结构示意图"));
const geoItems = mapPhys("geography.json", () => "地图/示意图");
const KIND_CN = { setup: "成套装置", part: "单件仪器", wrong: "反例" };
const registry = JSON.parse(readFileSync(path.join(ROOT, "config/diagram/device_registry.json"), "utf8"));
const known = new Set(Object.keys(registry.chemistry.types));

const CATEGORY_CN = {
  set: "成套装置",
  part: "单个装置",
  color: "彩色装置",
  experiment: "课本实验装置",
  glass: "玻璃仪器",
  inst: "仪器与用品",
  illus: "课本插图",
  meta: "页眉/图例",
};

const items = index.items.map((it) => {
  const lb = labels[it.id] ?? {};
  const lib = libById.get(it.id);
  // labels 里的 devices 是注册表 type（英文），用来算缺口；library 里的是给学生看的中文器材名
  const devices = lb.devices ?? [];
  const devicesCn = lib?.devices ?? [];
  return {
    id: it.id,
    file: it.file,
    page: it.page,
    section: it.section,
    // 精选库里的名字是核对过装配关系的，优先用它
    name: lib?.name ?? lb.name ?? null,
    category: lb.category ?? "illus",
    categoryCn: CATEGORY_CN[lb.category ?? "illus"],
    // 进课堂图库的条目：kind 决定它是正例还是反例，assembly 是讲课时要说的装配要点
    inLibrary: !!lib,
    kind: lib?.kind ?? null,
    assembly: lib?.assembly ?? null,
    aliases: lib?.aliases ?? [],
    devices,
    devicesCn,
    missing: devices.filter((d) => !known.has(d)),
    note: lib?.note ?? lb.note ?? null,
    text: it.text,
    size: it.size,
    bbox: it.bbox,
  };
});

const unlabeled = items.filter((i) => !i.name).map((i) => i.id);
const byCategory = {};
for (const it of items) byCategory[it.categoryCn] = (byCategory[it.categoryCn] ?? 0) + 1;

const missingCount = {};
for (const it of items) for (const m of it.missing) missingCount[m] = (missingCount[m] ?? 0) + 1;
const missing = Object.entries(missingCount)
  .sort((a, b) => b[1] - a[1])
  .map(([type, count]) => ({ type, count, usedBy: items.filter((i) => i.missing.includes(type)).map((i) => i.id) }));

const catalog = {
  source: index.source,
  total: items.length,
  byCategory,
  missingTypes: missing,
  items,
};
writeFileSync(path.join(ATLAS, "catalog.json"), JSON.stringify(catalog, null, 1), "utf8");

/* ── HTML 总览 ───────────────────────────── */
const GROUP_ORDER = ["成套装置", "彩色装置", "课本实验装置", "单个装置", "玻璃仪器", "仪器与用品", "课本插图", "页眉/图例"];
const groups = {};
for (const it of items) (groups[it.categoryCn] ??= []).push(it);

const libItems = items.filter((it) => it.inLibrary);
const libGroups = { setup: [], part: [], wrong: [] };
for (const it of libItems) (libGroups[it.kind] ??= []).push(it);

const badge = (it) => {
  if (!it.inLibrary) return "";
  const t = it.kind === "wrong" ? "反例" : it.kind === "part" ? "单件" : "课堂可用";
  return `<span class="badge ${it.kind}">${t}</span>`;
};

const card = (it) => `
  <figure class="card${it.inLibrary ? " lib" : ""}" data-cat="${it.categoryCn}" data-name="${(it.name ?? "").replace(/"/g, "&quot;")}">
    <a href="./${it.file}" target="_blank"><img loading="lazy" src="./${it.file}" alt="${it.name ?? it.id}"></a>
    <figcaption>
      <b>${it.name ?? "（待标注）"}${badge(it)}</b>
      <span class="meta">${it.id} · 第${it.page}页 · ${it.size[0]}×${it.size[1]}</span>
      <span class="dev">${(it.devicesCn.length ? it.devicesCn : it.devices).map((d) => (it.missing.includes(d) ? `<i>${d}</i>` : d)).join(" ")}</span>
      ${it.assembly ? `<span class="asm">装配：${it.assembly}</span>` : ""}
      ${it.note ? `<span class="note">${it.note}</span>` : ""}
    </figcaption>
  </figure>`;

const libSection = `
  <h2 class="lib-h">★ 课堂图库（${libItems.length} 张，AI 讲装置时优先引用这些） <small>成套 ${libGroups.setup.length} · 单件 ${libGroups.part.length} · 反例 ${libGroups.wrong.length}</small></h2>
  <p class="lead">这些图的装配关系已逐张核对：导管插入深度、塞子开孔、铁夹位置、加热位置。讲解时引擎直接把原图插进课堂，不再现画。</p>
  <div class="grid">${[...libGroups.setup, ...libGroups.wrong, ...libGroups.part].map(card).join("")}</div>`;

const physSetup = physItems.filter((i) => i.kind === "setup").length;
const physPrinciple = physItems.filter((i) => i.kind === "principle").length;
const physSection = `
  <h2 class="lib-h">★ 初中物理图库（${physItems.length} 张：实验装置 ${physSetup} · 光路/成像原理图 ${physPrinciple}） <small>来自实验专题讲义（扫描）+ 光路图大全</small></h2>
  <p class="lead">这些图是教材原图/教学光路图，讲装置、光路、成像、压强、电路时优先引用，不再用引擎现画（物理引擎只有 10 类器材图元，画不出光线与成像）。</p>
  <div class="grid">${physItems.map(card).join("")}</div>`;

const physHsSetup = physHsItems.filter((i) => i.kind === "setup").length;
const physHsPrinciple = physHsItems.filter((i) => i.kind === "principle").length;
const physHsSection = `
  <h2 class="lib-h">★ 高中物理图库（${physHsItems.length} 张：实验装置/原理图 ${physHsSetup} · 示意图/图像 ${physHsPrinciple}） <small>来自高中物理图册/题册（自动抽取，按章节归类）</small></h2>
  <p class="lead">高中物理的场线、波形、函数图像、电路连接，引擎同样画不出，讲这些时优先引用原图。名称按页首标题自动生成，可继续细化 device 与装配要点。</p>
  <div class="grid">${physHsItems.map(card).join("")}</div>`;

const histSection = `
  <h2 class="lib-h">★ 初中历史图库（${histItems.length} 张：历史地图 + 示意图） <small>来自部编版初中历史图库 PDF（自动抽取）</small></h2>
  <p class="lead">历史地图上的疆域界线、都城与遗址位置、进军路线现画必错，讲地图时优先引用原图。历史 OCR 多为地名碎片，挑不出标题的以「章节·出处」命名，可复核细化。</p>
  <div class="grid">${histItems.map(card).join("")}</div>`;

const bioSection = `
  <h2 class="lib-h">★ 初中生物图库（${bioItems.length} 张：结构示意图 + 实验图） <small>来自人教版初中生物图库 PDF（自动抽取）</small></h2>
  <p class="lead">微观结构与解剖层次现画必错，讲细胞、器官、系统结构时优先引用原图。</p>
  <div class="grid">${bioItems.map(card).join("")}</div>`;

const geoSection = `
  <h2 class="lib-h">★ 初中地理图库（${geoItems.length} 张：地图 + 示意图 + 图像） <small>来自人教版初中地理图库 PDF（自动抽取）</small></h2>
  <p class="lead">地理图形的轮廓形状、要素分布与数据关系现画必错，讲分布、地形、气候时优先引用原图。</p>
  <div class="grid">${geoItems.map(card).join("")}</div>`;

const sectionsHtml =
  libSection +
  physSection +
  physHsSection +
  histSection +
  bioSection +
  geoSection +
  GROUP_ORDER.filter((g) => groups[g])
    .map(
      (g) => `
  <h2>${g} <small>${groups[g].length} 张</small></h2>
  <div class="grid">${groups[g].map(card).join("")}</div>`,
    )
    .join("");

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>教材图库 · 化学 + 物理（人教版初中）</title>
<style>
  :root{--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;--accent:#b91c1c}
  *{box-sizing:border-box}
  body{margin:0;padding:28px 32px 60px;font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:#fafafa}
  h1{font-size:20px;margin:0 0 6px}
  .lead{color:var(--muted);margin:0 0 18px}
  .stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px}
  .stats span{background:#fff;border:1px solid var(--line);border-radius:999px;padding:3px 12px;font-size:12.5px;color:#374151}
  .stats i{color:var(--accent);font-style:normal}
  h2{font-size:15px;margin:26px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  h2 small{color:var(--muted);font-weight:400;font-size:12px;margin-left:6px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
  .card{margin:0;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
  .card img{width:100%;height:150px;object-fit:contain;background:#fff;padding:8px}
  figcaption{padding:8px 10px 10px;font-size:12.5px;display:flex;flex-direction:column;gap:3px;border-top:1px solid #f3f4f6}
  figcaption b{font-size:13px}
  .meta{color:var(--muted);font-size:11.5px}
  .dev{color:#374151;font-size:11.5px;word-spacing:3px}
  .dev i{color:var(--accent);font-style:normal;text-decoration:underline dotted}
  .note{color:var(--muted);font-size:11.5px}
  .missing{margin-top:22px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 18px}
  .missing h3{margin:0 0 8px;font-size:14px}
  .missing li{font-size:12.5px;color:#374151}
  .lib-h{margin-top:10px}
  .card.lib{border-color:#bbf7d0;box-shadow:0 0 0 1px #dcfce7 inset}
  .badge{font-size:10.5px;font-weight:400;padding:1px 6px;border-radius:999px;margin-left:6px;vertical-align:1px}
  .badge.setup{background:#dcfce7;color:#166534}
  .badge.part{background:#e0e7ff;color:#3730a3}
  .badge.wrong{background:#fef3c7;color:#92400e}
  .asm{color:#166534;font-size:11.5px;line-height:1.5;background:#f0fdf4;border-radius:6px;padding:4px 6px}
</style></head>
<body>
<h1>教材图库 · 化学 + 物理（初中 / 高中）+ 史地生（初中）</h1>
<p class="lead">来源：${index.source} · 自动切分 ${items.length} 张 · 下划线标红的类型表示装置注册表里还没有</p>
<div class="stats"><span>★ 课堂图库 <b>${libItems.length}</b></span>${Object.entries(byCategory)
  .map(([k, v]) => `<span>${k} <b>${v}</b></span>`)
  .join("")}<span>待补器材类型 <i>${missing.length}</i></span></div>
${sectionsHtml}
<div class="missing"><h3>装置注册表缺口（按使用频次）</h3><ul>${missing
  .map((m) => `<li><code>${m.type}</code> · ${m.count} 处 · ${m.usedBy.slice(0, 6).join("、")}${m.usedBy.length > 6 ? "…" : ""}</li>`)
  .join("")}</ul></div>
</body></html>`;
writeFileSync(path.join(ROOT, "assets/atlas/index.html"), html, "utf8");

console.log(`catalog: ${items.length} 条，待标注 ${unlabeled.length} 条`);
console.log("分类：", byCategory);
console.log("缺口类型：", missing.map((m) => `${m.type}(${m.count})`).join(" "));
