# -*- coding: utf-8 -*-
"""
初中历史 / 生物 / 地理图库构建：与高中物理同思路——每页恰好一张内嵌位图，
图里的地名/结构标注都栅格化在图里，所以直接抽出内嵌位图（干净、标注不丢）。

三本都是"图库"型 PDF（历史 99 页 / 生物 34 页 / 地理 121 页，每页一张大图 + OCR 文字层）：
  筛选：挖掉文字块后暗墨占比 ≥ 0.3% 才收——目录页、近乎空白页不进清单。
  命名：优先取 OCR 里像标题的行（含标题词、4~30 个汉字）；历史图的 OCR 多是地名碎片，
        挑不出标题就回退「章节·出处」，老师可在总览页复核。
  归类：按各科章节关键词打 tag；生物的实验/观察图标 setup，其余都标 principle。

用法：python scripts/atlas-figures.py            # 三科全跑
      python scripts/atlas-figures.py history    # 只跑一科
产出：public/atlas/{his,bio,geo}-*.png、config/diagram/atlas/{history,biology,geography}.json、
      assets/atlas/{history,biology,geography}.html（+ 图片镜像供总览页引用）
"""
import json
import re
import sys
from pathlib import Path

import fitz
import numpy as np
from PIL import Image, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
try:
    from _local_paths import ROOT  # 本地私有配置（gitignored）
except ImportError:
    sys.exit("缺少 scripts/_local_paths.py：请复制 scripts/_local_paths.example.py 并填入本机教材路径。")
OUT_IMG = Path("public/atlas")
ASSET_IMG = Path("assets/atlas")
# 暗墨占比阈值（挖掉文字块后）：低于此值的页不收（目录页/近乎空白页）
INK_KEEP = 0.3

# 页面装饰文字：出现在任何一行都把该行当页面装饰丢弃
FURNITURE = ["教材重点图片", "返回目录", "目录", "教材", "新课标", "人教版", "部编版",
             "七年级", "八年级", "九年级", "上册", "下册", "new", "第页", "共页",
             "教研", "泉州市", "雯老师", "秋秋", "番外"]

