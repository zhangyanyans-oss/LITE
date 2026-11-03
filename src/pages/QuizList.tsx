import { Link } from "react-router";
import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/lib/errors";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export default function QuizList() {
  const utils = trpc.useUtils();
  const quizList = trpc.quiz.list.useQuery();
  const kbs = trpc.kb.list.useQuery();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [kbId, setKbId] = useState<string>("none");
  const [count, setCount] = useState<string>("5");

  const generate = trpc.quiz.generate.useMutation({
    onSuccess: (data) => {
      toast.success(`已生成 ${data.questionCount} 道题`);
      setOpen(false);
      setTopic("");
      utils.quiz.list.invalidate();
      location.assign(`/quiz/${data.id}`);
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const remove = trpc.quiz.remove.useMutation({
    onSuccess: () => {
      toast.success("已删除");
      utils.quiz.list.invalidate();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  return (
    <div className="anim-in">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="font-display text-3xl font-bold">出题</h1>
          <p className="text-sm text-muted-foreground mt-1">
            给一个主题，一次生成完整试卷——选择题自动判分，简答题 AI 阅卷并标注错因。
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="size-4" />出一套题</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>出一套题</DialogTitle>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (topic.trim().length < 2) return;
                generate.mutate({
                  topic: topic.trim(),
                  kbId: kbId === "none" ? undefined : Number(kbId),
                  count: Number(count),
                });
              }}
            >
              <Input
                placeholder="主题，例如：分数的加减法"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                autoFocus
              />
              <div className="grid grid-cols-2 gap-3">
                <Select value={kbId} onValueChange={setKbId}>
                  <SelectTrigger>
                    <SelectValue placeholder="出题依据" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不限（通识出题）</SelectItem>
                    {kbs.data?.map((kb) => (
                      <SelectItem key={kb.id} value={String(kb.id)}>
                        依据「{kb.name}」
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={count} onValueChange={setCount}>
                  <SelectTrigger>
                    <SelectValue placeholder="题量" />
                  </SelectTrigger>
                  <SelectContent>
                    {[3, 5, 8, 10].map((n) => (
                      <SelectItem key={n} value={String(n)}>{n} 道题</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" className="w-full" disabled={generate.isPending || topic.trim().length < 2}>
                {generate.isPending ? (
                  <><Loader2 className="size-4 animate-spin" />正在出题（约 20 秒）…</>
                ) : "生成试卷"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {quizList.data?.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border px-6 py-16 text-center text-muted-foreground">
          还没有试卷。点右上角「出一套题」。
        </div>
      )}

      <div className="space-y-3">
        {quizList.data?.map((quiz) => (
          <div
            key={quiz.id}
            className="group flex items-center gap-4 rounded-2xl bg-card border border-transparent hover:border-primary/40 transition-colors duration-200 px-5 py-4"
          >
            <Link to={`/quiz/${quiz.id}`} className="flex-1 min-w-0 rounded focus-visible:outline-2 focus-visible:outline-ring">
              <div className="font-semibold truncate">{quiz.topic}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {quiz.questionCount} 道题{quiz.kbName ? ` · 依据「${quiz.kbName}」` : " · 通识出题"}
              </div>
            </Link>
            <button
              type="button"
              aria-label={`删除 ${quiz.topic}`}
              className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                if (confirm(`删除试卷「${quiz.topic}」？`)) remove.mutate({ id: quiz.id });
              }}
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
