/**
 * 统一的 stderr 日志出口。
 * - router 自身日志(log):带本地时间戳 [HH:mm:ss],消息自身含 [mcp-router] 前缀
 * - 下游 stderr(forwardDownstreamStderr):按 UTF-8 解码后转发,不加前缀/时间戳
 * 全部走 stderr 而非 stdout:stdio 模式下 stdout 是 MCP 协议通道,不可污染。
 */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function log(message: string): void {
  console.error(`[${stamp()}] ${message}`);
}

let downstreamMuted = false;

/**
 * shutdown 开始后调用:此后下游 stderr 不再转发。
 * Ctrl+C 信号广播会同时打断下游进程(如 Python 打印 KeyboardInterrupt 堆栈),
 * mute 在信号处理同步路径设置,堆栈经 pipe 异步到达时通常已被静默(信号与管道数据的
 * 先后由操作系统调度决定,极小概率仍会漏出少量行,属平台限制)。
 */
export function muteDownstreamLogs(): void {
  downstreamMuted = true;
}

/** 转发下游 stderr(已按 UTF-8 解码的文本)。
 *
 * 不加时间戳/前缀:下游可能输出多行 ASCII art、进度条,逐块加前缀会打散排版。
 * 使用 process.stderr.write 写字符串而非原始字节:Windows 控制台下 Node 会经
 * Unicode 接口输出,不受控制台代码页影响;原始字节则会被按代码页误解成乱码。
 */
export function forwardDownstreamStderr(text: string): void {
  if (downstreamMuted) return;
  process.stderr.write(text);
}
