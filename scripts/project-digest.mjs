import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";

// Reuse the immediately preceding intelligence report instead of maintaining
// a separate, stale list of project names or performing duplicate API calls.
const source = JSON.parse(await readFile("reports/project-intelligence.json", "utf8"));
const projects = source.projects || [];
const lines = [
  "# Engineering and product intelligence", "",
  "Generated: " + new Date().toISOString(), "",
  "Scope: " + (source.scope || "unknown") + ". Archived repositories are excluded.", "",
  "| Repository | Latest Action | 14-day CI outcomes | Open issues and PRs |",
  "| --- | --- | --- | ---: |",
];
for (const item of projects) {
  const repo = item.repository?.split("/")[1] || "unknown";
  const latest = item.latest;
  const state = item.errors?.length
    ? "Unavailable (" + item.errors.join("; ").replace(/\\|/g, "/") + ")"
    : latest ? "[" + (latest.conclusion || "in progress") + "](" + latest.url + ")" : "No recent runs";
  const outcomes = (item.ci?.failure || 0) + " failed / " + (item.ci?.success || 0) + " succeeded";
  lines.push("| [" + repo + "](https://github.com/thembaxx/" + repo + ") | " +
    state + " | " + outcomes + " | " + (item.openIssues ?? "unknown") + " |");
}
lines.push(
  "", "## Interpretation", "",
  "Open counts from GitHub repository metadata include both issues and pull requests.",
  "Workflow outcomes are observations, not verification of current production health.",
  "Historical failures can remain visible after fixes; inspect the latest relevant commit before acting.",
  "Private repositories are omitted unless the report was generated with owner-authorized credentials.",
  "", "## Data not connected", "",
  "Visitors, retention, revenue, payments, conversion and customer satisfaction are unavailable.",
  "Prioritize actionable current failures and user feedback rather than assuming product-market fit."
);
const report = lines.join("\n") + "\n";
await mkdir("automation/reports", { recursive: true });
await writeFile("automation/reports/project-digest.md", report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
process.stdout.write(report);
