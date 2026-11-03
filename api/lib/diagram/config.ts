/**
 * 布局计划图示体系：类型定义 + 配置加载。
 *
 * 架构（与课程建设者约定）：
 * - 模型只输出「布局计划 JSON」（装置清单 + 相对位置 + 连接关系），绝不输出坐标/SVG；
 * - 代码做三件事：读配置 → 通用校验（validate.ts）→ 按相对位置映射坐标渲染 SVG（render.ts）；
 * - 学科规则与装置注册表全部是 config/diagram/*.json 数据文件，代码里不出现学科字面量。
 *
 * 配置文件在进程启动后首次使用时加载并缓存；加载失败会抛错（配置是课程建设者填的，
 * 错了应该在启动/测试阶段暴露，而不是静默 fallback 出怪图）。
 */
import { readFileSync } from "fs";
import path from "path";
import { z } from "zod";

/** 12 宫格相对位置：9 宫格 + 底部左中右（图例/比例尺/标注条常用） */
export const POSITIONS = [
  "left_top", "left_center", "left_bottom",
  "center_top", "center", "center_bottom",
  "right_top", "right_center", "right_bottom",
  "bottom_left", "bottom_center", "bottom_right",
] as const;
export type Pos = (typeof POSITIONS)[number];

export const SUBJECTS = ["chemistry", "physics", "biology", "geography"] as const;
export type Subject = (typeof SUBJECTS)[number];

/* ── 布局计划 Schema（模型输出的 L1 结构校验） ───────────── */

/**
 * 装置参数（主构架文档的 DeviceParams，外加前面资料补充的 particles）。
 * 模型只填语义，具体图形全部由渲染引擎确定性生成。
 */
export const deviceParamsSchema = z.object({
  /** 容器内液面高度（0~1，0.7 = 装七成水），引擎据此自动画波浪水面 */
  liquid_level: z.number().min(0.05).max(0.95).optional(),
  /** 容器底部有固体药品（大理石/锌粒/高锰酸钾），引擎自动画灰块 */
  solid_chunks: z.boolean().optional(),
  /** 集气瓶倒置（向下排空气法 / 排水法） */
  inverted: z.boolean().optional(),
  /** 集气瓶口盖玻璃片（向上排空气法必须 true） */
  has_glass_plate: z.boolean().optional(),
  /** 试管口向下倾斜（固体加热防冷凝水倒流炸裂） */
  tilted: z.enum(["down", "none"]).optional(),
  /** 试管口塞棉花（高锰酸钾制氧防粉末进入导管） */
  has_cotton: z.boolean().optional(),
  /** 漏斗里放折好的滤纸（过滤必须 true；引擎在锥壁内侧画一圈贴壁滤纸） */
  has_filter_paper: z.boolean().optional(),
  /** 坩埚/蒸发皿加盖（灼烧后冷却、防飞溅） */
  has_cover: z.boolean().optional(),
  /** 微观粒子语义：bubbles = 液面下升起的气泡 */
  particles: z.enum(["bubbles"]).optional(),
});
export type DeviceParams = z.infer<typeof deviceParamsSchema>;

export const layoutPlanSchema = z.object({
  subject: z.enum(SUBJECTS),
  canvas_hint: z.enum(["single_column", "two_column", "ring", "map_standard"]),
  devices: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        type: z.string().min(1).max(64),
        label: z.string().min(1).max(30),
        relative_position: z.enum(POSITIONS),
        interface: z.array(z.string().max(40)).max(8),
        params: deviceParamsSchema.optional(),
      }),
    )
    .min(1)
    .max(12),
  connections: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        style: z.enum(["straight", "curve", "dashed", "arrow"]),
        /**
         * 走线方式：直角折线/导管下插/S 曲线；缺省按 style 画直线或圆弧。
         * down_into_jar = 从上方进入集气瓶（向上排空气）；up_into_jar = 从下方伸入倒置瓶口（排水法）；
         * into_tube = 气体送入试管：导管穿过管口塞子伸到管内固体药品上方（H2/CuO、CO 还原金属氧化物）。
         */
        route: z
          .enum(["straight", "orthogonal", "orthogonal_down", "s_curve", "down_into_jar", "up_into_jar", "into_tube"])
          .optional(),
        note: z.string().max(30).optional(),
      }),
    )
    .max(16),
  expected_counts: z.record(z.string(), z.number().int().min(1)),
  notes: z.string().max(200).optional(),
});
export type LayoutPlan = z.infer<typeof layoutPlanSchema>;
export type Device = LayoutPlan["devices"][number];

