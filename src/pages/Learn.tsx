import { useParams, Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpenText,
  CheckCircle2,
  ChevronRight,
  Circle,
  ClipboardList,
  GraduationCap,
  History,
  Lightbulb,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/lib/errors";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type {
  GradeResult,
  Lesson,
  ObjectiveStage,
  QuizPhase,
  QuizQuestion,
  QuizVariant,
} from "../../contracts/types";

import { Markdown } from "@/components/Markdown";
import { CodeRunner, DEFAULT_CODE_FRAME } from "@/components/CodeRunner";

type QuizPayload = { phase: QuizPhase; objectiveId: string; objectiveTitle: string; questions: QuizQuestion[] };
type GradePayload = {
  phase: QuizPhase;
  objectiveTitle: string;
  results: GradeResult[];
  score: number;
  outcome: "baseline" | "passed" | "retry" | "weak";
  finalAttempts?: number;
  /** 错题变形卷：考点不变、情境全换的一道加练单选（翻牌自测） */
  variant?: QuizVariant;
};

const PHASE_LABEL: Record<QuizPhase, string> = { diagnostic: "摸底测试", final: "结课测验" };

function QuizCard({
  messageId,
  payload,
  courseId,
  graded,
  onGraded,
}: {
  messageId: number;
  payload: QuizPayload;
  courseId: number;
  graded: boolean;
  onGraded: (outcome: GradePayload["outcome"], focus: string, score: number, objectiveId: string) => void;
}) {
  const utils = trpc.useUtils();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [runOutputs, setRunOutputs] = useState<Record<string, string | undefined>>({});
  const grade = trpc.learn.grade.useMutation({
    onSuccess: (data) => {
      utils.learn.messages.invalidate({ courseId });
      utils.learn.state.invalidate({ courseId });
      onGraded(data.outcome, data.focus ?? "", data.score ?? 0, payload.objectiveId);
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  /** 编程题的"答案"就是代码本身：没改过就用预置框架 */
  const codeOf = (q: QuizQuestion) => answers[q.id] ?? q.starterCode ?? DEFAULT_CODE_FRAME;
  const allAnswered = payload.questions.every((q) =>
    q.type === "code" ? codeOf(q).trim().length > 0 : (answers[q.id] ?? "").trim().length > 0,
  );
  const isDiag = payload.phase === "diagnostic";

  return (
    <div className="rounded-2xl border border-primary/30 bg-card px-5 py-4 space-y-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-primary">
        <ClipboardList className="size-4" />
        {PHASE_LABEL[payload.phase]} · {payload.objectiveTitle}
      </div>
      {payload.questions.map((q, qi) => (
        <div key={q.id} className="space-y-2">
          <div className="text-[15px]">
            <span className="text-muted-foreground mr-2">
              {q.type === "choice" ? "选择" : q.type === "code" ? "编程" : "简答"}
            </span>
            <span className="mr-1.5">{qi + 1}.</span>
            <Markdown text={q.stem} inline />
          </div>
          {q.type === "code" && q.expectedOutput !== undefined && (
            <div className="rounded-lg border border-dashed border-border bg-muted/40 px-3.5 py-2 text-[13px]">
              <span className="text-muted-foreground">预期输出：</span>
              <pre className="mt-1 font-mono whitespace-pre-wrap break-all">{q.expectedOutput}</pre>
            </div>
          )}
          {q.type === "choice" ? (
            <div className="grid gap-1.5">
              {q.options?.map((opt, oi) => {
                const letter = String.fromCharCode(65 + oi);
                const selected = answers[q.id] === letter;
                return (
                  <button
                    key={oi}
                    type="button"
                    disabled={graded}
                    onClick={() => setAnswers((a) => ({ ...a, [q.id]: letter }))}
                    className={[
                      "text-left rounded-lg border px-3.5 py-2 text-sm transition-colors duration-150 cursor-pointer",
                      "focus-visible:outline-2 focus-visible:outline-ring",
                      selected ? "border-primary bg-primary/10" : "border-border hover:border-primary/40",
                      graded ? "opacity-70 cursor-not-allowed" : "",
                    ].join(" ")}
                  >
                    <span className="font-semibold mr-2">{letter}.</span>
                    <Markdown text={opt} inline />
                  </button>
                );
              })}
            </div>
          ) : q.type === "code" ? (
            <CodeRunner
              code={codeOf(q)}
              disabled={graded}
              expectedOutput={q.expectedOutput}
              onChange={(code) => setAnswers((a) => ({ ...a, [q.id]: code }))}
              onRunResult={(out) => setRunOutputs((r) => ({ ...r, [q.id]: out }))}
            />
          ) : (
            <textarea
              disabled={graded}
              className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm min-h-20 focus-visible:outline-2 focus-visible:outline-ring"
              placeholder="写下你的答案…"
              value={answers[q.id] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
            />
          )}
        </div>
      ))}
      {!graded && (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={!allAnswered || grade.isPending}
            onClick={() =>
              grade.mutate({
                courseId,
                messageId,
                answers: payload.questions.map((q) => ({
                  questionId: q.id,
                  answer: q.type === "code" ? codeOf(q) : (answers[q.id] ?? ""),
                  runOutput: q.type === "code" ? runOutputs[q.id] : undefined,
                })),
              })
            }
          >
            {grade.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            提交判分
          </Button>
          <span className="text-xs text-muted-foreground">
            {isDiag ? "摸底只用来了解基础，放轻松答。" : "80 分过关；最多补考 1 次，之后自动放行。"}
          </span>
        </div>
      )}
    </div>
  );
}

/** 变形加练题：考点不变、情境全换的一题，点选后当场揭晓对错与解析 */
function VariantCard({ variant }: { variant: QuizVariant }) {
  const [picked, setPicked] = useState<string | null>(null);
  const correctLetter = variant.answer.trim().toUpperCase().charAt(0);
  return (
    <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 py-3 space-y-2">
      <div className="text-sm font-semibold text-primary">加练一题 · 换个情境再考你一次</div>
      <Markdown text={variant.stem} className="text-sm" />
      <div className="grid gap-1.5">
        {variant.options.map((opt, i) => {
          const letter = "ABCD"[i];
          const isCorrect = letter === correctLetter;
          const chosen = picked === letter;
          return (
            <button
              key={letter}
              type="button"
              disabled={picked !== null}
              onClick={() => setPicked(letter)}
              className={`text-left text-sm rounded-lg px-3 py-1.5 border transition-colors ${
                picked === null
                  ? "border-border hover:border-primary/50 hover:bg-primary/5 cursor-pointer"
                  : isCorrect
                    ? "border-primary/60 bg-primary/10 text-primary"
                    : chosen
                      ? "border-destructive/60 bg-destructive/10 text-destructive"
                      : "border-border opacity-60"
              }`}
            >
              <span className="font-semibold mr-1.5">{letter}.</span>
              {opt}
            </button>
          );
        })}
      </div>
      {picked !== null && (
        <div className="text-sm space-y-1">
          <div className={picked === correctLetter ? "text-primary font-medium" : "text-destructive font-medium"}>
            {picked === correctLetter ? "答对了——这个易错点已经拿下。" : "又掉进同一个坑了——看解析，把这个点记住。"}
          </div>
          <Markdown text={variant.explanation} className="text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

function GradeCard({ payload, onNext }: { payload: GradePayload; onNext?: () => void }) {
  const headline =
    payload.outcome === "baseline"
      ? `摸底完成 · 基础得分 ${Math.round(payload.score * 100)} 分`
      : payload.outcome === "passed"
        ? `结课测验通过 · ${Math.round(payload.score * 100)} 分，本课完成！`
        : payload.outcome === "retry"
          ? `本次 ${Math.round(payload.score * 100)} 分，还差一点 —— 老师已针对错题重新备课`
          : `本课标记为「待巩固」，先继续往后学，别卡在这里`;
  return (
    <div className="rounded-2xl border border-border bg-card px-5 py-4 space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold">
        {payload.outcome === "passed" ? (
          <span className="text-primary inline-flex items-center gap-1.5">
            <CheckCircle2 className="size-4" />
            {headline}
          </span>
        ) : (
          <span>{headline}</span>
        )}
      </div>
      <ul className="space-y-1.5 text-sm text-muted-foreground">
        {payload.results.map((r, i) => (
          <li key={r.questionId} className="flex gap-2">
            <span className={r.correct ? "text-primary" : "text-destructive"}>
              {r.correct ? "✓" : "✗"} 第 {i + 1} 题
            </span>
            <div className="flex-1">
              <Markdown text={r.feedback} />
              {r.errorType && !r.correct ? `（${r.errorType}）` : ""}
            </div>
          </li>
        ))}
      </ul>
      {payload.variant && payload.outcome !== "baseline" && (
        <VariantCard variant={payload.variant} />
      )}
      {onNext && (payload.outcome === "passed" || payload.outcome === "weak") && (
        <Button size="sm" className="mt-1" onClick={onNext}>
          进入下一课
          <span aria-hidden>→</span>
        </Button>
      )}
    </div>
  );
}

/** 交互式讲课卡：分段讲解 + 随堂快问（点选即时反馈）+ 操作按钮 */
function LessonCard({
  lesson,
  busy,
  onReexplain,
  onToFinal,
}: {
  lesson: Lesson;
  busy: boolean;
  onReexplain: () => void;
  onToFinal: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const correctLetter = lesson.quickCheck.answer.trim().toUpperCase().charAt(0);

  return (
    <div className="rounded-2xl border border-primary/30 bg-card px-5 py-5 space-y-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-primary">
        <BookOpenText className="size-4" />
        {lesson.title}
      </div>
      <Markdown text={lesson.intro} className="text-[15px] text-muted-foreground" />

      {lesson.sections.map((s, i) => (
        <section key={i} className="rounded-xl bg-background border border-border px-4 py-3">
          <h3 className="font-semibold text-[15px] mb-1.5">
            <span className="text-primary mr-2 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
            {s.heading}
          </h3>
          <Markdown text={s.content} className="text-[15px] text-foreground/90" />
        </section>
      ))}

      {/* 随堂快问：交互窗口，点一下立即反馈 */}
      <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 py-3.5 space-y-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Lightbulb className="size-4" />
          随堂快问 · 点一点，马上知道懂没懂
        </div>
        <Markdown text={lesson.quickCheck.stem} className="text-[15px]" />
        <div className="grid gap-1.5">
          {lesson.quickCheck.options.map((opt, oi) => {
            const letter = String.fromCharCode(65 + oi);
            const isRight = letter === correctLetter;
            const isPicked = picked === letter;
            return (
              <button
                key={oi}
                type="button"
                disabled={picked !== null}
                onClick={() => setPicked(letter)}
                className={[
                  "text-left rounded-lg border px-3.5 py-2 text-sm transition-colors duration-150 cursor-pointer",
                  "focus-visible:outline-2 focus-visible:outline-ring",
                  picked === null
                    ? "border-border bg-card hover:border-primary/40"
                    : isRight
                      ? "border-primary bg-primary/15 font-medium"
                      : isPicked
                        ? "border-destructive bg-destructive/10"
                        : "border-border opacity-60",
                ].join(" ")}
              >
                <span className="font-semibold mr-2">{letter}.</span>
                {opt}
                {picked !== null && isRight ? " ✓" : picked === letter && !isRight ? " ✗" : ""}
              </button>
            );
          })}
        </div>
        {picked !== null && (
          <p className="text-sm text-muted-foreground">
            {picked === correctLetter ? "答对了！" : `正确答案是 ${correctLetter}。`}
            <Markdown text={lesson.quickCheck.explanation} inline />
          </p>
        )}
      </div>

      <div className="rounded-xl bg-background border border-border px-4 py-3">
        <div className="text-xs font-semibold text-muted-foreground mb-1.5">本课要点</div>
        <ul className="space-y-1 text-sm list-disc list-inside">
          {lesson.takeaways.map((t, i) => (
            <li key={i}><Markdown text={t} inline /></li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onToFinal} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <GraduationCap className="size-4" />}
          我懂了，参加结课测验
        </Button>
        <Button size="sm" variant="outline" onClick={onReexplain} disabled={busy}>
          <RefreshCw className="size-4" />
          没太懂，换个方式再讲一遍
        </Button>
      </div>
    </div>
  );
}

const STAGE_META: Record<ObjectiveStage, { label: string; hint: string }> = {
  diagnose: { label: "摸底测试", hint: "3 道小题，摸摸底，老师好知道从哪讲起" },
  learn: { label: "上课", hint: "看讲解、点一点随堂快问" },
  final: { label: "结课测验", hint: "80 分过关，进下一课" },
  done: { label: "已完成", hint: "" },
};

/** 知识点类型徽标（DeepTutor 分类：记忆/概念/程序/设计） */
const TYPE_META: Record<string, { label: string; className: string }> = {
  memory: { label: "记忆", className: "bg-sky-100 text-sky-700" },
  concept: { label: "概念", className: "bg-violet-100 text-violet-700" },
  procedure: { label: "程序", className: "bg-rose-100 text-rose-700" },
  design: { label: "设计", className: "bg-orange-100 text-orange-700" },
};

export default function Learn() {
  const { courseId: raw } = useParams<{ courseId: string }>();
  const courseId = Number(raw);
  const state = trpc.learn.state.useQuery({ courseId });
  const utils = trpc.useUtils();

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null); // 跳跃学习：目录里点中的知识点
  /** null = 当前这段对话；给数字 = 正在回看某段历史（只读） */
  const [viewSession, setViewSession] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const gradedQuizIds = useRef<Set<number>>(new Set());

  const messages = trpc.learn.messages.useQuery({ courseId, sessionId: viewSession });
  const sessions = trpc.learn.sessions.useQuery({ courseId });
  const readingHistory = viewSession !== null;

  const startPhase = trpc.learn.startPhase.useMutation({
    onSuccess: () => {
      // 新内容永远写进"当前这段"，所以任何阶段动作都把视角拉回来
      setViewSession(null);
      messages.refetch();
      sessions.refetch();
      state.refetch();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  /**
   * 开始新对话：库里打一条分隔标记，页面只显示标记之后的消息。
   * 学习进度（掌握度/阶段）不在这里动——只清屏，不重来；旧对话在「历史对话」里还能翻。
   */
  const newSession = trpc.learn.newSession.useMutation({
    onSuccess: () => {
      setInput("");
      setStreaming(null);
      setViewSession(null);
      messages.refetch();
      sessions.refetch();
      utils.learn.state.invalidate({ courseId });
      toast.success("已开始新对话，上一段已存进「历史对话」");
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  /** 删除对话：默认删当前这段；回看历史时删的是正在看的那段 */
  const deleteSession = trpc.learn.deleteSession.useMutation({
    onSuccess: () => {
      setInput("");
      setStreaming(null);
      setViewSession(null);
      messages.refetch();
      sessions.refetch();
      toast.success("对话已删除");
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  /** 判分后的自动衔接：摸底完→自动备课开讲（全对则直接结课测验）；测验挂科→针对错题自动重讲 */
  function handleGraded(outcome: GradePayload["outcome"], focus: string, score: number, objectiveId: string) {
    if (outcome === "baseline") {
      if (score >= 0.999) {
        toast.success("摸底全对！没有要讲的，直接挑战结课测验…");
        startPhase.mutate({ courseId, phase: "final", objectiveId });
      } else {
        toast.success("摸底完成，老师正在针对薄弱点备课…");
        startPhase.mutate({ courseId, phase: "lesson", focus: focus || undefined, objectiveId });
      }
    } else if (outcome === "retry") {
      toast.info("别灰心，老师针对错题再讲一遍…");
      startPhase.mutate({ courseId, phase: "lesson", focus: focus || undefined, objectiveId });
    } else if (outcome === "passed") {
      toast.success("过关！点顶部横幅开始下一课");
      setSelectedId(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      toast.info("已标记待巩固，点顶部横幅继续下一课");
      setSelectedId(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    utils.learn.state.invalidate({ courseId });
  }

  // 已判分的题卡 id（grade 消息在题卡之后出现即视为已判）
  useEffect(() => {
    if (!messages.data) return;
    let lastQuizId = -1;
    for (const m of messages.data) {
      if (m.kind === "quiz") lastQuizId = m.id;
      if (m.kind === "grade" && lastQuizId > 0) gradedQuizIds.current.add(lastQuizId);
    }
  }, [messages.data]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.data, streaming]);

  async function send() {
    const text = input.trim();
    if (!text || streaming !== null || readingHistory) return;
    setInput("");
    setStreaming("");
    try {
      const res = await fetch("/api/learn/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, message: text, objectiveId: targetObj?.id }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `请求失败（${res.status}）`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setStreaming(acc);
      }
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setStreaming(null);
      // 落库前服务端可能还在编译 tikz 装置图（onFinish 里），
      // 流结束 ≠ 消息已入库——立即刷一次，再延迟补刷两次，保证编译完成的图能替换掉裸代码
      messages.refetch();
      sessions.refetch();
      setTimeout(() => messages.refetch(), 4000);
      setTimeout(() => messages.refetch(), 12000);
    }
  }

  const data = state.data;
  const pct = data && data.totalObjectives > 0 ? (data.masteredObjectives / data.totalObjectives) * 100 : 0;
  const allObjectives = data?.modules.flatMap((m) => m.objectives) ?? [];
  const currentObj = allObjectives.find((o) => o.current) ?? null;
  // 跳跃学习：右侧目录点哪个，横幅和按钮就作用在哪个知识点上；没点就跟系统进度走
  const targetObj = (selectedId ? allObjectives.find((o) => o.id === selectedId) : null) ?? currentObj;
  const jumping = !!selectedId && !!currentObj && selectedId !== currentObj.id;
  const allDone = !!data && data.totalObjectives > 0 && !currentObj;
  const busy = startPhase.isPending;
  /** 正在生成内容 / 正在流式回答时不允许切换对话，免得消息串到另一段里 */
  const chatLocked =
    busy || streaming !== null || newSession.isPending || deleteSession.isPending;

  /** 成绩单上的「进入下一课」：回到系统进度，直接开始下一课的摸底 */
  function startNext() {
    setSelectedId(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
    startPhase.mutate({ courseId, phase: "diagnostic" });
  }

  return (
    <div className="anim-in">
      <Link
        to="/courses"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 focus-visible:outline-2 focus-visible:outline-ring rounded"
      >
        <ArrowLeft className="size-4" />
        返回课程
      </Link>

      <div className="grid gap-6 md:grid-cols-[1fr_280px]">
        {/* 左：阶段横幅 + 对话/卡片流 */}
        <div className="order-2 md:order-1">
          {/* 阶段横幅：吸顶常驻，下一步按钮永远看得见；点右侧目录可跳到任意知识点 */}
          <div className="sticky top-3 z-20 rounded-2xl bg-primary text-primary-foreground shadow-lg px-5 py-4 mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            {targetObj ? (
              <>
                <div className="min-w-0">
                  <div className="text-xs opacity-80 flex items-center gap-2">
                    {jumping ? "跳跃学习" : "当前学习"} · {STAGE_META[targetObj.stage].label}
                    {jumping && (
                      <button
                        type="button"
                        onClick={() => setSelectedId(null)}
                        className="underline underline-offset-2 hover:opacity-100 opacity-90"
                      >
                        回到当前进度：{currentObj?.title}
                      </button>
                    )}
                  </div>
                  <div className="font-display font-bold text-lg leading-snug truncate">{targetObj.title}</div>
                  <div className="text-xs opacity-80 mt-0.5">
                    {targetObj.stage === "done" ? "这一课已完成，可以随时复习重讲或再测一次" : STAGE_META[targetObj.stage].hint}
                  </div>
                </div>
                <div className="ml-auto flex flex-wrap gap-2">
                  {targetObj.stage === "diagnose" && (
                    <>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => startPhase.mutate({ courseId, phase: "diagnostic", objectiveId: targetObj.id })}
                      >
                        {busy ? <Loader2 className="size-4 animate-spin" /> : <ClipboardList className="size-4" />}
                        开始摸底测试
                      </Button>
                      <Button
                        variant="outline"
                        className="bg-transparent text-primary-foreground border-primary-foreground/40 hover:bg-primary-foreground/10"
                        disabled={busy}
                        onClick={() => startPhase.mutate({ courseId, phase: "lesson", objectiveId: targetObj.id })}
                      >
                        <BookOpenText className="size-4" />
                        跳过摸底直接讲课
                      </Button>
                    </>
                  )}
                  {targetObj.stage === "learn" && (
                    <>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => startPhase.mutate({ courseId, phase: "lesson", objectiveId: targetObj.id })}
                      >
                        {busy ? <Loader2 className="size-4 animate-spin" /> : <BookOpenText className="size-4" />}
                        开始上课
                      </Button>
                      <Button
                        variant="outline"
                        className="bg-transparent text-primary-foreground border-primary-foreground/40 hover:bg-primary-foreground/10"
                        disabled={busy}
                        onClick={() => startPhase.mutate({ courseId, phase: "final", objectiveId: targetObj.id })}
                      >
                        <GraduationCap className="size-4" />
                        直接测验
                      </Button>
                    </>
                  )}
                  {targetObj.stage === "final" && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => startPhase.mutate({ courseId, phase: "final", objectiveId: targetObj.id })}
                    >
                      {busy ? <Loader2 className="size-4 animate-spin" /> : <GraduationCap className="size-4" />}
                      参加结课测验
                    </Button>
                  )}
                  {targetObj.stage === "done" && (
                    <>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => startPhase.mutate({ courseId, phase: "lesson", objectiveId: targetObj.id })}
                      >
                        {busy ? <Loader2 className="size-4 animate-spin" /> : <BookOpenText className="size-4" />}
                        再听一遍
                      </Button>
                      <Button
                        variant="outline"
                        className="bg-transparent text-primary-foreground border-primary-foreground/40 hover:bg-primary-foreground/10"
                        disabled={busy}
                        onClick={() => startPhase.mutate({ courseId, phase: "final", objectiveId: targetObj.id })}
                      >
                        <GraduationCap className="size-4" />
                        再测一次
                      </Button>
                    </>
                  )}
                </div>
              </>
            ) : allDone ? (
              <div className="font-display font-bold">这门课全部学完了！去「出题」页来套综合卷检验一下吧。</div>
            ) : null}
          </div>

          {/* 回看历史对话时：顶部说明 + 只读，避免把新消息写到另一段里去 */}
          {readingHistory && (
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900">
              <History className="size-3.5 shrink-0" />
              <span>正在回看历史对话（只读，不能接着提问）。</span>
              <button
                type="button"
                className="underline underline-offset-2 hover:text-amber-950"
                onClick={() => setViewSession(null)}
              >
                回到当前对话 →
              </button>
            </div>
          )}

          <div className="rounded-2xl bg-card border border-border px-5 py-4 space-y-4 min-h-[40vh]">
            {messages.data?.length === 0 && streaming === null && (
              <p className="text-sm text-muted-foreground py-10 text-center">
                {readingHistory
                  ? "这段对话里没有内容。"
                  : "点上方吸顶横幅的「开始摸底测试」进入第一课；右侧目录点任意知识点可直接跳课；也可以直接在下面问老师任何问题。"}
              </p>
            )}
            {messages.data?.map((m) => {
              if (m.kind === "quiz") {
                let payload: QuizPayload | null = null;
                try {
                  payload = JSON.parse(m.content);
                } catch {
                  /* 忽略损坏消息 */
                }
                return payload ? (
                  <QuizCard
                    key={m.id}
                    messageId={m.id}
                    payload={payload}
                    courseId={courseId}
                    graded={readingHistory || gradedQuizIds.current.has(m.id)}
                    onGraded={handleGraded}
                  />
                ) : null;
              }
              if (m.kind === "grade") {
                try {
                  return (
                    <GradeCard
                      key={m.id}
                      payload={JSON.parse(m.content)}
                      onNext={readingHistory ? undefined : startNext}
                    />
                  );
                } catch {
                  return null;
                }
              }
              if (m.kind === "lesson") {
                try {
                  const lesson = JSON.parse(m.content) as Lesson;
                  return (
                    <LessonCard
                      key={m.id}
                      lesson={lesson}
                      busy={busy || readingHistory}
                      onReexplain={() =>
                        startPhase.mutate({
                          courseId,
                          phase: "lesson",
                          objectiveId: m.objectiveId ?? targetObj?.id,
                          focus: "学生表示没听懂，请换一种更通俗的讲法，多用生活中的例子，并覆盖之前的薄弱点。",
                        })
                      }
                      onToFinal={() =>
                        startPhase.mutate({ courseId, phase: "final", objectiveId: m.objectiveId ?? targetObj?.id })
                      }
                    />
                  );
                } catch {
                  return null;
                }
              }
              return (
                <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={[
                      "prose-chat max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px]",
                      m.role === "user" ? "bg-primary text-primary-foreground" : "bg-background border border-border",
                    ].join(" ")}
                  >
                    <Markdown text={m.content} />
                  </div>
                </div>
              );
            })}
            {streaming !== null && (
              <div className="flex justify-start">
                <div className="prose-chat max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] bg-background border border-border">
                  {streaming ? <Markdown text={streaming} /> : <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {readingHistory ? (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
              <span>历史对话是只读的，接着提问请回到当前对话。</span>
              <Button size="sm" variant="outline" onClick={() => setViewSession(null)}>
                回到当前对话
              </Button>
            </div>
          ) : (
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <input
                className="flex-1 rounded-xl border border-border bg-card px-4 py-2.5 text-[15px] focus-visible:outline-2 focus-visible:outline-ring"
                placeholder="没听懂的地方，直接问老师…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={streaming !== null}
              />
              <Button type="submit" disabled={streaming !== null || !input.trim()}>
                <Send className="size-4" />
                发送
              </Button>
            </form>
          )}
        </div>

        {/* 右：课程进度树（带阶段标记） */}
        <aside className="order-1 md:order-2">
          <div className="md:sticky md:top-6 rounded-2xl bg-card border border-border px-5 py-4">
            <h2 className="font-display font-bold text-lg leading-snug">{data?.title ?? "课程"}</h2>
            {data?.description && (
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{data.description}</p>
            )}
            <div className="mt-3 flex items-center gap-3">
              <Progress value={pct} className="h-2 flex-1" />
              <span className="text-xs text-muted-foreground tabular-nums">
                {data?.masteredObjectives ?? 0}/{data?.totalObjectives ?? 0}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              每课三步：摸底 → 上课 → 结课测验。80 分过关，卡住会自动放行。点任意一课即可跳过去学。
            </p>

            {/* 对话管理：和课程大纲同一栏，动手不用来回找 */}
            <div className="mt-4 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  disabled={chatLocked}
                  title="清屏开一段新对话，学习进度保留"
                  onClick={() => newSession.mutate({ courseId })}
                >
                  {newSession.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <MessageSquarePlus className="size-4" />
                  )}
                  新对话
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={chatLocked}
                    >
                      <Trash2 className="size-4" />
                      删除对话
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{readingHistory ? "删除这段历史对话？" : "删除当前对话？"}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {readingHistory
                          ? "这段对话的消息会被永久删除，无法恢复。学习进度、掌握度和其他对话都不受影响。"
                          : "本段对话的消息会被永久删除，无法恢复。学习进度、掌握度和课程大纲都不受影响。如果只是想重新开个头，用「新对话」就好——它只清屏，记录留在「历史对话」里。"}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>取消</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-white hover:bg-destructive/90"
                        onClick={() => deleteSession.mutate({ courseId, sessionId: viewSession })}
                      >
                        删除
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                新对话只清屏，进度保留；旧对话在下面「历史对话」里能翻回来。
              </p>

              {/* 历史对话：旧对话不再"消失"，可点开只读回看 */}
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                className="mt-2.5 flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronRight className={`size-3.5 transition-transform ${showHistory ? "rotate-90" : ""}`} />
                历史对话（{sessions.data?.length ?? 0}）
              </button>
              {showHistory && (
                <ul className="mt-1.5 space-y-1">
                  {sessions.data?.length === 0 && (
                    <li className="px-2 py-1 text-[11px] text-muted-foreground">还没有历史对话。</li>
                  )}
                  {sessions.data?.map((s) => {
                    const active = s.current ? viewSession === null : viewSession === s.id;
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => setViewSession(s.current ? null : s.id)}
                          className={[
                            "w-full rounded-lg px-2.5 py-1.5 text-left transition-colors cursor-pointer",
                            "hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-ring",
                            active ? "bg-primary/10 ring-1 ring-primary/40" : "",
                          ].join(" ")}
                        >
                          <div className="truncate text-xs text-foreground">
                            {s.current && <span className="mr-1 text-primary">当前 ·</span>}
                            {s.preview || "（空对话）"}
                          </div>
                          <div className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
                            {s.startedAt ?? "最早"} · {s.count} 条
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="mt-5 space-y-4 max-h-[55vh] overflow-y-auto pr-1">
              {data?.modules.map((mod, mi) => (
                <div key={mod.id}>
                  <div className="text-xs font-semibold text-muted-foreground mb-1.5">
                    {String(mi + 1).padStart(2, "0")} · {mod.title}
                  </div>
                  {mod.objective && (
                    <div className="text-xs text-muted-foreground/80 leading-relaxed mb-1.5 pl-0.5">
                      学完能：{mod.objective}
                    </div>
                  )}
                  <ul className="space-y-1">
                    {mod.objectives.map((o) => (
                      <li key={o.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId((prev) => (prev === o.id ? null : o.id))}
                          title="点我跳到这一课"
                          className={[
                            "w-full text-left flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors cursor-pointer",
                            "hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-ring",
                            o.id === selectedId ? "bg-primary/10 ring-1 ring-primary/40 text-foreground"
                              : o.current && !selectedId ? "bg-primary/10 text-foreground"
                              : "text-muted-foreground",
                          ].join(" ")}
                        >
                          {o.stage === "done" ? (
                            <CheckCircle2
                              className={`size-4 mt-0.5 shrink-0 ${o.status === "weak" ? "text-amber-600" : "text-primary"}`}
                            />
                          ) : (
                            <Circle className={`size-4 mt-0.5 shrink-0 ${o.current ? "text-primary" : "text-border"}`} />
                          )}
                          <span className="flex-1 leading-snug">
                            {o.type && TYPE_META[o.type] && (
                              <span className={`mr-1.5 inline-block rounded px-1 py-px text-[10px] leading-4 align-middle ${TYPE_META[o.type].className}`}>
                                {TYPE_META[o.type].label}
                              </span>
                            )}
                            {o.title}
                            {o.stage !== "done" && o.current && (
                              <span className="ml-1.5 text-xs text-primary">{STAGE_META[o.stage].label}</span>
                            )}
                            {o.stage === "done" && o.status === "weak" && (
                              <span className="ml-1.5 text-xs text-amber-600">待巩固</span>
                            )}
                          </span>
                          {o.baseline != null && (
                            <span className="text-xs tabular-nums text-muted-foreground">
                              摸底{Math.round(o.baseline * 100)}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
