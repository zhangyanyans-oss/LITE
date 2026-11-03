/**
 * 掌握度引擎 —— "能不能进阶"是确定性计算，不归 LLM 管。
 * 规则：取最近 3 次判分的平均分（EMA 近似），达到阈值且至少考过 2 次才算掌握。
 */
import { MASTERY_MIN_ATTEMPTS, MASTERY_THRESHOLD } from "@contracts/types";

export function nextMastery(prevMastery: number, prevAttempts: number, newScore: number): number {
  const window = Math.min(prevAttempts, 2); // 近似"最近 3 次"的滑动窗口
  return (prevMastery * window + newScore) / (window + 1);
}

export function isMastered(mastery: number, attempts: number): boolean {
  return attempts >= MASTERY_MIN_ATTEMPTS && mastery >= MASTERY_THRESHOLD;
}
