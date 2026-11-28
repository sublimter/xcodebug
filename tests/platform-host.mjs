import { fileURLToPath } from "node:url";
// Only mock the policy input; filesystem paths and child-process I/O use the real host.
import "node:path";
import "node:child_process";

export const platformPreload = fileURLToPath(import.meta.url);

export function mockPlatform(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  const setPlatform = value => Object.defineProperty(process, "platform", { value, configurable: true, enumerable: true });
  setPlatform(platform);
  t.after(() => {
    if (original) Object.defineProperty(process, "platform", original);
    else delete process.platform;
  });
  return setPlatform;
}

// This environment variable is read only by this private test preload, never by production.
if (process.env.XCODEBUG_TEST_PLATFORM !== undefined) {
  Object.defineProperty(process, "platform", { value: process.env.XCODEBUG_TEST_PLATFORM, configurable: true, enumerable: true });
}
