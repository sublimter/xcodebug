import { MAX_READ_LINES, type Capture, type FoundLine } from "./capture.ts";

export const MAX_REPLY_BYTES = 48 * 1024;
const MAX_LINE_BYTES = 4096;
const BODY_BYTES = MAX_REPLY_BYTES - 4096;
const MAX_CONTEXT = 20;
const LINE_TRUNCATED = " … [line truncated]";
const CLIPPED_LINE_BYTES = MAX_LINE_BYTES - Buffer.byteLength(LINE_TRUNCATED);

export function clock(at: number): string {
  const date = new Date(at);
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} `;
}

/** Cut only at complete UTF-8 code points. The original remains in the log. */
export function clipBytes(text: string, budget: number): string {
  let end = Math.floor(budget);
  if (end <= 0) return "";
  if (text.length <= end && Buffer.byteLength(text) <= end) return text;
  const bytes = Buffer.from(text.slice(0, end + 1));
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function describeFilter(filter: string | RegExp): string {
  const raw = typeof filter === "string" ? filter : String(filter);
  const prefix = clipBytes(raw, 1021);
  const shown = prefix === raw ? raw : `${prefix}…`;
  return typeof filter === "string" ? `"${shown}"` : shown;
}

export function evidencePath(path: string): string {
  if (path.length <= 1024 && Buffer.byteLength(path) <= 1024) return path;
  const suffix = Buffer.from(path.slice(-1024));
  let start = suffix.length - 512;
  while ((suffix[start] & 0xc0) === 0x80) start++;
  return `${clipBytes(path, 509)}…${suffix.subarray(start).toString("utf8")}`;
}

export function formatEvidenceLines(lines: FoundLine[], times = false, consoleMode = false, required = new Set<number>()): { text: string; truncated: boolean; shown: number } {
  const selected: FoundLine[] = [];
  const seen = new Set<number>();
  for (const line of lines) {
    if (required.has(line.index)) {
      selected.push(line);
      seen.add(line.index);
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!seen.has(lines[i].index)) selected.push(lines[i]);
  }
  const kept: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const line of selected) {
    const tag = consoleMode && line.stream === "out" ? "[devicectl] " : "";
    const raw = `${String(line.index).padStart(6, " ")} ${times ? clock(line.at) : ""}${tag}${line.text}`;
    const row = raw.length > MAX_LINE_BYTES || Buffer.byteLength(raw) > MAX_LINE_BYTES
      ? `${clipBytes(raw, CLIPPED_LINE_BYTES)}${LINE_TRUNCATED}` : raw;
    const size = Buffer.byteLength(row) + (kept.length > 0 ? 1 : 0);
    if (bytes + size > BODY_BYTES) {
      truncated = true;
      continue;
    }
    kept.push(row);
    bytes += size;
  }
  kept.sort((a, b) => Number(a.trim().split(" ", 1)[0]) - Number(b.trim().split(" ", 1)[0]));
  return { text: kept.join("\n"), truncated, shown: kept.length };
}

export function evictedNote(read: { evicted: number; missing?: number }, logFile: string): string {
  if (read.evicted === 0) return "";
  if (read.missing === undefined) return `\nnote: ${read.evicted} older line(s) are no longer in memory; read them from ${evidencePath(logFile)}`;
  const found = read.evicted - read.missing;
  const parts = [
    found > 0 ? `${found} line(s) no longer in memory were searched in ${evidencePath(logFile)}` : "",
    read.missing > 0 ? `${read.missing} line(s) are in neither memory nor the log files and were not searched` : "",
  ];
  return `\nnote: ${parts.filter(Boolean).join("; ")}`;
}

async function withContext(capture: Capture, matches: FoundLine[], radius: number, since: number, cursor: number, signal?: AbortSignal) {
  const ranges: Array<{ first: number; last: number }> = [];
  const add = (first: number, last: number): void => {
    if (first > last) return;
    const prior = ranges.at(-1);
    if (prior && first <= prior.last + 1) prior.last = Math.max(prior.last, last);
    else ranges.push({ first, last });
  };
  // Recover only the neighborhoods of pinned matches, not the matches again.
  let previous = since;
  for (const { index } of matches) {
    if (previous > since) add(previous + 1, Math.min(index - 1, previous + radius));
    add(Math.max(previous + 1, index - radius), index - 1);
    previous = index;
  }
  add(previous + 1, Math.min(cursor, previous + radius));
  const read = await capture.search({ since, until: cursor, ranges, limit: MAX_READ_LINES, signal });
  return {
    lines: [...matches, ...read.lines].sort((a, b) => a.index - b.index).slice(-MAX_READ_LINES),
    missing: read.missing,
    omitted: read.total + matches.length > MAX_READ_LINES,
  };
}

export async function formatLogLines(capture: Capture, options: {
  since: number; limit: number; grep?: string | RegExp; context?: number; times?: boolean; signal?: AbortSignal;
}): Promise<{ text: string; cursor: number; total: number }> {
  const { since, limit, grep, signal } = options;
  signal?.throwIfAborted();
  const read = grep ? await capture.search({ since, limit, grep, signal }) : capture.read({ since, limit });
  const total = grep ? read.total : read.total + read.evicted;
  let note = evictedNote(read, capture.logFile);
  if (total === 0) {
    const what = grep ? `no line matching ${describeFilter(grep)}` : "no new lines";
    return { text: `(${what} since ${since}; capture cursor is ${read.cursor})${note}`, cursor: read.cursor, total };
  }
  const radius = Math.trunc(Math.min(MAX_CONTEXT, options.context ?? 0));
  const context = grep && radius > 0 ? await withContext(capture, read.lines, radius, since, read.cursor, signal) : undefined;
  if (context?.missing) note += `\nnote: ${context.missing} context line(s) unavailable`;
  const body = formatEvidenceLines(context?.lines ?? read.lines, options.times, capture.mode === "console",
    context ? new Set(read.lines.map((line) => line.index)) : undefined);
  const omitted = Math.max(0, total - body.shown);
  const header = context
    ? `${total} match(es) · ${body.shown} line(s) with context · cursor ${read.cursor}`
    : `${body.shown} line(s)${omitted > 0 ? ` (${omitted} older omitted)` : ""} · cursor ${read.cursor}`;
  if (context?.omitted) note += `\nnote: older context omitted; full evidence in log: ${evidencePath(capture.logFile)}`;
  else if (body.truncated) note += `\nnote: output truncated by byte budget; full evidence in log: ${evidencePath(capture.logFile)}`;
  return { text: `${header}${body.text ? `\n${body.text}` : ""}${note}`, cursor: read.cursor, total };
}
