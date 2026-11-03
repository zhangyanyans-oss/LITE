# TikZ 绘图提示词版本档案

装置图提示词经历了三代，当前启用 **v3（节点+相对定位版）**。要换版本，改 api/lib/diagram/tikz.ts 里的
buildTikzPromptSection、TIKZ_FEW_SHOT、TIKZ_FIX_SYSTEM 三处即可（v1 还需恢复宏包加载与 assets 拷贝，见 v1 文档）。

- tikz-v1-宏包版.md —— tikz-chemlab 宏包版（补丁12h 及之前）
- tikz-v2-极简绝对坐标版.md —— 极简纯 TikZ、绝对坐标（补丁12i）
- tikz-v3-节点相对定位版.md —— 节点搭积木、positioning 相对定位（当前启用，补丁12j）
