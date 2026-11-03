/**
 * 讲课提示词里的 plan 规则段落：类型清单从配置动态生成（注册表加了新类型，提示词自动带上），
 * 化学五条铁律与自检清单按主构架文档写死（把"化学教科书"写进 Prompt）。
 * FEW_SHOT_PLAN 导出给 e2e 测试做一致性校验（示例本身必须能通过全部校验器）。
 */
import { readFileSync } from "fs";
import path from "path";
import { POSITIONS, loadDiagramConfig } from "./config";

/**
 * 图库模板清单（config/diagram/atlas/plans.json）：教材里反复出现的成套装置已经固化成标准 plan。
 * 这里只把"目录"写进提示词——模型照模板填写装置清单与连接方式，比每次从零想更稳、更省 token。
 */
function templateList(): string {
  try {
    const file = path.resolve(process.cwd(), "config/diagram/atlas/plans.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as {
      templates: Array<{ id: string; name: string; tags: string[] }>;
    };
    return data.templates
      .map((t) => `   - ${t.id}｜${t.name}${t.tags?.length ? `（${t.tags.join("/")}）` : ""}`)
      .join("\n");
  } catch {
    return "";
  }
}

/** 满分范例：高锰酸钾制氧气，排水法收集（同时用作修正轮的垫片，解决"不知道参数怎么填"的问题） */
export const FEW_SHOT_PLAN = {
  subject: "chemistry",
  canvas_hint: "two_column",
  devices: [
    { id: "stand_1", type: "stand", label: "铁架台", relative_position: "left_center", interface: ["clamp", "base"] },
    {
      id: "test_tube_1",
      type: "test_tube",
      label: "试管",
      relative_position: "center",
      params: { solid_chunks: true, tilted: "down", has_cotton: true },
      interface: ["mouth_open"],
    },
    { id: "burner_1", type: "burner", label: "酒精灯", relative_position: "center_bottom", interface: ["flame"] },
    { id: "tube_1", type: "tube", label: "导管", relative_position: "right_center", interface: ["left_end", "right_end"] },
    {
      id: "trough_1",
      type: "trough",
      label: "水槽",
      relative_position: "right_bottom",
      params: { liquid_level: 0.8 },
      interface: ["liquid_inside"],
    },
    {
      id: "gas_jar_1",
      type: "gas_jar",
      label: "集气瓶",
      relative_position: "right_bottom",
      params: { inverted: true, has_glass_plate: false },
      interface: ["top_in", "top_out"],
    },
  ],
  connections: [
    { from: "stand_1.clamp", to: "test_tube_1.mouth_open", style: "dashed", note: "固定试管" },
    { from: "test_tube_1.mouth_open", to: "tube_1.left_end", style: "straight", note: "导管从管口引出" },
    { from: "tube_1.right_end", to: "gas_jar_1.top_in", style: "straight", route: "up_into_jar", note: "排水法，伸入倒扣瓶口" },
  ],
  expected_counts: { stand: 1, test_tube: 1, burner: 1, tube: 1, trough: 1, gas_jar: 1 },
} as const;

const FEW_SHOT = `\`\`\`plan\n${JSON.stringify(FEW_SHOT_PLAN)}\n\`\`\``;

