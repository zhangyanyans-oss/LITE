# LITE · AI 精通式学习辅导

面向中小学的一对一 AI 学习助手：把你的教材/讲义变成一门结构化的课程，逐模块、逐知识点
摸底 → 讲课 → 结课测验，闯关式推进，全程因材施教。

## 核心特性

- **课程自动生成**：上传教材/讲义到知识库，AI 还原目录、按"一章一模块"生成学习路线；
  模块数随内容体量、目录章数、时间安排（学期/周/月/天）动态伸缩，可手动指定
- **精通式推进**：每个知识点先 3 题摸底（全对直接跳过），讲课聚焦薄弱点，结课 4 题判分，
  通过才解锁下一关；未通过自动安排重讲/补考
- **反直觉开场 + 回马枪复习**：每课用最违反直觉的事实开场；新课不动声色地把最近学过的
  知识揉进例子里，间隔复习藏在课堂中
- **错题变形卷**：结课测验答错时，自动基于错题生成"考点不变、情境全换"的加练题
- **六科教材图库（460 张）**：化学（atlas-）/初中物理（phy-）/高中物理（phs-）/
  初中历史（his-）/初中生物（bio-）/初中地理（geo-），讲课时按主题引用教材原图，
  学科自动识别、互不串台；物理/化学装置图另有 plan 引擎与 TikZ 双通道现画
- **代码题判分**：编程知识点支持运行学生代码并自动判分

## 技术栈

React 19 + Vite 7 + TailwindCSS（shadcn/ui）· tRPC + Drizzle ORM + MySQL ·
DeepSeek API（讲课/出题/判分）· esbuild 打包单进程生产引导（`scripts/build-boot.mjs`）

## 快速开始

```bash
# 1. 依赖（Node 20+，MySQL 8）
npm install

# 2. 配置环境变量：复制 .env.example 为 .env，填入数据库与相关 Key
#    APP_ID / APP_SECRET：云后端应用凭证（可选）
#    DATABASE_URL：mysql://user:pass@localhost:3306/dbname

# 3. 初始化数据库表
npx drizzle-kit push

# 4. 开发
npm run dev

# 5. 生产
npm run build && npm start
```

> AI 的 DeepSeek API Key 在应用「设置」页填写（存库，不入代码）。

## 图库重建（可选）

仓库自带 `public/atlas/` 下的教材抽图与 `config/diagram/atlas/*.json` 清单，开箱即用。
若要从原始教材 PDF 重新抽取/扩充图库：

```bash
cp scripts/_local_paths.example.py scripts/_local_paths.py  # 填入本机教材 PDF 路径
python scripts/atlas-figures.py          # 历史/生物/地理
python scripts/atlas-physics.py          # 初中物理
python scripts/atlas-physics-hs.py       # 高中物理
python scripts/atlas-library.py          # 合并生成前端映射表 src/lib/atlasMap.ts
node scripts/atlas-build.mjs             # 生成 assets/atlas/index.html 总览
```

教材 PDF 需自备（人教版/部编版），路径配置文件已被 gitignore，不会上传。

## 目录结构

```
api/          tRPC 路由与生成逻辑（course / learn / diagram / atlas 图库）
src/          前端页面（课程列表 / 学习 / 设置）
config/       图库清单 JSON
public/atlas/ 教材抽图（六科 460 张）
scripts/      图库提取、总览构建、e2e 测试
db/           Drizzle schema
contracts/    前后端共享类型
```
