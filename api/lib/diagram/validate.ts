/**
 * 布局计划通用校验器（L1–L5）。
 * L1 结构（zod）在调用方做；这里做 L2 引用完整性 / L3 数量一致性 / L4 区域容量 / L5 学科规则。
 * 代码通用，不含任何学科字面量；L5 规则全部来自配置。
 */
import type { Device, LayoutPlan, Pos, RegistryFile, Rule } from "./config";
import { layoutPlanSchema } from "./config";

export interface ValidationError {
  code: string;
  message: string;
  refs: string[];
  /** fatal=true 才进入模型修正轮；接口未知这类只告警（模型常给装置加自定义接口，资料自带示例也如此） */
  fatal: boolean;
}

/** 12 格映射到网格坐标：列 0/1/2，行 0/1/2/3（底部行为 3） */
export const POS_GRID: Record<Pos, [number, number]> = {
  left_top: [0, 0], left_center: [0, 1], left_bottom: [0, 2],
  center_top: [1, 0], center: [1, 1], center_bottom: [1, 2],
  right_top: [2, 0], right_center: [2, 1], right_bottom: [2, 2],
  bottom_left: [0, 3], bottom_center: [1, 3], bottom_right: [2, 3],
};

export function isAdjacent(a: Pos, b: Pos): boolean {
  const [ax, ay] = POS_GRID[a];
  const [bx, by] = POS_GRID[b];
  return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1 && !(ax === bx && ay === by);
}

export function satisfiesRelation(a: Pos, b: Pos, rel: string): boolean {
  const [ax, ay] = POS_GRID[a];
  const [bx, by] = POS_GRID[b];
  switch (rel) {
    case "below": return ay > by;
    case "above": return ay < by;
    case "left_of": return ax < bx;
    case "right_of": return ax > bx;
    default: return true;
  }
}

/** L1：结构校验。返回 null 表示通过，否则返回给模型可读的错误描述 */
export function checkPlanSchema(raw: unknown): { plan: LayoutPlan } | { errors: ValidationError[] } {
  const parsed = layoutPlanSchema.safeParse(raw);
  if (parsed.success) return { plan: parsed.data };
  return {
    errors: parsed.error.issues.slice(0, 8).map((i) => ({
      code: "SCHEMA",
      message: `${i.path.join(".") || "/"}: ${i.message}`,
      refs: [],
      fatal: true,
    })),
  };
}

function splitEndpoint(end: string): [string, string] {
  const i = end.indexOf(".");
  return i < 0 ? [end, ""] : [end.slice(0, i), end.slice(i + 1)];
}

