import { Link } from "react-router";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/lib/errors";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

export default function KbList() {
  const utils = trpc.useUtils();
  const kbs = trpc.kb.list.useQuery();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const create = trpc.kb.create.useMutation({
    onSuccess: (data) => {
      toast.success("知识库已创建，去上传文档吧");
      setOpen(false);
      setName("");
      setDescription("");
      utils.kb.list.invalidate();
      location.assign(`/kb/${data.id}`);
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const remove = trpc.kb.remove.useMutation({
    onSuccess: () => {
      toast.success("已删除");
      utils.kb.list.invalidate();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  return (
    <div className="anim-in">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="font-display text-3xl font-bold">知识库</h1>
          <p className="text-sm text-muted-foreground mt-1">
            上传学习资料，系统解析成文字并建立索引——之后讲授和出题只用索引文本。
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="size-4" />新建知识库</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新建知识库</DialogTitle>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                create.mutate({ name: name.trim(), description: description.trim() || undefined });
              }}
            >
              <Input
                placeholder="名称，例如：五年级数学下册"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <Textarea
                placeholder="备注（可选）"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
              <Button type="submit" className="w-full" disabled={create.isPending || !name.trim()}>
                {create.isPending ? "创建中…" : "创建"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {kbs.data?.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border px-6 py-16 text-center text-muted-foreground">
          还没有知识库。点右上角「新建知识库」开始。
        </div>
      )}

      <div className="space-y-3">
        {kbs.data?.map((kb) => (
          <div
            key={kb.id}
            className="group flex items-center gap-4 rounded-2xl bg-card border border-transparent hover:border-primary/40 transition-colors duration-200 px-5 py-4"
          >
            <Link to={`/kb/${kb.id}`} className="flex-1 min-w-0 focus-visible:outline-2 focus-visible:outline-ring rounded">
              <div className="font-semibold truncate">{kb.name}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {kb.docCount} 篇文档 · {kb.chunkCount} 个索引块
                {kb.description ? ` · ${kb.description}` : ""}
              </div>
            </Link>
            <button
              type="button"
              aria-label={`删除 ${kb.name}`}
              className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-2 focus-visible:outline-ring cursor-pointer"
              onClick={() => {
                if (confirm(`确定删除「${kb.name}」？其中的文档、索引和相关课程都会一并删除。`)) {
                  remove.mutate({ id: kb.id });
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