SUBJECTS = {
    "history": {
        "name": "history",
        "cn": "初中历史",
        "prefix": "his",
        "docs": [ROOT / "历史（部编版）" / "初中历史图库" / "初中历史图库.pdf"],
        "out_json": "config/diagram/atlas/history.json",
        "out_html": "assets/atlas/history.html",
        "title": "初中历史图库 · 部编版（历史地图 + 示意图）",
        # OCR 多是地名碎片：按朝代/主题词归类，挑不出标题就「章节·出处」
        "chapters": [
            ("史前时期", ["元谋人", "北京人", "山顶洞人", "原始", "河姆渡", "半坡", "炎帝", "黄帝", "史前", "氏族", "农耕"]),
            ("夏商周", ["夏", "商", "周", "青铜", "甲骨文", "分封", "牧野", "殷", "春秋", "战国", "诸侯"]),
            ("秦汉时期", ["秦", "汉", "丝绸之路", "兵马俑", "长城", "汉武帝", "造纸", "咸阳", "长安"]),
            ("三国两晋南北朝", ["三国", "两晋", "南北朝", "赤壁", "淝水", "北魏", "江南", "蜀", "吴"]),
            ("隋唐时期", ["隋", "唐", "大运河", "科举", "贞观", "开元", "突厥", "吐蕃"]),
            ("宋元时期", ["宋", "元", "辽", "西夏", "金", "蒙古", "行省", "榷场", "开封", "临安"]),
            ("明清时期", ["明", "清", "郑和", "戚继光", "闭关", "紫禁城", "倭寇", "台湾府"]),
            ("近代侵略与抗争", ["鸦片", "甲午", "八国", "南京条约", "马关", "辛丑", "侵华", "条约", "割地", "租界"]),
            ("近代化探索", ["洋务", "戊戌", "辛亥", "新文化", "维新", "革命", "武昌"]),
            ("新民主主义革命", ["五四", "中共", "长征", "抗日", "解放", "建国", "井冈山", "遵义", "延安"]),
            ("经济与社会生活", ["货币", "农业", "手工业", "商业", "人口", "社会生活"]),
        ],
        "setup_kw": [],  # 历史图没有实验装置，全部 principle
        "title_kw": ["遗址", "疆域", "形势", "路线", "都城", "战役", "分布", "示意图", "地图", "运河", "文明", "遗址图"],
        "setup_asm": "{chapter}场景示意图，讲解时按图说明人物、事件与时间背景。",
        "principle_asm": "{chapter}历史地图/示意图，讲解时指出疆域范围、都城与遗址位置、路线走向与时间背景。",
    },
    "biology": {
        "name": "biology",
        "cn": "初中生物",
        "prefix": "bio",
        "docs": [ROOT / "生物学（人教版）" / "初中生物图库" / "初中生物图库.pdf"],
        "out_json": "config/diagram/atlas/biology.json",
        "out_html": "assets/atlas/biology.html",
        "title": "初中生物图库 · 人教版（结构示意图 + 实验图）",
        "chapters": [
            ("生态与食物链", ["生态", "食物链", "食物网", "生产者", "消费者", "分解者", "生态系统", "环境", "物质循环"]),
            ("细胞与显微镜", ["细胞", "显微镜", "分裂", "玻片", "细胞核", "细胞膜", "液泡", "叶绿体"]),
            ("植物体", ["种子", "根", "芽", "叶", "光合", "蒸腾", "花", "果实", "导管", "筛管", "植株", "萌发", "叶脉", "茎"]),
            ("人体的结构与生理", ["消化", "呼吸", "循环", "血液", "血管", "心脏", "泌尿", "肾", "神经", "眼球", "耳", "内分泌", "激素", "运动系统", "骨骼", "关节"]),
            ("微生物与生物圈", ["细菌", "真菌", "病毒", "微生物", "发酵"]),
            ("生殖发育与遗传", ["生殖", "发育", "遗传", "变异", "进化", "基因", "DNA", "染色体", "胚胎", "受精", "染色体"]),
            ("健康与免疫", ["免疫", "传染病", "健康", "急救", "抗体", "抗原"]),
        ],
        "setup_kw": ["实验", "探究", "观察", "装置", "显微镜", "培养", "萌发", "测量", "对照"],
        # 纯品牌页标志：页面挑不出任何标题行、又含这些词时整页跳过（水印行本身已在 FURNITURE 丢弃）
        "skip_words": ["教研", "泉州市"],
        "title_kw": ["示意图", "结构", "过程", "显微镜", "系统", "组成", "实验", "探究", "关系", "曲线", "模式图", "装置"],
        "setup_asm": "{chapter}实验/观察图，讲解时按图说明器材、步骤与观察要点。",
        "principle_asm": "{chapter}结构示意图，讲解时点出图中各结构的名称、位置与功能对应关系。",
    },
    "geography": {
        "name": "geography",
        "cn": "初中地理",
        "prefix": "geo",
        "docs": [ROOT / "地理（人教版）" / "初中地理图库" / "初中地理图库.pdf"],
        "out_json": "config/diagram/atlas/geography.json",
        "out_html": "assets/atlas/geography.html",
        "title": "初中地理图库 · 人教版（地图 + 示意图 + 图像）",
        "chapters": [
            ("地球与地图", ["地球", "地轴", "经线", "纬线", "经度", "纬度", "半球", "比例尺", "方向", "图例", "自转", "公转", "昼夜", "经纬网", "赤道"]),
            ("地形与地貌", ["地形", "高原", "平原", "山地", "丘陵", "盆地", "山脉", "等高线", "地势", "地形剖面"]),
            ("气候与天气", ["气候", "气温", "降水", "季风", "气压", "风向", "温度带", "干湿", "天气"]),
            ("河流与水文", ["河流", "湖泊", "水文", "流域", "黄河", "长江", "内流河", "外流河"]),
            ("资源与能源", ["资源", "能源", "矿产", "煤", "石油", "水能", "土地", "耕地", "林地", "草地"]),
            ("人口与聚落", ["人口", "城市", "聚落", "密度", "增长"]),
            ("农业与工业交通", ["农业", "工业", "交通", "商业", "铁路", "贸易", "运输"]),
            ("中国地理分区", ["中国", "省级", "行政区", "南方", "北方", "西北", "青藏", "台湾", "香港", "澳门"]),
            ("世界地理", ["世界", "大洲", "大洋", "板块", "海陆", "发达国家", "发展中国家", "国际合作"]),
        ],
        "setup_kw": [],  # 地理图没有实验装置，全部 principle
        "title_kw": ["示意图", "分布", "地图", "曲线", "变化", "比较", "剖面", "地形", "气候", "降水", "气温", "纬线", "经线", "路线", "分区"],
        "setup_asm": "{chapter}示意图，讲解时按图说明要素关系与形成过程。",
        "principle_asm": "{chapter}地理示意图/地图，讲解时指出方向、分布特征、数值变化与区域差异。",
    },
}


