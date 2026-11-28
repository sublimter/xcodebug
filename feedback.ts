import { runCommand } from "./exec.ts";

const REPOSITORY = "sublimter/xcodebug";
const ISSUES_URL = `https://github.com/${REPOSITORY}/issues`;

export async function submitFeedback(title: string, body = "", timeoutMs = 60_000) {
  const result = await runCommand("gh", [
    "api", "--hostname", "github.com", "--method", "POST", `repos/${REPOSITORY}/issues`,
    "--raw-field", `title=${title.trim()}`, "--raw-field", `body=${body}`, "--jq", ".html_url",
  ], { timeoutMs, maxBytes: 8_192 });
  const output = result.stdout.trim();
  const prefix = `${ISSUES_URL}/`;
  const issueUrl = output.startsWith(prefix) && /^[1-9]\d*$/.test(output.slice(prefix.length)) ? output : undefined;
  if (result.code === 0 && !result.timedOut && issueUrl) {
    return {
      content: [{ type: "text" as const, text: `Feedback submitted to ${REPOSITORY}:\n${issueUrl}` }],
      details: { repository: REPOSITORY, issueUrl },
      isError: false,
    };
  }
  const reason = result.stderr.includes("spawn gh ENOENT")
    ? "GitHub CLI (gh) is required. Install it and run gh auth login --hostname github.com."
    : result.timedOut
      ? "The GitHub feedback request timed out."
      : result.stderr.includes("E2BIG")
        ? "Feedback text is too large for the local command; shorten the body."
        : `GitHub CLI exited with code ${result.code}; issue creation could not be confirmed. Check gh auth status --hostname github.com.`;
  // A failed or cancelled HTTP request may have created the issue before its reply was lost.
  return {
    content: [{ type: "text" as const, text: `${reason}\nCheck ${issueUrl ?? ISSUES_URL} before submitting again: an issue may already have been created. No automatic retry was made.` }],
    details: { repository: REPOSITORY, issueUrl },
    isError: true,
  };
}
