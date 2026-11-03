/** E2E：plan 图示管道——配置加载、通用校验、化学硬规则、params 渲染、路由走线、正文替换、坏计划兜底 */
import { loadDiagramConfig } from "../api/lib/diagram/config";
import { validatePlan, checkPlanSchema } from "../api/lib/diagram/validate";
import { renderPlan } from "../api/lib/diagram/render";
import { extractPlanBlocks, processPlanBlocks, stripHandDrawnApparatus, planFallbackFigure } from "../api/lib/diagram";
import { loadAtlas, processFigureBlocks, buildFigurePromptSection, matchFigureForPlan, detectSubject, libraryItems } from "../api/lib/diagram/atlas";
import { buildPlanPromptSection, FEW_SHOT_PLAN } from "../api/lib/diagram/prompt";
import { extractSvgBlocks, svgStructurallyOk } from "../api/lib/quizlib";
import { existsSync } from "fs";
import path from "path";

let failed = false;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " | " + extra : ""}`);
  if (!ok) failed = true;
};

const cfg = loadDiagramConfig();

// 1. 配置加载 + 加载期校验
check("配置加载（4 学科注册表 + 规则）", Object.keys(cfg.registries).length === 4 && Object.keys(cfg.rules).length === 4);

// 2. 注册表包含主构架文档要求的新类型/接口
const chem = cfg.registries.chemistry;
check(
  "化学注册表含新类型与接口",
  !!chem.types.separating_funnel &&
    !!chem.types.inverted_funnel &&
    !!chem.types.glass_rod &&
    !!chem.types.test_tube.interfaces.mouth_open &&
    !!chem.types.bottle.interfaces.side_out &&
    !!chem.types.gas_jar.interfaces.top_in &&
    !!chem.types.trough.interfaces.liquid_inside,
);

// 3. 提示词段落包含类型清单与五条铁律
const section = buildPlanPromptSection();
check(
  "提示词段落包含装置类型与铁律",
  section.includes("gas_jar(集气瓶") && section.includes("map_frame(图框") && section.includes("液封") && section.includes("长进短出"),
);

// 4. few-shot 示例自身必须能通过 L1 + 全部校验（提示词与校验器一致性）
{
  const r = checkPlanSchema(JSON.parse(JSON.stringify(FEW_SHOT_PLAN)));
  if ("plan" in r) {
    const errs = validatePlan(r.plan, cfg.registries.chemistry, cfg.rules.chemistry);
    check("few-shot 示例零 fatal 零 warning", errs.length === 0, errs.map((e) => e.code + ":" + e.message).join("; "));
    check("few-shot 示例渲染合法", svgStructurallyOk(renderPlan(r.plan, cfg.registries.chemistry)));
  } else {
    check("few-shot 示例通过 L1", false, r.errors.map((e) => e.message).join("; "));
  }
}

// 5. 合法计划：CO2 制取（固液常温 + 向上排空气），应零 fatal 错误
const goodPlan = {
  subject: "chemistry",
  canvas_hint: "two_column",
  devices: [
    { id: "funnel_1", type: "long_neck_funnel", label: "长颈漏斗", relative_position: "left_top", interface: ["top_open", "bottom_out"] },
    {
      id: "bottle_1",
      type: "bottle",
      label: "锥形瓶",
      relative_position: "left_center",
      params: { liquid_level: 0.55, solid_chunks: true },
      interface: ["top_open", "side_out", "liquid_inside"],
    },
    { id: "tube_1", type: "tube", label: "导管", relative_position: "center_top", interface: ["left_end", "right_end"] },
    {
      id: "gas_jar_1",
      type: "gas_jar",
      label: "集气瓶",
      relative_position: "right_center",
      params: { inverted: false, has_glass_plate: true },
      interface: ["bottom_in", "top_open"],
    },
  ],
  connections: [
    { from: "funnel_1.bottom_out", to: "bottle_1.liquid_inside", style: "straight", note: "长颈漏斗液封" },
    { from: "bottle_1.side_out", to: "tube_1.left_end", style: "straight", note: "导出CO2" },
    { from: "tube_1.right_end", to: "gas_jar_1.bottom_in", style: "straight", route: "down_into_jar", note: "向上排空气法" },
  ],
  expected_counts: { long_neck_funnel: 1, bottle: 1, tube: 1, gas_jar: 1 },
};
const checked = checkPlanSchema(JSON.parse(JSON.stringify(goodPlan)));
check("L1 结构校验通过", "plan" in checked);
if ("plan" in checked) {
  const errs = validatePlan(checked.plan, cfg.registries.chemistry, cfg.rules.chemistry);
  const fatal = errs.filter((e) => e.fatal);
  check("L2-L6 校验零 fatal", fatal.length === 0, fatal.map((e) => e.code + ":" + e.message).join("; "));
}

// 6. 坏计划：数量不符 + 幽灵引用 + 酒精灯在上方 + 加热试管未倾斜
const badPlan = {
  ...goodPlan,
  devices: [
    { id: "burner_1", type: "burner", label: "酒精灯", relative_position: "center_top", interface: [] },
    { id: "test_tube_1", type: "test_tube", label: "试管", relative_position: "center", interface: ["mouth_open"] },
  ],
  connections: [{ from: "test_tube_1.mouth_open", to: "ghost_1.top_open", style: "straight" }],
  expected_counts: { burner: 1, test_tube: 3 },
};
const badChecked = checkPlanSchema(JSON.parse(JSON.stringify(badPlan)));
if ("plan" in badChecked) {
  const errs = validatePlan(badChecked.plan, cfg.registries.chemistry, cfg.rules.chemistry);
  const codes = errs.map((e) => e.code);
  check("检出数量不符 COUNT_MISMATCH", codes.includes("COUNT_MISMATCH"));
  check("检出幽灵引用 MISSING_REF", codes.includes("MISSING_REF"));
  check("检出学科规则违反 RULE_VIOLATION（加热源在下）", codes.includes("RULE_VIOLATION"));
  check("检出加热试管未倾斜 TUBE_TILT", codes.includes("TUBE_TILT"));
  const nonFatal = errs.filter((e) => !e.fatal);
  check("fatal 标记正确（仅棉花提醒为 warning）", nonFatal.every((e) => e.code === "COTTON_HINT"));
} else {
  check("坏计划结构校验", false, "应通过 L1");
}

// 7. 化学硬规则逐项检出
const mkPlan = (devices: unknown[], connections: unknown[], counts: Record<string, number>) => ({
  subject: "chemistry",
  canvas_hint: "single_column",
  devices,
  connections,
  expected_counts: counts,
});
const fatalCodes = (p: unknown) => {
  const r = checkPlanSchema(JSON.parse(JSON.stringify(p)));
  if (!("plan" in r)) return ["SCHEMA_FAIL"];
  return validatePlan(r.plan, cfg.registries.chemistry, cfg.rules.chemistry).filter((e) => e.fatal).map((e) => e.code);
};

// 7a. 长颈漏斗未液封（没有从 bottom_out 出发的连接）
check(
  "检出未液封 LIQUID_SEAL",
  fatalCodes(
    mkPlan(
      [
        { id: "f1", type: "long_neck_funnel", label: "长颈漏斗", relative_position: "left_top", interface: ["bottom_out"] },
        { id: "b1", type: "bottle", label: "锥形瓶", relative_position: "left_center", interface: ["liquid_inside"] },
      ],
      [],
      { long_neck_funnel: 1, bottle: 1 },
    ),
  ).includes("LIQUID_SEAL"),
);
// 7b. 液封接错接口（bottom_out → top_open 而不是 liquid_inside）
check(
  "检出液封接错口 LIQUID_SEAL",
  fatalCodes(
    mkPlan(
      [
        { id: "f1", type: "long_neck_funnel", label: "长颈漏斗", relative_position: "left_top", interface: ["bottom_out"] },
        { id: "b1", type: "bottle", label: "锥形瓶", relative_position: "left_center", interface: ["top_open", "liquid_inside"] },
      ],
      [{ from: "f1.bottom_out", to: "b1.top_open", style: "straight" }],
      { long_neck_funnel: 1, bottle: 1 },
    ),
  ).includes("LIQUID_SEAL"),
);
// 7c. 向上排空气未盖玻璃片
check(
  "检出未盖玻璃片 GLASS_PLATE",
  fatalCodes(
    mkPlan(
      [
        { id: "t1", type: "tube", label: "导管", relative_position: "center_top", interface: ["right_end"] },
        { id: "g1", type: "gas_jar", label: "集气瓶", relative_position: "right_center", params: { inverted: false }, interface: ["bottom_in"] },
      ],
      [{ from: "t1.right_end", to: "g1.bottom_in", style: "straight" }],
      { tube: 1, gas_jar: 1 },
    ),
  ).includes("GLASS_PLATE"),
);
// 7d. 向上排空气导管没到底部（接 top_open）
check(
  "检出未长进短出 JAR_INTAKE",
  fatalCodes(
    mkPlan(
      [
        { id: "t1", type: "tube", label: "导管", relative_position: "center_top", interface: ["right_end"] },
        {
          id: "g1",
          type: "gas_jar",
          label: "集气瓶",
          relative_position: "right_center",
          params: { inverted: false, has_glass_plate: true },
          interface: ["bottom_in", "top_open"],
        },
      ],
      [{ from: "t1.right_end", to: "g1.top_open", style: "straight" }],
      { tube: 1, gas_jar: 1 },
    ),
  ).includes("JAR_INTAKE"),
);
// 7e. 加热时导管从管身中部引出
check(
  "检出导管未从管口引出 TUBE_OUTLET",
  fatalCodes(
    mkPlan(
      [
        { id: "tt1", type: "test_tube", label: "试管", relative_position: "center", params: { tilted: "down", has_cotton: true }, interface: ["mouth_open", "side_right_out"] },
        { id: "bu1", type: "burner", label: "酒精灯", relative_position: "center_bottom", interface: [] },
        { id: "tu1", type: "tube", label: "导管", relative_position: "right_center", interface: ["left_end"] },
      ],
      [{ from: "tt1.side_right_out", to: "tu1.left_end", style: "straight" }],
      { test_tube: 1, burner: 1, tube: 1 },
    ),
  ).includes("TUBE_OUTLET"),
);

// 8. 渲染：CO2 合法计划 → SVG 结构合法、液面/固体块/玻璃片/伸入导管齐全
if ("plan" in checked) {
  const svg = renderPlan(checked.plan, cfg.registries.chemistry);
  check("渲染产出合法 SVG", svgStructurallyOk(svg));
  check("SVG 含装置标注", svg.includes("长颈漏斗") && svg.includes("集气瓶"));
  check("SVG 无坏数值", !/NaN|undefined|null/.test(svg));
  check("液面波浪渲染（liquid_level）", svg.includes('stroke="#0284c7"'));
  check("固体块渲染（solid_chunks）", svg.includes('fill="#a3a3a3"'));
  // 玻璃片只画一次（params.has_glass_plate=true 时不应再触发 auto_plate 双画）
  check("玻璃片渲染且不重复", (svg.match(/fill="#d4d4d4"/g) ?? []).length === 1);
  // 液封：漏斗颈直接画到锥形瓶 liquid_inside 的 y=187.5（不再单独拉一条线，颈部不会"断"在管口）
  check("液封：漏斗颈伸到液面以下", svg.includes("99.3 187.5") && svg.includes("90.7 187.5"));
  // 导管一进一出 → 走成一条连续管路：瓶侧口 (130,147) → 拐进集气瓶并伸到 y=196（越过 bottom_in 伸向瓶心）
  const routed = svg.match(/<path d="M 130 147 [^"]*L 385 196"[^>]*\/>/g) ?? [];
  check("导管为一条连续管路并伸入瓶底", routed.length === 1, routed[0]?.slice(0, 90));
  const { writeFileSync } = await import("fs");
  writeFileSync("/tmp/plan-render-co2.svg", svg);
}

// 9. 倾斜试管渲染：管口锚点 = 旋转后的管口 (285.1,195.9)
{
  const heated = checkPlanSchema(
    JSON.parse(
      JSON.stringify(
        mkPlan(
          [
            { id: "st1", type: "stand", label: "铁架台", relative_position: "left_center", interface: ["clamp"] },
            { id: "tt1", type: "test_tube", label: "试管", relative_position: "center", params: { solid_chunks: true, tilted: "down", has_cotton: true }, interface: ["mouth_open"] },
            { id: "bu1", type: "burner", label: "酒精灯", relative_position: "center_bottom", interface: [] },
            { id: "tu1", type: "tube", label: "导管", relative_position: "right_center", interface: ["left_end"] },
          ],
          [
            { from: "st1.clamp", to: "tt1.mouth_open", style: "dashed", note: "固定" },
            { from: "tt1.mouth_open", to: "tu1.left_end", style: "straight", note: "出气" },
          ],
          { stand: 1, test_tube: 1, burner: 1, tube: 1 },
        ),
      ),
    ),
  );
  if ("plan" in heated) {
    const errs = validatePlan(heated.plan, cfg.registries.chemistry, cfg.rules.chemistry).filter((e) => e.fatal);
    check("加热装置计划零 fatal", errs.length === 0, errs.map((e) => e.code).join(";"));
    const svg = renderPlan(heated.plan, cfg.registries.chemistry);
    check("倾斜试管渲染合法", svgStructurallyOk(svg));
    check("倾斜试管带旋转变换", svg.includes("rotate(18"));
    check("棉花渲染（has_cotton）", (svg.match(/fill="#e5e5e5"/g) ?? []).length >= 3);
    // 单端导管（只有一头连接）现在直接吸附到管口、沿试管轴线斜放，不再额外拉一条连线
    check(
      "单端导管贴到管口并沿轴线斜放",
      (svg.match(/rotate\(18[\s,]/g) ?? []).length >= 2 && !svg.includes("M 285.1 195.9"),
    );
    // 酒精灯没有 flame 连线时也应吸附到被加热容器下方（火焰尖落在试管外框范围内）
    const flame = svg.match(/<path d="M [\d.]+ ([\d.]+) q/);
    check("酒精灯自动吸附到试管下方", !!flame && Number(flame[1]) > 160 && Number(flame[1]) < 216, flame?.[1]);
  } else {
    check("加热装置计划通过 L1", false);
  }
}

// 10. 完整管道：正文里的 ```plan 块被处理后不会再以代码块形式出现
//     ——图库有同一台标准装置时换成教材原图，图库没有时换成引擎 SVG（两者都不能留 plan 围栏）
const lesson = `实验室制取二氧化碳，装置如下：\n\n\`\`\`plan\n${JSON.stringify(goodPlan)}\n\`\`\`\n\n注意长颈漏斗要液封。`;
const processed = await processPlanBlocks(lesson, { topic: "二氧化碳制取" });
const lessonFig = processed.match(/```figure\n(\{[\s\S]*?\})\n```/);
const lessonFigPayload = lessonFig ? (JSON.parse(lessonFig[1]) as { src: string; id: string }) : null;
check("图库有标准装置时 plan 换成教材原图", lessonFigPayload?.id === "atlas-110", lessonFigPayload?.src ?? "仍是 svg");
check("正文文字保留", processed.includes("注意长颈漏斗要液封"));

