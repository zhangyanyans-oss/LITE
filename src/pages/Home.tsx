import { Link } from "react-router";
import { ArrowUpRight, BookOpen, Database, GraduationCap, PencilLine } from "lucide-react";
import { trpc } from "@/providers/trpc";

const STEPS = [
  { no: "01", title: "建知识库", desc: "上传 PDF / Word / 文本，系统自动解析成文字并建立向量索引。", to: "/kb", icon: Database },
  { no: "02", title: "生成课程", desc: "说一句学习目标，系统把知识库分解成模块与知识点的学习路线。", to: "/courses", icon: BookOpen },
  { no: "03", title: "跟着学", desc: "私教逐点讲授，学完就闯关；掌握度达标才解锁下一个知识点。", to: "/courses", icon: GraduationCap },
  { no: "04", title: "自由出题", desc: "任意主题一键成卷，选择自动判分、简答 AI 阅卷并给出错因。", to: "/quiz", icon: PencilLine },
];

export default function Home() {
  const overview = trpc.kb.overview.useQuery();

  const stats = [
    { label: "知识库", value: overview.data?.kbs },
    { label: "索引文本块", value: overview.data?.chunks },
    { label: "课程", value: overview.data?.courses },
    { label: "试卷", value: overview.data?.quizzes },
    { label: "已掌握知识点", value: overview.data?.mastered },
  ];

  return (
    <div className="anim-in">
      <header className="mb-10">
        <p className="text-sm text-muted-foreground mb-2">DeepTutor 精简版</p>
        <h1 className="font-display text-4xl md:text-5xl font-bold leading-tight">
          把一摞资料，<br className="md:hidden" />变成一门学得完的课。
        </h1>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          没有绕圈子的「思考中」，没有只说不做的出题——每个功能都是一次明确的动作：
          检索在代码里完成，出题和判分一次性出结果，能不能进阶由掌握度引擎说了算。
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-border rounded-2xl overflow-hidden border border-border mb-10">
        {stats.map((s) => (
          <div key={s.label} className="bg-card px-5 py-4">
            <div className="font-display text-3xl font-bold tabular-nums">
              {s.value ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        {STEPS.map((step) => (
          <Link
            key={step.no}
            to={step.to}
            className="group grid grid-cols-[auto_1fr_auto] items-center gap-4 md:gap-6 rounded-2xl border border-transparent bg-card px-5 py-5 md:px-7 transition-colors duration-200 ease-out-expo hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="font-display text-2xl text-primary/70 tabular-nums w-10">{step.no}</span>
            <span>
              <span className="flex items-center gap-2 font-semibold">
                <step.icon className="size-4 text-primary" strokeWidth={1.8} />
                {step.title}
              </span>
              <span className="block text-sm text-muted-foreground mt-1">{step.desc}</span>
            </span>
            <ArrowUpRight className="size-5 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary" />
          </Link>
        ))}
      </div>
    </div>
  );
}
