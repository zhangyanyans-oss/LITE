/** 把底层网络错误翻译成人话 */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Unexpected end of JSON input|Failed to execute 'json'/i.test(msg)) {
    return "服务暂时没有响应（可能刚在重启），请稍等几秒再试一次。";
  }
  if (/failed to fetch|networkerror|fetch failed|load failed/i.test(msg)) {
    return "网络连接失败，请稍后重试。";
  }
  return msg;
}
