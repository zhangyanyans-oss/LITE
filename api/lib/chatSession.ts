/**
 * 学习页的「对话分段」。
 *
 * 表结构里没有会话表，也不打算为了一次清屏去改库——所以用 learn_messages 里
 * 一行 kind='session' 的标记消息当作分隔线：它的 id 就是「本段对话」的起点，
 * 页面只读 id 大于它的消息。
 *
 * 好处：老数据（没有标记行）的 startId 是 0，历史对话原样可见，向后兼容；
 * 学习进度（objective_states）完全不受影响——新对话只清屏，不重置学习状态。
 */
import { and, asc, eq, gt, lt } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { learnMessages } from "@db/schema";

export const SESSION_KIND = "session";

/** 本课程所有「新对话」标记的 id（升序） */
async function markerIds(courseId: number): Promise<number[]> {
  const db = getDb();
  const rows = await db
    .select({ id: learnMessages.id })
    .from(learnMessages)
    .where(and(eq(learnMessages.courseId, courseId), eq(learnMessages.kind, SESSION_KIND)))
    .orderBy(asc(learnMessages.id));
  return rows.map((r) => r.id);
}

/** 本段对话的起点消息 id；没有标记行（历史数据）时返回 0 */
export async function sessionStartId(courseId: number): Promise<number> {
  const markers = await markerIds(courseId);
  return markers[markers.length - 1] ?? 0;
}

/**
 * 一段对话的消息区间：(start, end) 左开右闭。
 * sessionId 省略 = 当前这段；给定时用它作起点，下一条标记作终点（null = 到最新）。
 */
export async function sessionBounds(
  courseId: number,
  sessionId?: number | null,
): Promise<{ start: number; end: number | null }> {
  const markers = await markerIds(courseId);
  if (sessionId == null) return { start: markers[markers.length - 1] ?? 0, end: null };
  const idx = markers.indexOf(sessionId);
  if (idx >= 0) return { start: sessionId, end: markers[idx + 1] ?? null };
  // 不是标记 id：最老的那一段（标记之前的历史消息），终点是第一条标记
  return { start: sessionId, end: markers[0] ?? null };
}

/** 打一条分隔标记：此后写进库的消息属于新的一段对话 */
export async function markNewSession(courseId: number) {
  const db = getDb();
  await db.insert(learnMessages).values({
    courseId,
    role: "assistant",
    kind: SESSION_KIND,
    content: JSON.stringify({ startedAt: new Date().toISOString() }),
  });
}

/** 删除一段对话的消息；isCurrent=false 时连这段的分隔标记一起删（否则这一段会以空对话的形式留在列表里） */
export async function deleteSessionMessages(courseId: number, sessionId: number | null | undefined) {
  const db = getDb();
  const { start, end } = await sessionBounds(courseId, sessionId);
  const conds = [eq(learnMessages.courseId, courseId), gt(learnMessages.id, start)];
  if (end != null) conds.push(lt(learnMessages.id, end));
  await db.delete(learnMessages).where(and(...conds));

  const markers = await markerIds(courseId);
  const isCurrent = sessionId == null || sessionId === markers[markers.length - 1];
  if (!isCurrent && typeof sessionId === "number" && sessionId > 0) {
    await db.delete(learnMessages).where(eq(learnMessages.id, sessionId));
  }
}