const engineLesson = `装置如下：\n\n\`\`\`plan\n${JSON.stringify(goodPlan)}\n\`\`\`\n\n注意液封。`;
const processedEngine = await processPlanBlocks(engineLesson, { topic: "气体的制取（通用装置）" });
const svgBlocks = extractSvgBlocks(processedEngine);
check("图库没有对应装置时走引擎 svg", svgBlocks.length === 1 && svgStructurallyOk(svgBlocks[0].svg));
check("引擎路径正文文字保留", processedEngine.includes("注意液封"));

// 11. 坏计划走完整管道：修正轮需要模型（沙箱离线必失败），应优雅删除该块而不是留坏图
const badLesson = `装置：\n\n\`\`\`plan\n${JSON.stringify(badPlan)}\n\`\`\`\n\n完。`;
const t0 = Date.now();
const processedBad = await processPlanBlocks(badLesson, { topic: "测试" });
check("坏计划被优雅移除（不留 plan 围栏）", !processedBad.includes("```plan"), `耗时 ${(Date.now() - t0) / 1000}s`);

// 11b. 物理图库接入：图库现在含化学 + 物理两科，互不通台
check("物理图库已加载", libraryItems("physics").length >= 40, `物理条目 ${libraryItems("physics").length}`);
check("化学图库仍在", libraryItems("chemistry").length >= 40, `化学条目 ${libraryItems("chemistry").length}`);
check("化学课提示词不含物理图 id", !buildFigurePromptSection("chemistry").includes("phy-"), "化学清单泄漏了 phy-");
check("物理课提示词含物理图 id", buildFigurePromptSection("physics").includes("phy-"), "物理清单缺失 phy-");
check("不指定学科时两科都给", buildFigurePromptSection().includes("phy-") && buildFigurePromptSection().includes("atlas-"), "双清单不全");

