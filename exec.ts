/**
 * Small child-process helpers shared by every xcodebug command.
 *
 * Every invocation is bounded by a timeout and a byte cap so a stuck
 * xcrun/devicectl call can never wedge a tool call or grow without limit.
 */
import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Called as output arrives, before the final buffered result is returned. */
  onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const { cwd, timeoutMs = 120_000, maxBytes = 2_000_000, signal, onChunk } = options;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // `detached` puts the child in its own process group so the whole tree can
    // be signalled at once. `sh -lc "cd x && npm test"` runs the real work as a
    // grandchild that inherits our stdio pipes: killing only the `sh` wrapper
    // leaves it running, and `close` then never fires because the pipes are
    // still open - the promise would hang forever and the runner would outlive
    // the cancelled run.
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killTree = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // No process group (already gone, or detached failed): fall back.
        child.kill("SIGKILL");
      }
    };
    const onAbort = (): void => {
      killTree();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree();
          }, timeoutMs)
        : undefined;

    const append = (current: string, chunk: string): string =>
      current.length >= maxBytes ? current : (current + chunk).slice(0, maxBytes);

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code, timedOut });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
      onChunk?.("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
      onChunk?.("stderr", chunk);
    });
    child.on("error", (error: Error) => {
      stderr = append(stderr, error.message);
      finish(-1);
    });
    child.on("close", (code: number | null) => {
      finish(code ?? -1);
    });
  });
}

export function lastLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(-count).join("\n");
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A filesystem-safe timestamp with millisecond precision.
 *
 * Second precision is not enough: relaunching the same app twice within one
 * second produced two captures writing interleaved lines into the same file.
 * `slice(0, 23)` keeps `YYYY-MM-DD_HH-mm-ss-SSS`.
 */
export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 23);
}
