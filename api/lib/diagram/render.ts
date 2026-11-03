/**
 * 布局引擎：把校验通过的布局计划确定性地渲染成 SVG。
 * 相对位置 → 12 宫格坐标 → 装置符号 + 连接线。无随机、无模型参与，同一计划必出同一张图。
 * 产出的 SVG 保证通过前端的 svgStructurallyOk（单根、有 viewBox、无脚本/外链/坏数值）。
 *
 * 图层顺序（自下而上）：器皿 → 连接线 → 插入件（漏斗/导管/铁架台） → 图注。
 * 这样"伸进瓶里的漏斗颈/导管"不会被器皿的白底盖住，管线也不会被瓶身吃掉。
 */
import type { Device, DeviceTypeDef, LayoutPlan, Pos, RegistryFile } from "./config";
import { POS_GRID } from "./validate";
import { VESSEL_PROFILES } from "./profiles";

const W = 480;
const H = 360;
const COL_X = [95, 240, 385];
const ROW_Y = [75, 165, 255, 322];

const INK = "#222";
const ACCENT = "#b91c1c";
const TEXT = "#333";
const FLUID = "#0284c7"; // 水面线
const FLUID_FILL = "#7dd3fc"; // 水体填充（半透明）

/** 波浪水面：在宽度 w 内画 4 个平滑波峰 */
function wavePath(x: number, y: number, w: number): string {
  const seg = w / 4;
  return `M ${num(x)} ${num(y)} q ${num(seg / 2)} -3 ${num(seg)} 0 t ${num(seg)} 0 t ${num(seg)} 0 t ${num(seg)} 0`;
}

/** 流体与微观粒子（模型只给 params.liquid_level/particles 语义，图形由引擎确定性生成） */
function fluidLayer(p: Placed): string {
  const { d, cx, cy, w, h } = p;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const level = d.params?.liquid_level;
  let out = "";
  if (level != null) {
    const fy = y + h * (1 - level); // 液面 y：level 越大液面越高
    out +=
      `<path d="${wavePath(x + 2, fy, w - 4)}" fill="none" stroke="${FLUID}" stroke-width="1.5"/>` +
      `<path d="${wavePath(x + 2, fy, w - 4)} L ${num(x + w - 2)} ${num(y + h - 1)} L ${num(x + 2)} ${num(y + h - 1)} Z" fill="${FLUID_FILL}" fill-opacity="0.35" stroke="none"/>`;
  }
  if (d.params?.particles === "bubbles") {
    const fy = level != null ? y + h * (1 - level) : y + h * 0.4;
    const bubbles: Array<[number, number, number]> = [
      [cx - w * 0.18, fy + h * 0.12, 2.6],
      [cx + w * 0.05, fy + h * 0.2, 2],
      [cx + w * 0.2, fy + h * 0.08, 2.2],
      [cx - w * 0.05, fy + h * 0.28, 1.8],
    ];
    for (const [bx, by, r] of bubbles) {
      out += `<circle cx="${num(bx)}" cy="${num(Math.min(by, y + h - 4))}" r="${r}" fill="none" stroke="${FLUID}" stroke-width="1"/>`;
    }
  }
  return out;
}

/** 固体药品（params.solid_chunks）：容器底部两三块灰色小块 */
function solidChunks(p: Placed): string {
  if (!p.d.params?.solid_chunks) return "";
  const { cx, w, h } = p;
  const y = p.cy - h / 2;
  const baseY = y + h - 10;
  return (
    `<rect x="${num(cx - w * 0.3)}" y="${num(baseY - 7)}" width="${num(w * 0.26)}" height="8" rx="2.5" fill="#a3a3a3" fill-opacity="0.75" stroke="${INK}" stroke-width="1"/>` +
    `<rect x="${num(cx + w * 0.02)}" y="${num(baseY - 6)}" width="${num(w * 0.22)}" height="7" rx="2.5" fill="#a3a3a3" fill-opacity="0.6" stroke="${INK}" stroke-width="1"/>` +
    `<rect x="${num(cx - w * 0.08)}" y="${num(baseY - 13)}" width="${num(w * 0.18)}" height="6" rx="2.5" fill="#a3a3a3" fill-opacity="0.5" stroke="${INK}" stroke-width="1"/>`
  );
}

/** 器皿类型 → 轮廓库 key（轮廓提取自 tongjiang-lab 3D 课件的车削剖面） */
const PROFILE_OF: Record<string, string> = {
  beaker: "beaker",
  bottle: "reagent_bottle",
  flask: "flask",
  trough: "trough",
  separating_funnel: "separatory_funnel",
  test_tube: "test_tube",
  gas_jar: "gas_jar",
  evaporating_dish: "evaporating_dish",
  crucible: "crucible",
  cylinder: "cylinder",
  volumetric_flask: "volumetric_flask",
  distilling_flask: "distilling_flask",
  watch_glass: "watch_glass",
  petri_dish: "petri_dish",
};

/** 插入件：画在连接线之上，"伸进去"的那截才看得见（不能当器皿先用白底盖住管线） */
const INSTRUMENT = new Set([
  "long_neck_funnel",
  "separating_funnel",
  "inverted_funnel",
  "tube",
  "glass_rod",
  "funnel",
  "thermometer",
  "condenser",
  "distillation_head",
]);

/**
 * 玻璃管：黑轮廓 + 白芯双描边。管件（U 形管/干燥管/冷凝管内管/蒸馏头）用它画，
 * 比"两条平行线 + 圆端"省事，端点平头正好是敞开的管口。
 */
function glassPipe(d: string, width = 8): string {
  return (
    `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${num(width)}" stroke-linecap="butt" stroke-linejoin="round"/>` +
    `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="${num(Math.max(1.6, width - 3.4))}" stroke-linecap="butt" stroke-linejoin="round"/>`
  );
}

/**
 * 轮廓适配包围盒生成 path：outline（y 向上）→ SVG（y 向下）；flip=true 时口朝下（倒扣）。
 * 不假设轮廓已归一化，按实际点集包围盒适配（水槽剖面的 y 范围就不是 0~1）。
 *
 * 器皿分两种口部：outline 首尾同点（烧杯/水槽：轮廓里已经画过口沿横线）→ 闭合；
 * 首尾同高但分居两侧（试管/集气瓶/烧瓶：口沿两端）→ 闭合会凭空补一条横线，器皿看起来像封口的胶囊。
 * 所以描边路径不闭合，让口真的敞开；填充仍用闭合路径，遮挡关系不变。
 */
function profilePaths(
  key: string,
  x: number,
  y: number,
  w: number,
  h: number,
  flip = false,
): { fill: string; stroke: string } | null {
  const prof = VESSEL_PROFILES[key];
  if (!prof || prof.outline.length < 3) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [ox, oy] of prof.outline) {
    if (ox < minX) minX = ox;
    if (ox > maxX) maxX = ox;
    if (oy < minY) minY = oy;
    if (oy > maxY) maxY = oy;
  }
  const sx = w / (maxX - minX || 1);
  const sy = h / (maxY - minY || 1);
  const pts = prof.outline.map(([ox, oy]) => {
    const px = x + (ox - minX) * sx;
    const py = flip ? y + (oy - minY) * sy : y + (maxY - oy) * sy;
    return `${num(px)} ${num(py)}`;
  });
  const fill = `M ${pts.join(" L ")} Z`;
  const first = prof.outline[0];
  const last = prof.outline[prof.outline.length - 1];
  const openMouth = Math.abs(first[1] - last[1]) < 1e-6 && Math.abs(first[0] - last[0]) > 1e-6;
  return { fill, stroke: openMouth ? `M ${pts.join(" L ")}` : fill };
}

/** 器皿描边：填充一层（半透明白底，遮挡后方管线）+ 描边一层（开口器皿口部不封） */
function vesselMarkup(geo: { fill: string; stroke: string }, fillAttr: string, sw = 2): string {
  const body = fillAttr.includes("none") ? "" : `<path d="${geo.fill}"${fillAttr} stroke="none"/>`;
  return body + `<path d="${geo.stroke}" fill="none" stroke="${INK}" stroke-width="${sw}"/>`;
}

