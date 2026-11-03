"""把切好的图库小图拼成 contact sheet，便于逐图核对与标注。

用法：
  python scripts/atlas-sheet.py <索引index.json> <输出前缀> [--section 关键词] [--cols 5] [--cell 220] [--per 20]
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

INDEX = Path(sys.argv[1])
OUT = Path(sys.argv[2])
COLS = int(sys.argv[sys.argv.index("--cols") + 1]) if "--cols" in sys.argv else 5
CELL = int(sys.argv[sys.argv.index("--cell") + 1]) if "--cell" in sys.argv else 220
PER = int(sys.argv[sys.argv.index("--per") + 1]) if "--per" in sys.argv else 20
SECTION = sys.argv[sys.argv.index("--section") + 1] if "--section" in sys.argv else None

data = json.loads(INDEX.read_text(encoding="utf-8"))
items = data["items"]
if SECTION:
    items = [i for i in items if (i["section"] or "").find(SECTION) >= 0]
if not items:
    print("no items")
    sys.exit(1)

imgdir = INDEX.parent.parent.parent / "assets" / "atlas"
if not imgdir.exists():
    imgdir = Path("assets/atlas")

for si in range(0, len(items), PER):
    chunk = items[si:si + PER]
    rows = (len(chunk) + COLS - 1) // COLS
    sheet = Image.new("RGB", (COLS * CELL, rows * (CELL + 20)), "white")
    dr = ImageDraw.Draw(sheet)
    for k, it in enumerate(chunk):
        img = Image.open(imgdir / it["file"]).convert("RGB")
        img.thumbnail((CELL - 10, CELL - 10))
        cx = (k % COLS) * CELL
        cy = (k // COLS) * (CELL + 20)
        sheet.paste(img, (cx + (CELL - img.width) // 2, cy + 16))
        dr.rectangle([cx, cy, cx + CELL - 1, cy + CELL + 18], outline=(215, 215, 215))
        dr.text((cx + 4, cy + 3), f'{it["id"]} {it["size"][0]}x{it["size"][1]}', fill=(160, 0, 0))
    name = OUT.with_name(f"{OUT.stem}-{si // PER + 1}.png")
    sheet.save(name)
    print(name, len(chunk))
