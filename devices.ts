/**
 * Device discovery and process lookup through `xcrun devicectl`.
 *
 * devicectl accepts a uuid, ecid, serial number, udid, name or DNS name, so
 * every identifier we keep is accepted verbatim by later commands.
 */
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { asRecord, asString, runCommand } from "./exec.ts";

export interface DeviceInfo {
  /** CoreDevice identifier (uuid) — accepted by devicectl. */
  id: string;
  /** Hardware UDID — required by xcodebuild destinations and idevicesyslog. */
  udid?: string;
  name: string;
  model?: string;
  os?: string;
  state: string;
  physical: boolean;
  /**
   * How the device is attached: `wired` for USB, `network` for Wi-Fi.
   *
   * This tool's console bridge is a USB-speed firehose, and a Wi-Fi drop shows
   * up mid-run as `WebSocket connection closed`, which reads exactly like an app
   * crash. Surfacing the transport lets that be diagnosed instead of guessed at.
   */
  transport?: string;
}

export function describeDevices(devices: DeviceInfo[]): string {
  if (devices.length === 0) return "(no devices reported by devicectl)";
  return devices
    .map((device) => {
      const kind = device.physical ? "physical" : "simulated";
      const os = device.os ? ` · iOS ${device.os}` : "";
      // Name the transport: a Wi-Fi-only device produces mid-run disconnects
      // that look like app crashes, and the fix (plug in USB) is invisible
      // unless the attachment is reported.
      const link = device.transport ? ` · ${device.transport}` : "";
      return `- ${device.name} [${device.state}] ${kind}${os}${link} · udid=${device.udid ?? "?"}`;
    })
    .join("\n");
}

function toDevice(raw: unknown): DeviceInfo | undefined {
  const entry = asRecord(raw);
  const properties = asRecord(entry.properties);
  const hardware = asRecord(properties.hardware ?? entry.hardwareProperties);
  const connection = asRecord(properties.connection ?? entry.connectionProperties);
  const state = asRecord(properties.state ?? entry.deviceProperties);
  const software = asRecord(properties.software);
  const id = asString(entry.identifier);
  if (!id) return undefined;
  return {
    id,
    udid: asString(hardware.udid),
    name: asString(state.name) ?? asString(hardware.marketingName) ?? id,
    model: asString(hardware.marketingName),
    os: asString(asRecord(software.osVersionNumber).stringValue) ?? asString(state.osVersionNumber),
    state: asString(connection.state) ?? asString(connection.tunnelState) ?? "unknown",
    physical: asString(hardware.reality) === "physical",
    transport: asString(connection.transportType),
  };
}