/** 液体/气泡按器皿轮廓裁剪：斜壁不外溢（倒扣集气瓶、梯形水槽的关键）；无液体参数时输出空串 */
function clippedFluid(p: Placed, dAttr: string): string {
  if (!dAttr) return "";
  if (p.d.params?.liquid_level == null && p.d.params?.particles !== "bubbles") return "";
  const id = `dg-clip-${p.d.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return `<clipPath id="${id}"><path d="${dAttr}"/></clipPath><g clip-path="url(#${id})">${fluidLayer(p)}</g>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function num(n: number): string {
  return String(Math.round(n * 10) / 10);
}

interface Placed {
  d: Device;
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** 铁架台的铁夹：夹口落在被夹装置左壁（armX, armY），夹臂从立柱伸过去 */
  clamp?: { armY: number; armX: number };
  /** 管口有东西穿过（漏斗/导管/电极/燃烧匙）→ 补一个橡皮塞 */
  stopper?: boolean;
  /** 漏斗颈要伸到的 y（连到容器 liquid_inside 时把颈管画到液面以下，"液封"才看得见） */
  neckTo?: number;
  /** 计算好的标签位置（避让过装置包围盒与其它标签） */
  labelAt?: { x: number; y: number; anchor: "middle" | "start" | "end" };
  /** 封盖（玻璃片/橡皮塞）上留给穿过件的孔：绝对 x 与孔宽 */
  hole?: { x1: number; x2: number };
  /** 导管从管口插进管内：塞子中间要开孔，导管才是"穿过塞子"而不是"盖在塞子上" */
  bore?: boolean;
  /** 该装置是否倒扣（任意器皿通用：口朝下） */
  inverted?: boolean;
  /** 倒扣浸在液面以下（排水法）：此时瓶口不盖玻璃片 */
  inWater?: boolean;
  /** 斜放角度（弧度）：单端导管吸附到装置口后沿这个方向伸出去 */
  angle?: number;
}

/** 倾斜试管的角度（管口向下 18°，绕左端/底部旋转） */
const TILT_RAD = (18 * Math.PI) / 180;

/**
 * 装置实际占的矩形（含倾斜/旋转）。
 * 之前一律用 cx±w/2、cy±h/2：倾斜 18° 的试管真实外框比这个高一截，
 * 标签就按"假包围盒"避让，结果正好压在试管身上。
 */
function bboxOf(p: Placed): { x1: number; y1: number; x2: number; y2: number } {
  if (p.d.params?.tilted === "down") {
    // 绕管底（左端）旋转：轴线两端 + 半径法向四个角
    const ax = p.cx - p.w / 2;
    const ay = p.cy;
    const ex = ax + p.w * Math.cos(TILT_RAD);
    const ey = ay + p.w * Math.sin(TILT_RAD);
    const nx = -Math.sin(TILT_RAD) * (p.h / 2);
    const ny = Math.cos(TILT_RAD) * (p.h / 2);
    return {
      x1: Math.min(ax + nx, ax - nx, ex + nx, ex - nx),
      y1: Math.min(ay + ny, ay - ny, ey + ny, ey - ny),
      x2: Math.max(ax + nx, ax - nx, ex + nx, ex - nx),
      y2: Math.max(ay + ny, ay - ny, ey + ny, ey - ny),
    };
  }
  if (p.angle) {
    const hw = (p.w / 2) * Math.abs(Math.cos(p.angle)) + (p.h / 2) * Math.abs(Math.sin(p.angle));
    const hh = (p.w / 2) * Math.abs(Math.sin(p.angle)) + (p.h / 2) * Math.abs(Math.cos(p.angle));
    return { x1: p.cx - hw, y1: p.cy - hh, x2: p.cx + hw, y2: p.cy + hh };
  }
  return { x1: p.cx - p.w / 2, y1: p.cy - p.h / 2, x2: p.cx + p.w / 2, y2: p.cy + p.h / 2 };
}

/** 倾斜试管的管口坐标：从水平左端绕左端点向下旋转 TILT_RAD */
function tiltedMouth(p: Placed): [number, number] {
  const px = p.cx - p.w / 2;
  return [px + p.w * Math.cos(TILT_RAD), p.cy + p.w * Math.sin(TILT_RAD)];
}

/** 接口锚点：优先用注册表里定义的包围盒相对坐标（如试管口在 {x:0.5,y:0}，而不是装置中心） */
function anchor(p: Placed, iface: string, registry: RegistryFile | undefined): [number, number] {
  // 倾斜试管的口部接口全部指向旋转后的管口（几何与 glyph 里的旋转一致）
  if (p.d.params?.tilted === "down" && /mouth_open|top_open|side_right_out/.test(iface)) return tiltedMouth(p);
  const pt = registry?.types[p.d.type]?.interfaces[iface];
  if (pt) {
    // 倒扣器皿的几何是上下翻转的，锚点必须跟着翻，否则"瓶口"还停在上方
    const ny = p.inverted ? 1 - pt.y : pt.y;
    return [p.cx - p.w / 2 + pt.x * p.w, p.cy - p.h / 2 + ny * p.h];
  }
  // 注册表没配坐标时的关键字兜底
  const s = iface.toLowerCase();
  if (/left|west/.test(s)) return [p.cx - p.w / 2, p.cy];
  if (/right|east/.test(s)) return [p.cx + p.w / 2, p.cy];
  if (/top|north|eyepiece|ring|hook$|top_open|top_hook|top_ring/.test(s)) return [p.cx, p.cy - p.h / 2];
  if (/bottom|south|bottom_out|bottom_in|bottom_hook/.test(s)) return [p.cx, p.cy + p.h / 2];
  return [p.cx, p.cy];
}

/**
 * 导管伸进试管内部：返回"管口外的接驳点"与"管内尖端"。
 * 还原金属氧化物（H2/CuO、CO/Fe2O3）这类装置，导管必须穿过管口塞子伸到固体药品上方——
 * 只画到管口等于气体一出来就跑了，图上也只是"贴在管口外的一根管子"。
 * 深度按固体位置定：固体铺在管底（0.07~0.18 管长处），尖端停在 0.34 管长处，正好在固体上方。
 */
function tubeBore(host: Placed, iface: string, registry: RegistryFile | undefined): { outer: Pt; tip: Pt } | null {
  if (host.inverted) return null;
  if (host.d.params?.tilted === "down") {
    // 管口朝右下倾斜：管轴方向 = 管底 → 管口，往里退就到管内
    const dx = Math.cos(TILT_RAD);
    const dy = Math.sin(TILT_RAD);
    const m = tiltedMouth(host);
    // 从管口往管内退 deep：管长 100 时退到 0.24w 处，正好压在管底固体（0.07~0.18w）上方
    const deep = Math.min(host.w * 0.76, Math.max(20, host.w - 26));
    return {
      tip: [m[0] - dx * deep, m[1] - dy * deep],
      outer: [m[0] + dx * 12, m[1] + dy * 12],
    };
  }
  const mouth = anchor(host, iface, registry);
  return {
    tip: [host.cx, host.cy - host.h / 2 + host.h * 0.62],
    outer: [mouth[0], mouth[1] - 12],
  };
}

/** 容器判定：接口里有开口/入口（top_open/bottom_in/liquid_inside）的装置视为容器，给半透明白底实现遮挡 */function isContainer(def: DeviceTypeDef | undefined): boolean {
  if (!def) return false;
  return Object.keys(def.interfaces).some((i) => /top_open|bottom_in|liquid_inside/.test(i));
}

/** 区间挖洞：封盖上要给穿过件留位置（玻璃片/塞子不该"凭空被管子穿过"） */
function subtractSpan(span: [number, number], hole?: { x1: number; x2: number }): Array<[number, number]> {
  if (!hole || hole.x2 <= span[0] || hole.x1 >= span[1]) return [span];
  const out: Array<[number, number]> = [];
  if (hole.x1 > span[0]) out.push([span[0], hole.x1]);
  if (hole.x2 < span[1]) out.push([hole.x2, span[1]]);
  return out;
}

/** 玻璃片：一条横条，中间有穿过件时断开 */
function plateBar(x1: number, x2: number, plateY: number, hole?: { x1: number; x2: number }): string {
  return subtractSpan([x1, x2], hole)
    .map(
      ([a, b]) =>
        `<rect x="${num(a)}" y="${num(plateY)}" width="${num(b - a)}" height="5" fill="#d4d4d4" fill-opacity="0.6" stroke="${INK}" stroke-width="1"/>`,
    )
    .join("");
}

/** 器口实际宽度：集气瓶是宽身短颈，塞子/玻璃片只能跟颈口等宽，不能按瓶身宽度铺 */
function mouthSpan(key: string, x: number, w: number): [number, number] {
  const prof = VESSEL_PROFILES[key];
  if (!prof || prof.outline.length < 2) return [x, x + w];
  const xs = prof.outline.map((o) => o[0]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const scale = w / (maxX - minX || 1);
  const a = x + (Math.min(prof.outline[0][0], prof.outline[prof.outline.length - 1][0]) - minX) * scale;
  const b = x + (Math.max(prof.outline[0][0], prof.outline[prof.outline.length - 1][0]) - minX) * scale;
  return b - a < w * 0.25 ? [x, x + w] : [a, b];
}

/** 橡皮塞：口部被漏斗/导管/电极穿过时补一块（双孔塞画成两条带子，管子从中间缺口压过去） */
function stopperBand(p: Placed): string {
  if (!p.stopper) return "";
  const { cx, cy, w, h } = p;
  const x = cx - w / 2;
  const pk = PROFILE_OF[p.d.type];
  const [mx1, mx2] = pk ? mouthSpan(pk, x, w) : [x, x + w];
  const half = (mx2 - mx1) / 2 + 2;
  const dir = p.inverted ? -1 : 1; // 塞子朝容器内部的方向
  const mouthY = cy - (dir * h) / 2;
  const yTop = mouthY - dir * 1;
  const yBot = mouthY + dir * 6;
  return subtractSpan([cx - half, cx + half], p.hole)
    .map(([a, b]) => {
      const ia = a === cx - half ? a + 1 : a;
      const ib = b === cx + half ? b - 1 : b;
      return `<path d="M ${num(a)} ${num(yBot)} L ${num(ia)} ${num(yTop)} L ${num(ib)} ${num(yTop)} L ${num(b)} ${num(yBot)} Z" fill="#e7e5e4" stroke="${INK}" stroke-width="1.2"/>`;
    })
    .join("");
}

/** 装置符号：玻璃器皿用提取的真实剖面轮廓（profiles.ts），少量内置模板（火焰/铁架台/漏斗/地图要素），其余为圆角框 + 中文标注 */
function glyph(p: Placed, def: DeviceTypeDef | undefined, plate: boolean): string {
  const { d, cx, cy, w, h } = p;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const lp = p.labelAt ?? { x: cx, y: cy + h / 2 + 14, anchor: "middle" as const };
  const label = `<text x="${num(lp.x)}" y="${num(lp.y)}" font-size="12" fill="${TEXT}" text-anchor="${lp.anchor}">${esc(d.label)}</text>`;
  const inv = p.inverted === true;
  const fluid = fluidLayer(p);
  // 容器给半透明白底：管线从后面经过时被自然遮挡（不穿模），进入内部的仍然可见
  const bodyFill = isContainer(def) ? ` fill="#ffffff" fill-opacity="0.8"` : ` fill="none"`;
  // 排空气法集气瓶：引擎自动补一块瓶口玻璃片（模型忘了画也不怕）；口部有穿过件时留孔
  const platePk = PROFILE_OF[d.type];
  const [plx1, plx2] = platePk ? mouthSpan(platePk, x, w) : [x, x + w];
  const plateSvg = plate ? plateBar(plx1 - 3, plx2 + 3, y - 5, p.hole) : "";
  switch (d.type) {
    case "long_neck_funnel": {
      // 长颈漏斗：上口宽锥 + 细长颈（颈长占 70%）；接到容器液面以下时，颈管直接画到液面附近。
      // 标签走统一的避让结果（原来硬写在锥口上方，漏斗顶到画布上沿时名字就被裁掉了）
      const bottomY = p.neckTo != null ? Math.max(p.neckTo, y + h * 0.6) : y + h;
      return (
        `<path d="M ${num(x)} ${num(y)} L ${num(x + w)} ${num(y)} L ${num(cx + w * 0.12)} ${num(y + h * 0.3)} L ${num(cx + w * 0.12)} ${num(bottomY)} L ${num(cx - w * 0.12)} ${num(bottomY)} L ${num(cx - w * 0.12)} ${num(y + h * 0.3)} Z" fill="none" stroke="${INK}" stroke-width="2"/>` +
        label
      );
    }
    case "solid_chunks": {
      // 固体药品：容器底部的两三块小灰块
      return (
        `<rect x="${num(x)}" y="${num(cy)}" width="${num(w * 0.45)}" height="${num(h * 0.7)}" rx="3" fill="#a3a3a3" fill-opacity="0.7" stroke="${INK}" stroke-width="1"/>` +
        `<rect x="${num(cx + w * 0.05)}" y="${num(cy + h * 0.15)}" width="${num(w * 0.4)}" height="${num(h * 0.6)}" rx="3" fill="#a3a3a3" fill-opacity="0.55" stroke="${INK}" stroke-width="1"/>` +
        label
      );
    }
    case "glass_plate": {
      return (
        `<rect x="${num(x)}" y="${num(cy - 2)}" width="${num(w)}" height="5" fill="#d4d4d4" fill-opacity="0.6" stroke="${INK}" stroke-width="1"/>` +
        label
      );
    }
    case "test_tube": {
      const cotton = (mx: number, my: number) =>
        `<circle cx="${num(mx)}" cy="${num(my)}" r="4" fill="#e5e5e5" fill-opacity="0.9" stroke="${INK}" stroke-width="1"/>` +
        `<circle cx="${num(mx - 4)}" cy="${num(my + 2)}" r="3" fill="#e5e5e5" fill-opacity="0.8" stroke="${INK}" stroke-width="1"/>` +
        `<circle cx="${num(mx + 4)}" cy="${num(my + 2)}" r="3" fill="#e5e5e5" fill-opacity="0.8" stroke="${INK}" stroke-width="1"/>`;
      if (d.params?.tilted === "down") {
        // 管口向下倾斜：轮廓先水平摆放（管底在左、管口在右），再绕管底旋转 18°；锚点与 anchor() 的 tiltedMouth 一致。
        // 口部必须留开口（描边不闭合），否则试管会画成一个封死的"子弹头"。
        const deg = (TILT_RAD * 180) / Math.PI;
        const prof = VESSEL_PROFILES.test_tube;
        const sr = h / (2 * (prof?.halfWidth || 1)); // 管径方向缩放（轮廓中轴 x=0，±halfWidth 为壁）
        const pts = (prof?.outline ?? []).map(([ox, oy]) => `${num(x + oy * w)} ${num(cy + ox * sr)}`);
        if (pts.length < 3) return label;
        const dLine = `M ${pts.join(" L ")}`;
        const rad = h / 2;
        const mouthX = x + w;
        // 管底装固体药品（CuO / 高锰酸钾）：贴着管底铺一层，加热时"固体在受热"才看得出来
        const chunks = d.params?.solid_chunks
          ? [0, 1, 2, 3]
              .map((i) =>
                `<circle cx="${num(x + w * (0.07 + (i % 2) * 0.055 + Math.floor(i / 2) * 0.02))}" cy="${num(
                  cy + ((i % 2) - 0.5) * rad * 0.72 + Math.floor(i / 2) * rad * 0.1,
                )}" r="${num(Math.max(2.2, rad * 0.29))}" fill="#a3a3a3" fill-opacity="0.75" stroke="${INK}" stroke-width="1"/>`,
              )
              .join("")
          : "";
        // 口部塞子：导管从这里通入，塞子画在管口内侧。
        // 导管真的插进去时（p.bore），塞子中间留一道孔——上下两片，导管从孔里穿过去。
        const [p1, p2, p3, p4] = [cy - rad * 0.82, cy - rad * 0.94, cy + rad * 0.94, cy + rad * 0.82];
        const pxs = [mouthX - 12, mouthX - 4];
        const plug = p.stopper
          ? p.bore
            ? `<path d="M ${num(pxs[0])} ${num(p1)} L ${num(pxs[1])} ${num(p2)} L ${num(pxs[1])} ${num(cy - 4.5)} L ${num(pxs[0])} ${num(cy - 4.5)} Z" fill="#e7e5e4" stroke="${INK}" stroke-width="1.2"/>` +
              `<path d="M ${num(pxs[0])} ${num(cy + 4.5)} L ${num(pxs[1])} ${num(cy + 4.5)} L ${num(pxs[1])} ${num(p3)} L ${num(pxs[0])} ${num(p4)} Z" fill="#e7e5e4" stroke="${INK}" stroke-width="1.2"/>`
            : `<path d="M ${num(pxs[0])} ${num(p1)} L ${num(pxs[1])} ${num(p2)} L ${num(pxs[1])} ${num(p3)} L ${num(pxs[0])} ${num(p4)} Z" fill="#e7e5e4" stroke="${INK}" stroke-width="1.2"/>`
          : "";
        return (
          `<g transform="rotate(${num(deg)} ${num(x)} ${num(cy)})">` +
          (bodyFill.includes("none") ? "" : `<path d="${dLine} Z"${bodyFill} stroke="none"/>`) +
          `<path d="${dLine}" fill="none" stroke="${INK}" stroke-width="2"/>` +
          chunks +
          plug +
          (d.params?.has_cotton ? cotton(mouthX - 10, cy) : "") +
          `</g>` +
          label
        );
      }
      const geo = profilePaths("test_tube", x, y, w, h, inv);
      if (!geo) return label;
      return (
        vesselMarkup(geo, bodyFill) +
        clippedFluid(p, geo.fill) +
        (!inv ? solidChunks(p) : "") +
        stopperBand(p) +
        (!inv && d.params?.has_cotton ? cotton(cx, y + 2) : "") +
        label
      );
    }
    case "gas_jar": {
      const showPlate = !p.stopper && !p.inWater && (plate || d.params?.has_glass_plate === true);
      // 玻璃片盖在瓶口：正放盖顶部，倒扣盖底部；宽度跟颈口走
      const plateY = inv ? y + h : y - 5;
      const [px1, px2] = mouthSpan("gas_jar", x, w);
      const plateRect = showPlate ? plateBar(px1 - 3, px2 + 3, plateY, p.hole) : "";
      // 宽口短颈轮廓；倒扣时整体翻转，瓶口朝下
      const geo = profilePaths("gas_jar", x, y, w, h, inv);
      if (!geo) return label;
      return (
        vesselMarkup(geo, bodyFill) +
        clippedFluid(p, geo.fill) +
        plateRect +
        stopperBand(p) +
        label
      );
    }
    case "separating_funnel": {
      // 分液漏斗：梨形轮廓（含下管）+ 活塞横杠（位置按剖面：颈部收束上方）
      const geo = profilePaths("separatory_funnel", x, y, w, h);
      if (!geo) return label;
      return (
        vesselMarkup(geo, bodyFill) +
        clippedFluid(p, geo.fill) +
        `<line x1="${num(cx - w * 0.18)}" y1="${num(y + h * 0.87)}" x2="${num(cx + w * 0.18)}" y2="${num(y + h * 0.87)}" stroke="${INK}" stroke-width="2.5"/>` +
        label
      );
    }
    case "inverted_funnel": {
      // 倒置漏斗（尾气吸收防倒吸）：上细管 + 下宽口，宽口悬于液面上方
      return (
        `<rect x="${num(cx - w * 0.08)}" y="${num(y)}" width="${num(w * 0.16)}" height="${num(h * 0.4)}" fill="none" stroke="${INK}" stroke-width="2"/>` +
        `<path d="M ${num(cx - w * 0.08)} ${num(y + h * 0.4)} L ${num(cx - w / 2)} ${num(y + h)} L ${num(cx + w / 2)} ${num(y + h)} L ${num(cx + w * 0.08)} ${num(y + h * 0.4)} Z"${bodyFill} stroke="${INK}" stroke-width="2"/>` +
        label
      );
    }
    case "glass_rod": {
      return (
        `<rect x="${num(x)}" y="${num(cy - 3)}" width="${num(w)}" height="6" rx="3" fill="#e5e5e5" fill-opacity="0.7" stroke="${INK}" stroke-width="1.5" transform="rotate(-15 ${num(cx)} ${num(cy)})"/>` +
        label
      );
    }
    case "burner": {
      const fx = cx;
      return (
        `<rect x="${num(x + w * 0.2)}" y="${num(cy)}" width="${num(w * 0.6)}" height="${num(h / 2)}" fill="none" stroke="${INK}" stroke-width="2"/>` +
        `<path d="M ${num(fx)} ${num(cy - h / 2)} q ${num(w * 0.18)} ${num(h * 0.3)} 0 ${num(h / 2)} q ${num(-w * 0.18)} ${num(-h * 0.2)} 0 ${num(-h / 2)} Z" fill="none" stroke="${ACCENT}" stroke-width="2"/>` +
        label
      );
    }
    case "stand": {
      // 铁架台：立柱 + 底座（底板要有一定宽度，否则读起来像一根钉子）+ 铁夹
      const baseW = w * 0.5;
      let out =
        `<line x1="${num(cx)}" y1="${num(y)}" x2="${num(cx)}" y2="${num(y + h - 4)}" stroke="${INK}" stroke-width="3"/>` +
        `<rect x="${num(cx - baseW)}" y="${num(y + h - 6)}" width="${num(baseW * 2)}" height="7" fill="#e7e5e4" stroke="${INK}" stroke-width="1.6"/>`;
      if (p.clamp) {
        const { armY, armX } = p.clamp;
        const jaw = 6.5;
        out +=
          `<line x1="${num(cx)}" y1="${num(armY)}" x2="${num(armX)}" y2="${num(armY)}" stroke="${INK}" stroke-width="2.5"/>` +
          `<line x1="${num(armX)}" y1="${num(armY - jaw)}" x2="${num(armX)}" y2="${num(armY + jaw)}" stroke="${INK}" stroke-width="2.2"/>` +
          `<line x1="${num(armX - 4)}" y1="${num(armY - jaw)}" x2="${num(armX)}" y2="${num(armY - jaw)}" stroke="${INK}" stroke-width="2"/>` +
          `<line x1="${num(armX - 4)}" y1="${num(armY + jaw)}" x2="${num(armX)}" y2="${num(armY + jaw)}" stroke="${INK}" stroke-width="2"/>`;
      }
      return out + label;
    }
    case "map_frame": {
      return (
        `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="none" stroke="${INK}" stroke-width="2"/>` +
        `<rect x="${num(x + 8)}" y="${num(y + 8)}" width="${num(w - 16)}" height="${num(h - 16)}" fill="none" stroke="${INK}" stroke-width="1" stroke-dasharray="3 3"/>` +
        label
      );
    }
    case "compass": {
      return (
        `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(Math.min(w, h) / 2)}" fill="none" stroke="${INK}" stroke-width="2"/>` +
        `<path d="M ${num(cx)} ${num(cy - 10)} L ${num(cx + 5)} ${num(cy + 6)} L ${num(cx - 5)} ${num(cy + 6)} Z" fill="${ACCENT}"/>` +
        `<text x="${num(cx)}" y="${num(y - 3)}" font-size="11" fill="${TEXT}" text-anchor="middle">N</text>` +
        label
      );
    }
    case "scale_bar": {
      const seg = w / 4;
      let bars = "";
      for (let i = 0; i < 4; i++) {
        bars += `<rect x="${num(x + i * seg)}" y="${num(y)}" width="${num(seg)}" height="${num(h)}" fill="${i % 2 === 0 ? INK : "none"}" stroke="${INK}" stroke-width="1"/>`;
      }
      return bars + label;
    }
    case "legend": {
      return (
        `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="none" stroke="${INK}" stroke-width="1.5" stroke-dasharray="4 3"/>` +
        `<text x="${num(cx)}" y="${num(y + 15)}" font-size="11" fill="${TEXT}" text-anchor="middle">${esc(d.label)}</text>`
      );
    }
    case "arrow": {
      return (
        `<line x1="${num(x)}" y1="${num(cy)}" x2="${num(x + w)}" y2="${num(cy)}" stroke="${ACCENT}" stroke-width="2" marker-end="url(#dg-arrow)"/>` +
        label
      );
    }
    case "section_line": {
      return (
        `<line x1="${num(x)}" y1="${num(cy)}" x2="${num(x + w)}" y2="${num(cy)}" stroke="${INK}" stroke-width="3"/>` +
        `<text x="${num(x)}" y="${num(cy - 6)}" font-size="11" fill="${TEXT}">A</text>` +
        `<text x="${num(x + w)}" y="${num(cy - 6)}" font-size="11" fill="${TEXT}" text-anchor="end">A′</text>` +
        label
      );
    }
    case "label_box": {
      return (
        `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="none" stroke="${INK}" stroke-width="1.5"/>` +
        `<text x="${num(cx)}" y="${num(cy + 4)}" font-size="12" fill="${TEXT}" text-anchor="middle">${esc(d.label)}</text>`
      );
    }
    case "tube": {
      // 导管：细玻璃管——两根平行边 + 圆端，读起来是一根管子而不是一个方框。
      // 单端导管会被吸附到装置口并沿口部法线斜放（p.angle），所以这里要跟着转。
      const r = 3.5;
      const inner =
        `<path d="M ${num(x + r)} ${num(cy - r)} L ${num(x + w - r)} ${num(cy - r)} A ${r} ${r} 0 0 1 ${num(x + w - r)} ${num(
          cy + r,
        )} L ${num(x + r)} ${num(cy + r)} A ${r} ${r} 0 0 1 ${num(x + r)} ${num(cy - r)} Z" fill="#ffffff" fill-opacity="0.9" stroke="${INK}" stroke-width="1.6"/>`;
      return (
        (p.angle ? `<g transform="rotate(${num((p.angle * 180) / Math.PI)} ${num(cx)} ${num(cy)})">${inner}</g>` : inner) +
        label
      );
    }
    case "electrode": {
      // 电极：细棒 + 顶端接线帽 + 下端斜尖，插进液体后尖端可见
      const r = Math.max(2.6, Math.min(w * 0.24, 4.5));
      return (
        `<rect x="${num(cx - r)}" y="${num(y + 7)}" width="${num(r * 2)}" height="${num(h - 16)}" fill="#d6d3d1" stroke="${INK}" stroke-width="1.4"/>` +
        `<rect x="${num(cx - r * 1.7)}" y="${num(y)}" width="${num(r * 3.4)}" height="8" rx="2" fill="#a8a29e" stroke="${INK}" stroke-width="1.2"/>` +
        `<path d="M ${num(cx - r)} ${num(y + h - 9)} L ${num(cx)} ${num(y + h)} L ${num(cx + r)} ${num(y + h - 9)} Z" fill="#d6d3d1" stroke="${INK}" stroke-width="1.4"/>` +
        label
      );
    }
    case "battery": {
      // 直流电源：电池符号（长正极 + 短负极）+ 正负标注
      return (
        `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="4"${bodyFill} stroke="${INK}" stroke-width="2"/>` +
        `<line x1="${num(cx - w * 0.1)}" y1="${num(cy - h * 0.3)}" x2="${num(cx - w * 0.1)}" y2="${num(cy + h * 0.3)}" stroke="${INK}" stroke-width="2.6"/>` +
        `<line x1="${num(cx + w * 0.1)}" y1="${num(cy - h * 0.16)}" x2="${num(cx + w * 0.1)}" y2="${num(cy + h * 0.16)}" stroke="${INK}" stroke-width="1.4"/>` +
        `<text x="${num(x + w * 0.16)}" y="${num(cy - h * 0.34)}" font-size="10" fill="${TEXT}" text-anchor="middle">+</text>` +
        `<text x="${num(x + w * 0.84)}" y="${num(cy - h * 0.34)}" font-size="10" fill="${TEXT}" text-anchor="middle">−</text>` +
        label
      );
    }
    case "combustion_spoon": {
      // 燃烧匙：细杆 + 上开口的小勺，勺里装红色固体（红磷/硫粉）
      const bowlW = Math.max(12, w * 1.7);
      const bowlTop = y + h - bowlW * 0.7;
      return (
        `<line x1="${num(cx)}" y1="${num(y)}" x2="${num(cx)}" y2="${num(bowlTop + 1)}" stroke="${INK}" stroke-width="2.6"/>` +
        `<path d="M ${num(cx - bowlW / 2)} ${num(bowlTop)} Q ${num(cx - bowlW / 2)} ${num(bowlTop + bowlW * 0.62)} ${num(cx)} ${num(bowlTop + bowlW * 0.62)} Q ${num(cx + bowlW / 2)} ${num(bowlTop + bowlW * 0.62)} ${num(cx + bowlW / 2)} ${num(bowlTop)} Z" fill="#f5f5f4" stroke="${INK}" stroke-width="1.6"/>` +
        `<ellipse cx="${num(cx)}" cy="${num(bowlTop + bowlW * 0.18)}" rx="${num(bowlW * 0.28)}" ry="${num(bowlW * 0.1)}" fill="${ACCENT}" fill-opacity="0.85"/>` +
        label
      );
    }
    case "funnel": {
      // 普通漏斗（过滤）：大锥 + 细直颈。颈口敞着（液体滴下去），所以描边分两段画、不封底
      const coneBot = y + h * 0.6;
      const stem = Math.max(2.6, w * 0.055);
      const fill =
        `M ${num(x)} ${num(y)} L ${num(x + w)} ${num(y)} L ${num(cx + stem)} ${num(coneBot)} L ${num(cx + stem)} ${num(y + h)} ` +
        `L ${num(cx - stem)} ${num(y + h)} L ${num(cx - stem)} ${num(coneBot)} Z`;
      const stroke =
        `M ${num(x)} ${num(y)} L ${num(x + w)} ${num(y)} L ${num(cx + stem)} ${num(coneBot)} L ${num(cx + stem)} ${num(y + h)} ` +
        `M ${num(cx - stem)} ${num(y + h)} L ${num(cx - stem)} ${num(coneBot)} L ${num(x)} ${num(y)}`;
      // 滤纸：贴锥壁的折角纸（三层滤纸那一边靠玻璃棒，图上用虚线表示纸边）
      const paper = d.params?.has_filter_paper
        ? `<path d="M ${num(x + 3)} ${num(y + 3)} L ${num(cx + stem - 1)} ${num(coneBot - 3)} L ${num(cx - stem + 1)} ${num(coneBot - 3)} L ${num(x + w - 3)} ${num(y + 3)}" fill="#f5f5f4" fill-opacity="0.95" stroke="#78716c" stroke-width="1.1" stroke-dasharray="3 2"/>` +
          `<line x1="${num(cx)}" y1="${num(y + 4)}" x2="${num(cx)}" y2="${num(coneBot - 4)}" stroke="#a8a29e" stroke-width="0.8" stroke-dasharray="2 3"/>`
        : "";
      return (
        (bodyFill.includes("none") ? "" : `<path d="${fill}"${bodyFill} stroke="none"/>`) +
        `<path d="${stroke}" fill="none" stroke="${INK}" stroke-width="2"/>` +
        paper +
        label
      );
    }
    case "thermometer": {
      // 温度计：细玻璃管 + 球泡 + 红色液柱 + 刻度线（球泡是测温部位，必须落在液面以下）
      const r = Math.max(2.2, w * 0.3);
      const bulbR = r * 1.75;
      const bulbY = y + h - bulbR;
      const topY = y + 2.5;
      let ticks = "";
      const span = Math.max(10, bulbY - bulbR - topY);
      for (let i = 1; i <= 9; i++) {
        const ty = bulbY - bulbR - (span * i) / 10;
        const len = i % 2 === 0 ? 4.5 : 2.6;
        ticks += `<line x1="${num(cx + r)}" y1="${num(ty)}" x2="${num(cx + r + len)}" y2="${num(ty)}" stroke="${INK}" stroke-width="0.9"/>`;
      }
      return (
        `<rect x="${num(cx - r)}" y="${num(topY)}" width="${num(r * 2)}" height="${num(bulbY - topY)}" rx="${num(r)}" fill="#ffffff" fill-opacity="0.92" stroke="${INK}" stroke-width="1.4"/>` +
        `<rect x="${num(cx - r * 0.4)}" y="${num(topY + 10)}" width="${num(r * 0.8)}" height="${num(bulbY - topY - 10)}" fill="${ACCENT}" fill-opacity="0.8"/>` +
        `<circle cx="${num(cx)}" cy="${num(bulbY)}" r="${num(bulbR)}" fill="${ACCENT}" fill-opacity="0.55" stroke="${INK}" stroke-width="1.4"/>` +
        ticks +
        label
      );
    }
    case "cylinder": {
      // 量筒：直筒 + 平底座 + 右侧刻度（每 1/10 一格，5 的倍数加长）
      const geo = profilePaths("cylinder", x, y, w, h, inv);
      if (!geo) return label;
      const wall = cx + (0.46 / 1.44) * w; // 直壁在屏幕上的 x（轮廓直壁 ±0.46，总宽 1.44）
      let ticks = "";
      for (let i = 1; i <= 10; i++) {
        const ty = y + h * 0.16 + (h * 0.78 * i) / 11;
        const len = i % 5 === 0 ? 8 : i % 2 === 0 ? 5 : 3;
        ticks += `<line x1="${num(wall - len)}" y1="${num(ty)}" x2="${num(wall)}" y2="${num(ty)}" stroke="${INK}" stroke-width="0.9"/>`;
      }
      return vesselMarkup(geo, bodyFill) + clippedFluid(p, geo.fill) + ticks + label;
    }
    case "volumetric_flask": {
      // 容量瓶：梨形瓶体 + 细长颈 + 颈部刻度环（定容线，必须画出来，否则只是个瓶子）
      const geo = profilePaths("volumetric_flask", x, y, w, h, inv);
      if (!geo) return label;
      const neck = (0.1 / 1.24) * w;
      const markY = y + h * 0.26;
      return (
        vesselMarkup(geo, bodyFill) +
        clippedFluid(p, geo.fill) +
        `<line x1="${num(cx - neck - 3)}" y1="${num(markY)}" x2="${num(cx + neck + 3)}" y2="${num(markY)}" stroke="${ACCENT}" stroke-width="1.4"/>` +
        label
      );
    }
    case "evaporating_dish":
    case "crucible": {
      // 蒸发皿/坩埚：剖面轮廓 + 液面/固体；加盖时补一个弧形盖
      const geo = profilePaths(PROFILE_OF[d.type], x, y, w, h, inv);
      if (!geo) return label;
      const lid = d.params?.has_cover
        ? `<path d="M ${num(x + w * 0.05)} ${num(y + 2)} Q ${num(cx)} ${num(y - h * 0.3)} ${num(x + w * 0.95)} ${num(y + 2)}" fill="#f5f5f4" fill-opacity="0.9" stroke="${INK}" stroke-width="1.6"/>`
        : "";
      return vesselMarkup(geo, bodyFill) + clippedFluid(p, geo.fill) + solidChunks(p) + lid + label;
    }
    case "distilling_flask": {
      // 蒸馏烧瓶：圆底烧瓶 + 颈侧支管（支管口 side_out 接冷凝管）
      const geo = profilePaths("distilling_flask", x, y, w, h, inv);
      if (!geo) return label;
      const bx = cx + w * 0.1;
      const by = y + h * 0.34;
      const ex = x + w;
      const ey = y + h * 0.55;
      return (
        vesselMarkup(geo, bodyFill) +
        clippedFluid(p, geo.fill) +
        glassPipe(`M ${num(bx)} ${num(by)} L ${num(ex)} ${num(ey)}`, 9) +
        label
      );
    }
    case "hard_glass_tube": {
      // 硬质玻璃管：横放两端敞口（导管从端面插入），管内中部铺固体药品
      const chunks = d.params?.solid_chunks
        ? [0, 1, 2, 3, 4, 5]
            .map(
              (i) =>
                `<circle cx="${num(cx + (i - 2.5) * w * 0.09)}" cy="${num(cy + h * 0.16 - (i % 2) * 2)}" r="${num(
                  Math.max(2, h * 0.11),
                )}" fill="#a3a3a3" fill-opacity="0.75" stroke="${INK}" stroke-width="0.9"/>`,
            )
            .join("")
        : "";
      return (
        `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="2"${bodyFill} stroke="${INK}" stroke-width="2"/>` +
        chunks +
        label
      );
    }
    case "u_tube": {
      // U 形管：两竖管 + 底部半圆（双描边玻璃管），底部可盛液体（洗气/检验）
      const R = Math.max(14, Math.min(w / 2 - 5, (h - 12) / 2));
      const bottomY = y + h - 6 - R;
      const dPath = `M ${num(cx - R)} ${num(y)} L ${num(cx - R)} ${num(bottomY)} A ${num(R)} ${num(R)} 0 0 0 ${num(cx + R)} ${num(bottomY)} L ${num(cx + R)} ${num(y)}`;
      const level = d.params?.liquid_level;
      let liquid = "";
      if (level != null) {
        // 液面在底部弯头之上：两竖管里各有一段液柱 + 底部连通
        const rise = R * 1.2 * level + R * 0.2;
        const ly = bottomY + R - rise;
        const lPath = `M ${num(cx - R)} ${num(ly)} L ${num(cx - R)} ${num(bottomY)} A ${num(R)} ${num(R)} 0 0 0 ${num(cx + R)} ${num(bottomY)} L ${num(cx + R)} ${num(ly)}`;
        liquid =
          `<path d="${lPath}" fill="none" stroke="${FLUID_FILL}" stroke-opacity="0.75" stroke-width="5.4" stroke-linecap="butt"/>` +
          `<line x1="${num(cx - R - 3)}" y1="${num(ly)}" x2="${num(cx - R + 3)}" y2="${num(ly)}" stroke="${FLUID}" stroke-width="1.6"/>` +
          `<line x1="${num(cx + R - 3)}" y1="${num(ly)}" x2="${num(cx + R + 3)}" y2="${num(ly)}" stroke="${FLUID}" stroke-width="1.6"/>`;
      }
      return glassPipe(dPath, 9) + liquid + label;
    }
    case "drying_tube": {
      // 球形干燥管：中间球（装固体干燥剂）+ 左上、右上两短管
      const r = Math.max(11, Math.min(w * 0.24, h * 0.34));
      const bx = cx;
      const by = y + h * 0.58;
      const grains = d.params?.solid_chunks
        ? [0, 1, 2, 3, 4]
            .map((i) => {
              const ang = (i / 5) * Math.PI * 2;
              return `<circle cx="${num(bx + Math.cos(ang) * r * 0.45)}" cy="${num(by + Math.sin(ang) * r * 0.4)}" r="${num(Math.max(1.8, r * 0.16))}" fill="#a3a3a3" fill-opacity="0.8" stroke="${INK}" stroke-width="0.8"/>`;
            })
            .join("")
        : "";
      return (
        glassPipe(`M ${num(x + 3)} ${num(y + 3)} L ${num(bx - r * 0.7)} ${num(by - r * 0.68)}`, 8) +
        glassPipe(`M ${num(bx + r * 0.7)} ${num(by - r * 0.68)} L ${num(x + w - 3)} ${num(y + 3)}`, 8) +
        `<circle cx="${num(bx)}" cy="${num(by)}" r="${num(r)}" fill="#ffffff" fill-opacity="0.9" stroke="${INK}" stroke-width="2"/>` +
        grains +
        label
      );
    }
    case "condenser": {
      // 直形冷凝管（横放）：内管贯穿两端敞开，外套管套在中段（半透明白底，能看见里面的内管），
      // 冷却水下进上出（左下进水、右上出水）
      const jx1 = x + w * 0.2;
      const jx2 = x + w * 0.8;
      const jinX = x + w * 0.33;
      const joutX = x + w * 0.67;
      return (
        glassPipe(`M ${num(x)} ${num(cy)} L ${num(x + w)} ${num(cy)}`, 8) +
        `<rect x="${num(jx1)}" y="${num(y + 2)}" width="${num(jx2 - jx1)}" height="${num(h - 4)}" rx="5" fill="#ffffff" fill-opacity="0.55" stroke="${INK}" stroke-width="2"/>` +
        glassPipe(`M ${num(jinX)} ${num(y + h - 3)} L ${num(jinX)} ${num(y + h + 8)}`, 6) +
        glassPipe(`M ${num(joutX)} ${num(y - 8)} L ${num(joutX)} ${num(y + 3)}`, 6) +
        label
      );
    }
    case "distillation_head": {
      // 蒸馏头（三通）：竖管（下端接烧瓶、上端插温度计）+ 右下斜支管（接冷凝管）
      return (
        glassPipe(`M ${num(cx)} ${num(y + h)} L ${num(cx)} ${num(y)}`, 13) +
        glassPipe(`M ${num(cx)} ${num(y + h * 0.36)} L ${num(x + w)} ${num(y + h * 0.56)}`, 11) +
        label
      );
    }
    case "balance": {
      // 托盘天平：底座 + 立柱 + 横梁 + 两个托盘 + 指针
      const baseY = y + h - 7;
      const beamY = y + h * 0.3;
      const panY = beamY + 16;
      const pan = (px: number) =>
        `<line x1="${num(px)}" y1="${num(beamY)}" x2="${num(px)}" y2="${num(panY)}" stroke="${INK}" stroke-width="1.2"/>` +
        `<path d="M ${num(px - 17)} ${num(panY)} Q ${num(px)} ${num(panY + 9)} ${num(px + 17)} ${num(panY)} Z" fill="#e7e5e4" stroke="${INK}" stroke-width="1.6"/>`;
      return (
        `<rect x="${num(x)}" y="${num(baseY)}" width="${num(w)}" height="7" rx="2" fill="#e7e5e4" stroke="${INK}" stroke-width="1.6"/>` +
        `<line x1="${num(cx)}" y1="${num(beamY)}" x2="${num(cx)}" y2="${num(baseY)}" stroke="${INK}" stroke-width="3"/>` +
        `<line x1="${num(x + 6)}" y1="${num(beamY)}" x2="${num(x + w - 6)}" y2="${num(beamY)}" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>` +
        `<line x1="${num(cx)}" y1="${num(beamY)}" x2="${num(cx)}" y2="${num(beamY + 12)}" stroke="${ACCENT}" stroke-width="1.6"/>` +
        pan(x + w * 0.24) +
        pan(x + w * 0.76) +
        label
      );
    }
    case "tripod": {
      // 三脚架：台面 + 两条外张的前腿 + 一条后腿（虚线，表示在后面）
      const topY = y + h * 0.08;
      return (
        `<line x1="${num(x)}" y1="${num(topY)}" x2="${num(x + w)}" y2="${num(topY)}" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>` +
        `<line x1="${num(x + 10)}" y1="${num(topY + 2)}" x2="${num(x - 5)}" y2="${num(y + h)}" stroke="${INK}" stroke-width="2.6"/>` +
        `<line x1="${num(x + w - 10)}" y1="${num(topY + 2)}" x2="${num(x + w + 5)}" y2="${num(y + h)}" stroke="${INK}" stroke-width="2.6"/>` +
        `<line x1="${num(cx)}" y1="${num(topY + 2)}" x2="${num(cx)}" y2="${num(y + h - 4)}" stroke="${INK}" stroke-width="1.6" stroke-dasharray="4 3"/>` +
        label
      );
    }
    case "clay_triangle": {
      // 泥三角：三角形瓷管圈（架在铁圈/三脚架上托坩埚），三个角各套一节瓷管
      const tri = `M ${num(cx)} ${num(y + 2)} L ${num(x + w - 2)} ${num(y + h * 0.78)} L ${num(x + 2)} ${num(y + h * 0.78)} Z`;
      const bead = (bx: number, by2: number) =>
        `<rect x="${num(bx - 4.5)}" y="${num(by2 - 3.2)}" width="9" height="6.4" rx="1.6" fill="#e7e5e4" stroke="${INK}" stroke-width="1.2"/>`;
      return (
        `<path d="${tri}" fill="none" stroke="${INK}" stroke-width="1.8"/>` +
        bead(cx, y + 2) +
        bead(x + w - 2, y + h * 0.78) +
        bead(x + 2, y + h * 0.78) +
        label
      );
    }
    case "copper_plate": {
      // 铜片：薄金属片（紫红色）
      return (
        `<rect x="${num(x)}" y="${num(cy - 2.5)}" width="${num(w)}" height="5" rx="1.5" fill="#c2703f" fill-opacity="0.9" stroke="${INK}" stroke-width="1.2"/>` +
        label
      );
    }
    case "stopper": {
      // 橡胶塞：上宽下窄的梯形（塞进瓶口的一端略窄）
      const t = h * 0.18;
      return (
        `<path d="M ${num(x)} ${num(y)} L ${num(x + w)} ${num(y)} L ${num(x + w - t)} ${num(y + h)} L ${num(x + t)} ${num(y + h)} Z" fill="#e7e5e4" stroke="${INK}" stroke-width="1.4"/>` +
        label
      );
    }
    case "clamp": {
      // 铁夹：横臂 + 前端的 C 形夹口（夹试管/烧瓶用）
      const jaw = w * 0.34;
      return (
        `<line x1="${num(x)}" y1="${num(cy)}" x2="${num(x + w - jaw)}" y2="${num(cy)}" stroke="${INK}" stroke-width="2.8"/>` +
        `<path d="M ${num(x + w - jaw)} ${num(cy - 8)} L ${num(x + w - jaw * 0.5)} ${num(cy - 8)} Q ${num(x + w)} ${num(cy - 6)} ${num(x + w)} ${num(cy)} Q ${num(x + w)} ${num(cy + 6)} ${num(x + w - jaw * 0.5)} ${num(cy + 8)} L ${num(x + w - jaw)} ${num(cy + 8)}" fill="none" stroke="${INK}" stroke-width="2.2"/>` +
        label
      );
    }
    default: {
      // 有剖面轮廓的器皿（烧杯/试剂瓶/烧瓶/水槽…）：真实器形 + 轮廓裁剪液体；其余白描圆角框
      const pk = PROFILE_OF[d.type];
      const geo = pk ? profilePaths(pk, x, y, w, h, inv) : null;
      if (geo) {
        return (
          vesselMarkup(geo, bodyFill) +
          plateSvg +
          clippedFluid(p, geo.fill) +
          (!inv ? solidChunks(p) : "") +
          stopperBand(p) +
          label
        );
      }
      // 容器：半透明填充（遮挡）+ 水面/气泡层 + 固体块；非容器：白描圆角框
      return (
        `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="6"${bodyFill} stroke="${INK}" stroke-width="2"/>` +
        plateSvg +
        fluid +
        solidChunks(p) +
        stopperBand(p) +
        label
      );
    }
  }
}

/* ── 连线路由 ───────────────────────────────────────── */

type Pt = [number, number];

/** 折线 → 带圆角的 path（拐角用二次贝塞尔切角，像真实玻璃导管） */
function polyPath(pts: Pt[], r: number): string {
  if (pts.length < 2) return "";
  let d = `M ${num(pts[0][0])} ${num(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx0, cy0] = pts[i];
    const [nx, ny] = pts[i + 1];
    const d1 = Math.hypot(cx0 - px, cy0 - py);
    const d2 = Math.hypot(nx - cx0, ny - cy0);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const inX = cx0 + ((px - cx0) / (d1 || 1)) * rr;
    const inY = cy0 + ((py - cy0) / (d1 || 1)) * rr;
    const outX = cx0 + ((nx - cx0) / (d2 || 1)) * rr;
    const outY = cy0 + ((ny - cy0) / (d2 || 1)) * rr;
    d += ` L ${num(inX)} ${num(inY)} Q ${num(cx0)} ${num(cy0)} ${num(outX)} ${num(outY)}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return d + ` L ${num(lx)} ${num(ly)}`;
}

/** 折线上按长度比例取点（编号徽标贴在线上用） */
function pointAt(pts: Pt[], frac: number): Pt {
  return pointDir(pts, frac).p;
}

/** 同上，顺带给出该点所在线段的方向（徽标沿法向错开，不压在线上） */
function pointDir(pts: Pt[], frac: number): { p: Pt; dir: Pt } {
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    segs.push(l);
    total += l;
  }
  let target = total * frac;
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i] || i === segs.length - 1) {
      const t = segs[i] ? Math.min(1, target / segs[i]) : 0;
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      return {
        p: [ax + (bx - ax) * t, ay + (by - ay) * t],
        dir: [bx - ax, by - ay],
      };
    }
    target -= segs[i];
  }
  return { p: pts[pts.length - 1], dir: [1, 0] };
}

