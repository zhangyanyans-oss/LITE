import { Link, useParams } from "react-router";
import { useState } from "react";
import { ArrowLeft, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/lib/errors";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import type { GradeResult, QuizQuestion } from "../../contracts/types";
import { Markdown } from "@/components/Markdown";
import { CodeRunner, DEFAULT_CODE_FRAME } from "@/components/CodeRunner";

export default function QuizDetail() {
  const { id } = useParams<{ id: string }>();
  const quizId = Number(id);
  const quiz = trpc.quiz.get.useQuery({ id: quizId });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [runOutputs, setRunOutputs] = useState<Record<string, string | undefined>>({});
  const [result, setResult] = useState<{ results: GradeResult[]; score: number } | null>(null);

  const submit = trpc.quiz.submit.useMutation({
    onSuccess: (data) => {
      setResult(data);
      quiz.refetch();
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const questions = quiz.data?.questions ?? [];
  const resultOf = (qid: string) => result?.results.find((r) => r.questionId === qid);
  const codeOf = (q: QuizQuestion) => answers[q.id] ?? q.starterCode ?? DEFAULT_CODE_FRAME;
  const allAnswered = questions.every((q) =>
    q.type === "code" ? codeOf(q).trim().length > 0 : (answers[q.id] ?? "").trim().length > 0,
  );

  return (
    <div className="anim-in">
      <Link to="/quiz" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 focus-visible:outline-2 focus-visible:outline-ring rounded">
        <ArrowLeft className="size-4" />返回出题
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="font-display text-3xl font-bold">{quiz.data?.topic ?? "试卷"}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {questions.length} 道题
            {result && ` · 本次得分 ${Math.round(result.score * 100)} 分`}
          </p>
        </div>
        {result && (
          <Button
            variant="secondary"
            onClick={() => {
              setResult(null);
              setAnswers({});
            }}
          >
            再做一遍
          </Button>
        )}
      </div>

      <div className="space-y-5">
        {questions.map((q, qi) => {
          const r = resultOf(q.id);
          return (
            <div key={q.id} className="rounded-2xl bg-card border border-border px-5 py-4">
              <p className="text-[15px] font-medium">
                <span className="text-muted-foreground mr-2 text-sm">
                  {q.type === "choice" ? "单选" : q.type === "code" ? "编程" : "简答"}
                </span>
                {qi + 1}. <Markdown text={q.stem} inline />
              </p>

              {q.type === "code" && q.expectedOutput !== undefined && (
                <div className="mt-3 rounded-lg border border-dashed border-border bg-muted/40 px-3.5 py-2 text-[13px]">
                  <span className="text-muted-foreground">预期输出：</span>
                  <pre className="mt-1 font-mono whitespace-pre-wrap break-all">{q.expectedOutput}</pre>
                </div>
              )}

              {q.type === "choice" ? (
                <div className="grid gap-1.5 mt-3">
                  {q.options?.map((opt, oi) => {
                    const letter = String.fromCharCode(65 + oi);
                    const selected = answers[q.id] === letter;
                    const isCorrectOption = r && q.answer.trim().toUpperCase().charAt(0) === letter;
                    return (
                      <button
                        key={oi}
                        type="button"
                        disabled={!!result}
                        onClick={() => setAnswers((a) => ({ ...a, [q.id]: letter }))}
                        className={[
                          "text-left rounded-lg border px-3.5 py-2 text-sm transition-colors duration-150 cursor-pointer",
                          "focus-visible:outline-2 focus-visible:outline-ring",
                          result
                            ? isCorrectOption
                              ? "border-primary bg-primary/10"
                              : selected
                                ? "border-destructive bg-destructive/10"
                                : "border-border opacity-60"
                            : selected
                              ? "border-primary bg-primary/10"
                              : "border-border hover:border-primary/40",
                          result ? "cursor-default" : "",
                        ].join(" ")}
                      >
                        <span className="font-semibold mr-2">{letter}.</span>
                        {opt}
                      </button>
                    );
                  })}
                </div>
              ) : q.type === "code" ? (
                <div className="mt-3">
                  <CodeRunner
                    code={codeOf(q)}
                    disabled={!!result}
                    expectedOutput={q.expectedOutput}
                    onChange={(code) => setAnswers((a) => ({ ...a, [q.id]: code }))}
                    onRunResult={(out) => setRunOutputs((r) => ({ ...r, [q.id]: out }))}
                  />
                </div>
              ) : (
                <textarea
                  disabled={!!result}
                  className="w-full mt-3 rounded-lg border border-border bg-background px-3.5 py-2 text-sm min-h-24 focus-visible:outline-2 focus-visible:outline-ring"
                  placeholder="写下你的答案…"
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                />
              )}

              {r && (
                <div className="mt-3 rounded-xl bg-background border border-border px-4 py-3 text-sm space-y-1">
                  <div className={`flex items-center gap-1.5 font-semibold ${r.correct ? "text-primary" : "text-destructive"}`}>
                    {r.correct ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
                    {r.correct ? "答对了" : `答错了${r.errorType ? `（${r.errorType}）` : ""}`}
                    {!r.correct && q.type === "choice" && <span className="font-normal">· 正确答案 {q.answer}</span>}
                  </div>
                  <p className="text-muted-foreground whitespace-pre-wrap">{r.feedback}</p>
                  {q.type === "short" && !r.correct && (
                    <p className="text-muted-foreground"><span className="text-foreground">参考答案：</span>{q.answer}</p>
                  )}
                  {q.type === "code" && !r.correct && (
                    <details className="text-muted-foreground">
                      <summary className="cursor-pointer text-foreground">查看参考代码</summary>
                      <pre className="mt-1.5 rounded-lg bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-100 whitespace-pre-wrap">{q.answer}</pre>
                    </details>
                  )}
                  {q.source && <p className="text-xs text-muted-foreground/70">依据：{q.source}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!result && questions.length > 0 && (
        <div className="sticky bottom-4 mt-6">
          <Button
            className="w-full shadow-lg"
            size="lg"
            disabled={!allAnswered || submit.isPending}
            onClick={() =>
              submit.mutate({
                quizId,
                answers: Object.fromEntries(
                  questions.map((q) => [q.id, q.type === "code" ? codeOf(q) : (answers[q.id] ?? "")]),
                ),
                runOutputs: Object.fromEntries(
                  questions
                    .filter((q) => q.type === "code" && runOutputs[q.id] !== undefined)
                    .map((q) => [q.id, runOutputs[q.id] as string]),
                ),
              })
            }
          >
            {submit.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            交卷判分{!allAnswered && "（还有题没答）"}
          </Button>
        </div>
      )}
    </div>
  );
}
