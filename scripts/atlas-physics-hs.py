# -*- coding: utf-8 -*-
"""
高中物理图库构建：从《高中物理图1.pdf》《高中物理图2.pdf》两本直接抽取内嵌位图。

与初中物理不同，这两本是「图册/题册」：每一页恰好一张内嵌位图（覆盖约 70% 版面），
图里的 小车/纸带/电源 等文字标签是栅格化的、跟着图一起走。所以不再像初中那样
「挖文字块遮罩后按墨迹切」，而是把整张内嵌位图直接抽出来——干净、标签不丢。

筛选：用「挖掉文字块后剩下的暗墨占比」判断这一页是不是"实质插图"。
  暗墨占比 < 0.3% 的页（稀疏小题配图、或几乎空白的页）不收，避免把例题小图也灌进清单。
  —— 这正好把清单控制在约 145 张实质插图，而不是 250 张全收。

命名/归类：用页首标题当 name，按章节关键词打 tag（力学/电磁/光学…），实验装置类标 setup、
  示意图/图像类标 principle。device 与装配要点先给通用占位，老师可后续细化。

用法：python scripts/atlas-physics-hs.py
产出：public/atlas/phs-*.png、config/diagram/atlas/physics-hs.json、assets/atlas/physics-hs.html
"""
import io
import json
from pathlib import Path

import sys
from pathlib import Path

import fitz
import numpy as np
from PIL import Image, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
try:
    from _local_paths import PHY_HS_PDFS
except ImportError:
    sys.exit("缺少 scripts/_local_paths.py：请复制 scripts/_local_paths.example.py 并填入本机教材路径。")

DOCS = [Path(p) for p in PHY_HS_PDFS]
OUT_IMG = Path("public/atlas")
ASSET_IMG = Path("assets/atlas")
OUT_JSON = Path("config/diagram/atlas/physics-hs.json")
OUT_HTML = Path("assets/atlas/physics-hs.html")
# 暗墨占比阈值（挖掉文字块后）：低于此值的页不收（稀疏小题配图/空白页）
INK_KEEP = 0.3


# ── 章节归类：命中即归类，顺序=优先级（具体章节在前）─────────────
CHAPTERS = [
    ("运动学", ["匀变速", "直线运动", "速度", "加速度", "位移", "打点计时器", "纸带", "自由落体", "竖直上抛", "追及", "相遇", "运动图像"]),
    ("力与平衡", ["重力", "弹力", "摩擦力", "受力", "力的合成", "力的分解", "平行四边形", "共点力", "平衡", "受力分析", "力的图示"]),
    ("牛顿运动定律", ["牛顿", "惯性", "超重", "失重", "单位制"]),
    ("曲线运动", ["平抛", "斜抛", "圆周运动", "向心力", "曲线运动", "匀速圆周", "圆锥摆", "临界"]),
    ("万有引力与航天", ["万有引力", "天体", "卫星", "开普勒", "宇宙速度", "重力加速度", "双星", "黑洞"]),
    ("功和能", ["功", "功率", "动能", "势能", "机械能守恒", "能量守恒", "功能关系", "动摩擦因数"]),
    ("动量", ["动量", "冲量", "碰撞", "反冲", "动量守恒", "动量定理"]),
    ("机械振动与波", ["简谐", "弹簧振子", "单摆", "机械波", "横波", "纵波", "干涉", "衍射", "多普勒", "共振", "波的图象"]),
    ("静电场", ["库仑", "电场", "电荷", "电势", "电势能", "电容", "平行板", "等势", "匀强电场", "电场线", "静电"]),
    ("恒定电流", ["电流", "电阻", "欧姆", "电功率", "电动势", "闭合电路", "伏安", "电阻定律", "电阻率", "电表", "滑动变阻器", "读数"]),
    ("磁场", ["磁场", "磁感", "安培", "洛伦兹", "带电粒子", "磁通", "磁感应强度", "质谱仪", "回旋加速器"]),
    ("电磁感应", ["电磁感应", "感应电动势", "法拉第", "楞次", "互感", "自感", "涡流", "感应电流", "感生"]),
    ("交变电流", ["交变", "正弦式", "变压器", "交流电", "有效值", "峰值", "电感", "电容", "三相"]),
    ("电磁场与电磁波", ["电磁场", "电磁波", "LC振荡", "电磁振荡"]),
    ("光学", ["折射", "全反射", "光的干涉", "光的衍射", "偏振", "几何光学", "透镜", "棱镜", "视深", "色散", "光的反射", "光路", "折射率"]),
    ("原子物理", ["原子", "原子核", "玻尔", "能级", "跃迁", "衰变", "半衰期", "裂变", "聚变", "光电效应", "量子", "波粒二象性", "核反应", "结合能"]),
    ("热学", ["分子", "内能", "热力学", "气体", "理想气体", "温度", "压强", "布朗", "扩散", "饱和汽", "表面张力"]),
    ("物理实验基础", ["实验", "仪器", "螺旋测微器", "游标卡尺", "误差", "有效数字", "测量"]),
]

SETUP_KW = ["实验", "装置", "电路", "连接", "器材", "仪器", "实物", "游标", "螺旋测微", "读数", "示波器", "电表", "光具座"]


def chapter_of(text: str) -> str:
    for name, kws in CHAPTERS:
        if any(k in text for k in kws):
            return name
    return "通用/其他"