/** 连线样式描述 */
interface Edge {
  pts: Pt[];
  style: string;
  route?: string;
  /** 直连（非折线）时用贝塞尔/圆弧的画法 */
  curved?: "quad" | "s";
  note?: string;
}

function edgeMarkup(e: Edge, noteNo: number | null): string {
  const [x1, y1] = e.pts[0];
  const [x2, y2] = e.pts[e.pts.length - 1];
  const dash = e.style === "dashed" ? ` stroke-dasharray="5 4"` : "";
  const arrow = e.style === "arrow" ? ` marker-end="url(#dg-arrow)"` : "";
  const attrs = `fill="none" stroke="${INK}" stroke-width="1.5"${dash}${arrow}`;
  let path: string;
  if (e.curved === "s") {
    const mx = (x1 + x2) / 2;
    path = `<path d="M ${num(x1)} ${num(y1)} C ${num(mx)} ${num(y1)} ${num(mx)} ${num(y2)} ${num(x2)} ${num(y2)}" ${attrs}/>`;
  } else if (e.curved === "quad") {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 - 24;
    path = `<path d="M ${num(x1)} ${num(y1)} Q ${num(mx)} ${num(my)} ${num(x2)} ${num(y2)}" ${attrs}/>`;
  } else {
    path = `<path d="${polyPath(e.pts, 10)}" ${attrs}/>`;
  }
  if (noteNo == null) return path;
  const badge = badgeAt(e.pts, noteNo, e.curved ? 0.5 : 0.45);
  return path + badge;
}