export function validatePlan(plan: LayoutPlan, registry: RegistryFile | undefined, rules: Rule[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const push = (code: string, message: string, refs: string[] = [], fatal = true) =>
    errors.push({ code, message, refs, fatal });

  // L2: id 唯一 + 类型/接口在注册表内
  const seen = new Set<string>();
  for (const d of plan.devices) {
    if (seen.has(d.id)) push("DUPLICATE_ID", `重复 id: ${d.id}`, [d.id]);
    seen.add(d.id);
    const def = registry?.types[d.type];
    if (!def) {
      push("UNKNOWN_TYPE", `未知装置类型: ${d.type}（${d.id}）`, [d.id]);
      continue;
    }
    for (const iface of d.interface) {
      if (!(iface in def.interfaces))
        push("UNKNOWN_INTERFACE", `${d.id} 声明了类型 ${d.type} 没有的接口 ${iface}`, [d.id, iface], false);
    }
  }

  // L2: connection 端点引用存在、接口在装置声明的 interface 里
  const deviceById = new Map<string, Device>(plan.devices.map((d) => [d.id, d]));
  for (const c of plan.connections) {
    for (const [end, label] of [[c.from, "from"], [c.to, "to"]] as const) {
      const [id, iface] = splitEndpoint(end);
      const dev = deviceById.get(id);
      if (!dev) push("MISSING_REF", `${label} 引用了不存在的装置: ${id}`, [end]);
      else if (iface && !dev.interface.includes(iface))
        push("BAD_IFACE_REF", `${label} 接口未在装置中声明: ${end}`, [end], false);
    }
  }

  // L3: 数量一致性
  const actual: Record<string, number> = {};
  for (const d of plan.devices) actual[d.type] = (actual[d.type] ?? 0) + 1;
  for (const [type, n] of Object.entries(plan.expected_counts)) {
    if ((actual[type] ?? 0) !== n)
      push("COUNT_MISMATCH", `${type} 计划 ${n} 个，实际 ${actual[type] ?? 0} 个`, [type]);
  }
  const sumExpected = Object.values(plan.expected_counts).reduce((a, b) => a + b, 0);
  if (sumExpected !== plan.devices.length)
    push("COUNT_SUM_MISMATCH", `expected_counts 总和 ${sumExpected} 与 devices 数量 ${plan.devices.length} 不一致`);
  for (const type of Object.keys(actual)) {
    if (plan.expected_counts[type] == null)
      push("UNEXPECTED_TYPE", `devices 中有 ${type} 但 expected_counts 未列出`, [type]);
  }

  // L4: 区域容量（取同区域装置的注册表容量，缺省 2）
  //     插进同区域容器里的装置不算占位——倒扣试管本来就要和水槽待在同一格，否则它必然悬空
  const nested = new Set<string>();
  for (const c of plan.connections) {
    const [fromId] = splitEndpoint(c.from);
    const [, toIface] = splitEndpoint(c.to);
    const from = deviceById.get(fromId);
    const inserts =
      /^(liquid_inside|bottom_in|top_in|inside)$/.test(toIface) ||
      (/^(mouth_open|top_open)$/.test(toIface) && from?.params?.inverted === true);
    if (inserts) nested.add(fromId);
  }
  const byRegion = new Map<Pos, Device[]>();
  for (const d of plan.devices) {
    if (nested.has(d.id)) continue;
    const list = byRegion.get(d.relative_position) ?? [];
    list.push(d);
    byRegion.set(d.relative_position, list);
  }
  for (const [region, list] of byRegion) {
    const cap = Math.min(...list.map((d) => registry?.types[d.type]?.region_capacity ?? 2));
    if (list.length > cap)
      push("REGION_OVERFLOW", `${region} 区域放了 ${list.length} 个装置，超出容量 ${cap}`, list.map((d) => d.id));
  }

  // L5: 学科规则（配置驱动的通用执行器）
  const matchTypes = (d: Device, types: string[] | undefined) =>
    !!types && (types.includes("*") || types.includes(d.type));
  for (const r of rules) {
    switch (r.kind) {
      case "position_relation": {
        const aList = plan.devices.filter((d) => d.type === r.a_type);
        const bList = plan.devices.filter((d) => matchTypes(d, r.b_type));
        for (const a of aList) {
          if (!bList.some((b) => satisfiesRelation(a.relative_position, b.relative_position, r.relation!)))
            push("RULE_VIOLATION", r.message, [a.id]);
        }
        break;
      }
      case "must_be_adjacent": {
        const aList = plan.devices.filter((d) => d.type === r.a_type);
        const bList = plan.devices.filter((d) => matchTypes(d, r.b_type) && d.id !== r.a_type);
        for (const a of aList) {
          const others = bList.filter((b) => b.id !== a.id);
          if (!others.some((b) => isAdjacent(a.relative_position, b.relative_position)))
            push("RULE_VIOLATION", r.message, [a.id]);
        }
        break;
      }
      case "position_in": {
        for (const a of plan.devices.filter((d) => d.type === r.a_type)) {
          if (!(r.allowed as Pos[]).includes(a.relative_position)) push("RULE_VIOLATION", r.message, [a.id]);
        }
        break;
      }
      case "connection_direction": {
        for (const c of plan.connections) {
          const from = deviceById.get(splitEndpoint(c.from)[0]);
          const to = deviceById.get(splitEndpoint(c.to)[0]);
          if (from && to && from.type === r.from_type && to.type === r.to_type) {
            if (!satisfiesRelation(from.relative_position, to.relative_position, r.direction!))
              push("RULE_VIOLATION", r.message, [from.id, to.id]);
          }
        }
        break;
      }
      case "connection_required": {
        // 每个 from_type 装置都必须有一条从它出发、指向 b_type 装置的连接（如长颈漏斗必须连到反应容器）
        const targets = new Set(plan.devices.filter((d) => matchTypes(d, r.b_type)).map((d) => d.id));
        for (const a of plan.devices.filter((d) => d.type === r.from_type)) {
          const ok = plan.connections.some((c) => {
            const [fromId] = splitEndpoint(c.from);
            const [toId] = splitEndpoint(c.to);
            return fromId === a.id && targets.has(toId);
          });
          if (!ok) push("RULE_VIOLATION", r.message, [a.id]);
        }
        break;
      }
      case "must_be_connected": {
        // 图上有好几个装置时，玻璃器皿不该是孤岛：没有一条连接=图上看不出它和谁相通（典型错误：试剂瓶/试管悬空摆着）
        if (plan.devices.length < 2) break;
        for (const a of plan.devices.filter((d) => d.type === r.a_type)) {
          const linked = plan.connections.some(
            (c) => splitEndpoint(c.from)[0] === a.id || splitEndpoint(c.to)[0] === a.id,
          );
          if (!linked) push("ORPHAN_DEVICE", r.message, [a.id]);
        }
        break;
      }
      case "connection_endpoint": {
        // 任何以 to_type 装置为终点的连接，都必须用指定的接口（如导管连集气瓶必须接 bottom_in）
        for (const c of plan.connections) {
          const [toId, toIface] = splitEndpoint(c.to);
          const to = deviceById.get(toId);
          if (to?.type === r.to_type && toIface !== r.to_iface)
            push("RULE_VIOLATION", r.message, [c.to]);
        }
        break;
      }
    }
  }

  // L6: 化学领域硬规则（主构架文档 validator.ts，写死防幻觉；通用规则仍走上面的配置层）
  if (plan.subject === "chemistry") validateChemistryDomainRules(plan, push);

  return errors;
}

/**
 * 化学实验装置硬校验（企业级主构架：把大模型当初实习生，画完必须过"老教授"审查）。
 * 规则一 液封铁律 / 规则二 固体加热倾斜与管口出气 / 规则三 排空气法长进短出。
 */
function validateChemistryDomainRules(
  plan: LayoutPlan,
  push: (code: string, message: string, refs?: string[], fatal?: boolean) => void,
): void {
  const hasBurner = plan.devices.some((d) => d.type === "burner");

  // 规则一：长颈漏斗必须液封——从 bottom_out 出发，连到某容器的 liquid_inside（液面以下）
  for (const funnel of plan.devices.filter((d) => d.type === "long_neck_funnel")) {
    const sealConn = plan.connections.find((c) => c.from === `${funnel.id}.bottom_out`);
    if (!sealConn) {
      push("LIQUID_SEAL", `长颈漏斗 ${funnel.id} 未从 bottom_out 引出连接，无法形成液封`, [funnel.id]);
      continue;
    }
    const [, toIface] = splitEndpoint(sealConn.to);
    if (toIface !== "liquid_inside")
      push(
        "LIQUID_SEAL",
        `长颈漏斗下端必须伸入液面以下（连接到容器的 liquid_inside），否则气体从漏斗逸出；当前接到了 ${sealConn.to}`,
        [funnel.id, sealConn.to],
      );
  }

  // 规则二：有加热（存在酒精灯）时，试管口必须略向下倾斜，且导管只能从管口引出
  for (const tube of plan.devices.filter((d) => d.type === "test_tube")) {
    if (hasBurner && tube.params?.tilted !== "down")
      push("TUBE_TILT", `加热时试管 ${tube.id} 的管口必须略向下倾斜（params.tilted="down"），防冷凝水倒流炸裂`, [tube.id]);
    if (hasBurner && tube.params?.has_cotton !== true)
      push("COTTON_HINT", `加热固体制气时试管口通常要塞棉花（params.has_cotton=true）`, [tube.id], false);
    for (const c of plan.connections.filter((c) => splitEndpoint(c.from)[0] === tube.id)) {
      const [, fromIface] = splitEndpoint(c.from);
      if (fromIface !== "mouth_open" && fromIface !== "top_open")
        push("TUBE_OUTLET", `导管必须从试管口（mouth_open）引出，绝对不可从管身中部穿出；当前从 ${c.from} 引出`, [tube.id]);
    }
  }

  // 规则三：排空气法收集——正放（向上排空气）必须盖玻璃片且导管到底（长进短出）；倒扣从瓶口进
  for (const jar of plan.devices.filter((d) => d.type === "gas_jar")) {
    const inlet = plan.connections.find((c) => splitEndpoint(c.to)[0] === jar.id);
    // 燃烧匙/电极这类"器械插进去"不是排空气法的进气管：杆要穿过瓶口，瓶口不能盖玻璃片。
    const inletFrom = inlet ? plan.devices.find((d) => d.id === splitEndpoint(inlet.from)[0]) : undefined;
    const instrument = /^(combustion_spoon|electrode|thermometer|glass_rod)$/.test(inletFrom?.type ?? "");
    if (jar.params?.inverted !== true) {
      // 向上排空气法（收集 CO2 等重气体）
      if (inlet && !instrument && jar.params?.has_glass_plate !== true)
        push("GLASS_PLATE", `向上排空气法的集气瓶 ${jar.id} 瓶口必须盖玻璃片（params.has_glass_plate=true）`, [jar.id]);
      if (inlet && !instrument) {
        const [, toIface] = splitEndpoint(inlet.to);
        if (toIface !== "bottom_in")
          push("JAR_INTAKE", `向上排空气法导管必须伸到集气瓶底部（bottom_in，长进短出）；当前接到了 ${inlet.to}`, [jar.id]);
      }
    } else if (inlet) {
      // 倒置后瓶口在下方：进气/进水都从瓶口进（top_in）；bottom_in 是封闭的瓶底，不能接
      const [, toIface] = splitEndpoint(inlet.to);
      if (toIface !== "top_in")
        push("JAR_INTAKE", `倒置集气瓶必须从瓶口进气（top_in）；bottom_in 是封底，接上去等于把管子插进瓶底；当前接到了 ${inlet.to}`, [jar.id]);
    }
  }

  // 规则四：过滤必须放滤纸（漏斗里没纸 = 固体全进滤液，过滤就白做了）
  for (const f of plan.devices.filter((d) => d.type === "funnel")) {
    if (f.params?.has_filter_paper !== true)
      push("FILTER_PAPER", `过滤漏斗 ${f.id} 必须放滤纸（params.has_filter_paper=true）`, [f.id]);
  }

  // 规则五：量筒只量体积——不能加热，也不能当反应容器（受热炸裂、刻度失准）
  const heatedNow = new Set<string>();
  for (const c of plan.connections) {
    const [, fif] = splitEndpoint(c.from);
    if (fif === "flame") heatedNow.add(splitEndpoint(c.to)[0]);
  }
  for (const cy of plan.devices.filter((d) => d.type === "cylinder")) {
    const wired = plan.connections.some((c) => splitEndpoint(c.from)[0] === cy.id || splitEndpoint(c.to)[0] === cy.id);
    if (heatedNow.has(cy.id) || wired)
      push("CYLINDER_USE", `量筒 ${cy.id} 只用于量取液体体积，不能加热、也不能当反应容器或接导管`, [cy.id], false);
  }
}

/** 把校验错误转成给模型的修正提示（只含 fatal；warning 进日志） */
export function buildFixFeedback(errors: ValidationError[]): string {
  const fatal = errors.filter((e) => e.fatal);
  return [
    "上一轮布局计划存在以下问题，请只修正这些问题并重新输出完整的布局计划 JSON，不要输出其他内容：",
    ...fatal.map(
      (e, i) => `${i + 1}. [${e.code}] ${e.message}${e.refs.length ? `（涉及: ${e.refs.join(", ")}）` : ""}`,
    ),
  ].join("\n");
}