// 学科判定：强标志优先，术语兜底；只提物理没提年级时给两套物理清单（physics-all）以免漏图
check("detectSubject 物理（光路，无年级→physics-all）", detectSubject("光的反射定律") === "physics-all");
check("detectSubject 化学（制取）", detectSubject("高锰酸钾制氧气") === "chemistry");
check("detectSubject 拿不准返回 undefined", detectSubject("今天我们聊聊学习方法") === undefined);

// 物理图库反查：主题点名 + 器材对得上 → 命中物理图，且不会错配到化学
const phyHit = matchFigureForPlan({ subject: "physics", topic: "测量平均速度", devices: ["斜面", "小车"] });
check("物理主题+器材命中物理图", phyHit?.item.id === "phy-001", phyHit?.item.id ?? "未命中");
const chemScope = matchFigureForPlan({ subject: "chemistry", topic: "测量平均速度", devices: ["斜面", "小车"] });
check("物理器材不会错配到化学图库", chemScope === null, chemScope?.item.id ?? "误配");
check("物理图反查优先级：主题点名优先于弱线索", (() => {
  const a = matchFigureForPlan({ subject: "physics", topic: "测量小车的平均速度·斜面装置" });
  return a?.item.id === "phy-001";
})(), "未命中或错配");

// 物理图前端解析：figure 围栏里的 phy 裸 id 与 JSON 都能落地成图卡片
const phyFence = processFigureBlocks("如图所示：\n\n```figure phy-101\n```\n\n这就是光的反射。");
check("物理图裸 id 围栏被解析", phyFence.used.includes("phy-101") && phyFence.content.includes("/atlas/phy-101.png"), "未解析 phy-101");
const phyJson = processFigureBlocks("```figure\n{\"id\":\"phy-101\"}\n```");
check("物理图 JSON 围栏被解析", phyJson.used.includes("phy-101") && phyJson.content.includes("/atlas/phy-101.png"), "未解析 phy-101");
const phyBad = processFigureBlocks("```figure phy-999\n```");
check("不存在的物理 id 被整块删除", !phyBad.content.includes("```figure") && phyBad.used.length === 0, "坏 id 未清理");

// 11c. 高中物理图库接入：化学 + 初中物理 + 高中物理 三科，互不通台
check("高中物理图库已加载", libraryItems("physics-hs").length >= 100, `高中物理条目 ${libraryItems("physics-hs").length}`);
check("高中物理课提示词含 phs- id", buildFigurePromptSection("physics-hs").includes("phs-"), "高中清单缺失 phs-");
check("高中物理课提示词不含初中 phy-", !buildFigurePromptSection("physics-hs").includes("phy-"), "高中清单泄漏了初中 phy-");
check("初中物理课提示词不含高中 phs-", !buildFigurePromptSection("physics").includes("phs-"), "初中清单泄漏了高中 phs-");
check("化学课提示词不含高中 phs-", !buildFigurePromptSection("chemistry").includes("phs-"), "化学清单泄漏了高中 phs-");
check("physics-all 两套物理都给", buildFigurePromptSection("physics-all").includes("phs-") && buildFigurePromptSection("physics-all").includes("phy-"), "双物理清单不全");

// 年级判定：高中 / 初中 / 泛物理 / 化学
check("detectSubject 高中（牛顿第二定律，术语兜底→physics-all）", detectSubject("牛顿第二定律") === "physics-all");
check("detectSubject 高中（高一物理）", detectSubject("高一物理·匀变速直线运动") === "physics-hs");
check("detectSubject 高中（必修一）", detectSubject("必修一 运动的描述") === "physics-hs");
check("detectSubject 初中（八年级物理）", detectSubject("八年级物理·浮力") === "physics");
check("detectSubject 化学优先于年级", detectSubject("高中化学·氧化还原反应") === "chemistry");

// 高中物理图库反查：主题点名 → 命中高中图，且不会错配到初中/化学
const hsHit = matchFigureForPlan({ subject: "physics-hs", topic: "研究匀变速直线运动" });
check("高中主题点名命中高中图", hsHit?.item.id === "phs-001", hsHit?.item.id ?? "未命中");
const hsHit2 = matchFigureForPlan({ subject: "physics-hs", topic: "测定玻璃的折射率" });
check("高中主题点名命中折射率图", hsHit2?.item.id === "phs-128", hsHit2?.item.id ?? "未命中");
const hsScope = matchFigureForPlan({ subject: "chemistry", topic: "研究匀变速直线运动" });
check("高中器材概念不会错配到化学图库", hsScope === null, hsScope?.item.id ?? "误配");
const midScope = matchFigureForPlan({ subject: "physics", topic: "研究匀变速直线运动" });
check("高中主题不会错配到初中物理图库", midScope === null, midScope?.item.id ?? "误配");

// 高中物理图前端解析：figure 围栏里的 phs 裸 id 与 JSON 都能落地成图卡片
const hsFence = processFigureBlocks("如图所示：\n\n```figure phs-001\n```\n\n这是匀变速直线运动实验。");
check("高中图裸 id 围栏被解析", hsFence.used.includes("phs-001") && hsFence.content.includes("/atlas/phs-001.png"), "未解析 phs-001");
const hsJson = processFigureBlocks("```figure\n{\"id\":\"phs-128\"}\n```");
check("高中图 JSON 围栏被解析", hsJson.used.includes("phs-128") && hsJson.content.includes("/atlas/phs-128.png"), "未解析 phs-128");
const hsBad = processFigureBlocks("```figure phs-999\n```");
check("不存在的高中 id 被整块删除", !hsBad.content.includes("```figure") && hsBad.used.length === 0, "坏 id 未清理");

// 11d. 史地生图库接入：六科清单互不串台；detectSubject 学科词优先于年级词
check("历史图库已加载", libraryItems("history").length >= 90, `历史条目 ${libraryItems("history").length}`);
check("生物图库已加载", libraryItems("biology").length >= 30, `生物条目 ${libraryItems("biology").length}`);
check("地理图库已加载", libraryItems("geography").length >= 100, `地理条目 ${libraryItems("geography").length}`);
{
  const p = buildFigurePromptSection("history");
  check("历史课提示词含 his- 不含其他科", p.includes("his-") && !p.includes("geo-") && !p.includes("bio-") && !p.includes("phs-") && !p.includes("phy-") && !p.includes("atlas-"), "历史清单串台");
  const b = buildFigurePromptSection("biology");
  check("生物课提示词含 bio- 不含其他科", b.includes("bio-") && !b.includes("his-") && !b.includes("geo-") && !b.includes("phs-"), "生物清单串台");
  const g = buildFigurePromptSection("geography");
  check("地理课提示词含 geo- 不含其他科", g.includes("geo-") && !g.includes("his-") && !g.includes("bio-") && !g.includes("phs-"), "地理清单串台");
  const ph = buildFigurePromptSection("physics");
  check("物理课提示词不含史地生", !ph.includes("his-") && !ph.includes("bio-") && !ph.includes("geo-"), "物理清单泄漏史地生");
}
check("detectSubject 历史（初中历史）", detectSubject("初中历史·秦朝统一") === "history");
check("detectSubject 生物（七年级生物）", detectSubject("七年级生物·细胞结构") === "biology");
check("detectSubject 地理（八年级地理）", detectSubject("八年级地理·季风气候") === "geography");
check("detectSubject 高中生物也是 biology", detectSubject("高中生物·光合作用") === "biology");
check("detectSubject 历史词优先于历史地图", detectSubject("唐朝疆域地图") === "history");

