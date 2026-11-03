"""把图库条目拼成带 id 的核对版式，用于逐张检查正/反例标注。"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
lib = json.loads((ROOT / "config/diagram/atlas/library.json").read_text(encoding="utf-8"))
items = lib["items"]
out_dir = ROOT / ".tmp-audit"
out_dir.mkdir(exist_ok=True)

FONT = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 18)
CELL_W, CELL_H = 260, 240
COLS, ROWS = 3, 3
PER = COLS * ROWS

for page in range((len(items) + PER - 1) // PER):
    chunk = items[page * PER : (page + 1) * PER]
    sheet = Image.new("RGB", (COLS * CELL_W, ROWS * (CELL_H + 26)), "white")
    d = ImageDraw.Draw(sheet)
    for i, it in enumerate(chunk):
        x = (i % COLS) * CELL_W
        y = (i // COLS) * (CELL_H + 26)
        im = Image.open(ROOT / "public" / "atlas" / it["file"]).convert("RGB")
        im.thumbnail((CELL_W - 12, CELL_H - 12), Image.LANCZOS)
        sheet.paste(im, (x + (CELL_W - im.width) // 2, y + (CELL_H - im.height) // 2))
        d.rectangle([x, y, x + CELL_W - 1, y + CELL_H + 25], outline=(200, 200, 200))
        d.text((x + 6, y + CELL_H + 2), f"{it['id']} [{it['kind']}]", font=FONT, fill=(0, 0, 0))
    p = out_dir / f"sheet-{page + 1}.png"
    sheet.save(p)
    print(p, [it["id"] for it in chunk])
