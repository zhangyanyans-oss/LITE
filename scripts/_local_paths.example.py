"""本地私有路径模板——复制为 scripts/_local_paths.py 并填入本机实际路径。

atlas-*.py 提取脚本会从 scripts/_local_paths.py（已 gitignore）读取教材 PDF 路径，
仓库本身不包含任何本机路径信息。
"""

# 各科教材/图库 PDF 的公共根目录
from pathlib import Path

ROOT = Path(r"D:\path\to\教材电子版")

# 初中物理：实验图 PDF 与光学装置图
PHY_JUNIOR_PDF = r"{ROOT}\物理（人教版）\初中实验图\实验图.pdf".format(ROOT=ROOT)
PHY_JUNIOR_OPTICS = [
    r"{ROOT}\物理（人教版）\初中光学装置图\图片-001.jpg".format(ROOT=ROOT),
]

# 高中物理图库
PHY_HS_PDFS = [
    r"{ROOT}\物理（人教版）\高中物理图1.pdf".format(ROOT=ROOT),
    r"{ROOT}\物理（人教版）\高中物理图2.pdf".format(ROOT=ROOT),
]