// 史地生反查：主题点名 → 命中本科图，不会错配到物理/化学
const hisHit = matchFigureForPlan({ subject: "history", topic: "秦朝形势图" });
check("历史主题点名命中历史地图", hisHit?.item.id === "his-007", hisHit?.item.id ?? "未命中");
const bioHit = matchFigureForPlan({ subject: "biology", topic: "心脏结构示意图" });
check("生物主题点名命中结构图", bioHit?.item.id === "bio-018", bioHit?.item.id ?? "未命中");
const geoHit = matchFigureForPlan({ subject: "geography", topic: "纬线和纬度" });
check("地理主题点名命中地理图", geoHit?.item.id === "geo-002", geoHit?.item.id ?? "未命中");
check("历史主题不会错配到物理图库", matchFigureForPlan({ subject: "physics", topic: "秦朝形势图" }) === null, "误配");
check("生物主题不会错配到化学图库", matchFigureForPlan({ subject: "chemistry", topic: "心脏结构示意图" }) === null, "误配");

// 史地生前端解析：figure 围栏里的新前缀 id 与 JSON 都能落地，坏 id 清理
const bioFence = processFigureBlocks("如图所示：\n\n```figure bio-018\n```\n\n这是心脏的结构。");
check("生物图裸 id 围栏被解析", bioFence.used.includes("bio-018") && bioFence.content.includes("/atlas/bio-018.png"), "未解析 bio-018");
const hisJson = processFigureBlocks("```figure\n{\"id\":\"his-007\"}\n```");
check("历史图 JSON 围栏被解析", hisJson.used.includes("his-007") && hisJson.content.includes("/atlas/his-007.png"), "未解析 his-007");
const geoFence = processFigureBlocks("```figure geo-002\n```");
check("地理图裸 id 围栏被解析", geoFence.used.includes("geo-002") && geoFence.content.includes("/atlas/geo-002.png"), "未解析 geo-002");
const newBad = processFigureBlocks("```figure geo-999\n```");
check("不存在的地理 id 被整块删除", !newBad.content.includes("```figure") && newBad.used.length === 0, "坏 id 未清理");

