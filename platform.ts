import { accessSync, constants } from "node:fs";

const MAC_ACTIONS: readonly string[] = ["devices", "changes", "build", "install", "launch", "syslog", "terminate", "restart"];
type AvailabilityError = {
  content: Array<{ type: "text"; text: string }>;
  details: {
    code: "unsupported_platform" | "unsupported_shell";
    platform: NodeJS.Platform;
    action: string;
    requiredPlatform?: "darwin";
    requiredShell?: "/bin/sh";
  };
  isError: true;
};

export function shellUnavailable(action: string): AvailabilityError | undefined {
  const platform = process.platform;
  if (platform !== "win32") {
    try { accessSync("/bin/sh", constants.X_OK); return; } catch { /* Not an executable shell on this host. */ }
  }
  return {
    content: [{ type: "text", text: `xcodebug ${action}: command= is unavailable on ${platform}; an executable /bin/sh is required.\nUse a POSIX execution host with /bin/sh. No shell command was started.` }],
    details: { code: "unsupported_shell", platform, action, requiredShell: "/bin/sh" },
    isError: true,
  };
}

export function availabilityError(action: string, command?: string): AvailabilityError | undefined {
  const platform = process.platform;
  if (platform !== "darwin" && MAC_ACTIONS.includes(action)) {
    return {
      content: [{ type: "text", text: `xcodebug ${action} is unavailable on ${platform}: this action requires macOS + Xcode.\nRun xcodebug on a Mac, or use an MCP server running on a Mac. No Xcode or device command was started.` }],
      details: { code: "unsupported_platform", platform, action, requiredPlatform: "darwin" },
      isError: true,
    };
  }
  // A stop must finish cancellation and cleanup before rejecting its appended command.
  if (platform === "win32" && command && action !== "stop") return shellUnavailable(action);
}

export function platformNotice(): string {
  if (process.platform === "darwin") return "";
  return `xcodebug on ${process.platform}: ${MAC_ACTIONS.join(", ")} require macOS + Xcode and are unavailable here. Feedback and local session controls remain available; command= requires /bin/sh. Use a Mac execution host for Xcode/device actions.`;
}
