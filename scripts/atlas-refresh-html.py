"""从 config/diagram/atlas/{history,biology,geography}.json 重新生成各科总览 HTML。

用途：手工复核改过 JSON 里的 name / 删除了条目之后，不用重跑整条 PDF 提取链路，
直接刷新 assets/atlas/<subject>.html 与图片镜像。

用法：python scripts/atlas-refresh-html.py [history biology geography]
"""

import importlib.util
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).parent

# atlas-figures.py 文件名带连字符，用 importlib 按路径加载（main 有 __name__ 守卫，安全）
_spec = importlib.util.spec_from_file_location("atlas_figures", HERE / "atlas-figures.py")
atlas_figures = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(atlas_figures)


def main():
    keys = sys.argv[1:] or list(atlas_figures.SUBJECTS)
    for key in keys:
        cfg = atlas_figures.SUBJECTS[key]
        p = Path(cfg["out_json"])
        if not p.exists():
            print(f"skip {key}: {p} 不存在")
            continue
        items = json.loads(p.read_text(encoding="utf-8")).get("items", [])
        # 镜像缺失时从 public/atlas 补一份
        for it in items:
            dst = atlas_figures.ASSET_IMG / it["file"]
            src = atlas_figures.OUT_IMG / it["file"]
            if not dst.exists() and src.exists():
                shutil.copy2(src, dst)
        atlas_figures.write_overview(items, cfg)
        print(f"{key}: {len(items)} 条 -> {cfg['out_html']}")


if __name__ == "__main__":
    main()