// 12. 装配：倒扣试管必须沉到液面之下（不是悬在水槽上方），电极插进试管口内
{
  const elec = checkPlanSchema({
    subject: "chemistry",
    canvas_hint: "two_column",
    devices: [
      { id: "bat1", type: "battery", label: "直流电源", relative_position: "center_top", interface: ["positive", "negative"] },
      { id: "tr1", type: "trough", label: "水槽", relative_position: "center_bottom", params: { liquid_level: 0.72 }, interface: ["liquid_inside"] },
      { id: "ta", type: "test_tube", label: "试管甲", relative_position: "center_bottom", params: { inverted: true }, interface: ["mouth_open"] },
      { id: "tb", type: "test_tube", label: "试管乙", relative_position: "center_bottom", params: { inverted: true }, interface: ["mouth_open"] },
      { id: "ea", type: "electrode", label: "电极", relative_position: "center", interface: ["top", "tip"] },
      { id: "eb", type: "electrode", label: "电极", relative_position: "center", interface: ["top", "tip"] },
    ],
    connections: [
      { from: "ta.mouth_open", to: "tr1.liquid_inside", style: "straight", note: "甲管倒扣浸入水中" },
      { from: "tb.mouth_open", to: "tr1.liquid_inside", style: "straight", note: "乙管倒扣浸入水中" },
      { from: "ea.top", to: "ta.mouth_open", style: "straight", note: "电极伸入甲管口" },
      { from: "eb.top", to: "tb.mouth_open", style: "straight", note: "电极伸入乙管口" },
      { from: "bat1.positive", to: "ea.top", style: "straight", note: "接负极" },
      { from: "bat1.negative", to: "eb.top", style: "straight", note: "接正极" },
    ],
    expected_counts: { battery: 1, trough: 1, test_tube: 2, electrode: 2 },
  });
  if ("plan" in elec) {
    const errs = validatePlan(elec.plan, cfg.registries.chemistry, cfg.rules.chemistry).filter((e) => e.fatal);
    check("电解水计划零 fatal", errs.length === 0, errs.map((e) => e.code + e.message).join(";"));
    const svg = renderPlan(elec.plan, cfg.registries.chemistry);
    check("引擎产物带 data-dg 标记（供手写图拦截器识别）", svg.includes('data-dg="1"'));
    // 水槽 center_bottom(240,255)，h=70 → 水面 239.6；倒扣试管口要沉到 251.6（液面下 12px）
    check("倒扣试管沉到液面以下", svg.includes("239.6") && svg.includes("251.6"));
    // 开口器皿（试管/集气瓶）描边不闭合，否则管口被 Z 补一条横线，看着像封口的胶囊
    check("开口器皿口部不封口（描边无 Z）", /<path d="M [^"]*[^Z]" fill="none" stroke="#222" stroke-width="2"\/>/.test(svg));
    check("插入关系不画多余连线（只留导线 2 条）", (svg.match(/<path d="M [^"]*" fill="none" stroke="#222" stroke-width="1.5"/g) ?? []).length === 2);
  } else {
    check("电解水计划通过 L1", false);
  }
}

// 13. 孤立装置：多个器皿却一条连接都没有 → 直接打回（这就是"试管悬空在水槽上方"那张图的计划）
{
  const orphan = checkPlanSchema({
    subject: "chemistry",
    canvas_hint: "two_column",
    devices: [
      { id: "be1", type: "beaker", label: "水槽", relative_position: "center_bottom", params: { liquid_level: 0.8 }, interface: ["top_open", "liquid_inside"] },
      { id: "t1", type: "test_tube", label: "试管甲", relative_position: "left_center", interface: ["mouth_open"] },
      { id: "t2", type: "test_tube", label: "试管乙", relative_position: "right_center", interface: ["mouth_open"] },
    ],
    connections: [],
    expected_counts: { beaker: 1, test_tube: 2 },
  });
  const codes =
    "plan" in orphan
      ? validatePlan(orphan.plan, cfg.registries.chemistry, cfg.rules.chemistry)
          .filter((e) => e.fatal)
          .map((e) => e.code)
      : [];
  check("检出孤立装置 ORPHAN_DEVICE", codes.filter((c) => c === "ORPHAN_DEVICE").length === 3, codes.join(","));
}

// 14. 手写装置图一律丢弃（没有几何校验，穿模/悬空都会进课堂）；抽象图与引擎产物保留
{
  const hand = "看图：\n```svg\n<svg viewBox=\"0 0 480 360\"><text x=\"240\" y=\"60\">集气瓶</text></svg>\n```\n";
  const abstract = "抛物线：\n```svg\n<svg viewBox=\"0 0 480 320\"><path d=\"M 40 280 Q 240 -40 440 280\"/></svg>\n```\n";
  const engineSvg = "```svg\n<svg data-dg=\"1\" viewBox=\"0 0 480 360\"><text>集气瓶</text></svg>\n```\n";
  check("手写的装置图被丢弃", stripHandDrawnApparatus(hand).dropped === 1 && !extractSvgBlocks(stripHandDrawnApparatus(hand).content).length);
  check("抽象图（函数图像）保留", stripHandDrawnApparatus(abstract).dropped === 0);
  check("引擎产出的装置图保留", stripHandDrawnApparatus(engineSvg).dropped === 0);
}

/**
 * 从渲染结果里取出"旋转摆放的导管"（单端导管胶囊画在 rotate 组里），
 * 反算回画布坐标，好判断它到底伸到管子里的哪一段（t = 沿管轴离管底的距离）。
 */
function rotatedTubeEnds(svg: string): Array<{ ang: number; ends: Array<[number, number]> }> {
  const out: Array<{ ang: number; ends: Array<[number, number]> }> = [];
  const re = /<g transform="rotate\(([-\d.]+) ([\d.]+) ([\d.]+)\)"><path d="M ([\d.]+) ([\d.]+) L ([\d.]+) [\d.-]+ A 3\.5 3\.5/g;
  for (const m of svg.matchAll(re)) {
    const ang = (Number(m[1]) * Math.PI) / 180;
    const ox = Number(m[2]);
    const oy = Number(m[3]);
    const y = Number(m[5]);
    const rot = (p: [number, number]): [number, number] => {
      const dx = p[0] - ox;
      const dy = p[1] - oy;
      return [ox + dx * Math.cos(ang) - dy * Math.sin(ang), oy + dx * Math.sin(ang) + dy * Math.cos(ang)];
    };
    out.push({ ang, ends: [rot([Number(m[4]) - 3.5, y]), rot([Number(m[6]) + 3.5, y])] });
  }
  return out;
}

// 15. 导管伸进试管：气体通入试管（H2 还原 CuO）时，导管必须穿过管口塞子、伸到管内固体药品上方。//     之前引擎只把导管贴到管口外，管口尖端停在试管外面——气体等于从口部直接跑掉，
//     这也是"导管要深入试管、在氧化铜上方"那张图最刺眼的地方。
{
  const mk = (dir: "in" | "out", route?: string) => {
    const flow =
      dir === "in"
        ? { from: "tu1.right_end", to: "tt1.mouth_open", style: "straight", route, note: "通入氢气" }
        : { from: "tt1.mouth_open", to: "tu1.left_end", style: "straight", route, note: "导管伸入试管底部" };
    return mkPlan(
      [
        { id: "st1", type: "stand", label: "铁架台", relative_position: "left_center", interface: ["clamp"] },
        { id: "tt1", type: "test_tube", label: "试管", relative_position: "center", params: { solid_chunks: true, tilted: "down" }, interface: ["mouth_open"] },
        { id: "bu1", type: "burner", label: "酒精灯", relative_position: "center_bottom", interface: [] },
        { id: "tu1", type: "tube", label: "导管", relative_position: "right_center", interface: ["left_end", "right_end"] },
      ],
      [{ from: "st1.clamp", to: "tt1.mouth_open", style: "dashed", note: "固定" }, flow],
      { stand: 1, test_tube: 1, burner: 1, tube: 1 },
    );
  };
  // 倾斜试管的轴线：管底 (190,165)，18° 向下；t = 沿轴离管底的距离（管长 100，管口 t=100）
  const base: [number, number] = [190, 165];
  const u: [number, number] = [Math.cos((18 * Math.PI) / 180), Math.sin((18 * Math.PI) / 180)];
  const along = (p: [number, number]) => (p[0] - base[0]) * u[0] + (p[1] - base[1]) * u[1];
  const tipsInTube = (svg: string) =>
    rotatedTubeEnds(svg).filter((t) => t.ends.some((e) => along(e) > 16 && along(e) < 50)).length;

  for (const [name, plan] of [
    ["显式 route=into_tube", checkPlanSchema(JSON.parse(JSON.stringify(mk("in", "into_tube"))))],
    ["方向写反（试管口→导管，单端+加热+固体无棉花）", checkPlanSchema(JSON.parse(JSON.stringify(mk("out"))))],
  ] as const) {
    if (!("plan" in plan)) {
      check(`H2/CuO 计划通过 L1（${name}）`, false);
      continue;
    }
    const svg = renderPlan(plan.plan, cfg.registries.chemistry);
    check(`导管伸到管内固体上方（${name}）`, tipsInTube(svg) === 1, `tips=${tipsInTube(svg)}`);
    check(`H2/CuO 渲染合法（${name}）`, svgStructurallyOk(svg) && !/NaN|undefined/.test(svg));
  }

  // 发生装置（管口塞棉花 = 防粉末进导管）：导管是"引出"，必须停在管口外，不能被当成进气伸进去
  const gen = checkPlanSchema(
    JSON.parse(
      JSON.stringify(
        mkPlan(
          [
            { id: "st1", type: "stand", label: "铁架台", relative_position: "left_center", interface: ["clamp"] },
            { id: "tt1", type: "test_tube", label: "试管", relative_position: "center", params: { solid_chunks: true, tilted: "down", has_cotton: true }, interface: ["mouth_open"] },
            { id: "bu1", type: "burner", label: "酒精灯", relative_position: "center_bottom", interface: [] },
            { id: "tu1", type: "tube", label: "导管", relative_position: "right_center", interface: ["left_end"] },
          ],
          [
            { from: "st1.clamp", to: "tt1.mouth_open", style: "dashed", note: "固定" },
            { from: "tt1.mouth_open", to: "tu1.left_end", style: "straight", note: "出气" },
          ],
          { stand: 1, test_tube: 1, burner: 1, tube: 1 },
        ),
      ),
    ),
  );
  if ("plan" in gen) {
    const svg = renderPlan(gen.plan, cfg.registries.chemistry);
    const ends = rotatedTubeEnds(svg).flatMap((t) => t.ends);
    check("发生装置（有棉花）的导管仍停在管口外", ends.length > 0 && ends.every((e) => along(e) > 88), ends.map((e) => along(e).toFixed(1)).join(","));
  } else {
    check("发生装置计划通过 L1", false);
  }
}

// 16. 图库模板库（config/diagram/atlas/plans.json）：教材常用装置固化成标准 plan，
//     每条都要能过结构校验、零 fatal、渲染出合法 SVG——模板是"可执行资料"，不是文档。
{
  const { readFileSync } = await import("fs");
  const tpl = JSON.parse(readFileSync("config/diagram/atlas/plans.json", "utf8")).templates as Array<{
    id: string;
    name: string;
    plan: unknown;
  }>;
  check("图库模板不少于 8 条", tpl.length >= 8, `${tpl.length} 条`);
  for (const t of tpl) {
    const r = checkPlanSchema(JSON.parse(JSON.stringify(t.plan)));
    if (!("plan" in r)) {
      check(`模板 ${t.id} 通过 L1`, false, r.errors.map((e) => e.message).join(";"));
      continue;
    }
    const errs = validatePlan(r.plan, cfg.registries.chemistry, cfg.rules.chemistry).filter((e) => e.fatal);
    check(`模板 ${t.id} 零 fatal`, errs.length === 0, errs.map((e) => e.code + ":" + e.message).join(";"));
    check(`模板 ${t.id} 渲染合法`, svgStructurallyOk(renderPlan(r.plan, cfg.registries.chemistry)));
  }
}

// 17. 补全器材（过滤/蒸发/量取/洗气/蒸馏）：19 类新器材都要能渲染，
//     而且"颈件插进容器口""管路件坐在瓶口""接收瓶对出口"这几条装配必须真的生效——
//     新器材只进注册表不写渲染，图上就是一个圆角框；只写渲染不装配，图上就是一堆零件各站一格。
{
  const NEW_TYPES = [
    "funnel", "thermometer", "evaporating_dish", "crucible", "cylinder", "volumetric_flask",
    "distilling_flask", "hard_glass_tube", "u_tube", "drying_tube", "condenser", "distillation_head",
    "balance", "tripod", "clay_triangle", "watch_glass", "petri_dish", "copper_plate", "stopper",
  ];
  const missing = NEW_TYPES.filter((t) => !chem.types[t]);
  check("注册表补齐 19 类教学器材", missing.length === 0, missing.join(","));

  const badRender: string[] = [];
  for (const t of NEW_TYPES) {
    const r = checkPlanSchema(
      mkPlan([{ id: `${t}_1`, type: t, label: t, relative_position: "center", interface: [] }], [], { [t]: 1 }),
    );
    if (!("plan" in r) || !svgStructurallyOk(renderPlan(r.plan, cfg.registries.chemistry))) badRender.push(t);
  }
  check("19 类新器材均渲染合法", badRender.length === 0, badRender.join(","));

  // 17a. 过滤：漏斗必须架到烧杯口正上方、颈伸进杯口内（不是停在上方）
  const fil = checkPlanSchema(
    mkPlan(
      [
        { id: "f1", type: "funnel", label: "漏斗", relative_position: "center", params: { has_filter_paper: true }, interface: ["top_open", "stem_bottom"] },
        { id: "b1", type: "beaker", label: "烧杯", relative_position: "center_bottom", params: { liquid_level: 0.3 }, interface: ["top_open", "liquid_inside"] },
        { id: "r1", type: "glass_rod", label: "玻璃棒", relative_position: "right_top", interface: ["top", "bottom"] },
      ],
      [
        { from: "f1.stem_bottom", to: "b1.top_open", style: "straight", note: "漏斗颈靠烧杯内壁" },
        { from: "r1.bottom", to: "f1.top_open", style: "straight", note: "玻璃棒引流" },
      ],
      { funnel: 1, beaker: 1, glass_rod: 1 },
    ),
  );
  if ("plan" in fil) {
    const svg = renderPlan(fil.plan, cfg.registries.chemistry);
    // 漏斗轮廓：水平顶边 → 斜边收到颈 → 竖颈到底；第 6 个捕获组就是颈底 y
    const fm = svg.match(/M ([\d.]+) ([\d.]+) L ([\d.]+) \2 L ([\d.]+) ([\d.]+) L \4 ([\d.]+)/);
    const beakerMouthY = 255 - 100 / 2; // 烧杯在 center_bottom，h=100 → 口沿 205
    check(
      "漏斗颈伸进烧杯口内",
      !!fm && Number(fm[6]) > beakerMouthY && Number(fm[6]) < beakerMouthY + 22,
      fm ? `颈底 y=${fm[6]}` : "未匹配到漏斗轮廓",
    );
    check("漏斗与烧杯同心", !!fm && Math.abs((Number(fm[1]) + Number(fm[3])) / 2 - 240) < 1.5, fm?.[1]);
    check("漏斗带滤纸", svg.includes('stroke-dasharray="3 2"'));
  } else {
    check("过滤计划通过 L1", false);
  }

  // 17b. 蒸馏：蒸馏头坐在烧瓶口、温度计水银球在蒸馏头内（支管口高度）、冷凝管贴着斜口
  const dist = checkPlanSchema(
    mkPlan(
      [
        { id: "fl1", type: "distilling_flask", label: "蒸馏烧瓶", relative_position: "center_bottom", params: { liquid_level: 0.5 }, interface: ["top_open", "side_out", "bottom"] },
        { id: "hd1", type: "distillation_head", label: "蒸馏头", relative_position: "left_center", interface: ["bottom_in", "top_out", "slant_out"] },
        { id: "th1", type: "thermometer", label: "温度计", relative_position: "left_center", interface: ["top", "bulb"] },
        { id: "cd1", type: "condenser", label: "冷凝管", relative_position: "center", interface: ["in_left", "out_right"] },
        { id: "bk1", type: "beaker", label: "锥形瓶", relative_position: "right_bottom", params: { liquid_level: 0.3 }, interface: ["top_open"] },
        { id: "bn1", type: "burner", label: "酒精灯", relative_position: "bottom_center", interface: ["flame"] },
      ],
      [
        { from: "bn1.flame", to: "fl1.bottom", style: "straight", note: "加热" },
        { from: "fl1.top_open", to: "hd1.bottom_in", style: "straight", note: "装蒸馏头" },
        { from: "th1.bulb", to: "hd1.top_out", style: "straight", note: "温度计水银球在支管口" },
        { from: "hd1.slant_out", to: "cd1.in_left", style: "straight", note: "蒸气进冷凝管" },
        { from: "cd1.out_right", to: "bk1.top_open", style: "straight", note: "馏出液流入接收瓶" },
      ],
      { distilling_flask: 1, distillation_head: 1, thermometer: 1, condenser: 1, beaker: 1, burner: 1 },
    ),
  );
  if ("plan" in dist) {
    const errs = validatePlan(dist.plan, cfg.registries.chemistry, cfg.rules.chemistry).filter((e) => e.fatal);
    check("蒸馏计划零 fatal", errs.length === 0, errs.map((e) => e.code).join(";"));
    const svg = renderPlan(dist.plan, cfg.registries.chemistry);
    // 温度计球泡（唯一的红色圆）：必须落在蒸馏头竖直段内、也就是支管口高度
    const bulb = svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="[\d.]+" fill="#b91c1c"/);
    check("温度计水银球在蒸馏头内（支管口高度）", !!bulb && Number(bulb[2]) > 160 && Number(bulb[2]) < 200, bulb?.[2]);
    check("水银球与烧瓶同轴", !!bulb && Math.abs(Number(bulb[1]) - 240) < 1.5, bulb?.[1]);
    // 蒸馏头竖直段：粗管 `<path d="M 240 267 L 240 151"`（宽 13）
    check("蒸馏头坐在烧瓶口上", svg.includes('stroke-width="13"'));
    check("冷凝管接在斜口右侧", svg.includes('stroke-width="8"') && svg.includes('stroke-width="6"'));
  } else {
    check("蒸馏计划通过 L1", false);
  }

  // 17c. 规则：漏斗没放滤纸要被拦下；孤立的温度计/干燥管要被判为孤立装置
  check(
    "检出未放滤纸 FILTER_PAPER",
    fatalCodes(
      mkPlan(
        [
          { id: "f1", type: "funnel", label: "漏斗", relative_position: "center", interface: ["top_open", "stem_bottom"] },
          { id: "b1", type: "beaker", label: "烧杯", relative_position: "center_bottom", params: { liquid_level: 0.3 }, interface: ["top_open", "liquid_inside"] },
        ],
        [{ from: "f1.stem_bottom", to: "b1.top_open", style: "straight", note: "引流" }],
        { funnel: 1, beaker: 1 },
      ),
    ).includes("FILTER_PAPER"),
  );
  check(
    "检出孤立温度计 ORPHAN_DEVICE",
    fatalCodes(
      mkPlan(
        [
          { id: "th1", type: "thermometer", label: "温度计", relative_position: "left_center", interface: ["top", "bulb"] },
          { id: "b1", type: "beaker", label: "烧杯", relative_position: "center", params: { liquid_level: 0.4 }, interface: ["top_open", "liquid_inside"] },
          { id: "bn1", type: "burner", label: "酒精灯", relative_position: "center_bottom", interface: ["flame"] },
        ],
        [{ from: "bn1.flame", to: "b1.bottom", style: "straight", note: "加热" }],
        { thermometer: 1, beaker: 1, burner: 1 },
      ),
    ).includes("ORPHAN_DEVICE"),
  );
}

// 18. 教材图库：清单完整、图片文件真实存在、正文引用能被正确替换
{
  const atlas = loadAtlas();
  const items = atlas.items;
  check("图库清单非空", items.length >= 30, `${items.length} 条`);
  check("图库 id 无重复", new Set(items.map((i) => i.id)).size === items.length);

  // 每条记录都必须指向一张真实存在的 png——清单写了名字、文件却没落地，等于给学生一个裂图
  const missing = items.filter((it) => !existsSync(path.join(process.cwd(), "public", "atlas", it.file)));
  check("图库图片文件都存在", missing.length === 0, missing.map((m) => m.file).join(","));

  check(
    "成套装置都写了装配要点",
    items.filter((i) => i.kind === "setup").every((i) => i.assembly.trim().length >= 8),
  );
  check("反例图都带了警示说明", items.filter((i) => i.kind === "wrong").every((i) => !!i.note));

  // 正文替换：正常引用 → 规范化 JSON，src 落在站内 /atlas/
  const ok = processFigureBlocks("看图：\n```figure atlas-110\n```\n这张图说明……");
  const m = ok.content.match(/```figure\n(\{[\s\S]*?\})\n```/);
  const payload = m ? (JSON.parse(m[1]) as { src: string; name: string; kind: string }) : null;
  check("figure 围栏替换为图卡片 JSON", !!payload && payload.src === "/atlas/p5-110.png", payload?.src);
  check("figure 替换后保留正文", ok.content.includes("这张图说明") && ok.used.includes("atlas-110"));

  // 模型编造 id → 整块删掉，不留裂图
  const bad = processFigureBlocks("前文\n```figure atlas-999\n```\n后文");
  check("未知 id 的图块被丢弃", !bad.content.includes("figure") && bad.content.includes("前文") && bad.used.length === 0);

  // 裸 id 带尾巴（模型常写成 "atlas-123 加热高锰酸钾"）也要认得
  const tail = processFigureBlocks("```figure atlas-123 加热高锰酸钾制氧气\n```");
  check("带尾巴的 id 能解析", tail.used.includes("atlas-123"));

  // 提示词里必须有清单和优先级铁律，否则模型根本不知道有原图可用
  const figSection = buildFigurePromptSection();
  check(
    "提示词含图库清单与优先级铁律",
    figSection.includes("atlas-110") && figSection.includes("atlas-123") && figSection.includes("一律引用原图"),
    `${figSection.length} 字符`,
  );
}

// 19. plan 失败时的反向兜底：从图库反查同一个实验的原图顶上，且绝不给错图
{
  const planOf = (devices: unknown[], connections: unknown[], counts: Record<string, number>, subject = "chemistry") => ({
    subject,
    canvas_hint: "two_column",
    devices,
    connections,
    expected_counts: counts,
  });
  const figOf = (hit: { block: string } | null) => {
    if (!hit) return null;
    const m = hit.block.match(/```figure\n(\{[\s\S]*?\})\n```/);
    return m ? (JSON.parse(m[1]) as { id: string; name: string; src: string; kind: string }) : null;
  };
  const atlasItems = loadAtlas().items;

  // 长颈漏斗只接了瓶口（没伸进液面）→ LIQUID_SEAL 致命，引擎画不出；主题点名了实验，应换成教材原图
  const co2Broken = planOf(
    [
      { id: "f1", type: "long_neck_funnel", label: "长颈漏斗", relative_position: "left_top", interface: ["top_open", "bottom_out"] },
      { id: "b1", type: "bottle", label: "锥形瓶", relative_position: "left_center", params: { liquid_level: 0.5 }, interface: ["top_open", "side_out"] },
      { id: "t1", type: "tube", label: "导管", relative_position: "center_top", interface: ["left_end", "right_end"] },
      { id: "j1", type: "gas_jar", label: "集气瓶", relative_position: "right_center", params: { has_glass_plate: true }, interface: ["bottom_in", "top_open"] },
    ],
    [
      { from: "f1.top_open", to: "b1.top_open", style: "straight" },
      { from: "t1.left_end", to: "b1.side_out", style: "straight" },
      { from: "t1.right_end", to: "j1.bottom_in", style: "straight" },
    ],
    { long_neck_funnel: 1, bottle: 1, tube: 1, gas_jar: 1 },
  );
  const co2Hit = planFallbackFigure(JSON.stringify(co2Broken), "实验室制取二氧化碳（向上排空气法）");
  const co2Fig = figOf(co2Hit);
  check("坏 plan 反查到制 CO₂ 原图", co2Hit?.id === "atlas-110", `${co2Hit?.id ?? "无"} | ${co2Hit?.why ?? ""}`);
  check("兜底产物是可直接渲染的 figure 卡片", !!co2Fig && co2Fig.src === "/atlas/p5-110.png" && co2Fig.kind === "setup", co2Fig?.src);

  // 加热高锰酸钾制氧气（试管没倾斜 + 导管从管壁穿出）→ 换成排水法制氧原图
  const o2Broken = planOf(
    [
      { id: "s1", type: "stand", label: "铁架台", relative_position: "center", interface: ["clamp"] },
      { id: "tt1", type: "test_tube", label: "试管", relative_position: "center", params: { tilted: "none" }, interface: ["mouth_open", "side_right_out"] },
      { id: "bn1", type: "burner", label: "酒精灯", relative_position: "center_bottom", interface: ["flame"] },
      { id: "tu1", type: "tube", label: "导管", relative_position: "right_top", interface: ["left_end", "right_end"] },
      { id: "tr1", type: "trough", label: "水槽", relative_position: "right_bottom", params: { liquid_level: 0.7 }, interface: ["liquid_inside"] },
      { id: "j1", type: "gas_jar", label: "集气瓶", relative_position: "right_bottom", params: { inverted: true }, interface: ["top_in"] },
    ],
    [
      { from: "bn1.flame", to: "tt1.mouth_open", style: "straight" },
      { from: "tu1.left_end", to: "tt1.side_right_out", style: "straight" },
      { from: "tu1.right_end", to: "j1.top_in", style: "straight" },
      { from: "j1.top_in", to: "tr1.liquid_inside", style: "straight" },
    ],
    { stand: 1, test_tube: 1, burner: 1, tube: 1, trough: 1, gas_jar: 1 },
  );
  const o2Hit = planFallbackFigure(JSON.stringify(o2Broken), "加热高锰酸钾制氧气（排水法收集）");
  check("坏 plan 反查到排水法制氧原图", o2Hit?.id === "atlas-123", `${o2Hit?.id ?? "无"} | ${o2Hit?.why ?? ""}`);

  // 图库覆盖不到的实验（蒸发结晶）→ 必须返回 null（宁缺不留错图）
  const saltBroken = planOf(
    [
      { id: "ed1", type: "evaporating_dish", label: "蒸发皿", relative_position: "center", interface: ["top_open"] },
      { id: "gr1", type: "glass_rod", label: "玻璃棒", relative_position: "right_top", interface: ["end_1"] },
      { id: "bn1", type: "burner", label: "酒精灯", relative_position: "center_bottom", interface: ["flame"] },
    ],
    [],
    { evaporating_dish: 1, glass_rod: 1, burner: 1 },
  );
  check("图库没有的实验不硬凑", planFallbackFigure(JSON.stringify(saltBroken), "粗盐提纯（蒸发结晶）") === null);

  // 图库只覆盖化学/物理；其它学科（生物/地理/通用）的计划即使坏掉也不兜底
  const bioBroken = planOf([{ id: "m1", type: "microscope", label: "显微镜", relative_position: "center", interface: [] }], [], { m: 1 }, "biology");
  check("非图库学科不参与兜底", planFallbackFigure(JSON.stringify(bioBroken), "观察洋葱表皮细胞") === null);

  // JSON 坏掉也不能白瞎：主题里的实验名仍能救回来
  check("plan JSON 坏掉时靠主题兜底", planFallbackFigure("{ 这不是 json", "实验室制取二氧化碳")?.id === "atlas-110");

  // 排空气法的计划绝不能配上排水法的图（差一个水槽就是两种收集方法）
  const upAir = planOf(
    [
      { id: "b1", type: "bottle", label: "锥形瓶", relative_position: "left_center", interface: ["top_open", "side_out"] },
      { id: "t1", type: "tube", label: "导管", relative_position: "center_top", interface: ["left_end", "right_end"] },
      { id: "j1", type: "gas_jar", label: "集气瓶", relative_position: "right_center", params: { has_glass_plate: true }, interface: ["bottom_in", "top_open"] },
      { id: "gp1", type: "glass_plate", label: "玻璃片", relative_position: "right_top", interface: [] },
    ],
    [],
    { bottle: 1, tube: 1, gas_jar: 1, glass_plate: 1 },
  );
  const upAirHit = planFallbackFigure(JSON.stringify(upAir), "二氧化碳的实验室制法");
  const upAirItem = upAirHit ? atlasItems.find((i) => i.id === upAirHit.id) : undefined;
  check(
    "排空气法不会配上排水法的图",
    !!upAirItem && !upAirItem.devices.includes("水槽"),
    `${upAirItem?.id ?? "无"} ${upAirItem?.devices.join("/") ?? ""}`,
  );

  // 反例图永远不参与兜底（那是要学生找错的图，顶上去等于把错装置当正解）
  const wrongHits = atlasItems
    .filter((i) => i.kind === "wrong")
    .map((i) => planFallbackFigure("", i.name))
    .filter((h) => h && atlasItems.find((i) => i.id === h!.id)?.kind === "wrong");
  check("反例图不会被当成正解顶上", wrongHits.length === 0, `${wrongHits.length} 次误用`);

  // 同一节课已经用过这张图时，别再顶第二张一样的
  const again = planFallbackFigure(JSON.stringify(o2Broken), "加热高锰酸钾制氧气", ["atlas-123"]);
  check("已用过的图不重复顶", again?.id !== "atlas-123", again?.id ?? "无");

  // 走完整管道：坏计划不许留 plan 围栏，产物只能是 svg 或 figure（或两者都没有），绝不能是代码块
  const badLesson2 = `装置如下：\n\n\`\`\`plan\n${JSON.stringify(co2Broken)}\n\`\`\`\n\n注意液封。`;
  const out2 = await processPlanBlocks(badLesson2, { topic: "实验室制取二氧化碳（向上排空气法）" });
  check("坏计划不留 plan 围栏", !out2.includes("```plan"));
  check(
    "坏计划的图只能是引擎图或教材原图",
    (out2.match(/```svg/g) ?? []).length + (out2.match(/```figure/g) ?? []).length <= 1 && out2.includes("注意液封"),
  );
  if (out2.includes("```figure")) {
    check("管道里顶上的图是站内 atlas 路径", /"src":"\/atlas\/[\w.-]+\.png"/.test(out2));
  }
}

// 20. 正向收紧：plan 画得出来，但主题点名的就是图库里那台标准装置 → 直接换教材原图
{
  const figOf = (text: string) => {
    const m = text.match(/```figure\n(\{[\s\S]*?\})\n```/);
    return m ? (JSON.parse(m[1]) as { id: string; src: string }) : null;
  };
  const o2Plan = {
    subject: "chemistry",
    canvas_hint: "two_column",
    devices: [
      { id: "s1", type: "stand", label: "铁架台", relative_position: "center", interface: ["clamp"] },
      { id: "tt1", type: "test_tube", label: "试管", relative_position: "center", params: { tilted: "down", has_cotton: true }, interface: ["mouth_open"] },
      { id: "bn1", type: "burner", label: "酒精灯", relative_position: "center_bottom", interface: ["flame"] },
      { id: "tu1", type: "tube", label: "导管", relative_position: "right_top", interface: ["left_end", "right_end"] },
      { id: "tr1", type: "trough", label: "水槽", relative_position: "right_bottom", params: { liquid_level: 0.7 }, interface: ["liquid_inside"] },
      { id: "j1", type: "gas_jar", label: "集气瓶", relative_position: "right_bottom", params: { inverted: true }, interface: ["top_in"] },
    ],
    connections: [
      { from: "bn1.flame", to: "tt1.mouth_open", style: "straight" },
      { from: "tu1.left_end", to: "tt1.mouth_open", style: "straight" },
      { from: "tu1.right_end", to: "j1.top_in", style: "straight" },
      { from: "j1.top_in", to: "tr1.liquid_inside", style: "straight" },
    ],
    expected_counts: { stand: 1, test_tube: 1, burner: 1, tube: 1, trough: 1, gas_jar: 1 },
  };
  const o2Lesson = (topic: string) =>
    `装置如下：\n\n\`\`\`plan\n${JSON.stringify(o2Plan)}\n\`\`\`\n\n注意管口方向。`;

  const o2Out = await processPlanBlocks(o2Lesson("加热高锰酸钾制氧气（排水法收集）"), {
    topic: "加热高锰酸钾制氧气（排水法收集）",
  });
  check("标准装置计划被换成教材原图", figOf(o2Out)?.id === "atlas-123", figOf(o2Out)?.id ?? "未换");
  check("换成原图后不再留 svg 块", !o2Out.includes("```svg"));

  // 讲"不塞棉花会怎样"时，计划里是刻意不塞——不能被标准图顶掉
  const variantPlan = {
    ...o2Plan,
    devices: o2Plan.devices.map((d) => (d.id === "tt1" ? { ...d, params: { tilted: "down", has_cotton: false } } : d)),
  };
  const variantOut = await processPlanBlocks(
    `装置如下：\n\n\`\`\`plan\n${JSON.stringify(variantPlan)}\n\`\`\`\n\n这里故意不塞棉花。`,
    { topic: "加热高锰酸钾制氧气（排水法收集）" },
  );
  check("计划带变体参数时保留引擎图", !variantOut.includes("```figure") && variantOut.includes("```svg"));

  // 讲错例的段落一律不换
  const wrongTopic = await processPlanBlocks(o2Lesson("制取氧气的常见错误装置（反例辨析）"), {
    topic: "制取氧气的常见错误装置（反例辨析）",
  });
  check("反例段落不换标准图", !wrongTopic.includes("```figure") && wrongTopic.includes("```svg"));

  // 同一节里两个同类 plan：第二张不能再顶同一张图
  const twice = await processPlanBlocks(
    `两个角度：\n\n\`\`\`plan\n${JSON.stringify(o2Plan)}\n\`\`\`\n\n换个角度看：\n\n\`\`\`plan\n${JSON.stringify(o2Plan)}\n\`\`\``,
    { topic: "加热高锰酸钾制氧气（排水法收集）" },
  );
  const ids = [...twice.matchAll(/"id":"(atlas-\d{3})"/g)].map((m) => m[1]);
  check("同一节不重复用同一张图", ids.length === 2 && ids[0] !== ids[1], ids.join(","));

  // 非化学学科不参与
  const physOut = await processPlanBlocks(
    `电路：\n\n\`\`\`plan\n${JSON.stringify({ ...o2Plan, subject: "physics" })}\n\`\`\``,
    { topic: "加热高锰酸钾制氧气（排水法收集）" },
  );
  check("非化学计划不走图库", !physOut.includes("```figure") || physOut.includes("```svg"), "");
}

// 21. 正反例数据一致性：反例必须写明错在哪，正确装置不能带"错"字描述
{
  const items = loadAtlas().items;
  const wrongs = items.filter((i) => i.kind === "wrong");
  check("反例都写了错在哪", wrongs.every((i) => /错|不能|不可/.test(i.assembly)), wrongs.map((i) => i.id).join(","));
  check(
    "正确装置没被写成反例",
    items.filter((i) => i.kind !== "wrong").every((i) => !/错在|错误示范/.test(i.assembly)),
  );
  // 制氨气三方案：B 是正确装置，A（没加热）和 C（管口向上）是反例——这三张曾经整体标反过
  const byAlias = (a: string) => items.find((i) => i.aliases.includes(a));
  check("制氨气 B 标为正确装置", byAlias("制氨气B")?.kind === "setup", byAlias("制氨气B")?.name);
  check(
    "制氨气 A/C 标为反例",
    byAlias("制氨气A")?.kind === "wrong" && byAlias("制氨气C")?.kind === "wrong",
    `${byAlias("制氨气A")?.name} / ${byAlias("制氨气C")?.name}`,
  );
  // 反例图不能进"可选装置"清单，只能进反例清单
  const figSection = buildFigurePromptSection();
  const setupPart = figSection.split("反例图")[0];
  check("反例不进可选装置清单", !/atlas-032|atlas-034|atlas-118/.test(setupPart));
}

console.log(failed ? "\n有失败项 ❌" : "\n全部通过 ✅");
process.exit(failed ? 1 : 0);
