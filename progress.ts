/**
 * Build progress for xcodebuild (stage-based).
 *
 * xcodebuild exposes no percentage and no total task count: the "compiled N of
 * M" bar lives in the Xcode IDE over a private IPC channel, and there is no
 * -dry-run to precompute M (measured: the same scheme reports 32,042 tasks on a
 * clean build and 3,217 on an interrupted one).
 *
 * What the log DOES expose reliably is the build phase. Markers are ordered by
 * where they actually appear in a real 322k-line log, not by intuition:
 *   ProcessInfoPlistFile at line 5,133 - a pod plist, long before compiling
 *   CompileSwift          at line 55,406
 *   Ld                    at line 63,826
 *   CodeSign              at line 65,102
 *   ** BUILD SUCCEEDED ** at line 322,614
 * Only markers that genuinely come last advance the stage.
 */

export type BuildStage = "starting" | "compiling" | "linking" | "signing" | "done" | "failed";

const STAGE_LABEL: Record<BuildStage, string> = {
  starting: "preparing",
  compiling: "compiling",
  linking: "linking",
  signing: "signing",
  done: "done",
  failed: "failed",
};

/** Coarse completion fraction by stage. */
const STAGE_FLOOR: Record<BuildStage, number> = {
  starting: 0,
  compiling: 0.05,
  linking: 0.85,
  signing: 0.93,
  done: 1,
  failed: 1,
};

/**
 * How far a stage may creep past its floor while it lasts.
 *
 * A flat floor is what made the bar sit at exactly 93% through a long signing
 * phase: nothing distinguished "still working" from "hung". Creeping makes the
 * bar move during a quiet stage, and the cap keeps it from reaching the next
 * stage's floor, so a real transition still shows as a jump rather than a slide.
 */
const STAGE_CREEP: Record<BuildStage, number> = {
  starting: 0.04,
  compiling: 0.75,
  linking: 0.07,
  signing: 0.06,
  done: 0,
  failed: 0,
};

/** A stage's creep reaches its cap after this long without a phase change. */
const CREEP_MS = 120_000;

export interface BuildProgress {
  stage: BuildStage;
  stageLabel: string;
  /** Completed task lines seen so far - a fact, not an estimate. */
  tasks: number;
  elapsedMs: number;
  /** Coarse completion fraction from the stage model (0..1). */
  fraction: number;
}

function stageFromLine(line: string): BuildStage | undefined {
  // Order matters: the success marker also contains "** BUILD".
  if (line.startsWith("** BUILD SUCCEEDED")) return "done";
  if (line.startsWith("** BUILD FAILED") || line.startsWith("** BUILD INTERRUPTED")) return "failed";
  if (line.startsWith("CodeSign ")) return "signing";
  if (line.startsWith("ComputeTargetDependencyGraph") || line.startsWith("SendProjectDescription") ||
      line.startsWith("CreateBuildOperation") || line.startsWith("GatherProvisioningInputs") ||
      line.startsWith("CreateBuildDescription") || line.startsWith("ExecuteExternalTool")) return "starting";
  if (line.startsWith("Ld ") || line.startsWith("Libtool ") || line.startsWith("GenerateDSYMFile")) return "linking";
  // Any per-target work line means the build has left "preparing". An
  // incremental build emits no CompileSwift at all - it is all
  // PhaseScriptExecution / ProcessInfoPlistFile - so those count too.
  if (
    line.startsWith("CompileSwift") ||
    line.startsWith("SwiftCompile") ||
    line.startsWith("SwiftDriver") ||
    line.startsWith("EmitSwiftModule") ||
    line.startsWith("CompileC") ||
    line.startsWith("CompileMetal") ||
    line.startsWith("CompileAssetCatalog") ||
    line.startsWith("CompileXIB") ||
    line.startsWith("CompileStoryboard") ||
    line.startsWith("PhaseScriptExecution") ||
    line.startsWith("ProcessInfoPlistFile") ||
    line.startsWith("CpResource") ||
    line.startsWith("CpHeader") ||
    line.startsWith("CopySwiftLibs") ||
    line.startsWith("WriteAuxiliaryFile")
  ) {
    return "compiling";
  }
  return undefined;
}

/** Tracks one build's stage from its output stream. */
export class BuildProgressTracker {
  private readonly startedAt = Date.now();
  private stage: BuildStage = "starting";
  /** When the current stage began; creep is measured from here. */
  private stageStartedAt = Date.now();
  private tasks = 0;
  private remainder = "";

  /** Feed a raw output chunk; returns the current progress snapshot. */
  update(chunk: string): BuildProgress {
    const pending = this.remainder + chunk;
    const lines = pending.split("\n");
    this.remainder = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed.includes("(in target '")) this.tasks += 1;
      const next = stageFromLine(trimmed.trimStart());
      // Stages only move forward; a stray earlier-phase line must not rewind.
      if (next && STAGE_FLOOR[next] >= STAGE_FLOOR[this.stage]) {
        if (next !== this.stage) this.stageStartedAt = Date.now();
        this.stage = next;
      }
    }
    return this.snapshot();
  }

  snapshot(): BuildProgress {
    return {
      stage: this.stage,
      stageLabel: STAGE_LABEL[this.stage],
      tasks: this.tasks,
      elapsedMs: Date.now() - this.startedAt,
      fraction: this.fraction(),
    };
  }

  /**
   * Stage floor plus however much this stage has crept toward its cap.
   *
   * Signing a large app can take minutes with no output at all, and a frozen
   * 93% is indistinguishable from a wedged build. Creep keeps the bar honest
   * about "still going" without ever claiming the next stage was reached.
   */
  private fraction(): number {
    const floor = STAGE_FLOOR[this.stage];
    const creep = STAGE_CREEP[this.stage];
    if (creep <= 0) return floor;
    const inStage = Date.now() - this.stageStartedAt;
    const progress = Math.min(1, inStage / CREEP_MS);
    return floor + creep * progress;
  }

  finish(stage: "done" | "failed"): BuildProgress {
    this.stage = stage;
    return this.snapshot();
  }
}

/** One-line rendering for tool updates. */
export function formatProgress(progress: BuildProgress): string {
  const barWidth = 20;
  const filled = Math.round(progress.fraction * barWidth);
  const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
  const elapsed = `${(progress.elapsedMs / 1000).toFixed(0)}s`;
  const tasks = progress.tasks > 0 ? ` · ${progress.tasks.toLocaleString()} tasks` : "";
  return `${bar} ${Math.round(progress.fraction * 100)}% · ${progress.stageLabel}${tasks} · ${elapsed}`;
}
