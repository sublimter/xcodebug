import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export interface RuntimeIdentity {
  version: string;
  revision?: string;
  sourceDigest: string;
  sourcePath: string;
  startedAt: number;
}

function sourceIdentity(root: string): { version: string; digest: string } {
  const files = [...readdirSync(root).filter(name => name.endsWith(".ts")), "mcp/server.ts"];
  const manifest = readFileSync(join(root, "package.json"));
  const pkg = JSON.parse(manifest.toString("utf8"));
  const hash = createHash("sha256");
  hash.update("package.json\0").update(manifest);
  for (const name of files.sort()) {
    hash.update(`\0${name}\0`);
    try { hash.update(readFileSync(join(root, name))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("<missing>");
    }
  }
  return { version: String(pkg.version), digest: hash.digest("hex") };
}

/** Keep the loaded identity separate from files an update may replace underneath it. */
export function createRuntimeVersion(root: string): { identity: RuntimeIdentity; warning(): string | undefined } {
  const initial = sourceIdentity(root);
  const git = spawnSync("git", ["rev-parse", "--show-toplevel", "HEAD"], { cwd: root, encoding: "utf8", timeout: 2000 });
  const lines = git.status === 0 ? git.stdout.trim().split("\n") : [];
  const identity: RuntimeIdentity = {
    version: initial.version, sourceDigest: initial.digest, sourcePath: root, startedAt: Date.now(),
    revision: lines[0] === root ? lines[1] : undefined,
  };
  return { identity, warning() {
    try {
      const disk = sourceIdentity(root);
      if (disk.digest !== initial.digest) {
        return `xcodebug ${identity.version} (${identity.sourceDigest.slice(0, 8)}) is still loaded; disk has ${disk.version} (${disk.digest.slice(0, 8)}). Restart the client to load the update.`;
      }
    } catch {
      return "xcodebug cannot verify its installed source; restart the client after checking the installation.";
    }
  } };
}

export const runtimeVersion = createRuntimeVersion(dirname(fileURLToPath(import.meta.url)));