/**
 * 进瓶方式：正放的容器（管口在上）如果横向廊道低于瓶口，就要先绕到瓶口上方再从正中插下去，
 * 否则管子会横穿瓶肩/瓶身——化学图里这是"错口插入"，一眼就能看出不对。
 */
function hookOverMouth(pts: Pt[], target: Placed | undefined): Pt[] {
  if (!target || target.d.params?.inverted === true) return pts;
  if (pts.length < 4) return pts;
  const topY = target.cy - target.h / 2;
  const laneY = pts[pts.length - 2][1];
  if (laneY <= topY - 6) return pts;
  const fromX = pts[0][0];
  const side = fromX <= target.cx ? -1 : 1;
  const xa = target.cx + side * (target.w / 2 + 12);
  const head = pts.slice(0, -2);
  return [...head, [xa, laneY], [xa, topY - 12], [target.cx, topY - 12], pts[pts.length - 1]];
}

/**
 * 排水法进瓶：倒扣瓶的瓶口在下方，管子必须从水下绕到瓶口再往上插，
 * 否则横向廊道正好从瓶身中间穿过去——玻璃瓶壁上穿一根管子，一眼就假。
 */
function diveUnderMouth(pts: Pt[], target: Placed | undefined): Pt[] {
  if (!target || target.inverted !== true) return pts;
  const mouthY = target.cy + target.h / 2;
  const last = pts[pts.length - 1];
  if (last[1] >= mouthY + 6) return pts; // 本来就是从下面进去的
  const underY = mouthY + 12;
  const sideX = pts[0][0] <= target.cx ? target.cx - target.w / 2 - 12 : target.cx + target.w / 2 + 12;
  return [pts[0], [sideX, pts[0][1]], [sideX, underY], [last[0], underY], last];
}

