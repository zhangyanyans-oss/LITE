import { useParams, Link } from "react-router";
import { useRef, useState } from "react";
import { ArrowLeft, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/lib/errors";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";

export default function KbDetail() {
  const { id } = useParams<{ id: string }>();
  const kbId = Number(id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const kbs = trpc.kb.list.useQuery();
  const kb = kbs.data?.find((k) => k.id === kbId);

  // 有 pending 文档时每 2 秒轮询一次索引状态
  const docs = trpc.kb.documents.useQuery(
    { kbId },
    { refetchInterval: (q) => (q.state.data?.some((d) => d.status === "pending") ? 2000 : false) },
  );

  const deleteDoc = trpc.kb.deleteDocument.useMutation({
    onSuccess: () => {
      toast.success("文档已删除");
      docs.refetch();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  async function handleUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      const form = new FormData();
      for (const file of Array.from(fileList)) form.append("files", file);
      const res = await fetch(`/api/upload/${kbId}/documents`, { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `上传失败（${res.status}）`);
      }
      toast.success("已收到文件，正在后台建立索引…");
      docs.refetch();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="anim-in">
      <Link to="/kb" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 focus-visible:outline-2 focus-visible:outline-ring rounded">
        <ArrowLeft className="size-4" />返回知识库
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="font-display text-3xl font-bold">{kb?.name ?? "知识库"}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            支持 PDF / Word(.docx) / TXT / Markdown。上传后自动解析成文字并建立向量索引。
          </p>
        </div>
        <div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md"
            className="hidden"
            onChange={(e) => handleUpload(e.target.files)}
          />
          <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            上传文档
          </Button>
        </div>
      </div>

      {docs.data?.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border px-6 py-16 text-center text-muted-foreground">
          还没有文档。建议一次上传同一科目的完整资料，课程分解会更准。
        </div>
      )}

      <div className="space-y-2">
        {docs.data?.map((doc) => (
          <div key={doc.id} className="flex items-center gap-4 rounded-xl bg-card px-5 py-3.5 border border-transparent">
            <FileText className="size-4 shrink-0 text-primary" strokeWidth={1.8} />
            <div className="flex-1 min-w-0">
              <div className="truncate text-[15px]">{doc.filename}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {doc.status === "pending" && (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="size-3 animate-spin" />正在建立索引…
                  </span>
                )}
                {doc.status === "ok" && `${doc.chunkCount} 个索引块 · ${Math.round(doc.charCount / 1000)}k 字`}
                {doc.status === "error" && <span className="text-destructive">索引失败：{doc.error}</span>}
              </div>
            </div>
            <button
              type="button"
              aria-label={`删除 ${doc.filename}`}
              className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                if (confirm(`删除「${doc.filename}」及其索引？`)) deleteDoc.mutate({ id: doc.id });
              }}
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
      </div>

      {(docs.data?.some((d) => d.status === "ok") ?? false) && (
        <div className="mt-8 rounded-2xl bg-primary/10 border border-primary/20 px-5 py-4 text-sm">
          索引就绪。下一步：<Link to="/courses" className="text-primary font-semibold underline underline-offset-4">去生成课程 →</Link>
        </div>
      )}
    </div>
  );
}
