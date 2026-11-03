import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Play, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { normalizeProgramOutput } from "../../contracts/types";

/**
 * 内置 C++ 代码框：JSCPP 浏览器解释器，不需要本地编译。
 * 运行放在 Web Worker 里（8 秒超时自动终止），死循环不会卡死页面。
 * 结构遵循练习规则：上方代码框，中间「运行」，下方输出窗；报错显示「运行出错：xxx」。
 * 注：规则里写的 jscpp@2.0.9 在国内镜像上并不存在（2.0.8/2.0.9 的 npm 包不再包含 dist 浏览器包），
 * 用同一镜像上最后一个带浏览器包的 2.0.6，解释器本体一致。
 */
const JSCPP_CDN = "https://cdn.jsdmirror.com/npm/JSCPP@2.0.6/dist/JSCPP.es5.min.js";

type RunOutcome = { output?: string; error?: string };

function runInWorkerOnce(code: string, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const workerSource = `
      importScripts(${JSON.stringify(JSCPP_CDN)});
      onmessage = function (e) {
        var out = "";
        try {
          JSCPP.run(e.data, "", { stdio: { write: function (s) { out += s; } } });
          postMessage({ output: out });
        } catch (err) {
          postMessage({ error: String((err && err.message) || err), output: out });
        }
      };
    `;
    const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    const worker = new Worker(url);
    const done = (r: RunOutcome) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ error: "运行超时（超过 8 秒）——检查是不是写成了死循环？" }),
      timeoutMs,
    );
    worker.onmessage = (e) => done(e.data as RunOutcome);
    worker.onerror = (e) => done({ error: `__LOAD_FAIL__${e.message || ""}` });
    worker.postMessage(code);
  });
}

/** 首次加载 CDN 脚本偶尔会握手失败，加载类失败自动重试一次（此时缓存已热，基本必成） */
async function runInWorker(code: string, timeoutMs = 8000): Promise<RunOutcome> {
  const first = await runInWorkerOnce(code, timeoutMs);
  if (first.error?.startsWith("__LOAD_FAIL__")) {
    const second = await runInWorkerOnce(code, timeoutMs);
    if (second.error?.startsWith("__LOAD_FAIL__")) {
      return { error: "解释器加载失败，请检查网络后重试" };
    }
    return second;
  }
  return first;
}

export const DEFAULT_CODE_FRAME = `#include <iostream>
using namespace std;

int main() {
    // 在这里写代码

    return 0;
}
`;

export function CodeRunner({
  code,
  onChange,
  expectedOutput,
  disabled,
  onRunResult,
}: {
  code: string;
  onChange: (code: string) => void;
  /** 给了预期输出就会在运行后自动判别 */
  expectedOutput?: string;
  disabled?: boolean;
  /** 运行成功后把输出回传给父组件（提交判分时用）；运行失败回传 undefined */
  onRunResult?: (output: string | undefined) => void;
}) {
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [ran, setRan] = useState(false);
  const starterRef = useRef(code);

  const passed =
    ran && !error && expectedOutput !== undefined
      ? normalizeProgramOutput(output) === normalizeProgramOutput(expectedOutput)
      : undefined;

  const run = async () => {
    setRunning(true);
    setError("");
    setOutput("");
    const r = await runInWorker(code);
    setRunning(false);
    setRan(true);
    if (r.error) {
      setError(r.error);
      setOutput(r.output ?? "");
      onRunResult?.(undefined);
    } else {
      setOutput(r.output ?? "");
      onRunResult?.(r.output ?? "");
    }
  };

  // 换题/重置时清空运行状态
  useEffect(() => {
    starterRef.current = code;
  }, []);

  return (
    <div className="space-y-2">
      <textarea
        value={code}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="w-full rounded-lg border border-border bg-neutral-950 px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-neutral-100 min-h-44 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-70"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={run} disabled={disabled || running}>
          {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          {running ? "运行中…" : "运行"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || running}
          onClick={() => {
            onChange(starterRef.current);
            setOutput("");
            setError("");
            setRan(false);
            onRunResult?.(undefined);
          }}
        >
          <RotateCcw className="size-4" />
          重置代码
        </Button>
        {passed !== undefined &&
          (passed ? (
            <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
              <CheckCircle2 className="size-4" />
              判别：通过，输出与预期一致
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-sm font-medium text-destructive">
              <XCircle className="size-4" />
              判别：未通过，输出与预期不一致
            </span>
          ))}
      </div>
      <div className="rounded-lg border border-border bg-neutral-950 px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-neutral-100 min-h-14 whitespace-pre-wrap break-all">
        {error ? (
          <span className="text-red-400">运行出错：{error}</span>
        ) : ran ? (
          output || <span className="text-neutral-500">（程序结束，没有任何输出）</span>
        ) : (
          <span className="text-neutral-500">点「运行」在这里看结果…</span>
        )}
      </div>
    </div>
  );
}
