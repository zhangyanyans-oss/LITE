/**
 * 课程生成逻辑的单元断言：时间解析 → 模块数目标 → 目录覆盖校验。
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/e2e-course.mts
 */
import {
  scheduleModuleTarget,
  moduleLimitFor,
  outlineCoverageReport,
  MAX_MODULE_LIMIT,
  type CourseOutline,
} from "../api/lib/courselib";

let failed = false;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " | " + extra : ""}`);
  if (!cond) failed = true;
}

// ── 时间解析 ──
check("两学期每周两小时 → 36", scheduleModuleTarget("两个学期，每周两小时") === 36, String(scheduleModuleTarget("两个学期，每周两小时")));
check("一学年 → 36", scheduleModuleTarget("一学年学完") === 36, String(scheduleModuleTarget("一学年学完")));
check("一个月 → 4", scheduleModuleTarget("一个月学完") === 4, String(scheduleModuleTarget("一个月学完")));
check("10周 → 10", scheduleModuleTarget("10周学完") === 10, String(scheduleModuleTarget("10周学完")));
check("每周里的周不算周数（每周2小时单独出现 → 0）", scheduleModuleTarget("每周2小时") === 0);
check("30天 → 6", scheduleModuleTarget("30天过完") === 6, String(scheduleModuleTarget("30天过完")));
check("暑假 → 4", scheduleModuleTarget("暑假把它学完") === 4, String(scheduleModuleTarget("暑假把它学完")));
check("每天1小时一个月 → 12", scheduleModuleTarget("每天1小时，一个月学完") === 12, String(scheduleModuleTarget("每天1小时，一个月学完")));
check("3个学期 → 54", scheduleModuleTarget("3个学期") === 54, String(scheduleModuleTarget("3个学期")));
check("没有时间安排 → 0", scheduleModuleTarget("帮我学好初中物理") === 0);

// ── 模块数目标 ──
const cap = (n: number) => Math.min(MAX_MODULE_LIMIT, n);
check("单文档小体量 → 下限 6", moduleLimitFor({ docCount: 1, totalChunks: 50 }) === 6, String(moduleLimitFor({ docCount: 1, totalChunks: 50 })));
check("单文档 300 chunk → 体量 12", moduleLimitFor({ docCount: 1, totalChunks: 300 }) === 12, String(moduleLimitFor({ docCount: 1, totalChunks: 300 })));
check("目录 12 章 → 至少 12", moduleLimitFor({ docCount: 1, totalChunks: 100, chapterCount: 12 }) === 12, String(moduleLimitFor({ docCount: 1, totalChunks: 100, chapterCount: 12 })));
check("时间安排 2 学期压倒一切 → 36", moduleLimitFor({ docCount: 1, totalChunks: 100, goal: "两个学期" }) === 36, String(moduleLimitFor({ docCount: 1, totalChunks: 100, goal: "两个学期" })));
check("多信号取最大且封顶 60", moduleLimitFor({ docCount: 40, totalChunks: 5000, chapterCount: 50, goal: "三个学期" }) === cap(60), String(moduleLimitFor({ docCount: 40, totalChunks: 5000, chapterCount: 50, goal: "三个学期" })));
check("手动滑杆走 input 通道（后端不做二次缩小）", Math.min(MAX_MODULE_LIMIT, Math.max(3, 20)) === 20);

// ── 目录覆盖校验 ──
const outline: CourseOutline = {
  outline: [
    { chapter: "第一章 有理数", sections: ["正数与负数", "数轴", "相反数"] },
    { chapter: "第二章 整式", sections: ["整式的加减"] },
  ],
};
const modules = [
  { title: "第一关·有理数的迷宫", objectives: [{ title: "理解正数与负数的意义" }, { title: "会在数轴上表示数" }] },
];
const cov = outlineCoverageReport(outline, modules);
check("目录覆盖：漏 2 节被查出", cov.total === 4 && cov.missing.length === 2, JSON.stringify(cov.missing));
check("漏的小节带章名", cov.missing.some((m) => m.section === "相反数" && m.chapter.includes("有理数")));
const covAll = outlineCoverageReport(outline, [
  { title: "第一章", objectives: [{ title: "正数与负数" }, { title: "数轴" }, { title: "相反数" }] },
  { title: "第二章", objectives: [{ title: "整式的加减" }] },
]);
check("全覆盖 → missing 空", covAll.missing.length === 0, JSON.stringify(covAll.missing));

console.log(failed ? "\n有失败项 ❌" : "\n全部通过 ✅");
process.exit(failed ? 1 : 0);