def ink_fraction(pg) -> float:
    """挖掉文字块后，剩余暗墨占整页比例——判断这一页有没有实质绘图。"""
    pm = pg.get_pixmap(dpi=110)
    img = Image.frombytes("RGB", (pm.width, pm.height), pm.samples)
    ink = np.asarray(img.convert("L")).astype(np.int16) < 200
    sx, sy = img.width / pg.rect.width, img.height / pg.rect.height
    tmask = np.zeros_like(ink)
    for b in pg.get_text("blocks"):
        x0, y0, x1, y1 = b[:4]
        tmask[
            max(0, int(y0 * sy) - 2) : int(y1 * sy) + 2,
            max(0, int(x0 * sx) - 2) : int(x1 * sx) + 2,
        ] = True
    gfx = ink & ~tmask
    return float(gfx.sum()) / (img.width * img.height) * 100.0


def clean_line(s: str) -> str:
    """去掉图例符号、序号、甲乙丙丁等前缀，压掉空白"""
    s = s.strip()
    s = re.sub(r"^[◎○●oO★☆·•◦\s]+", "", s)
    s = re.sub(r"^[\d一二三四五六七八九十]+[、.．）)]\s*", "", s)
    s = re.sub(r"^([甲乙丙丁戊ABCDab]\s*){1,4}", "", s)
    s = re.sub(r"\s+", "", s)
    return s


def pick_name(lines: list, chapter: str, source: str, title_kw: list) -> str:
    """优先取含标题词的行当 name；OCR 是碎片挑不出时回退「章节·出处」。"""
    cands = []
    for raw in lines:
        if any(f in raw for f in FURNITURE):
            continue
        s = clean_line(raw)
        if not s or not any("一" <= ch <= "鿿" for ch in s):
            continue
        if len(s) < 4 or len(s) > 30:
            continue
        cands.append(s)
    for s in cands:
        if any(k in s for k in title_kw):
            return s
    if cands:
        return max(cands, key=len)
    return f"{chapter}·{source}"


def chapter_of(text: str, chapters) -> str:
    for name, kws in chapters:
        if any(k in text for k in kws):
            return name
    return "其他"


def kind_of(name: str, text: str, setup_kw) -> str:
    return "setup" if any(k in (name + text) for k in setup_kw) else "principle"


def extract_subject(key: str, cfg: dict) -> list:
    docs = cfg["docs"]
    prefix = cfg["prefix"]
    chapters = cfg["chapters"]
    setup_kw = cfg["setup_kw"]
    title_kw = cfg["title_kw"]
    OUT_IMG.mkdir(parents=True, exist_ok=True)
    ASSET_IMG.mkdir(parents=True, exist_ok=True)

    items = []
    seq = 0
    for di, doc_path in enumerate(docs):
        doc = fitz.open(doc_path)
        tag = f"p{di + 1}" if len(docs) > 1 else ""
        for pi in range(doc.page_count):
            pg = doc[pi]
            text = pg.get_text()
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            # 纯品牌页（只有水印、挑不出任何标题行）整页跳过，不占编号
            has_caption = any(
                not any(f in raw for f in FURNITURE)
                and 4 <= len(clean_line(raw)) <= 30
                and any("一" <= ch <= "鿿" for ch in clean_line(raw))
                for raw in lines
            )
            if not has_caption and any(any(w in ln for w in cfg.get("skip_words", [])) for ln in lines):
                continue
            frac = ink_fraction(pg)
            if frac < INK_KEEP:
                continue
            imgs = pg.get_images(full=True)
            if not imgs:
                continue
            best, best_area = None, -1
            for im in imgs:
                for r in pg.get_image_rects(im[0]):
                    if r.get_area() > best_area:
                        best_area = r.get_area()
                        best = im
            if best is None:
                continue
            data = doc.extract_image(best[0])
            iid = f"{prefix}-{seq + 1:003d}"
            seq += 1
            fname = f"{iid}.png"
            OUT_IMG.joinpath(fname).write_bytes(data["image"])
            # 总览页（assets/atlas/index.html）按 ./<file> 引用，需要一份镜像副本
            ASSET_IMG.joinpath(fname).write_bytes(data["image"])

            text = pg.get_text()
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            head = lines[0] if lines else ""
            chap = chapter_of(head + " " + " ".join(lines[:6]), chapters)
            source = f"{tag}p{pi + 1}" if tag else f"p{pi + 1}"
            name = pick_name(lines, chap, source, title_kw)
            kind = kind_of(name, " ".join(lines[:6]), setup_kw)
            asm_tmpl = cfg["setup_asm"] if kind == "setup" else cfg["principle_asm"]
            entry = {
                "id": iid,
                "file": fname,
                "name": name,
                "kind": kind,
                "aliases": [name],
                "tags": [chap],
                "devices": [],
                "assembly": asm_tmpl.format(chapter=chap),
                "width": data["width"],
                "height": data["height"],
                "chapter": chap,
                "source": source,
            }
            items.append(entry)
            print(f"  {iid} {data['width']}x{data['height']} [{chap}/{kind}] {name}")
        doc.close()
    print(f"{cfg['cn']}: {len(items)} 张（暗墨阈值 {INK_KEEP}%）")
    return items