export function buildPlanPromptSection(): string {
  const cfg = loadDiagramConfig();
  const typeList = Object.entries(cfg.registries)
    .map(([subject, reg]) => {
      const types = Object.entries(reg.types)
        .map(([t, def]) => {
          const ifaces = Object.keys(def.interfaces);
          return `${t}(${def.display_name}${ifaces.length ? "，接口 " + ifaces.join("/") : ""})`;
        })
        .join("、");
      const name = { chemistry: "化学", physics: "物理", biology: "生物", geography: "地理" }[subject] ?? subject;
      return `  ${name} ${subject}：${types}`;
    })
    .join("\n");
  return `【实验装置图 / 地图要素图：用 plan，不手写 SVG】
涉及化学/物理/生物的实验装置、器材组合，或地理的地图要素（图名、图例、方向标、比例尺、示意箭头）时，输出一个 \`\`\`plan 围栏代码块，内容是布局计划 JSON。你只负责装置清单、相对位置和连接关系；精确坐标由系统计算，绝对不要写任何坐标数字，绝对不要输出 SVG。
JSON 结构：
{"subject":"chemistry|physics|biology|geography","canvas_hint":"single_column|two_column|ring|map_standard","devices":[{"id":"类型_序号","type":"类型","label":"中文名","relative_position":"位置","interface":["接口"],"params":{"liquid_level":0.7,"solid_chunks":true,"inverted":false,"has_glass_plate":true,"tilted":"down","has_cotton":true}}],"connections":[{"from":"id.接口","to":"id.接口","style":"straight|curve|dashed|arrow","route":"…","note":"物理化学意义"}],"expected_counts":{"类型":数量}}
params 全是可选语义参数，引擎自动画图：liquid_level=液面高度（0.7=七成满，自动画波浪水面）；solid_chunks=容器底部有固体药品（干燥管里就是干燥剂）；inverted=器皿倒扣（集气瓶、试管倒扣收集气体都用它，引擎会把它沉进水里）；has_glass_plate=瓶口盖玻璃片；tilted="down"=试管口向下倾斜；has_cotton=试管口塞棉花；has_filter_paper=漏斗里放滤纸（过滤必须 true）；has_cover=坩埚/蒸发皿加盖；particles="bubbles"=液面下升起气泡。
引擎的装配规则（你只需要写连接，位置和插入深度由引擎算）：连接到某容器的 liquid_inside / top_in / bottom_in，等于"把这个东西插进那个容器"——倒扣试管会沉到液面以下、电极会伸进溶液、燃烧匙会从瓶口伸进瓶内，容器口部也会自动补上带孔的塞子。所以别把本该插进去的东西平铺在别的格子里。同理：漏斗颈连容器口 → 漏斗架到口正上方、颈伸进口内；蒸馏头连烧瓶口 → 头坐在瓶口；冷凝管连蒸馏头斜口 → 管贴到斜口；接收瓶连冷凝管出口 → 瓶摆到出口正下方；三脚架与蒸发皿在一起 → 架子托到皿底；玻璃棒连某个口 → 棒斜靠在那个口上。这些都只要写对连接，不要自己摆位置。
导管与试管口（test_tube.mouth_open）的连接按气流方向装配：写成"导管 → 试管口"是往试管里送气，引擎会把导管穿过管口塞子、一直伸到管内固体药品上方（也可显式加 route:"into_tube"）；写成"试管口 → 导管"是从试管往外导气，导管只停在管口。方向写反，图上就是"气体从口部白白跑掉"。
硬性规则：
1. relative_position 只能是：${POSITIONS.join("/")}
2. expected_counts 里每种类型的数量必须等于 devices 中该类型的实际个数，且不允许为 0；没有连接关系时 connections 给空数组 []
3. connections 的 from/to 格式是 "id.接口"，id 必须在 devices 里，接口必须从该类型的接口列表里选；化学装置的连接必须写 note，用一句话说明物理化学意义（如 "长颈漏斗液封"、"向上排空气法"）
4. 可用类型（subject 与类型必须对应，不要用别的学科的类型）：
${typeList}
5. 空间常识：酒精灯放在被加热装置的正下方（如被加热装置在 center，酒精灯在 center_bottom）；铁架台与被支撑物相邻；地理图的图名放 top 区域、方向标放 top 角落、比例尺和图例放底部
6. 地理只用地图要素类型，不使用实验装置的概念
7. 连线路由 route："straight"（直线）/ "orthogonal"（直角折线）/ "orthogonal_down"（先水平再垂直向下，导管专用）/ "down_into_jar"（从上方伸入集气瓶，向上排空气法）/ "up_into_jar"（从下方伸入倒置瓶口，排水法）/ "into_tube"（气体送入试管：导管穿过管口塞子伸到管内固体药品上方）/ "s_curve"（S 形平滑曲线）。规则：
   - tube（导管）两端装置一高一低时，必须用折线路由，禁止直线硬连；
   - 导管进入容器必须用容器的入口接口（如 gas_jar 的 bottom_in、trough 的 liquid_inside），不要连到器身侧面；
   - 试管/烧瓶的出气口必须用位于口部的接口（mouth_open / top_open / side_right_out / side_out），不要从器身中部引出
8. 化学五条铁律（违反任意一条，系统直接打回重写）：
   8.1 固液常温型发生装置（制 CO2、H2）：液封——必须有连接从 long_neck_funnel.bottom_out 连到反应容器的 liquid_inside（下端伸入液面以下，否则气体从漏斗跑光）；反应容器 params.solid_chunks=true；导气管从容器的 side_out 或 top_out 引出
   8.2 固固加热型发生装置（高锰酸钾制 O2）：test_tube 必须 params.tilted="down"（管口略向下倾斜，防冷凝水倒流炸裂）且通常 params.has_cotton=true（管口塞棉花）；burner 在试管正下方；导管必须从 test_tube.mouth_open 引出，绝对不可从管身中部穿出
   8.3 向上排空气法（收集 CO2 等重气体）：gas_jar 正放（inverted=false）、必须 has_glass_plate=true、导管连接 gas_jar.bottom_in（长进短出，直达瓶底），route 用 down_into_jar
   8.4 向下排空气法（收集 H2 等轻气体）：gas_jar 倒置（inverted=true）、导管连接 gas_jar.top_in（短进长出）
   8.5 排水法：必须有 trough（params.liquid_level）和倒置的 gas_jar（inverted=true），导管连接 gas_jar.top_in（水下的瓶口），route 用 up_into_jar
   8.6 尾气处理（有毒气体）：beaker 装吸收液（params.liquid_level）+ inverted_funnel，其 wide_bottom（宽口）悬浮在液面上方一点点，绝不插入液体（防倒吸）
   8.7 电解水 / 电解池：trough 盛水（params.liquid_level）+ 两支 test_tube 倒扣（params.inverted=true）分列左右 + 两根 electrode + 一块 battery。连接写全四类：① test_tube.mouth_open → trough.liquid_inside（试管倒扣浸入水中）；② electrode.top → test_tube.mouth_open（电极伸进对应试管口内）；③ battery.positive → 一根 electrode.top；④ battery.negative → 另一根 electrode.top。**绝对不能只摆三个器皿、一根线都不连**——那样引擎画出来就是三件悬空的东西。
   8.8 燃烧法测空气中氧气含量：gas_jar 正放 + combustion_spoon 燃烧匙，spoon.bowl → gas_jar.bottom_in（燃烧匙从瓶口伸进瓶内中部）；瓶底留少量水（liquid_level≈0.15）；不要盖 has_glass_plate（杆要穿过封盖，引擎会自动补一个带孔的塞子）
   8.9 气体通入试管的反应装置（H2 还原 CuO、H2/Fe2O3、CO 还原金属氧化物）：试管 params.tilted="down" + params.solid_chunks=true（金属氧化物铺在管底）；**导管必须伸到管内固体上方**——连接写成 "tube 的接口 → test_tube.mouth_open"（气流方向是"进入试管"），并加 route:"into_tube"；酒精灯连 test_tube（加热装固体的管底那一端）。绝对不要写成 "test_tube.mouth_open → tube"：那是"试管当气体发生装置、导管从管口引出"的画法，导管只会停在管口外，气体等于直接跑掉。
      关键几条照抄即可：试管 {"type":"test_tube","params":{"tilted":"down","solid_chunks":true}}；导管连接 {"from":"tube_1.right_end","to":"test_tube_1.mouth_open","style":"straight","route":"into_tube","note":"导管伸入试管，通入氢气"}；加热 {"from":"burner_1.flame","to":"test_tube_1.mouth_open","style":"straight","note":"加热氧化铜"}。
   8.10 过滤（分离不溶性固体）：funnel 必须 params.has_filter_paper=true；连接写成 funnel.stem_bottom → 烧杯.top_open（引擎会把漏斗架到烧杯口正上方、颈伸进杯口）；引流写成 glass_rod 的 lower 端 → funnel.top_open；stand 用 clamp 固定漏斗。一贴二低三靠：滤纸贴住漏斗内壁、液面低于滤纸边缘、漏斗颈靠烧杯内壁。烧杯里只装少量滤液（liquid_level≈0.3）。
   8.11 蒸发结晶：evaporating_dish（params.liquid_level 0.4~0.6）+ tripod（三脚架，与蒸发皿相邻、在它下方，引擎会把它吸附到皿底）+ burner.flame → dish.bottom（加热）+ glass_rod 搅拌（连到 dish.top_open）。加热到出现较多固体时停止加热，用余热蒸干。
   8.12 气体的干燥与洗气：drying_tube（球形干燥管，装固体干燥剂 params.solid_chunks=true）或 u_tube（装液体 params.liquid_level）**串在两根导管之间**——一根 tube 接它的 left_open、另一根 tube 接 right_open（左进右出）。洗气瓶用 bottle 装吸收液（liquid_level），进气管接 bottom_in（长进）、出气管从 top_out 引出（短出）。
   8.13 蒸馏：distilling_flask（params.liquid_level）+ distillation_head 坐在瓶口（flask.top_open → head.bottom_in）+ 温度计插在蒸馏头顶（thermo.bulb → head.top_out，引擎会把水银球送到支管口高度）+ 冷凝管接斜口（head.slant_out → cond.in_left）+ 接收瓶接出口（cond.out_right → 接收瓶.top_open，引擎会把接收瓶摆到出口正下方）+ burner 加热 + stand 固定烧瓶。冷凝水必须下进上出（water_in 进、water_out 出）。
9. 输出前内部逐项自检：漏斗插到液面以下了吗？加热试管的管口向下了吗？排空气法导管伸到瓶底了吗？排水法集气瓶倒扣了吗？倒扣的器皿有没有连到水容器的 liquid_inside（不然会悬空）？电极/燃烧匙有没有连到它该插进的那个容器？**气体送进试管的导管伸到固体上方了吗（方向是导管→试管口，route:"into_tube"）**？过滤漏斗放滤纸了吗（has_filter_paper）？蒸发皿架在三脚架上、温度计水银球在支管口了吗？干燥管/U形管两端都接上导管了吗？params 的必要参数都填了吗？
10. 标准装置模板（教材图库，均已通过校验）：讲实验时若与下面某条一致，直接沿用它的装置清单、params 与 connections（device 的 id 可以换，type/params/连接端点照抄），不要自己另发明连接方式：
${templateList()}
   不属于模板的实验再按上面的铁律自由组合。
示例（加热高锰酸钾制氧气，排水法收集）：
${FEW_SHOT}`;
}