export async function listDevices(): Promise<DeviceInfo[]> {
  const result = await runCommand("xcrun", ["devicectl", "list", "devices", "--json-output", "-"], {
    timeoutMs: 45_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `devicectl list devices failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 600)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("devicectl returned invalid JSON for the device list");
  }
  const devices = asRecord(asRecord(parsed).result).devices;
  if (!Array.isArray(devices)) return [];
  return devices
    .map(toDevice)
    .filter((device): device is DeviceInfo => device !== undefined);
}

export interface DeviceResolution {
  device: DeviceInfo;
  devices: DeviceInfo[];
}

export async function resolveDevice(selector?: string): Promise<DeviceResolution> {
  const devices = await listDevices();
  /**
   * USB only, by policy.
   *
   * `devicectl list` reports the CoreDevice tunnel, which is lazy: a wired
   * device that has not been spoken to yet reads `disconnected` even though it
   * is plugged in and healthy, while a Wi-Fi device can read `connected` and
   * then drop mid-run. Neither state is trustworthy on its own, so the
   * transport decides: only `wired` is accepted, and an ambiguous device is
   * probed once to bring its tunnel up before giving up.
   */
  const isUsb = (device: DeviceInfo): boolean => device.transport === "wired";
  const wifi = (device: DeviceInfo): boolean => device.transport === "network";

  if (selector && selector.trim().length > 0) {
    const wanted = selector.trim().toLowerCase();
    const identifiers = (device: DeviceInfo): string[] =>
      [device.id, device.udid, device.name]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase());
    const exact = devices.find((device) => identifiers(device).includes(wanted));
    const partial = devices.find((device) => identifiers(device).some((value) => value.includes(wanted)));
    const match = exact ?? partial;
    if (!match) {
      throw new Error(`No device matches "${selector}".\n${describeDevices(devices)}`);
    }
    if (!match.physical) {
      throw new Error(
        `${match.name} is a simulator. xcodebug only targets physical hardware: the build destination is ` +
          `platform=iOS,id=<udid> and the console bridge is devicectl, neither of which a simulator can provide.\n` +
          describeDevices(devices),
      );
    }
    if (wifi(match)) {
      throw new Error(
        `${match.name} is attached over Wi-Fi (transport=network). xcodebug needs USB: a wireless link drops ` +
          `mid-run and the console bridge reports it as "WebSocket connection closed", which looks like a crash. ` +
          `Connect the cable and retry.\n${describeDevices(devices)}`,
      );
    }
    return { device: match, devices };
  }

  // Only USB-attached hardware, in either tunnel state: a wired device whose
  // tunnel is idle is still the right target and will come up when used.
  const candidates = devices.filter((device) => device.physical && !wifi(device));
  const ready = candidates.filter((device) => device.state === "connected");
  if (ready.length === 1) return { device: ready[0], devices };
  if (ready.length > 1) {
    throw new Error(
      `Multiple physical devices are connected; pass device: <name|udid>.\n${describeDevices(ready)}`,
    );
  }

  // Nothing reports `connected`. A wired device is almost always just asleep
  // from CoreDevice's point of view - one direct query opens the tunnel - so
  // probe before declaring the device absent.
  const wired = candidates.find(isUsb) ?? candidates[0];
  if (wired) {
    const probed = await probeDevice(wired);
    const refreshed = await listDevices();
    const nowReady = refreshed.filter((device) => device.physical && !wifi(device) && device.state === "connected");
    if (nowReady.length >= 1) {
      const picked = nowReady.find((device) => device.udid === wired.udid) ?? nowReady[0]!;
      return { device: picked, devices: refreshed };
    }
    // The probe answered, so devicectl can still address this device even
    // though `list` keeps calling the tunnel idle. Using it is better than
    // failing a run that would have worked. A probe that failed says nothing
    // about the device, so it must not be read as "present".
    if (probed) return { device: wired, devices: refreshed };
  }

  // xcodebug only ever targets real hardware: the build destination is
  // platform=iOS,id=<udid> and the console bridge is devicectl. Saying so
  // explicitly stops the user waiting for a simulator that will never open.
  const simulators = devices.filter((device) => !device.physical).length;
  const hint = simulators > 0
    ? `\n${simulators} simulator(s) were reported and ignored - a simulator cannot provide device logs.`
    : "";
  throw new Error(
    `No USB-connected physical iOS device. Plug in the cable, trust the device, then retry.` +
      `\n(xcodebug never falls back to Wi-Fi or the simulator.)${hint}\n${describeDevices(devices)}`,
  );
}

/**
 * Bring a device's CoreDevice tunnel up by asking it one question.
 *
 * `devicectl list` only reports the tunnel that already exists; a freshly
 * plugged-in phone often reads `disconnected` until something addresses it by
 * identifier. `device info details` does exactly that and is read-only, so the
 * probe cannot disturb a run.
 */
async function probeDevice(device: DeviceInfo): Promise<boolean> {
  const target = device.udid ?? device.id;
  const result = await runCommand(
    "xcrun",
    ["devicectl", "device", "info", "details", "--device", target],
    { timeoutMs: 45_000 },
  );
  return result.code === 0;
}

/**
 * Best-effort pid lookup so `status` can name the running process.
 *
 * devicectl's process listing occasionally answers without the app (it can be
 * queried while the launch is still settling), so retry briefly before
 * concluding the process is absent.
 */
/**
 * Look up a running app's pid on the device.
 *
 * "The app is gone" and "I could not ask" must not be conflated: a verification
 * capture only ends when the app really exited, and a flaky USB/`devicectl`
 * probe would otherwise be mistaken for an exit and stop the capture for good.
 * `pid` is set only on a successful lookup; `queryFailed` marks the inconclusive
 * case where the process table could not be read at all.
 */
export interface ProcessLookup {
  pid?: number;
  /** True when the process table could not be read (command/JSON failure). */
  queryFailed: boolean;
}

export async function findProcessPid(
  device: DeviceInfo,
  executableName: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<number | undefined> {
  const lookup = await lookupProcess(device, executableName, options);
  return lookup.pid;
}

export async function lookupProcess(
  device: DeviceInfo,
  executableName: string,
  options: { attempts?: number; delayMs?: number; signal?: AbortSignal } = {},
): Promise<ProcessLookup> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = options.delayMs ?? 800;
  let queryFailed = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // The probe can take up to 45s; aborting it is what makes a user stop take
    // effect immediately instead of after the device finally answers.
    if (options.signal?.aborted) return { queryFailed: true };
    const result = await findProcessPidOnce(device, executableName, options.signal);
    if (result.pid !== undefined) return { pid: result.pid, queryFailed: false };
    if (result.queryFailed) queryFailed = true;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { queryFailed };
}

async function findProcessPidOnce(
  device: DeviceInfo,
  executableName: string,
  signal?: AbortSignal,
): Promise<ProcessLookup> {
  const result = await runCommand(
    "xcrun",
    ["devicectl", "device", "info", "processes", "--device", device.id, "--json-output", "-"],
    { timeoutMs: 45_000, signal },
  );
  // A failed command says nothing about the app; report it as inconclusive.
  if (result.code !== 0) return { queryFailed: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { queryFailed: true };
  }
  const processes = asRecord(asRecord(parsed).result).runningProcesses;
  if (!Array.isArray(processes)) return { queryFailed: true };
  // The app's own executable sits directly in its bundle. An extension runs from
  // `<App>.app/PlugIns/…` as a process of its own, and taking it for the app
  // would report a pid that is not the app's and an app that is not there.
  const needle = `/${executableName}.app/`;
  for (const raw of processes) {
    const entry = asRecord(raw);
    const executable = asString(entry.executable) ?? "";
    const at = executable.lastIndexOf(needle);
    if (at < 0 || executable.indexOf("/", at + needle.length) >= 0) continue;
    if (typeof entry.processIdentifier === "number") return { pid: entry.processIdentifier, queryFailed: false };
  }
  // The table was read successfully and the app is not in it: a real exit.
  return { queryFailed: false };
}

/**
 * Copy the crash report the device wrote for one instance of an app into
 * `directory`, and return where it landed.
 *
 * Crash reports are named `<executable>-<date>.ips`. The resource diagnostics
 * beside them (`<executable>.cpu_resource-…`) share the prefix up to the dot and
 * are not crashes. A report names the process it is about, so with `pid` only
 * that instance's report is returned: the next launch of the same app, crashing
 * in turn, writes one that is not this instance's. Without `pid` the newest
 * report since `since` is taken.
 */
export async function pullCrashReport(
  device: DeviceInfo,
  executableName: string,
  options: { since: number; directory: string; pid?: number; signal?: AbortSignal },
): Promise<{ path: string; terminationReason?: string } | undefined> {
  const listed = await runCommand(
    "xcrun",
    [
      "devicectl", "device", "info", "files", "--device", device.id,
      "--domain-type", "systemCrashLogs", "--search", executableName, "--json-output", "-",
    ],
    { timeoutMs: 45_000, signal: options.signal },
  );
  if (listed.code !== 0) return undefined;
  let files: unknown;
  try {
    files = asRecord(asRecord(JSON.parse(listed.stdout)).result).files;
  } catch {
    return undefined;
  }
  if (!Array.isArray(files)) return undefined;
  const candidates: Array<{ name: string; at: number }> = [];
  for (const raw of files) {
    const entry = asRecord(raw);
    const name = asString(entry.name);
    const at = Date.parse(asString(asRecord(entry.metadata).lastModDate) ?? "");
    if (name?.startsWith(`${executableName}-`) && name.endsWith(".ips") && basename(name) === name && at >= options.since) candidates.push({ name, at });
  }
  for (const { name } of candidates.sort((a, b) => b.at - a.at)) {
    options.signal?.throwIfAborted();
    const directory = await mkdtemp(join(options.directory, "crash-")).catch(() => undefined);
    if (!directory) return undefined;
    const destination = join(directory, `crash-${name}`);
    try {
      const copied = await runCommand(
        "xcrun",
        [
          "devicectl", "device", "copy", "from", "--device", device.id,
          "--domain-type", "systemCrashLogs", "--source", name, "--destination", destination,
        ],
        { timeoutMs: 60_000, signal: options.signal },
      );
      if (copied.code !== 0) continue;
      const report = await readFile(destination, "utf8").catch(() => undefined);
      if (report === undefined) continue;
      let parsed: Record<string, unknown>;
      try {
        // An Apple .ips has a one-line metadata object before the report JSON.
        const header = /^[^\n]*\}\s*\n(?=\s*\{)/.exec(report);
        parsed = asRecord(JSON.parse(header ? report.slice(header[0].length) : report));
      } catch {
        continue;
      }
      if (options.pid !== undefined && parsed.pid !== options.pid) continue;
      const retained = join(options.directory, `${basename(directory)}-${name}`);
      if (await rename(destination, retained).then(() => true, () => false)) {
        const termination = asRecord(parsed.termination);
        let reason = asString(termination.namespace);
        let code = asString(termination.code);
        if (typeof termination.code === "number" && Number.isSafeInteger(termination.code) && termination.code >= 0) {
          code = `0x${termination.code.toString(16).toUpperCase()}`;
        }
        if (code) reason = reason ? `${reason} ${code}` : code;
        const explanation = (Array.isArray(termination.reasons)
          ? termination.reasons.filter((value): value is string => typeof value === "string").join(" ")
          : undefined) || asString(termination.indicator);
        if (explanation) reason = reason ? `${reason}: ${explanation}` : explanation;
        return { path: retained, terminationReason: reason };
      }
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
  return undefined;
}
