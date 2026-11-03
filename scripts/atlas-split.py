"""
教材图库拆分器：把《初中图库常用大全.doc》（先转 PDF）切成"一个装置一张图"，并生成图库索引。

切分：整页渲染成位图，用"整行/整列全空"的空白带递归切分（X-Y cut 的像素版）。
比按矢量外框投影稳——长导管、铁架台横臂会把包围盒投影焊成一片，像素空白带只看真实墨迹。
归类：页面里的"一、二、三…"标题块确定章节，图名文字块就近吸附到对应的图。
输出：<图片目录>/*.png + <索引路径>（默认 config/diagram/atlas/index.json）。

用法：
  python scripts/atlas-split.py <pdf> <图片目录> [--index 路径] [--pad 4] [--gap 4] [--dpi 200]
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import pymupdf

PROBE_DPI = 100
SECTION_RE = re.compile(r"^[一二三四五六七八九十]+、")


def content_mask(page):
    pix = page.get_pixmap(dpi=PROBE_DPI, colorspace=pymupdf.csGRAY, alpha=False)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    return arr < 246, PROBE_DPI / 72.0


def empty_runs(flags, min_gap_px):
    runs, start = [], None
    for i, v in enumerate(flags):
        if not v and start is None:
            start = i
        elif v and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(flags)))
    n = len(flags)
    return [(a, b) for a, b in runs if a > 0 and b < n and (b - a) >= min_gap_px]


def cut_boxes(mask, min_gap_px, depth=0, box=None):
    if box is None:
        box = (0, 0, mask.shape[1], mask.shape[0])
    x0, y0, x1, y1 = box
    if x1 - x0 < 12 or y1 - y0 < 12 or depth > 16:
        return [box]
    sub = mask[y0:y1, x0:x1]
    if not sub.any():
        return []
    for axis, flags in ((0, sub.any(axis=0)), (1, sub.any(axis=1))):
        runs = empty_runs(flags, min_gap_px)
        if not runs:
            continue
        a, b = max(runs, key=lambda r: r[1] - r[0])
        if axis == 0:
            return cut_boxes(mask, min_gap_px, depth + 1, (x0, y0, x0 + a, y1)) + cut_boxes(
                mask, min_gap_px, depth + 1, (x0 + b, y0, x1, y1)
            )
        return cut_boxes(mask, min_gap_px, depth + 1, (x0, y0, x1, y0 + a)) + cut_boxes(
            mask, min_gap_px, depth + 1, (x0, y0 + b, x1, y1)
        )
    return [box]


def split_page(page, gap_pt=4.0, min_area_pt2=260.0):
    mask, scale = content_mask(page)
    min_gap_px = max(2, int(round(gap_pt * scale)))
    out = []
    for x0, y0, x1, y1 in cut_boxes(mask, min_gap_px):
        sub = mask[y0:y1, x0:x1]
        ys, xs = np.where(sub)
        if len(xs) == 0:
            continue
        r = pymupdf.Rect(
            (x0 + xs.min()) / scale,
            (y0 + ys.min()) / scale,
            (x0 + xs.max() + 1) / scale,
            (y0 + ys.max() + 1) / scale,
        )
        if r.get_area() >= min_area_pt2:
            out.append(r)
    out.sort(key=lambda r: (round(r.y0 / 40), r.x0))
    return out


def main():
    pdf = Path(sys.argv[1])
    imgdir = Path(sys.argv[2])
    arg = lambda name, default: float(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default
    pad = arg("--pad", 4.0)
    gap = arg("--gap", 4.0)
    dpi = int(arg("--dpi", 200))
    index_path = Path(sys.argv[sys.argv.index("--index") + 1]) if "--index" in sys.argv else None

    imgdir.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(pdf)
    items = []
    for pno, page in enumerate(doc, start=1):
        boxes = split_page(page, gap_pt=gap)
        shapes = [pymupdf.Rect(d["rect"]) for d in page.get_drawings()] + [
            pymupdf.Rect(i["bbox"]) for i in page.get_image_info()
        ]
        blocks = [b for b in page.get_text("blocks") if b[4].strip()]
        # 章节标题按"行"识别：PDF 里相邻的两个标题常常挤在同一个 block 里
        sections = []
        for b in page.get_text("dict")["blocks"]:
            for line in b.get("lines", []):
                txt = "".join(s["text"] for s in line["spans"]).strip()
                if SECTION_RE.match(txt):
                    sections.append({"title": txt, "y": line["bbox"][1]})
        sections.sort(key=lambda s: s["y"])

        page_items = []
        for r in boxes:
            text = page.get_text("text", clip=r).strip().replace("\n", " ")
            hits = [sh for sh in shapes if not (sh & r).is_empty]
            # 只有一两条细线（标题下的横线）+ 一片文字 → 这是文字块，不是装置图
            ink = sum((sh & r).get_area() for sh in hits)
            is_text = bool(text) and (len(hits) <= 2 or ink < 30)
            page_items.append({"rect": r, "text": text, "has_shape": bool(hits), "is_text": is_text})

        # 图名 → 吸附到最近的图。用"行"而不是块：这一版的图名常常和十几张图挤在同一个文本块里。
        # 只有落在图的**上下方之外**（图内标注在图内）且水平方向有重叠的行，才算这张图的图名。
        for b in page.get_text("dict")["blocks"]:
            for line in b.get("lines", []):
                txt = "".join(s["text"] for s in line["spans"]).strip()
                if not txt or SECTION_RE.match(txt) or len(txt) > 30:
                    continue
                lr = pymupdf.Rect(line["bbox"])
                best, best_d = None, 1e9
                for j, fig in enumerate(page_items):
                    if fig["is_text"]:
                        continue
                    fr = fig["rect"]
                    above = fr.y0 - lr.y1
                    below = lr.y0 - fr.y1
                    vd = min(above, below)
                    hx = min(fr.x1, lr.x1) - max(fr.x0, lr.x0)
                    if -2 <= vd <= 28 and hx > -20 and vd < best_d:
                        best, best_d = j, vd
                if best is not None:
                    page_items[best].setdefault("names", []).append(txt)

        # 分类：本页各图的 y 上方最近的章节标题
        for it in page_items:
            if not it["has_shape"] or it["is_text"]:
                continue
            sec = None
            for s in sections:
                if s["y"] <= it["rect"].y0 + 12:
                    sec = s["title"]
            items.append(
                {
                    "page": pno,
                    "rect": it["rect"],
                    "text": it["text"],
                    "names": it.get("names", []),
                    "section": sec,
                }
            )

    last_section = None
    out = []
    for n, it in enumerate(items, start=1):
        if it["section"]:
            last_section = it["section"]
        clip = pymupdf.Rect(it["rect"].x0 - pad, it["rect"].y0 - pad, it["rect"].x1 + pad, it["rect"].y1 + pad)
        page = doc[it["page"] - 1]
        clip &= page.rect
        name = f"p{it['page']}-{n:03d}.png"
        page.get_pixmap(clip=clip, dpi=dpi).save(imgdir / name)
        out.append(
            {
                "id": f"atlas-{n:03d}",
                "file": name,
                "page": it["page"],
                "section": last_section,
                "name": "；".join(it["names"]) or None,
                "label": None,  # 人工/模型标注的图名（后续补）
                "text": it["text"],
                "bbox": [round(v, 1) for v in (clip.x0, clip.y0, clip.x1, clip.y1)],
                "size": [round(clip.width), round(clip.height)],
            }
        )

    payload = {
        "source": pdf.name,
        "total": len(out),
        "sections": sorted({o["section"] for o in out if o["section"]}),
        "items": out,
    }
    if index_path:
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"total {len(out)} figures -> {imgdir}, index -> {index_path}")


if __name__ == "__main__":
    main()
