import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/lib/errors";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Settings() {
  const settings = trpc.settings.get.useQuery();
  const [deepseekKey, setDeepseekKey] = useState("");
  const [embedBaseUrl, setEmbedBaseUrl] = useState("");
  const [embedModel, setEmbedModel] = useState("");
  const [embedKey, setEmbedKey] = useState("");
  const [testResult, setTestResult] = useState<{ chat: string; embed: string } | null>(null);

  useEffect(() => {
    if (settings.data) {
      setEmbedBaseUrl(settings.data.embedBaseUrl);
      setEmbedModel(settings.data.embedModel);
    }
  }, [settings.data]);

  const update = trpc.settings.update.useMutation({
    onSuccess: () => {
      toast.success("已保存");
      setDeepseekKey("");
      setEmbedKey("");
      setTestResult(null);
      settings.refetch();
    },
    onError: (e) => toast.error(friendlyError(e)),
  });

  const test = trpc.settings.test.useMutation({
    onSuccess: (data) => setTestResult(data),
    onError: (e) => toast.error(friendlyError(e)),
  });

  return (
    <div className="anim-in max-w-2xl">
      <h1 className="font-display text-3xl font-bold mb-1">设置</h1>
      <p className="text-sm text-muted-foreground mb-8">
        大模型固定使用 DeepSeek，只需填入你的 API Key。密钥只保存在服务器数据库里，不会出现在浏览器之外。
      </p>

      <section className="rounded-2xl bg-card border border-border px-6 py-5 space-y-4">
        <div>
          <h2 className="font-semibold">对话模型（已固定）</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {settings.data?.deepseekModel} · {settings.data?.deepseekBaseUrl}
          </p>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="ds-key">
            DeepSeek API Key
            {settings.data?.hasDeepseekKey && (
              <span className="ml-2 text-xs text-muted-foreground">当前：{settings.data.deepseekKeyMasked}</span>
            )}
          </label>
          <Input
            id="ds-key"
            type="password"
            className="mt-1.5"
            placeholder={settings.data?.hasDeepseekKey ? "已配置，输入新 Key 可替换" : "sk-…（platform.deepseek.com 申请）"}
            value={deepseekKey}
            onChange={(e) => setDeepseekKey(e.target.value)}
          />
        </div>
      </section>

      <section className="rounded-2xl bg-card border border-border px-6 py-5 space-y-4 mt-5">
        <div>
          <h2 className="font-semibold">向量接口（知识库检索用）</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            DeepSeek 不提供向量服务，这里需要任意一个 OpenAI 兼容的 embedding 接口。
            默认已填好硅基流动（siliconflow.cn）的地址和免费模型，注册后把它的 Key 填进来即可。
          </p>
        </div>
        <div className="grid gap-4">
          <div>
            <label className="text-sm font-medium" htmlFor="emb-url">接口地址</label>
            <Input id="emb-url" className="mt-1.5" value={embedBaseUrl} onChange={(e) => setEmbedBaseUrl(e.target.value)} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="emb-model">向量模型</label>
            <Input id="emb-model" className="mt-1.5" value={embedModel} onChange={(e) => setEmbedModel(e.target.value)} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="emb-key">
              向量接口 Key
              {settings.data?.hasEmbedKey && (
                <span className="ml-2 text-xs text-muted-foreground">当前：{settings.data.embedKeyMasked}</span>
              )}
            </label>
            <Input
              id="emb-key"
              type="password"
              className="mt-1.5"
              placeholder={settings.data?.hasEmbedKey ? "已配置，输入新 Key 可替换" : "sk-…"}
              value={embedKey}
              onChange={(e) => setEmbedKey(e.target.value)}
            />
          </div>
        </div>
      </section>

      <div className="flex gap-3 mt-6">
        <Button
          onClick={() =>
            update.mutate({
              deepseekApiKey: deepseekKey || undefined,
              embedBaseUrl,
              embedModel,
              embedApiKey: embedKey || undefined,
            })
          }
          disabled={update.isPending}
        >
          保存
        </Button>
        <Button variant="secondary" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          测试连接
        </Button>
      </div>

      {testResult && (
        <div className="mt-4 rounded-2xl bg-card border border-border px-6 py-4 space-y-2 text-sm">
          {(["chat", "embed"] as const).map((k) => (
            <div key={k} className="flex items-start gap-2">
              {testResult[k] === "ok" ? (
                <CheckCircle2 className="size-4 mt-0.5 text-primary shrink-0" />
              ) : (
                <XCircle className="size-4 mt-0.5 text-destructive shrink-0" />
              )}
              <span className="break-all">
                {k === "chat" ? "DeepSeek 对话" : "向量接口"}：
                {testResult[k] === "ok" ? "正常" : testResult[k]}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
