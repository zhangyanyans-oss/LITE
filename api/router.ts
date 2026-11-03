import { createRouter, publicQuery } from "./middleware";
import { kbRouter } from "./routers/kb";
import { settingsRouter } from "./routers/settings";
import { courseRouter } from "./routers/course";
import { learnRouter } from "./routers/learn";
import { quizRouter } from "./routers/quiz";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  kb: kbRouter,
  settings: settingsRouter,
  course: courseRouter,
  learn: learnRouter,
  quiz: quizRouter,
});

export type AppRouter = typeof appRouter;
