import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { BookOpen, Database, PencilLine, Settings, Sprout } from "lucide-react";
import { useEffect } from "react";
import { trpc } from "@/providers/trpc";

const NAV = [
  { to: "/", label: "首页", icon: Sprout, end: true },
  { to: "/kb", label: "知识库", icon: Database },
  { to: "/courses", label: "课程", icon: BookOpen },
  { to: "/quiz", label: "出题", icon: PencilLine },
  { to: "/settings", label: "设置", icon: Settings },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-row md:flex-col gap-1 overflow-x-auto md:overflow-visible">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            [
              "flex items-center gap-2 md:gap-3 rounded-xl border border-transparent px-3 py-2 md:px-4 md:py-2.5 text-sm md:text-[15px] whitespace-nowrap",
              "transition-colors duration-200 ease-out-expo",
              "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-foreground/80 hover:bg-secondary",
            ].join(" ")
          }
        >
          <item.icon className="size-4 shrink-0" strokeWidth={1.8} />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export default function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const settings = trpc.settings.get.useQuery(undefined, { retry: false });
  // 学习页内容多（讲课卡+进度树），放宽到跟随窗口；其余页面保持阅读宽度
  const wide = location.pathname.startsWith("/learn");

  // 没配 DeepSeek Key 时，任何页面都先去设置
  useEffect(() => {
    if (settings.data && !settings.data.hasDeepseekKey && location.pathname !== "/settings") {
      navigate("/settings");
    }
  }, [settings.data, navigate]);

  return (
    <div className="min-h-dvh bg-background">
      {/* 移动端顶栏 */}
      <header className="md:hidden sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="font-display text-xl font-bold">深学 Lite</span>
        </div>
        <NavItems />
      </header>

      {/* 桌面端固定左侧导航（参照 kNF4HLDK：固定栏 + 内容偏移） */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-56 flex-col border-r border-border px-4 py-6 z-40">
        <NavLink to="/" className="mb-1 px-2 focus-visible:outline-2 focus-visible:outline-ring rounded">
          <div className="font-display text-2xl font-bold leading-none">深学 Lite</div>
          <div className="text-xs text-muted-foreground mt-1.5">DeepTutor 精简版 · 学习 + 出题</div>
        </NavLink>
        <div className="mt-6 flex-1">
          <NavItems />
        </div>
        <p className="px-2 text-xs leading-relaxed text-muted-foreground">
          所有讲授与出题都只取自知识库索引文本，不翻原件。
        </p>
      </aside>

      <main className="md:pl-56">
        <div className={`mx-auto px-4 py-6 md:px-10 md:py-8 ${wide ? "max-w-[1600px]" : "max-w-5xl"}`}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