/* ── 注册表 / 学科规则 Schema（配置文件的加载期校验） ───────────── */

/** 接口锚点：在装置包围盒里的相对坐标（0~1，y=0 为顶部）——连线端点用它算，不再连装置中心 */
const ifacePointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

const deviceTypeSchema = z.object({
  display_name: z.string().min(1),
  default_size: z.tuple([z.number().positive(), z.number().positive()]),
  interfaces: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), ifacePointSchema),
  region_capacity: z.number().int().min(1).max(6).optional(),
  /**
   * 装配角色：决定"插进别人身体里"这类关系怎么落位。
   * vessel=容器（提供内部空间，可被插入）；insert=细长器械（会插进容器，必须吸附到宿主口/液面）；
   * fixture=支架/热源/电源等外挂件（不受装配约束，按位置关系摆）。缺省按 vessel 处理。
   */
  mount: z.enum(["vessel", "insert", "fixture"]).optional(),
  /**
   * 是否属于"实验装置件"：为 true 时禁止模型手写 SVG 绘制（必须走布局计划），
   * 也是手写 SVG 拦截器的词表来源。地图要素/纯抽象图形不要标。
   */
  apparatus: z.boolean().optional(),
  /** 有连接伸入 when_iface 且画面里没有水、没有玻璃片时，引擎自动在瓶口补一块玻璃片（排空气法） */
  auto_plate: z.object({ when_iface: z.string() }).optional(),
  /** 标记"我是玻璃片类型"，配合 auto_plate 防止重复补片 */
  is_plate: z.boolean().optional(),
});
export type DeviceTypeDef = z.infer<typeof deviceTypeSchema>;

const registryFileSchema = z.object({
  subject: z.enum(SUBJECTS),
  types: z.record(z.string(), deviceTypeSchema),
});
export type RegistryFile = z.infer<typeof registryFileSchema>;

const ruleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  kind: z.enum([
    "position_relation",
    "must_be_adjacent",
    "position_in",
    "connection_direction",
    "connection_required",
    "connection_endpoint",
    "must_be_connected",
  ]),
  message: z.string().min(4).max(200),
  a_type: z.string().min(1).optional(),
  b_type: z.array(z.string().min(1)).min(1).optional(),
  relation: z.enum(["above", "below", "left_of", "right_of"]).optional(),
  direction: z.enum(["above", "below", "left_of", "right_of"]).optional(),
  from_type: z.string().min(1).optional(),
  to_type: z.string().min(1).optional(),
  to_iface: z.string().min(1).optional(),
  allowed: z.array(z.enum(POSITIONS)).min(1).optional(),
});
export type Rule = z.infer<typeof ruleSchema>;

const rulesFileSchema = z.record(z.string(), z.array(ruleSchema));

/** 配置加载结果：注册表按学科分桶 + 规则按学科分桶 */
export interface DiagramConfig {
  registries: Record<string, RegistryFile>;
  rules: Record<string, Rule[]>;
}

/** 配置目录：打包后 dist/boot.js 的运行 cwd 是项目根目录，直接相对 cwd 找 config/diagram */
function configDir(): string {
  return path.resolve(process.cwd(), "config", "diagram");
}

