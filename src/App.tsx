import { Routes, Route } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import AppShell from "@/components/AppShell";
import Home from "@/pages/Home";
import KbList from "@/pages/KbList";
import KbDetail from "@/pages/KbDetail";
import CourseList from "@/pages/CourseList";
import Learn from "@/pages/Learn";
import QuizList from "@/pages/QuizList";
import QuizDetail from "@/pages/QuizDetail";
import Settings from "@/pages/Settings";
import NotFound from "@/pages/NotFound";

export default function App() {
  return (
    <>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          <Route path="/kb" element={<KbList />} />
          <Route path="/kb/:id" element={<KbDetail />} />
          <Route path="/courses" element={<CourseList />} />
          <Route path="/learn/:courseId" element={<Learn />} />
          <Route path="/quiz" element={<QuizList />} />
          <Route path="/quiz/:id" element={<QuizDetail />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      <Toaster position="top-center" richColors />
    </>
  );
}
