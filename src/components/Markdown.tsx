import type { ReactNode } from "react";
import { ATLAS_FIGURES } from "@/lib/atlasMap";

/**
 * 零依赖迷你 Markdown 渲染器（本地免安装版无法新增 npm 依赖，纯手写）。
 * 支持：**加粗**、`行内代码`、$行内公式$ / $$行间公式$$（常见 LaTeX 命令转可读符号）、
 * - 无序列表、1. 有序列表、##/### 小标题、--- 分隔线、段落。
 */

const LATEX_MAP: Array<[RegExp, string]> = [
  [/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1⁄$2"],
  [/\\dfrac\{([^{}]+)\}\{([^{}]+)\}/g, "$1⁄$2"],
  [/\\times/g, "×"],
  [/\\div/g, "÷"],
  [/\\cdot/g, "·"],
  [/\\pm/g, "±"],
  [/\\leq?/g, "≤"],
  [/\\geq?/g, "≥"],
  [/\\neq?/g, "≠"],
  [/\\approx/g, "≈"],
  [/\\sqrt\{([^{}]+)\}/g, "√($1)"],
  [/\\sqrt/g, "√"],
  [/\\%/g, "%"],
  [/\\ldots|\\dots/g, "…"],
  [/\\pi/g, "π"],
  [/\\[a-zA-Z]+/g, ""], // 其余命令去掉反斜杠命令名
  [/\\\{/g, "{"],
  [/\\\}/g, "}"],
];

const SUP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", n: "ⁿ", "-": "⁻",
};

function renderMath(src: string): string {
  let s = src;
  for (const [re, to] of LATEX_MAP) s = s.replace(re, to);
  // x^{2} / x^2 → 上标
  s = s.replace(/\^\{?([0-9n-]+)\}?/g, (_, p: string) =>
    p.split("").map((c) => SUP[c] ?? `^${c}`).join(""),
  );
  return s.replace(/[{}]/g, "").trim();
}

function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\$[^$]+\$|\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((seg, i) => {
    if (seg.startsWith("$") && seg.endsWith("$") && seg.length > 2) {
      return (
        <span key={i} className="font-serif italic px-0.5 text-foreground">
          {renderMath(seg.slice(1, -1))}
        </span>
      );
    }
    if (seg.startsWith("**") && seg.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {renderInline(seg.slice(2, -2))}
        </strong>
      );
    }
    if (seg.startsWith("`") && seg.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-muted px-1 py-px text-[0.9em] font-mono">
          {seg.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{seg}</span>;
  });
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "math"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "svg"; text: string }
  | { kind: "figure"; text: string }
  | { kind: "hr" };

/**
 * SVG 清洗：模型生成的示意图只允许静态图形元素。
 * 去掉脚本、事件属性、javascript: 链接、foreignObject 等可能执行代码或外联的部分。
 */
