import { matchesFilter, type Capture, type EvidenceSearch, type FoundLine } from "./capture.ts";
import { describeFilter, evidencePath, evictedNote, formatEvidenceLines } from "./log-output.ts";

export interface WaitOptions {
  since: number;
  match: string | RegExp;
  timeoutMs: number;
  absent?: boolean;
  times?: boolean;
  signal?: AbortSignal;
}

const MATCH_LIMIT = 500;

/** The pinned backlog and live subscription cover disjoint cursor intervals. */
export async function waitForEvidence(capture: Capture, options: WaitOptions): Promise<{
  text: string; cursor: number; matched: number; missing: number; isError: boolean;
  cancelled: boolean; ended: boolean; timedOut: boolean;
}> {
  const { since, match, timeoutMs, absent, times, signal } = options;
  const initial = capture.status();
  const until = initial.cursor;
  const stopSignal = capture.signal;
  const coverageSince = capture.coverageSince;
  let drained = !initial.running;
  let exited = drained || capture.processExited;
  const continuousAtStart = !exited && !initial.error && !capture.stoppedByUser && since >= coverageSince && since <= until;
  let backlog: EvidenceSearch | undefined;
  const live: FoundLine[] = [];
  let liveMatched = 0;
  let finished = false;
  let settleMatch: ReturnType<typeof setTimeout> | undefined;
  const scanAbort = new AbortController();
  type Outcome = { cursor: number; cancelled: boolean; timedOut: boolean; ended: boolean; healthy: boolean };
  let resolveOutcome!: (value: Outcome) => void;
  let rejectOutcome!: (reason?: unknown) => void;
  const outcome = new Promise<Outcome>((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject; });
  const finish = (timedOut = false, cancelled = false): void => {
    if (finished) return;
    finished = true;
    const status = capture.status();
    const ended = exited || !status.running || capture.processExited;
    const healthy = !ended && !status.error && !capture.stoppedByUser &&
      status.relaunches === initial.relaunches && capture.coverageSince === coverageSince;
    resolveOutcome({ cursor: status.cursor, cancelled, timedOut, ended, healthy });
  };
  const offLine = capture.onLine(line => {
    if (finished || line.index <= Math.max(since, until) || !matchesFilter(line.text, match)) return;
    live[liveMatched++ % MATCH_LIMIT] = line;
    if (absent) finish();
    else if (backlog && !exited && !settleMatch) settleMatch = setTimeout(() => {
      if (!capture.processExited) finish();
    }, 50);
  });
  // Process exit breaks coverage, but a positive wait must still see the drain.
  const offProcessExit = capture.onProcessExit(() => {
    exited = true;
    if (absent && backlog) finish();
  });
  const offExit = capture.onExit(() => {
    drained = exited = true;
    if (backlog) finish();
  });
  const onAbort = (): void => finish(false, true);
  const onStop = (): void => { if (absent) finish(); };
  const deadline = setTimeout(() => finish(true), timeoutMs);
  let result: Outcome;
  try {
    signal?.addEventListener("abort", onAbort, { once: true });
    stopSignal.addEventListener("abort", onStop, { once: true });
    if (signal?.aborted) onAbort();
    if (!finished) {
      // Do not await the scan here: a stuck reader must not own the deadline.
      void capture.search({ since, until, limit: MATCH_LIMIT, grep: match, signal: scanAbort.signal }).then(found => {
        if (finished) return;
        backlog = found;
        if (drained || (absent && (found.total || exited || capture.stoppedByUser)) ||
            (!absent && !capture.processExited && (found.total || liveMatched))) finish();
      }, error => {
        if (finished) return;
        rejectOutcome(error);
      });
    }
    result = await outcome;
  } finally {
    clearTimeout(deadline);
    clearTimeout(settleMatch);
    offLine(); offProcessExit(); offExit();
    signal?.removeEventListener("abort", onAbort);
    stopSignal.removeEventListener("abort", onStop);
    if (!backlog) scanAbort.abort(signal?.reason);
  }
  const { cursor, ended, healthy } = result;
  const cancelled = result.cancelled || signal?.aborted === true;
  const timedOut = !cancelled && result.timedOut;
  const historical = backlog?.total ?? 0;
  const matched = historical + liveMatched;
  const missing = backlog?.missing ?? Math.max(0, until - since);
  const complete = timedOut && continuousAtStart && healthy && missing === 0;
  let note = "";
  let text: string;
  if (cancelled) text = `cancelled while waiting for ${describeFilter(match)} (cursor ${cursor})`;
  else if (matched) {
    const rows = liveMatched > MATCH_LIMIT ? live.sort((a, b) => a.index - b.index) : live;
    const backfill = MATCH_LIMIT - rows.length;
    if (backfill && backlog) rows.unshift(...backlog.lines.slice(-backfill));
    const body = formatEvidenceLines(rows, times);
    text = `${absent ? "forbidden pattern appeared: " : ""}matched ${matched} line(s) · cursor ${cursor}\n${body.text}`;
    if (historical) note += `\nnote: matching backlog predates this wait (${historical} historical, ${liveMatched} new; since=${since})`;
    if (body.truncated || matched > body.shown) note += `\nnote: output truncated; full evidence in log: ${evidencePath(capture.logFile)}`;
  } else {
    const shown = describeFilter(match);
    if (absent) text = complete
      ? `no matching line observed for ${shown} in captured lines (${since}, ${cursor}] for ${timeoutMs / 1000}s`
      : `inconclusive absence check for ${shown}: capture ended, changed, or coverage was incomplete (cursor ${cursor})`;
    else text = timedOut
      ? `timed out after ${timeoutMs / 1000}s waiting for ${shown} (cursor ${cursor})`
      : `capture ended before ${shown} appeared (cursor ${cursor})`;
  }
  if (backlog) note += evictedNote(backlog, capture.logFile);
  else if (missing) note += `\nnote: backlog search incomplete; ${missing} line(s) unchecked`;
  return { cursor, cancelled, timedOut, ended, text: text + note, matched, missing,
    isError: cancelled || (absent ? !complete || matched > 0 : matched === 0) };
}