def write_lib(items, cfg):
    lib = {
        "version": 1,
        "subject": cfg["name"],
        "source": f"{cfg['cn']}图库 PDF（自动抽取内嵌位图，每页一张，图内标注随图栅格化）",
        "baseUrl": "/atlas/",
        "note": (
            "kind: setup=实验/操作图（讲步骤、器材时引用）；principle=示意图/地图（讲结构、分布、过程时引用）。"
            "由 scripts/atlas-figures.py 自动抽取，name 取 OCR 标题、按章节打 tag；assembly 为通用占位，可后续细化。"
        ),
        "items": items,
    }
    out = Path(cfg["out_json"])
    out.write_text(json.dumps(lib, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{cfg['out_json']} <- {len(items)} 条")


def write_overview(items, cfg):
    try:
        ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 22)
    except OSError:
        pass
    order = [c[0] for c in cfg["chapters"]] + ["其他"]
    groups = []
    for ch in order:
        arr = [i for i in items if i.get("chapter") == ch]
        if arr:
            groups.append((ch, arr))
    cards = []
    for title, arr in groups:
        inner = "".join(
            f"""<figure class="card"><img src="../../public/atlas/{i['file']}" alt="{i['name']}">
<div class="meta"><b>{i['id']}</b> · {i['name']} <span class="src">{i.get('source','')}</span></div>
<div class="asm">{i['kind']} · {i['chapter']}</div></figure>"""
            for i in arr
        )
        cards.append(f"<h2>{title}<span>{len(arr)}</span></h2><div class='grid'>{inner}</div>")
    html = f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>{cfg['title']}</title>
<style>
:root{{--line:#e5e7eb;--muted:#6b7280;--accent:#1d4ed8}}
*{{box-sizing:border-box}}
body{{margin:0;padding:28px 32px 60px;background:#f8fafc;color:#111827;
font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif}}
h1{{font-size:21px;margin:0 0 6px}}
.lead{{color:var(--muted);font-size:13px;margin:0 0 22px}}
h2{{font-size:15px;margin:26px 0 12px;display:flex;align-items:center;gap:8px}}
h2 span{{background:#dbeafe;color:#1e40af;font-size:12px;padding:1px 8px;border-radius:999px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}}
.card{{margin:0;background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px;
display:flex;flex-direction:column;gap:6px}}
.card img{{width:100%;height:200px;object-fit:contain;background:#fff;border-radius:6px}}
.meta{{font-size:12.5px}}
.meta b{{color:var(--accent);font-weight:600}}
.src{{color:var(--muted);font-size:11px;margin-left:6px}}
.asm{{font-size:11.5px;line-height:1.5;color:#166534;background:#f0fdf4;border-radius:6px;padding:4px 7px}}
</style></head><body>
<h1>{cfg['title']}（自动抽取 · 按章节归类）</h1>
<p class="lead">共 {len(items)} 张 · 课堂上按 id 引用（figure 围栏，如 ```figure {cfg['prefix']}-001```）· 历史图 OCR 多为地名碎片，挑不出标题的会以「章节·出处」命名，老师可在本页复核</p>
{''.join(cards)}
</body></html>"""
    Path(cfg["out_html"]).write_text(html, encoding="utf-8")
    print(f"overview -> {cfg['out_html']}")


def main():
    keys = sys.argv[1:] or list(SUBJECTS)
    for key in keys:
        cfg = SUBJECTS[key]
        print(f"==== {cfg['cn']} ====")
        items = extract_subject(key, cfg)
        write_lib(items, cfg)
        write_overview(items, cfg)


if __name__ == "__main__":
    main()