def kind_of(text: str) -> str:
    return "setup" if any(k in text for k in SETUP_KW) else "principle"


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


TITLE_KW = ["实验", "探究", "测定", "研究", "验证", "原理", "装置", "电路", "图象", "图像",
            "模型", "示波", "读数", "光路", "折射率", "摆", "碰撞", "油酸", "多用电表",
            "螺旋测微", "游标卡尺", "图 ", "图1", "图2", "图3", "图4", "图5", "图6",
            "伏安", "传感器", "分压", "限流"]


def pick_name(lines: list, chapter: str, source: str) -> str:
    """优先挑一行像"图/实验标题"的文字当 name；挑不到或挑到的是废料，就用 章节·出处。"""
    cand = None
    for ln in lines:
        s = ln.strip()
        if any(k in s for k in TITLE_KW):
            cand = s
            break
    if cand is None:
        cand = lines[0] if lines else ""
    import re
    s = (cand or "").strip()
    # 去掉开头的题号/标号与 解析/答案 等前缀
    s = re.sub(r"^[\（\(]?\d+[\）).、]?\s*", "", s)
    s = re.sub(r"^实验[一二三四五六七八九十\d]+\s*", "", s)
    s = re.sub(r"^(解析|答案|见解析|（实验创新）|解：|解)\s*", "", s)
    if len(s) > 30:
        s = s[:30] + "…"
    # 废料判定：太短、或几乎不含汉字（纯数字/标点/英文碎片）
    has_cjk = any("一" <= ch <= "鿿" for ch in s)
    if not s or len(s) <= 3 or not has_cjk:
        return f"{chapter}·{source}"
    return s


def main():
    OUT_IMG.mkdir(parents=True, exist_ok=True)
    items = []
    seq = 0
    for di, doc_path in enumerate(DOCS):
        doc = fitz.open(doc_path)
        tag = f"图{di + 1}"
        for pi in range(doc.page_count):
            pg = doc[pi]
            frac = ink_fraction(pg)
            if frac < INK_KEEP:
                continue
            imgs = pg.get_images(full=True)
            if not imgs:
                continue
            # 取面积最大的那张内嵌位图（每页通常只有一张）
            best = None
            best_area = -1
            for im in imgs:
                rects = pg.get_image_rects(im[0])
                area = max((r.get_area() for r in rects), default=0)
                if area > best_area:
                    best_area = area
                    best = im
            data = doc.extract_image(best[0])
            iid = f"phs-{seq + 1:003d}"
            seq += 1
            fname = f"{iid}.png"
            OUT_IMG.joinpath(fname).write_bytes(data["image"])
            # 总览页（assets/atlas/index.html）按 ./<file> 引用，需要一份镜像副本
            ASSET_IMG.joinpath(fname).write_bytes(data["image"])

            text = pg.get_text()
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            head = lines[0] if lines else ""
            chap = chapter_of(head + " " + " ".join(lines[:6]))
            kind = kind_of(head)
            name = pick_name(lines, chap, f"{tag}-p{pi + 1}")
            entry = {
                "id": iid,
                "file": fname,
                "name": name,
                "kind": kind,
                "aliases": [name],
                "tags": [chap],
                "devices": [],
                "assembly": (
                    f"{chap}实验装置/原理图，讲解时按图说明器材、连线与操作步骤，点出关键器材位置与读数方法。"
                    if kind == "setup"
                    else f"{chap}示意图/图像，讲解时指出坐标轴、关键曲线/光线方向与物理意义。"
                ),
                "width": data["width"],
                "height": data["height"],
                "chapter": chap,
                "source": f"{tag}-p{pi + 1}",
            }
            items.append(entry)
            print(f"  {iid} {data['width']}x{data['height']} [{chap}/{kind}] {name}")
        doc.close()

    lib = {
        "version": 1,
        "subject": "physics-hs",
        "source": "人教版高中物理图册/题册（高中物理图1.pdf + 高中物理图2.pdf），逐页抽取内嵌位图",
        "baseUrl": "/atlas/",
        "note": "kind: setup=实验装置/原理图（讲实验、连线、读数时引用）；principle=示意图/图像（讲规律、场、波形、光路时引用）。由 scripts/atlas-physics-hs.py 自动抽取，name 取页首标题、按章节打 tag；device 与装配要点为通用占位，可后续细化。",
        "items": items,
    }
    OUT_JSON.write_text(json.dumps(lib, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"physics-hs.json <- {len(items)} 条（暗墨阈值 {INK_KEEP}%）")

    write_overview(items)


def write_overview(items):
    """一张总览页：给老师过眼复核用（不进课堂链路）"""
    try:
        font_big = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 22)
    except OSError:
        font_big = None
    order = [c[0] for c in CHAPTERS] + ["通用/其他"]
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
<title>高中物理图库 · 人教版</title>
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
<h1>高中物理图库 · 人教版（自动抽取 · 按章节归类）</h1>
<p class="lead">共 {len(items)} 张 · 课堂上按 id 引用（figure 围栏，如 ```figure phs-001```）· 灰底卡片里是系统自动生成的分类/类型，人工可后续细化 device 与装配要点</p>
{''.join(cards)}
</body></html>"""
    OUT_HTML.write_text(html, encoding="utf-8")
    print("overview ->", OUT_HTML)


if __name__ == "__main__":
    main()