/** 编号徽标：连线上一个小圆圈 + 序号，正文说明统一收到图下方（不再把文字压在图上） */function badgeAt(pts: Pt[], n: number, frac: number): string {
  const { p, dir } = pointDir(pts, frac);
  // 沿法向错开：横线编号在线的上方，竖线编号在线的右侧——不压线、不压液面、不压玻璃片
  const off: Pt = Math.abs(dir[0]) >= Math.abs(dir[1]) ? [0, -11] : [11, 0];
  const bx = p[0] + off[0];
  const by = p[1] + off[1];
  return (
    `<circle cx="${num(bx)}" cy="${num(by)}" r="7" fill="#ffffff" stroke="${INK}" stroke-width="1"/>` +
    `<text x="${num(bx)}" y="${num(by + 3.2)}" font-size="9" fill="${INK}" text-anchor="middle">${n}</text>`
  );
}

/** 主入口：布局计划 → SVG 字符串 */
export function renderPlan(plan: LayoutPlan, registry: RegistryFile | undefined): string {
  const types = registry?.types ?? {};
  const conns = plan.connections;

  // 0. 语义补全：容器被要求"伸入液面以下"却没给液面高度 → 引擎按 55% 画液面，"液封"才看得见
  const needLiquid = new Set(
    conns.filter((c) => /\.liquid_inside$/.test(c.to)).map((c) => c.to.split(".")[0]),
  );
  const devices: Device[] = plan.devices.map((d) =>
    needLiquid.has(d.id) && d.params?.liquid_level == null
      ? ({ ...d, params: { ...d.params, liquid_level: 0.55 } } as Device)
      : d,
  );

  // 1. 定位：relative_position → 网格坐标；同区域多个装置水平错开。
  //    但"宿主"（被插入/盛水的容器）不吃错开——它得待在自己那一格的中心，插进它里面的东西才有参照物。
  const INSIDE_IFACE = /^(liquid_inside|bottom_in|top_in|inside)$/;
  const hostIds = new Set<string>();
  for (const c of conns) {
    const [hid, hif] = c.to.split(".");
    if (INSIDE_IFACE.test(hif ?? "")) hostIds.add(hid);
  }
  for (const d of devices) {
    const [dw] = types[d.type]?.default_size ?? [0, 0];
    if (d.params?.liquid_level != null && dw >= 80) hostIds.add(d.id);
  }
  const byRegion = new Map<Pos, Device[]>();
  for (const d of devices) {
    const list = byRegion.get(d.relative_position) ?? [];
    list.push(d);
    byRegion.set(d.relative_position, list);
  }
  const placed = new Map<string, Placed>();
  for (const [pos, list] of byRegion) {
    const [col, row] = POS_GRID[pos];
    const peers = list.filter((d) => !hostIds.has(d.id));
    list.forEach((d) => {
      const def = types[d.type];
      let [w, h] = def?.default_size ?? [60, 60];
      // 倾斜试管按近水平放置：交换注册表的竖直默认尺寸
      if (d.params?.tilted === "down") [w, h] = [h, w];
      w = Math.max(16, Math.min(w, 300));
      h = Math.max(10, Math.min(h, 200));
      const idx = peers.indexOf(d);
      const spread = idx >= 0 && peers.length > 1 ? (idx - (peers.length - 1) / 2) * (w * 0.7) : 0;
      placed.set(d.id, {
        d,
        cx: COL_X[col] + spread,
        cy: ROW_Y[row],
        w,
        h,
        inverted: d.params?.inverted === true,
      });
    });
  }

  // 2. 插入装配：连接到容器内部接口（liquid_inside / bottom_in / top_in）的细长器械或倒扣器皿，
  //    不按九宫格摆，而是吸附到宿主上：轴线对准宿主，插入端沉到液面以下。
  //    这是"倒扣试管浸在水槽里""电极插进溶液""燃烧匙伸进集气瓶"唯一的通用解法——
  //    否则三件东西各占一格，图上就是悬空的孤立体。宿主本身也可能是个插入件（电极插进倒扣试管），
  //    所以按"宿主链深度"从小到大摆：先摆外层，内层才有坐标可依。
  const NECK_TYPES = /^(tube|long_neck_funnel|separating_funnel|inverted_funnel)$/;
  const insertHost = new Map<string, { host: string; iface: string; hostIface: string }>();
  const hostInserts = new Map<string, string[]>();
  const insertConns = new Set<number>();
  conns.forEach((c, idx) => {
    const [aid, aif] = c.from.split(".");
    const [bid, bif] = c.to.split(".");
    const B = placed.get(bid);
    if (!B) return;
    // 倒扣容器的口朝下，"连到它的口"等于"从下方伸进去"
    const intoMouth = B.inverted === true && /^(mouth_open|top_open)$/.test(bif ?? "");
    if (!INSIDE_IFACE.test(bif ?? "") && !intoMouth) return;
    const A = placed.get(aid);
    if (!A || aid === bid) return;
    if (NECK_TYPES.test(A.d.type)) return; // 导管/漏斗由下面的管路与颈管逻辑处理
    const role = types[A.d.type]?.mount;
    if (role !== "insert" && A.inverted !== true) return;
    insertHost.set(aid, { host: bid, iface: aif ?? "", hostIface: bif ?? "" });
    const list = hostInserts.get(bid) ?? [];
    if (!list.includes(aid)) list.push(aid);
    hostInserts.set(bid, list);
    insertConns.add(idx);
  });
  const depthOf = (id: string, seen = new Set<string>()): number => {
    const m = insertHost.get(id);
    if (!m || seen.has(id)) return 0;
    seen.add(id);
    return 1 + depthOf(m.host, seen);
  };
  const hostOrder = [...hostInserts.keys()].sort((a, b) => depthOf(a) - depthOf(b));
  for (const hostId of hostOrder) {
    const B = placed.get(hostId);
    const ids = hostInserts.get(hostId);
    if (!B || !ids) continue;
    const n = ids.length;
    // 同一宿主插多件（两只试管/两根电极）时左右分开；总跨度不超过宿主口宽，别插到器皿外面去
    const widest = Math.max(...ids.map((id) => placed.get(id)?.w ?? 20));
    const span = n > 1 ? Math.max(0, Math.min(B.w * 0.8 - widest, (n - 1) * (widest + 6))) : 0;
    ids.forEach((id, i) => {
      const A = placed.get(id);
      const meta = insertHost.get(id);
      if (!A || !meta) return;
      A.cx = B.cx + (n > 1 ? (i - (n - 1) / 2) * (span / (n - 1)) : 0);
      const innerTop = B.cy - B.h / 2;
      const liq = B.d.params?.liquid_level;
      let targetY: number;
      if (liq != null && /^liquid_inside$/.test(meta.hostIface)) {
        // 插进液体：埋到液面下 12px，液封/浸没才看得见
        targetY = innerTop + B.h * (1 - liq) + 12;
      } else if (B.inverted) {
        // 倒扣容器的口在下方：从口往上塞进去 20px，器械主体留在口外
        targetY = anchor(B, "top_open", registry)[1] - 20;
      } else {
        // 插进瓶内空间（燃烧匙等）：伸到内腔中部，不贴底、不插进水里
        targetY = innerTop + B.h * 0.58;
      }
      const a0 = anchor(A, meta.iface, registry);
      A.cy += targetY - a0[1];
      // 器械不能穿出最外层容器的底/顶（电极从水槽底下戳出来是最刺眼的一种错）
      let root = placed.get(id);
      for (let g = 0; root && insertHost.has(root.d.id) && g < 8; g++) {
        root = placed.get(insertHost.get(root.d.id)!.host);
      }
      if (root && root.d.id !== B.d.id) {
        const floor = root.cy + root.h / 2 - 4;
        if (A.cy + A.h / 2 > floor) A.cy = floor - A.h / 2;
      }
      if (A.cy - A.h / 2 < 8) A.cy = 8 + A.h / 2;
      // 封盖上给穿过件留孔，避免"玻璃片/胶塞被凭空穿过"
      if (A.cy + A.h / 2 > innerTop - 2 && A.cy - A.h / 2 < innerTop + 10) {
        const halfW = Math.max(3, A.w * 0.45);
        B.hole = {
          x1: Math.min(B.hole?.x1 ?? A.cx - halfW, A.cx - halfW),
          x2: Math.max(B.hole?.x2 ?? A.cx + halfW, A.cx + halfW),
        };
      }
    });
  }

  // 2b. 倒扣器皿入水：画面里有盛液容器、器皿又倒扣，就把它放进水里（排水法集气瓶/倒扣试管收集气体）。
  //     没有这条，"倒扣"只是把瓶子上下翻过来，还浮在水槽旁边。
  const waterHosts = [...placed.values()].filter(
    (p) => p.d.params?.liquid_level != null && p.inverted !== true && p.w >= 80 && p.h >= 30,
  );
  for (const p of placed.values()) {
    if (p.inverted !== true || insertHost.has(p.d.id)) continue;
    const host = waterHosts
      .filter((h) => h.d.id !== p.d.id && h.w >= p.w * 1.25)
      .sort((a, b) => Math.abs(a.cx - p.cx) - Math.abs(b.cx - p.cx))[0];
    if (!host) continue;
    const liq = host.d.params?.liquid_level ?? 0.7;
    const levelY = host.cy - host.h / 2 + host.h * (1 - liq);
    p.cx = host.cx;
    // 倒扣后瓶口在下方：让瓶口沉到液面以下 6px
    const mouthY = anchor(p, "top_open", registry)[1];
    p.cy += levelY + 6 - mouthY;
    p.inWater = true;
    p.stopper = false;
  }

  // 2b-3. 管路件接在口上：蒸馏头坐在烧瓶口、冷凝管贴到蒸馏头斜口、接收瓶对着冷凝管出口。
  //       这些是"接管件"而不是器皿，各占一格的话，一整套蒸馏装置会散成一堆零件。
  const PIPE_FITTING = /^(distillation_head|condenser)$/;
  const fittingConns = new Set<number>();
  conns.forEach((c, idx) => {
    const [aid, aif] = c.from.split(".");
    const [bid, bif] = c.to.split(".");
    const A = placed.get(aid);
    const B = placed.get(bid);
    if (!A || !B) return;
    // ① 管路件的底口坐在容器口上（蒸馏头 ← 烧瓶口；两个书写方向都认：谁在 from 都可能）
    const head = PIPE_FITTING.test(A.d.type) ? A : PIPE_FITTING.test(B.d.type) ? B : null;
    if (head) {
      const headIface = head === A ? aif : bif;
      const vessel = head === A ? B : A;
      const vesselIface = head === A ? bif : aif;
      if (/^bottom_in$/.test(headIface ?? "") && /^(top_open|mouth_open)$/.test(vesselIface ?? "") && !vessel.inverted) {
        head.cx = vessel.cx;
        head.cy +=
          anchor(vessel, vesselIface ?? "top_open", registry)[1] - anchor(head, headIface ?? "bottom_in", registry)[1];
        fittingConns.add(idx);
        return;
      }
    }
    // ② 管路件的进料端贴到上游接口（冷凝管 ← 蒸馏头斜口）：留一小段接管，别把件体压在斜管上
    if (PIPE_FITTING.test(B.d.type) && /^(in_left|in_bottom)$/.test(bif ?? "")) {
      const target = anchor(A, aif ?? "", registry);
      const own = anchor(B, bif ?? "in_left", registry);
      B.cx += target[0] + 12 - own[0];
      B.cy += target[1] + 11 - own[1];
      // 不消费：这一段留给"接管"，冷凝管才不会盖住蒸馏头的斜支管
    }
  });
  // ③ 接收瓶挪到管路件出口正下方（馏出液要落进瓶里，不能靠一条斜线连着了事）
  conns.forEach((c, idx) => {
    if (fittingConns.has(idx)) return;
    const [aid, aif] = c.from.split(".");
    const [bid, bif] = c.to.split(".");
    const A = placed.get(aid);
    const B = placed.get(bid);
    if (!A || !B || !PIPE_FITTING.test(A.d.type)) return;
    if (!/^(out_right|out_left|down_out)$/.test(aif ?? "")) return;
    if (!/^(top_open|mouth_open)$/.test(bif ?? "") || B.inverted) return;
    const out = anchor(A, aif ?? "out_right", registry);
    B.cx = out[0];
    B.cy = out[1] + 26 + B.h / 2;
    if (B.cy + B.h / 2 > H - 8) B.cy = H - 8 - B.h / 2; // 别把瓶底推出画布
    // 这条不消费：留一条竖线当"尾接管"，否则冷凝管出口和瓶口之间是断开的
  });

  // 2b-1. 颈管件插进容器口：过滤时漏斗颈插进烧杯口、量温度时温度计插进瓶口。
  //     这类关系是"下端伸进口内、主体留在口外"——既不该沉到液面下（那是插入装配），
  //     也不该各占一格：不装配的话，图上就是一支悬空的漏斗配一个空烧杯。
  const MOUTH_IFACE_RE = /^(mouth_open|top_open|top_in|top_out)$/;
  const NECK_PIECE = /^(funnel|thermometer|long_neck_funnel)$/;
  const neckInConns = new Set<number>();
  conns.forEach((c, idx) => {
    const [aid, aif] = c.from.split(".");
    const [bid, bif] = c.to.split(".");
    const A = placed.get(aid);
    const B = placed.get(bid);
    if (!A || !B || aid === bid) return;
    if (!NECK_PIECE.test(A.d.type)) return;
    if (!MOUTH_IFACE_RE.test(bif ?? "") || B.inverted) return;
    if (!/^(stem_bottom|bulb|bottom_out)$/.test(aif ?? "")) return;
    A.cx = B.cx;
    const mouthY = anchor(B, bif ?? "top_open", registry)[1];
    const aBot = anchor(A, aif ?? "stem_bottom", registry)[1];
    // 插进蒸馏头时球泡要落到支管口高度（蒸馏测温看的是蒸气温度，不是头顶温度）
    const deep = B.d.type === "distillation_head" ? B.h * 0.34 : 9;
    A.cy += mouthY + deep - aBot;
    // 顶到画布外就截短杆身（漏斗/温度计插在高处时，别让球泡连同名字一起被裁掉）
    if (A.cy - A.h / 2 < 6) {
      const bottom = A.cy + A.h / 2;
      A.h = Math.max(36, Math.min(A.h, bottom - 6));
      A.cy = 6 + A.h / 2;
    }
    // 细口容器（锥形瓶/试剂瓶/试管）口上插了漏斗或温度计，口一定塞着塞子，塞子上要开孔
    if (/^(flask|bottle|test_tube)$/.test(B.d.type)) {
      B.stopper = true;
      const halfW = Math.max(3, A.w * 0.3);
      B.hole = {
        x1: Math.min(B.hole?.x1 ?? A.cx - halfW, A.cx - halfW),
        x2: Math.max(B.hole?.x2 ?? A.cx + halfW, A.cx + halfW),
      };
    }
    neckInConns.add(idx);
  });

  // 2b-2. 三脚架/泥三角承托浅口器皿：蒸发皿、坩埚这类浅口器必须架在三脚架上，
  //       各摆一格的话，图上就是"一只碗浮在三脚架旁边"。
  for (const t of placed.values()) {
    if (t.d.type !== "tripod" && t.d.type !== "clay_triangle") continue;
    const cands = [...placed.values()].filter((q) => /^(evaporating_dish|crucible|watch_glass)$/.test(q.d.type));
    if (!cands.length) continue;
    const dist2 = (q: Placed) => (q.cx - t.cx) ** 2 + (q.cy - t.cy) ** 2;
    cands.sort((a, b) => dist2(a) - dist2(b));
    const host = cands[0];
    t.cx = host.cx;
    t.cy = host.cy + host.h / 2 + t.h / 2 - 7;
  }

  // 2b-4. 玻璃棒引流：棒的一端连着某个口时，斜靠在那个口上
  //       （不装配的话，图上只是"器材旁边悬着一根斜棍"）
  const rodConns = new Set<number>();
  conns.forEach((c, idx) => {
    const [aid, aif] = c.from.split(".");
    const [bid, bif] = c.to.split(".");
    const A = placed.get(aid);
    const B = placed.get(bid);
    if (!A || !B) return;
    const rod = A.d.type === "glass_rod" ? A : B.d.type === "glass_rod" ? B : null;
    if (!rod) return;
    const other = rod === A ? B : A;
    const t = anchor(other, rod === A ? bif ?? "" : aif ?? "", registry);
    const len = rod.w;
    // 玻璃棒绕自身中心斜 15°（右下端低、左上端高）：让低端落在目标口内
    rod.cx = t[0] - 8 + (len / 2) * Math.cos(Math.PI / 12);
    rod.cy = t[1] + 1 - (len / 2) * Math.sin(Math.PI / 12);
    rodConns.add(idx);
  });

  // 2c. 铁架台：有铁夹连接时贴到被固定装置左侧，夹臂真的搭上去（网格位置只是大概，夹持关系才是真的）。
  //     夹点必须落在"装置实际几何"上：倾斜试管若还按轴对齐包围盒算，夹臂会正好夹在管底/管口，
  //     看起来像把试管钉在架子上。真实铁夹夹在试管中上部（离管口约 1/3）。
  for (const c of conns) {
    const [sid, sif] = c.from.split(".");
    const [tid] = c.to.split(".");
    if (sif !== "clamp") continue;
    const s = placed.get(sid);
    const t = placed.get(tid);
    if (!s || !t) continue;
    s.h = Math.max(t.h + 40, 110);
    let armX: number;
    let armY: number;
    if (t.d.params?.tilted === "down") {
      const ratio = 0.62; // 从管底往管口 62% 处 ≈ 靠近管口的中上部
      const bx = t.cx - t.w / 2;
      armX = bx + t.w * ratio * Math.cos(TILT_RAD) - (t.h / 2) * 0.6;
      armY = t.cy + t.w * ratio * Math.sin(TILT_RAD);
      s.cy = Math.min(t.cy + 6, armY);
      s.cx = armX - 64;
      s.clamp = { armY, armX };
      continue;
    }
    s.cy = t.cy;
    s.cx = t.cx - t.w / 2 - 26;
    s.clamp = { armY: t.cy, armX: t.cx - t.w / 2 + 1 };
  }

  // 2d. 酒精灯：加热是"装配关系"，不是九宫格位置。
  //     有 flame 连线就加热那件容器；没有连线就吸附到最近的试管/烧瓶下方——
  //     加热装置必须贴着被加热物，否则图上就是一支孤零零站在角落的灯。
  const heatPoint = (host: Placed): [number, number] => {
    if (host.d.params?.tilted === "down") {
      // 倾斜试管受热部位在管底附近（装固体的地方），不是管口
      const t = 0.2;
      const bx = host.cx - host.w / 2;
      return [
        bx + host.w * t * Math.cos(TILT_RAD),
        host.cy + host.w * t * Math.sin(TILT_RAD) + (host.h / 2) * Math.cos(TILT_RAD),
      ];
    }
    if (host.inverted) return [host.cx, host.cy - host.h / 2];
    return [host.cx, host.cy + host.h / 2];
  };
  const placeBurner = (b: Placed, host: Placed) => {
    const [hx, hy] = heatPoint(host);
    b.cx = hx;
    b.cy = hy + b.h / 2 - 3; // 火焰尖顶到器底（略微交叠，看起来才像在烧）
  };
  const heatHosts = new Set<string>();
  for (const c of conns) {
    const [fid, fif] = c.from.split(".");
    if (fif !== "flame") continue;
    const b = placed.get(fid);
    const t = placed.get(c.to.split(".")[0]);
    if (!b || !t || b.d.type !== "burner") continue;
    placeBurner(b, t);
    heatHosts.add(t.d.id);
  }
  for (const b of placed.values()) {
    if (b.d.type !== "burner" || heatHosts.has(b.d.id)) continue;
    const cands = [...placed.values()].filter(
      (q) => q.d.id !== b.d.id && /^(test_tube|flask|evaporating_dish)$/.test(q.d.type) && !heatHosts.has(q.d.id),
    );
    if (!cands.length) continue;
    const dist2 = (q: Placed) => (q.cx - b.cx) ** 2 + (q.cy - b.cy) ** 2;
    cands.sort((a, b2) => dist2(a) - dist2(b2));
    placeBurner(b, cands[0]);
    heatHosts.add(cands[0].d.id);
  }

  // 2e. 灯的位置由加热几何决定，不能挪；铁架台底座却常常正好压在灯上。
  //     冲突时把铁架台让开（横臂自动变长），这样"夹持 + 加热"两个关系都能同时成立。
  for (const b of placed.values()) {
    if (b.d.type !== "burner") continue;
    const bb = bboxOf(b);
    for (const s of placed.values()) {
      if (s.d.type !== "stand") continue;
      const sb = bboxOf(s);
      const ox = Math.min(bb.x2, sb.x2) - Math.max(bb.x1, sb.x1);
      const oy = Math.min(bb.y2, sb.y2) - Math.max(bb.y1, sb.y1);
      if (ox <= 0 || oy <= 0) continue;
      const shift = ox + 8;
      if (s.cx - shift >= 36) s.cx -= shift;
      else s.cx += shift;
    }
  }


  // 2e-2. 铁架台的底座不许压在器皿上：过滤/蒸馏时它常跟烧杯、锥形瓶同处一格，
  //       底座横穿杯身看起来像"把烧杯钉在架子上"。横向挪开，夹臂自动变长。
  for (const s of placed.values()) {
    if (s.d.type !== "stand" || !s.clamp) continue;
    for (let iter = 0; iter < 6; iter++) {
      const baseW = s.w * 0.5;
      const base = { x1: s.cx - baseW, x2: s.cx + baseW, y1: s.cy + s.h / 2 - 9, y2: s.cy + s.h / 2 };
      const hit = [...placed.values()].find((q) => {
        if (q.d.id === s.d.id || q.d.type === "stand" || q.d.type === "burner") return false;
        const qb = bboxOf(q);
        return (
          Math.min(base.x2, qb.x2) > Math.max(base.x1, qb.x1) && Math.min(base.y2, qb.y2) > Math.max(base.y1, qb.y1)
        );
      });
      if (!hit) break;
      const qb = bboxOf(hit);
      const shift = Math.min(base.x2, qb.x2) - Math.max(base.x1, qb.x1) + 8;
      const left = s.cx <= hit.cx;
      s.cx = left ? s.cx - shift : s.cx + shift;
      // 顶到画布边缘时换到另一侧，别把架子推出画面
      if (s.cx < 34 || s.cx > W - 34) {
        s.cx = left ? hit.cx + qb.x2 - qb.x1 + baseW + 14 : hit.cx - (qb.x2 - qb.x1) - baseW - 14;
        s.cx = Math.max(34, Math.min(W - 34, s.cx));
      }
    }
  }

  // 2f. 导管伸进试管：气流"送进"试管时（或显式 route="into_tube"），导管要穿过管口塞子、
  //     一直伸到管内固体药品上方。只按几何贴到管口画，气体等于从口部直接跑掉，
  //     图上也只是"一根贴在管口外的管子"——这正是 H2 还原 CuO 那张图最刺眼的地方。
  //     导管两端都接线时才算"管路"（有下游）；只连一头 = 这根管子除了进出口没有别的去处。
  const tubeConnCount = new Map<string, number>();
  for (const c of conns) {
    for (const end of [c.from, c.to]) {
      const id = end.split(".")[0];
      if (placed.get(id)?.d.type === "tube") tubeConnCount.set(id, (tubeConnCount.get(id) ?? 0) + 1);
    }
  }
  const tubeBoreOf = new Map<number, { outer: Pt; tip: Pt }>();
  conns.forEach((c, idx) => {
    const [hostId, hostIface] = c.to.split(".");
    const [fromId, fromIface] = c.from.split(".");
    const explicit = c.route === "into_tube";
    const host = placed.get(hostId);
    const from = placed.get(fromId);
    if (!host || !from) return;
    const intoTube = (hp: Placed, hif: string) => {
      if (hp.d.type !== "test_tube" || hp.inverted) return false;
      return /^(mouth_open|top_open)$/.test(hif ?? "");
    };
    // 记下"这根管子穿过管口"：塞子上要给它开孔，不然是凭空穿透一块橡皮塞
    const setBore = (hp: Placed, bore: { outer: Pt; tip: Pt }) => {
      tubeBoreOf.set(idx, bore);
      hp.bore = true;
    };
    // 正写：导管 → 试管口 = 进气，必须伸到固体上方（铁夹连接 from 是铁架台，靠类型排除）
    if (explicit) {
      // 显式 route 优先，方向写反了也照办
      if (intoTube(host, hostIface ?? "")) {
        const bore = tubeBore(host, hostIface ?? "mouth_open", registry);
        if (bore) setBore(host, bore);
      } else if (intoTube(from, fromIface ?? "")) {
        const bore = tubeBore(from, fromIface ?? "mouth_open", registry);
        if (bore) setBore(from, bore);
      }
      return;
    }
    if (intoTube(host, hostIface ?? "") && from.d.type === "tube") {
      const bore = tubeBore(host, hostIface ?? "mouth_open", registry);
      if (bore) setBore(host, bore);
      return;
    }
    // 反过来写（试管口 → 导管）：AI 常照抄"发生装置"的习惯写法，方向写反了。
    // 单端导管 + 加热中的装固体的试管 = 这根试管是被通气的反应管，不是气体发生装置，
    // 导管照样得伸进去——按方向一刀切的话，这种 plan 会画成"气体从管口白白跑掉"。
    // 管口塞棉花是发生装置的标志（防粉末进导管），有棉花就不按这条兜底。
    if (!intoTube(from, fromIface ?? "") || from.d.type !== "test_tube") return;
    if (from.d.params?.solid_chunks !== true || from.d.params?.has_cotton === true) return;
    if (!heatHosts.has(from.d.id)) return;
    if ((tubeConnCount.get(hostId) ?? 0) !== 1) return;
    const bore = tubeBore(from, fromIface ?? "mouth_open", registry);
    if (bore) setBore(from, bore);
  });

  // 3. 管口被穿透的器皿补橡皮塞（试管/烧瓶/试剂瓶；集气瓶平时盖玻璃片，但口部插了器械就得换成打孔塞）
  const MOUTH_IFACE = /^(mouth_open|top_open|top_out)$/;
  for (const c of conns) {
    for (const end of [c.from, c.to]) {
      const [id, iface] = end.split(".");
      const p = placed.get(id);
      if (!p || !MOUTH_IFACE.test(iface ?? "")) continue;
      // 倒扣器皿的口朝下（多半还浸在水里），不该有塞子——塞住就收不到气了
      if (p.inverted) continue;
      // 倾斜试管也要塞：导管从管口通入，管口不塞就是"敞着口收集氢气"
      if (p.d.type === "test_tube" || p.d.type === "flask" || p.d.type === "bottle") p.stopper = true;
    }
  }
  for (const hostId of hostInserts.keys()) {
    const p = placed.get(hostId);
    if (p && p.d.type === "gas_jar") p.stopper = true; // 塞子取代玻璃片，杆才有孔可穿
  }

  // 4. 导管：一进一出 → 不再单独画一个"胶囊"，而是把它走成一条连续管路（模型只管"这里有一根导管"）
  //    管口还插着漏斗的容器，出气管要从塞子另一侧引出（两个孔），否则两根竖管叠在一条线上
  const busyMouth = new Set<string>();
  for (const c of conns) {
    const [toId, toIface] = c.to.split(".");
    if (toIface !== "liquid_inside") continue;
    const src = placed.get(c.from.split(".")[0]);
    if (src && /funnel/.test(src.d.type)) busyMouth.add(toId);
  }
  const pipeOf = new Map<string, { inIdx: number; outIdx: number }>();
  for (const d of devices) {
    if (d.type !== "tube") continue;
    const inIdx = conns.findIndex((c) => c.to.split(".")[0] === d.id);
    const outIdx = conns.findIndex((c) => c.from.split(".")[0] === d.id);
    if (inIdx >= 0 && outIdx >= 0 && inIdx !== outIdx) pipeOf.set(d.id, { inIdx, outIdx });
  }

  // 4a. 单端导管（只连了一头）：不能留在九宫格里当一根悬空的管子。
  //     把管口贴到所连装置的锚点上，沿"装置中心 → 锚点"的方向伸出去——这一头就真的接上了。
  const singleTubeConns: number[] = [];
  for (const d of devices) {
    if (d.type !== "tube" || pipeOf.has(d.id)) continue;
    const tubeP = placed.get(d.id);
    if (!tubeP) continue;
    const idx = conns.findIndex((c) => c.from.split(".")[0] === d.id || c.to.split(".")[0] === d.id);
    if (idx < 0) continue;
    const c = conns[idx];
    const tubeIsFrom = c.from.split(".")[0] === d.id;
    const otherId = (tubeIsFrom ? c.to : c.from).split(".")[0];
    const otherIface = (tubeIsFrom ? c.to : c.from).split(".")[1] ?? "";
    const other = placed.get(otherId);
    if (!other) continue;
    const a = anchor(other, otherIface, registry);
    // 伸进试管的导管：管口尖端落在管内固体上方，管身沿管轴向管口外延伸（不再是"贴在管口"）
    const bore = tubeBoreOf.get(idx);
    if (bore) {
      const ux0 = bore.outer[0] - bore.tip[0];
      const uy0 = bore.outer[1] - bore.tip[1];
      const len = Math.hypot(ux0, uy0) || 1;
      const ux = ux0 / len;
      const uy = uy0 / len;
      // 别把管子捅出画布：按方向截一段可用长度（x、y 两个方向都要看）
      const room = Math.min(
        ux > 0.2 ? (W - 14 - bore.tip[0]) / ux : ux < -0.2 ? (bore.tip[0] - 14) / -ux : W,
        uy > 0.2 ? (H - 14 - bore.tip[1]) / uy : uy < -0.2 ? (bore.tip[1] - 14) / -uy : H,
      );
      // 管长 = 管内那段 + 管口外露一截；太短会整根缩在试管里像个内胆
      const minLen = len + 40;
      tubeP.w = Math.min(room, Math.max(minLen, tubeP.w));
      tubeP.angle = Math.atan2(uy, ux);
      tubeP.cx = bore.tip[0] + ux * (tubeP.w / 2);
      tubeP.cy = bore.tip[1] + uy * (tubeP.w / 2);
      singleTubeConns.push(idx);
      continue;
    }
    let dx = a[0] - other.cx;
    let dy = a[1] - other.cy;
    if (other.d.params?.tilted === "down") {
      // 管口朝右下方倾斜：导管就沿试管轴线插进口里，不要按"中心→管口"算（那样会比试管更斜，看着像歪插）
      dx = Math.cos(TILT_RAD);
      dy = Math.sin(TILT_RAD);
    } else if (Math.abs(dy) > 0.7 * (Math.abs(dx) + Math.abs(dy))) {
      // 口在正上方/正下方的容器：导管直着往上会长出画布，改斜向引出
      const side = a[0] > W / 2 ? 1 : -1;
      dx = side * 0.78;
      dy = dy > 0 ? 0.62 : -0.62;
    }
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // 别把管子捅出画布：按方向截一段可用长度
    const room = dx > 0.2 ? (W - 14 - a[0]) / dx : dx < -0.2 ? (a[0] - 14) / -dx : W;
    tubeP.w = Math.max(46, Math.min(tubeP.w, room));
    tubeP.angle = Math.atan2(dy, dx);
    tubeP.cx = a[0] + dx * (tubeP.w / 2 - 1);
    tubeP.cy = a[1] + dy * (tubeP.w / 2 - 1);
    singleTubeConns.push(idx);
  }
  const consumed = new Set<number>();
  // 插入关系已经由几何表达（器械真的画在容器里），不再额外拉一条线——那是噪声
  for (const idx of insertConns) consumed.add(idx);
  // 漏斗颈/温度计已经插进容器口，同样不需要再拉一条线
  for (const idx of neckInConns) consumed.add(idx);
  // 管路件（蒸馏头/冷凝管）与接收瓶已经靠几何对齐，玻璃棒也搭在口上——这些连线不再画
  for (const idx of fittingConns) consumed.add(idx);
  for (const idx of rodConns) consumed.add(idx);
  const pipeLabels: string[] = [];
  /** 导管标注的已占区域：多根导管并排时"导管"两个字会叠在一起糊成一片 */
  const pipeLabelBoxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const putPipeLabel = (x: number, y: number, text: string, anchor: "middle" | "start" = "middle") => {
    const tw = [...text].reduce((a, ch) => a + (/[\u3000-\u9fff]/.test(ch) ? 11 : 6.2), 0) + 6;
    const x1 = anchor === "middle" ? x - tw / 2 : x;
    const x2 = anchor === "middle" ? x + tw / 2 : x + tw;
    let ty = y;
    for (let i = 0; i < 3; i++) {
      const box = { x1, y1: ty - 11, x2, y2: ty + 3 };
      if (!pipeLabelBoxes.some((b) => x1 < b.x2 && x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1)) break;
      ty -= 14;
    }
    pipeLabelBoxes.push({ x1, y1: ty - 11, x2, y2: ty + 3 });
    pipeLabels.push(
      `<text x="${num(x)}" y="${num(ty)}" font-size="11" fill="${TEXT}" text-anchor="${anchor}">${esc(text)}</text>`,
    );
  };
  for (const { inIdx, outIdx } of pipeOf.values()) {
    consumed.add(inIdx);
    consumed.add(outIdx);
  }
  // 单端导管已经贴到装置口上，那条连接不需要再拉一条线（否则管子旁边多出一根斜线）
  for (const idx of singleTubeConns) consumed.add(idx);

  // 4b. 漏斗伸到液面以下：直接把颈管画到液面（不再单独拉一条线），否则颈部"断"在管口，液封看不出来
  conns.forEach((c, idx) => {
    if (consumed.has(idx)) return;
    const [fid, fif] = c.from.split(".");
    const [, tif] = c.to.split(".");
    const f = placed.get(fid);
    const t = placed.get(c.to.split(".")[0]);
    if (!f || !t || fif !== "bottom_out") return;
    if (!/^(long_neck_funnel|separating_funnel)$/.test(f.d.type)) return;
    if (!/^(liquid_inside|bottom_in)$/.test(tif ?? "")) return;
    const levelY = anchor(t, tif ?? "", registry)[1];
    f.neckTo = levelY;
    // 只把颈延长是不够的：漏斗本体还留在九宫格那一格，颈就成了"悬在半空的一根棍"。
    // 把漏斗挪到容器正上方，颈才真的插进容器；塞子上也给它留个孔。
    f.cx = t.cx;
    const mouthY = t.d.params?.tilted === "down" ? t.cy : t.cy - t.h / 2;
    // 上口不能顶出画布（会被裁掉半个漏斗），锥体也不要整个钻进瓶子里
    const lowest = 14 + f.h / 2;
    const highest = mouthY - f.h * 0.3 - 8;
    f.cy = Math.max(lowest, Math.min(f.cy, Math.max(highest, lowest)));
    // 漏斗颈穿过瓶口，那个口一定塞着塞子：否则图上就是个"敞口瓶插着漏斗"，气体全从口跑了
    if (!t.inverted && /^(test_tube|flask|bottle)$/.test(t.d.type)) t.stopper = true;
    if (t.stopper) {
      const halfW = Math.max(3.5, f.w * 0.14);
      t.hole = {
        x1: Math.min(t.hole?.x1 ?? f.cx - halfW, f.cx - halfW),
        x2: Math.max(t.hole?.x2 ?? f.cx + halfW, f.cx + halfW),
      };
    }
    consumed.add(idx);
  });

  // 5. 连线（含管路）与说明编号
  const edges: Array<{ edge: Edge; noteNo: number | null }> = [];
  const extraBadges: string[] = [];
  const notes: string[] = [];
  const takeNote = (text: string | undefined): number | null => {
    if (!text) return null;
    notes.push(text);
    return notes.length;
  };
  const push = (pts: Pt[], style: string, curved?: "quad" | "s", note?: string) => {
    const no = takeNote(note);
    edges.push({ edge: { pts, style, curved }, noteNo: no });
  };

  // 5a. 管路（导管一进一出）：从上游锚点 → 导管横向廊道 → 下游锚点
  const pipeRendered = new Set<string>();
  for (const [tid, { inIdx, outIdx }] of pipeOf) {
    const cin = conns[inIdx];
    const cout = conns[outIdx];
    const [, fromIface] = cin.from.split(".");
    const [, toIface] = cout.to.split(".");
    const a0 = placed.get(cin.from.split(".")[0]);
    const b0 = placed.get(cout.to.split(".")[0]);
    const tubeP = placed.get(tid);
    if (!a0 || !b0 || !tubeP) continue;

    let a = anchor(a0, fromIface ?? "", registry);
    let b = anchor(b0, toIface ?? "", registry);
    // 下游是"导管送气进试管"：先把接驳点挪到管口外侧，末端再沿管轴插到固体上方
    const boreOut = tubeBoreOf.get(outIdx);
    if (boreOut) b = boreOut.outer;
    // 上游是"导管插在试管里"（进气口在管路的起点）：起点挪到管口外，管内那段最后补
    const boreIn = tubeBoreOf.get(inIdx);
    if (boreIn) a = boreIn.outer;
    if (cout.route === "down_into_jar" || cout.route === "up_into_jar") {
      const dx = b0.cx - b[0];
      const dy = b0.cy - b[1];
      const len = Math.hypot(dx, dy) || 1;
      b = [b[0] + (dx / len) * 14, b[1] + (dy / len) * 14];
    }
    // 同一个管口还插着漏斗时，出气管从塞子右边引出，两根竖管不叠在一条线上
    if (/^(mouth_open|top_open)$/.test(fromIface ?? "") && busyMouth.has(a0.d.id)) a = [a[0] + 12, a[1]];

    const laneY = a[1];
    let elbowX = tubeP.cx;
    if ((b[0] - a[0]) * (elbowX - a[0]) <= 0) elbowX = (a[0] + b[0]) / 2;
    let pts: Pt[] = [[a[0], a[1]]];
    if (Math.abs(b[1] - a[1]) < 2) {
      pts.push([b[0], b[1]]); // 同一高度：一条水平管
    } else if (Math.abs(elbowX - a[0]) < 2) {
      pts.push([a[0], b[1]], [b[0], b[1]]);
    } else {
      pts.push([elbowX, laneY], [b[0], laneY], [b[0], b[1]]);
      // 正放容器：横向廊道低于瓶口时，绕到瓶口上方再插下去（不从瓶肩横穿）
      if (toIface === "bottom_in") pts = hookOverMouth(pts, b0);
      if (cout.route === "up_into_jar") pts = diveUnderMouth(pts, b0);
    }
    // 末端沿管轴穿过塞子，管口停在固体药品上方（接驳点已在管口外侧）
    if (boreOut) pts.push(boreOut.tip);
    // 起点在试管内：从固体上方那一点开始，先出管口再走廊道
    if (boreIn) pts.unshift(boreIn.tip);
    const no = takeNote(cin.note ?? cout.note);
    edges.push({ edge: { pts, style: cout.style || cin.style }, noteNo: no });
    // 两端都有说明时，第二处编号单独挂在竖管上（不重复描一遍线）
    if (cin.note && cout.note) {
      notes.push(cout.note);
      const mid = pointAt(pts.slice(-2), 0.55);
      extraBadges.push(badgeAt([mid, mid], notes.length, 0.5));
    }
    pipeRendered.add(tid);
    // 导管标注写在横向廊道中点上方
    const span = Math.abs((pts[1] ?? pts[0])[0] - pts[0][0]);
    if (span > 20 && pts.length >= 3) {
      putPipeLabel((a[0] + pts[1][0]) / 2, laneY - 8, tubeP.d.label);
    } else {
      // 末段插进试管时，标注挂在管口外的接驳点上，别写进管身内部
      const last = pts[pts.length - 1];
      const at = boreOut ? pts[pts.length - 2] : last;
      putPipeLabel(at[0] + 8, at[1] - 6, tubeP.d.label, "start");
    }
  }

  // 5b. 其余连线
  conns.forEach((c, idx) => {
    if (consumed.has(idx)) {
      // 插入关系不画线，但它的说明仍然要进图注（"燃烧匙伸入瓶内"这类信息不能丢）
      if (insertConns.has(idx)) takeNote(c.note);
      return;
    }
    const [fromId, fromIface] = c.from.split(".");
    const [toId, toIface] = c.to.split(".");
    const a = placed.get(fromId);
    const b = placed.get(toId);
    if (!a || !b) return;
    // 铁夹已由铁架台的夹臂表达，不再画一条横跨半张图的虚线
    if (fromIface === "clamp" && a.clamp) return;
    const pa = anchor(a, fromIface ?? "", registry);
    let pb = anchor(b, toIface ?? "", registry);
    if (c.route === "down_into_jar" || c.route === "up_into_jar") {
      const dx = b.cx - pb[0];
      const dy = b.cy - pb[1];
      const len = Math.hypot(dx, dy) || 1;
      pb = [pb[0] + (dx / len) * 14, pb[1] + (dy / len) * 14];
    }
    const ortho =
      c.route === "orthogonal" ||
      c.route === "orthogonal_down" ||
      c.route === "down_into_jar" ||
      c.route === "up_into_jar";
    if (ortho && Math.abs(pb[0] - pa[0]) > 2 && Math.abs(pb[1] - pa[1]) > 2) {
      let pts: Pt[] = [pa, [pb[0], pa[1]], [pb[0], pb[1]]];
      if (c.route === "down_into_jar") pts = hookOverMouth(pts, b);
      if (c.route === "up_into_jar") pts = diveUnderMouth(pts, b);
      push(pts, c.style, undefined, c.note);
      // 折线拐角处单独编号没意义，说明统一进图注
      return;
    }
    if (c.route === "s_curve" && Math.abs(pb[0] - pa[0]) > 2 && Math.abs(pb[1] - pa[1]) > 2) {
      push([pa, pb], c.style, "s", c.note);
      return;
    }
    if (c.style === "curve") {
      push([pa, pb], c.style, "quad", c.note);
      return;
    }
    push([pa, pb], c.style, undefined, c.note);
  });

  // 6. 玻璃片自动补全：有连接伸入 auto_plate.when_iface、画面里既没有水（非排水法）也没玻璃片 → 引擎补一块
  const hasWater = devices.some((d) => d.params?.liquid_level != null);
  const hasPlate = devices.some((d) => types[d.type]?.is_plate || d.params?.has_glass_plate === true);
  const plateIds = new Set<string>();
  if (!hasWater && !hasPlate) {
    for (const [id, p] of placed) {
      const ap = types[p.d.type]?.auto_plate;
      if (!ap) continue;
      const targeted = conns.some((c) => {
        const [tid, tif] = c.to.split(".");
        return tid === id && tif === ap.when_iface;
      });
      if (targeted) plateIds.add(id);
    }
  }

  // 7. 标签排布：默认贴装置下方；被别的装置或已放标签压住就换到上方/右侧/左侧。
  //    之前一律 cy+h/2+14，倒扣试管插进水槽后，标签正好落在水槽身上。
  const boxes = [...placed.values()].map((p) => {
    const b = bboxOf(p);
    return { id: p.d.id, x1: b.x1 - 2, y1: b.y1 - 2, x2: b.x2 + 2, y2: b.y2 + 2 };
  });
  const usedLabels: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const textW = (s: string, fs = 12) => {
    let wt = 0;
    for (const ch of s) wt += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? fs : fs * 0.56;
    return wt;
  };
  const hits = (
    a: { x1: number; y1: number; x2: number; y2: number },
    b: { x1: number; y1: number; x2: number; y2: number },
  ) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  for (const p of placed.values()) {
    const tw = textW(p.d.label);
    const th = 13;
    // 候选位置按"真实外框"算（倾斜试管/旋转导管的框比轴对齐框大，按 p.h/2 算会压回装置身上）
    const bb = bboxOf(p);
    const midX = (bb.x1 + bb.x2) / 2;
    const midY = (bb.y1 + bb.y2) / 2;
    const cands: Array<{ x: number; y: number; anchor: "middle" | "start" | "end" }> = [
      { x: midX, y: bb.y2 + 14, anchor: "middle" },
      { x: midX, y: bb.y1 - 6, anchor: "middle" },
      { x: bb.x2 + 8, y: midY + 4, anchor: "start" },
      { x: bb.x1 - 8, y: midY + 4, anchor: "end" },
      // 并排的两件同类装置（甲乙试管/两根电极）标签会抢同一个位置，往上一层一层摞
      { x: midX, y: bb.y1 - 20, anchor: "middle" },
      { x: midX, y: bb.y1 - 34, anchor: "middle" },
      // 旁边有铁架台/酒精灯时下方和上方都被占，往再外一层推、或贴住装置上沿左右错开
      { x: midX, y: bb.y2 + 28, anchor: "middle" },
      { x: midX, y: bb.y2 + 42, anchor: "middle" },
      { x: bb.x2, y: bb.y1 - 6, anchor: "end" },
      { x: bb.x1, y: bb.y1 - 6, anchor: "start" },
      { x: midX, y: bb.y1 - 48, anchor: "middle" },
    ];
    // 插在容器里的器械（电极/燃烧匙/倒扣试管）自身四周全被宿主占着，
    // 标签只能挂到宿主外面去——否则只能压回宿主身上。
    const host = insertHost.get(p.d.id) ? placed.get(insertHost.get(p.d.id)!.host) : undefined;
    if (host) {
      cands.push(
        { x: host.cx, y: host.cy - host.h / 2 - 8, anchor: "middle" },
        { x: host.cx, y: host.cy + host.h / 2 + 16, anchor: "middle" },
        { x: host.cx + host.w / 2 + 8, y: host.cy + 4, anchor: "start" },
        { x: host.cx - host.w / 2 - 8, y: host.cy + 4, anchor: "end" },
      );
    }
    const rectOf = (c: { x: number; y: number; anchor: "middle" | "start" | "end" }) => ({
      x1: c.anchor === "middle" ? c.x - tw / 2 : c.anchor === "start" ? c.x : c.x - tw,
      x2: c.anchor === "middle" ? c.x + tw / 2 : c.anchor === "start" ? c.x + tw : c.x,
      y1: c.y - th + 3,
      y2: c.y + 3,
    });
    const inCanvas = (r: { x1: number; y1: number; x2: number; y2: number }) =>
      r.y1 >= 6 && r.x1 >= 4 && r.x2 <= W - 4;
    const chosen =
      cands.find((c) => {
        const r = rectOf(c);
        // 标签被裁掉一半（贴到画布边缘）不算"避开"，否则长颈漏斗这种顶到上沿的装置永远标不出名字
        return inCanvas(r) && !boxes.some((b) => b.id !== p.d.id && hits(b, r)) && !usedLabels.some((u) => hits(u, r));
      }) ??
      // 所有候选都压着东西时，退到"压得最少"的那个——不要无脑用第一个（那是装置正下方，最显眼）
      cands.reduce((best, c) => {
        const areaOf = (cc: typeof c) => {
          const r = rectOf(cc);
          let sum = 0;
          // 标签跑出画布等于没标（会被裁掉），当作最差
          if (r.y1 < 6 || r.x1 < 4 || r.x2 > W - 4) sum += 1e5;
          for (const b of boxes) {
            if (b.id === p.d.id) continue;
            const w = Math.min(b.x2, r.x2) - Math.max(b.x1, r.x1);
            const h = Math.min(b.y2, r.y2) - Math.max(b.y1, r.y1);
            if (w > 0 && h > 0) sum += w * h;
          }
          for (const u of usedLabels) {
            const w = Math.min(u.x2, r.x2) - Math.max(u.x1, r.x1);
            const h = Math.min(u.y2, r.y2) - Math.max(u.y1, r.y1);
            if (w > 0 && h > 0) sum += w * h;
          }
          return sum;
        };
        return areaOf(c) < areaOf(best) ? c : best;
      }, cands[0]);
    // 最后一道保险：兜底候选也可能贴边，平移回画布内（宁可压图也不要被裁掉）
    const rr = rectOf(chosen);
    let lx = 0;
    let ly = 0;
    if (rr.y1 < 6) ly = 6 - rr.y1;
    if (rr.x1 < 4) lx = 4 - rr.x1;
    if (rr.x2 > W - 4) lx = W - 4 - rr.x2;
    const finalAt = lx || ly ? { ...chosen, x: chosen.x + lx, y: chosen.y + ly } : chosen;
    usedLabels.push(rectOf(finalAt));
    p.labelAt = finalAt;
  }

  // 8. 装置符号：器皿先画（白底遮挡），插入件/支架后画（保证"伸进去"的部分可见）
  const vessels: string[] = [];
  const instruments: string[] = [];
  for (const p of placed.values()) {
    if (pipeRendered.has(p.d.id)) continue; // 导管已并进管路
    const svg = glyph(p, types[p.d.type], plateIds.has(p.d.id));
    // 插入件、浸在水里的倒扣器皿必须画在宿主之上，否则被宿主的白底吞掉，看着像"断在水面"
    const isInstrument =
      INSTRUMENT.has(p.d.type) ||
      p.d.type === "stand" ||
      p.d.type === "burner" ||
      types[p.d.type]?.mount === "insert" ||
      insertHost.has(p.d.id) ||
      p.inWater === true;
    (isInstrument ? instruments : vessels).push(svg);
  }

  // 8. 图注：编号 + 说明，排在图的下方（此前把 note 直接压在图上，两三条就糊成一片）
  const ROW = 15;
  const notesSvg = notes.length
    ? `<line x1="10" y1="${num(H + 4)}" x2="${W - 10}" y2="${num(H + 4)}" stroke="#e5e5e5" stroke-width="1"/>` +
      notes
        .map((t, i) => {
          const cy0 = H + 18 + i * ROW;
          return (
            `<circle cx="20" cy="${num(cy0)}" r="7" fill="#ffffff" stroke="${INK}" stroke-width="1"/>` +
            `<text x="20" y="${num(cy0 + 3.2)}" font-size="9" fill="${INK}" text-anchor="middle">${i + 1}</text>` +
            `<text x="34" y="${num(cy0 + 3.8)}" font-size="10.5" fill="${TEXT}">${esc(t)}</text>`
          );
        })
        .join("")
    : "";
  const totalH = H + (notes.length ? 18 + notes.length * ROW + 4 : 0);

  return (
    `<svg data-dg="1" viewBox="0 0 ${W} ${num(totalH)}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><marker id="dg-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">` +
    `<path d="M 0 0 L 8 4 L 0 8 Z" fill="${ACCENT}"/>` +
    `</marker></defs>` +
    vessels.join("") +
    edges.map((e) => edgeMarkup(e.edge, e.noteNo)).join("") +
    extraBadges.join("") +
    instruments.join("") +
    pipeLabels.join("") +
    notesSvg +
    `</svg>`
  );
}
