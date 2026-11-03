import { Link } from "react-router";
import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/lib/errors";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export default function CourseList() {
  const utils = trpc.useUtils();
  const courseList = trpc.course.list.useQuery();
  const kbs = trpc.kb.list.useQuery();
  const [open, setOpen] = useState(false);
  const [kbId, setKbId] = useState<string>("");
  const [goal, setGoal] = useState("");
  /** 模块数目标；0 = 自动（按文档数/内容体量/目录/时间安排算） */
  const [moduleLimit, setModuleLimit] = useState(0);

  const generate = trpc.course.generate.useMutation({
    onSuccess: (data) => {
      toast.success("课程已生成");
      setOpen(false);
      setGoal("");
      utils.course.list.invalidate();
      location.assign(`/learn/${data.id}`);
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const remove = trpc.course.remove.useMutation({
    onSuccess: () => {
      toast.success("已删除");
      utils.course.list.invalidate();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const readyKbs = kbs.data?.filter((k) => k.docCount > 0) ?? [];

  return (
    <div className="anim-in">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="font-display text-3xl font-bold">课程</h1>
          <p className="text-sm text-muted-foreground mt-1">
            说一句学习目标，系统把知识库分解成一条模块化的学习路线。
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="size-4" />生成课程</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>生成新课程</DialogTitle>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!kbId || goal.trim().length < 2) return;
                generate.mutate({
                  kbId: Number(kbId),
                  goal: goal.trim(),
                  ...(moduleLimit >= 3 ? { moduleLimit } : {}),
                });
              }}
            >
              <Select value={kbId} onValueChange={setKbId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择知识库" />
                </SelectTrigger>
                <SelectContent>
                  {readyKbs.map((kb) => (
                    <SelectItem key={kb.id} value={String(kb.id)}>
                      {kb.name}（{kb.docCount} 篇文档）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {readyKbs.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  还没有已建好索引的知识库，请先到「知识库」页上传文档。
                </p>
              )}
              <Textarea
                placeholder={"学习目标，例如：\n· 帮孩子系统掌握五年级分数运算\n· 两周内过完这本讲义的重点"}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={4}
              />
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <label htmlFor="module-limit" className="text-muted-foreground">课程规模（模块数）</label>
                  <span className="font-medium">{moduleLimit >= 3 ? `${moduleLimit} 个模块` : "自动"}</span>
                </div>
                <input
                  id="module-limit"
                  type="range"
                  min={0}
                  max={60}
                  step={1}
                  value={moduleLimit}
                  onChange={(e) => setModuleLimit(Number(e.target.value))}
                  className="w-full accent-primary"
                />
                <p className="text-xs text-muted-foreground">
                  自动 = 按资料体量、目录章数和学习目标里的时间安排（如"两学期""每天1小时"）折算。0 表示自动。
                </p>
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={generate.isPending || !kbId || goal.trim().length < 2}
              >
                {generate.isPending ? (
                  <><Loader2 className="size-4 animate-spin" />正在分解知识库，生成路线（约半分钟）…</>
                ) : "生成学习路线"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {courseList.data?.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border px-6 py-16 text-center text-muted-foreground">
          还没有课程。点右上角「生成课程」，从知识库变出一条学习路线。
        </div>
      )}

      <div className="space-y-3">
        {courseList.data?.map((course, i) => (
          <div
            key={course.id}
            className="group flex items-center gap-5 rounded-2xl bg-card border border-transparent hover:border-primary/40 transition-colors duration-200 px-5 py-4"
          >
            <span className="font-display text-2xl text-primary/60 tabular-nums w-9 shrink-0">
              {String(i + 1).padStart(2, "0")}
            </span>
            <Link to={`/learn/${course.id}`} className="flex-1 min-w-0 rounded focus-visible:outline-2 focus-visible:outline-ring">
              <div className="font-semibold truncate">{course.title}</div>
              {course.description && (
                <div className="text-xs text-muted-foreground/90 mt-0.5 line-clamp-1">{course.description}</div>
              )}
              <div className="text-xs text-muted-foreground mt-0.5">
                {course.moduleCount} 个模块 · {course.objectiveCount} 个知识点 · 源自「{course.kbName}」
              </div>
              <div className="text-sm text-muted-foreground mt-1 line-clamp-1">目标：{course.goal}</div>
            </Link>
            <button
              type="button"
              aria-label={`删除 ${course.title}`}
              className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                if (confirm(`删除课程「${course.title}」？学习记录会一并清除。`)) {
                  remove.mutate({ id: course.id });
                }
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