/** Schema 之外的跨项一致性检查：规则引用的 type 必须在该学科注册表中存在（或为 *） */
function crossCheck(registries: Record<string, RegistryFile>, rules: Record<string, Rule[]>): string[] {
  const errors: string[] = [];
  const posSet = new Set<string>(POSITIONS);
  for (const [subject, def] of Object.entries(registries)) {
    for (const [type, t] of Object.entries(def.types)) {
      for (const iface of Object.keys(t.interfaces)) {
        if (posSet.has(iface)) errors.push(`${subject}.${type}: 接口 "${iface}" 与位置枚举同名`);
      }
    }
  }
  for (const [subject, list] of Object.entries(rules)) {
    const known = new Set(Object.keys(registries[subject]?.types ?? {}));
    const checkType = (t: string, ctx: string) => {
      if (t !== "*" && !known.has(t)) errors.push(`${ctx}: 类型 "${t}" 不在 ${subject} 注册表中`);
    };
    const seen = new Set<string>();
    for (const r of list) {
      if (seen.has(r.id)) errors.push(`${subject}: 规则 id 重复 "${r.id}"`);
      seen.add(r.id);
      if (r.a_type) checkType(r.a_type, `${subject}.${r.id}.a_type`);
      for (const t of r.b_type ?? []) checkType(t, `${subject}.${r.id}.b_type`);
      if (r.from_type) checkType(r.from_type, `${subject}.${r.id}.from_type`);
      if (r.to_type) checkType(r.to_type, `${subject}.${r.id}.to_type`);
      // 每种 kind 的必填字段（schema 里做不到按 kind 条件必填，在这里补）
      if (r.kind === "position_relation" && (!r.a_type || !r.b_type || !r.relation))
        errors.push(`${subject}.${r.id}: position_relation 需要 a_type/b_type/relation`);
      if (r.kind === "must_be_adjacent" && (!r.a_type || !r.b_type))
        errors.push(`${subject}.${r.id}: must_be_adjacent 需要 a_type/b_type`);
      if (r.kind === "position_in" && (!r.a_type || !r.allowed))
        errors.push(`${subject}.${r.id}: position_in 需要 a_type/allowed`);
      if (r.kind === "connection_direction" && (!r.from_type || !r.to_type || !r.direction))
        errors.push(`${subject}.${r.id}: connection_direction 需要 from_type/to_type/direction`);
      if (r.kind === "connection_required" && (!r.from_type || !r.b_type))
        errors.push(`${subject}.${r.id}: connection_required 需要 from_type/b_type`);
      if (r.kind === "connection_endpoint" && (!r.to_type || !r.to_iface))
        errors.push(`${subject}.${r.id}: connection_endpoint 需要 to_type/to_iface`);
    }
  }
  return errors;
}

let cache: DiagramConfig | null = null;

/** 加载并校验配置（带缓存）。配置非法时抛错并列出全部问题。 */
export function loadDiagramConfig(): DiagramConfig {
  if (cache) return cache;
  const dir = configDir();
  const regRaw = JSON.parse(readFileSync(path.join(dir, "device_registry.json"), "utf8"));
  const rulesRaw = JSON.parse(readFileSync(path.join(dir, "subject_rules.json"), "utf8"));

  const registries: Record<string, RegistryFile> = {};
  const errors: string[] = [];
  for (const [subject, raw] of Object.entries(regRaw)) {
    const parsed = registryFileSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push(`注册表 ${subject}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`);
      continue;
    }
    registries[subject] = parsed.data;
  }
  const rulesParsed = rulesFileSchema.safeParse(rulesRaw);
  if (!rulesParsed.success) {
    errors.push(`学科规则: ${rulesParsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`);
  }
  if (errors.length === 0) errors.push(...crossCheck(registries, rulesParsed.data ?? {}));
  if (errors.length > 0) {
    throw new Error(`图示配置校验失败：\n${errors.map((e) => "  - " + e).join("\n")}`);
  }
  cache = { registries, rules: rulesParsed.data ?? {} };
  return cache;
}

/** 测试用：清除缓存强制重载 */
export function _resetDiagramConfigCache() {
  cache = null;
}