export function sanitizeSvg(src: string): string {
  let s = src.trim();
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  // 成对出现的危险标签整段删除
  for (;;) {
    const next = s.replace(
      /<\s*(script|foreignObject|iframe|object|embed|audio|video|link|meta|style|image)\b[\s\S]*?<\s*\/\s*\1\s*>/gi,
      "",
    );
    if (next === s) break;
    s = next;
  }
  // 自闭合/裸开的危险标签
  s = s.replace(/<\s*\/?\s*(script|foreignObject|iframe|object|embed|audio|video|link|meta|style|image)\b[^>]*>/gi, "");
  // <use> 单独处理：LaTeX 编译产物用 <use xlink:href="#glyph…"> 引用内部字形（文字必需），放行；
  // 引用外部资源的 <use> 一律删除
  s = s.replace(/<use\b[^>]*>/gi, (tag) => {
    const m = /(?:xlink:)?href\s*=\s*(["'])([^"']*)\1/i.exec(tag);
    return m && m[2].startsWith("#") ? tag : "";
  });
  // 事件属性 onxxx="..." / ='...' / =裸值
  s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  // javascript: 链接
  s = s.replace(/((?:xlink:)?href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
  return s.trim();
}

function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: "p", lines: para });
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      flushPara();
      continue;
    }
    if (t === "---" || t === "***") {
      flushPara();
      blocks.push({ kind: "hr" });
      continue;
    }
    // 围栏代码块：```svg 渲染成示意图，其它语言渲染成代码块
    const fence = t.match(/^```\s*(\w*)\s*$/);
    // 流式场景：模型常写成 ```figure atlas-123（id 跟在语言名后面、同一行）
    const figFence = fence ? null : t.match(/^```\s*figure\s+([^\s`]+)\s*$/);
    if (fence || figFence) {
      flushPara();
      const body: string[] = [];
      while (i + 1 < lines.length && !/^\s*```/.test(lines[i + 1])) body.push(lines[++i]);
      i++; // 跳过收尾的 ```
      if (figFence) {
        blocks.push({ kind: "figure", text: [figFence[1], ...body].join("\n") });
        continue;
      }
      if (fence![1] === "svg") blocks.push({ kind: "svg", text: body.join("\n") });
      else if (fence![1] === "figure") blocks.push({ kind: "figure", text: body.join("\n") });
      else blocks.push({ kind: "code", lang: fence![1], text: body.join("\n") });
      continue;
    }
    // 兜底：模型把围栏弄丢时，裸的 <svg …> 也按示意图处理（收到 </svg> 为止）
    if (/^(?:svg\s*)?<svg[\s>]/i.test(t)) {
      flushPara();
      const body: string[] = [t.replace(/^svg\s*(?=<svg)/i, "")];
      while (!/<\/svg>/i.test(body[body.length - 1]) && i + 1 < lines.length) body.push(lines[++i]);
      blocks.push({ kind: "svg", text: body.join("\n") });
      continue;
    }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      blocks.push({ kind: "h", level: h[1].length, text: h[2] });
      continue;
    }
    if (t.startsWith("$$")) {
      flushPara();
      let body = t.slice(2);
      while (!body.endsWith("$$") && i + 1 < lines.length) body += "\n" + lines[++i].trim();
      blocks.push({ kind: "math", text: body.replace(/\$\$$/, "") });
      continue;
    }
    const ul = t.match(/^[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      const items: string[] = [ul[1]];
      while (i + 1 < lines.length) {
        const m = lines[i + 1].trim().match(/^[-*]\s+(.*)$/);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
    const ol = t.match(/^\d+[.、]\s*(.*)$/);
    if (ol) {
      flushPara();
      const items: string[] = [ol[1]];
      while (i + 1 < lines.length) {
        const m = lines[i + 1].trim().match(/^\d+[.、]\s*(.*)$/);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }
    para.push(t);
  }
  flushPara();
  return blocks;
}

export function Markdown({
  text,
  className = "",
  inline = false,
}: {
  text: string;
  className?: string;
  /** 行内模式：只渲染加粗/代码/公式，不出块级结构（用于选项、列表项等） */
  inline?: boolean;
}) {
  if (inline) return <span className={className}>{renderInline(text ?? "")}</span>;
  const blocks = parseBlocks(text ?? "");
  return (
    <div className={`space-y-2 leading-relaxed ${className}`}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "h":
            return (
              <div key={i} className={`font-semibold text-foreground ${b.level <= 2 ? "text-base mt-1" : "text-[0.95em]"}`}>
                {renderInline(b.text)}
              </div>
            );
          case "ul":
            return (
              <ul key={i} className="space-y-1 pl-1">
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-2">
                    <span className="text-primary shrink-0">•</span>
                    <span className="flex-1">{renderInline(it)}</span>
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="space-y-1 pl-1">
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-2">
                    <span className="text-primary shrink-0 tabular-nums">{j + 1}.</span>
                    <span className="flex-1">{renderInline(it)}</span>
                  </li>
                ))}
              </ol>
            );
          case "math":
            return (
              <div key={i} className="my-1 rounded-lg bg-muted/60 px-3 py-2 text-center font-serif italic">
                {renderMath(b.text)}
              </div>
            );
          case "code":
            return (
              <pre
                key={i}
                className="overflow-x-auto whitespace-pre rounded-lg bg-neutral-950 px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-neutral-100"
              >
                {b.text}
              </pre>
            );
          case "svg": {
            const clean = sanitizeSvg(b.text);
            // 只接受完整的一个 <svg> 根元素；不完整或不含 svg 的按代码展示，不硬渲染
            if (!/^<svg[\s>]/i.test(clean) || !/<\/svg>\s*$/i.test(clean)) {
              return (
                <pre
                  key={i}
                  className="overflow-x-auto whitespace-pre rounded-lg bg-neutral-950 px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-neutral-100"
                >
                  {b.text}
                </pre>
              );
            }
            return (
              <div
                key={i}
                className="my-2 flex justify-center rounded-xl border border-border bg-white p-3 [&_svg]:h-auto [&_svg]:w-full [&_svg]:max-w-[440px]"
                // 已经过 sanitizeSvg 清洗：无脚本、无事件、无外联
                dangerouslySetInnerHTML={{ __html: clean }}
              />
            );
          }
          case "figure": {
            // 教材原图：后端会把 ```figure atlas-NNN / phy-NNN 规范成一段 JSON（src / name / kind）；
            // 流式输出时还没经过后端替换，这里按 id 查本地映射也能直接出图
            let meta: { src?: unknown; name?: unknown; kind?: unknown; note?: unknown } = {};
            try {
              meta = JSON.parse(b.text) as typeof meta;
            } catch {
              meta = {};
            }
            let src =
              typeof meta.src === "string" && /^\/atlas\/[\w.-]+$/.test(meta.src) ? meta.src : null;
            let name = typeof meta.name === "string" ? meta.name : "";
            let kind = typeof meta.kind === "string" ? meta.kind : "";
            if (!src) {
              const id = b.text.match(/(?:atlas|phy|phs|his|bio|geo)-\d{3}/)?.[0];
              const hit = id ? ATLAS_FIGURES[id] : undefined;
              if (!hit) return null;
              src = `/atlas/${hit.file}`;
              name = name || hit.name;
              kind = kind || hit.kind;
            }
            const isWrong = kind === "wrong";
            return (
              <figure
                key={i}
                className="my-3 flex flex-col items-center gap-2 rounded-xl border border-border bg-white px-3 py-3"
              >
                <img
                  src={src}
                  alt={name || "装置图"}
                  loading="lazy"
                  className="h-auto max-h-[340px] w-auto max-w-full object-contain"
                />
                {(name || isWrong) && (
                  <figcaption className="text-center text-[12px] leading-relaxed text-muted-foreground">
                    {name}
                    {isWrong && (
                      <span className="ml-1 font-medium text-amber-700">（反例：先找出图里的错误）</span>
                    )}
                  </figcaption>
                )}
              </figure>
            );
          }
          case "hr":
            return <hr key={i} className="border-border" />;
          default:
            return (
              <p key={i}>
                {b.lines.map((l, j) => (
                  <span key={j}>
                    {j > 0 && <br />}
                    {renderInline(l)}
                  </span>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
