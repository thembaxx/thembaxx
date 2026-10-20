import fs from "node:fs";
const repos = ["procodiapp","stockvel","carpur","citylit","hydromental","homebuyer","homecheck","mypets","leesmaat","pamoja","subzero","nou","civicwise","rental","baby"];
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");
async function request(path) {
  const response = await fetch("https://api.github.com/" + path, {headers:{"authorization":"Bearer " + token,"accept":"application/vnd.github+json","x-github-api-version":"2022-11-28","user-agent":"thembaxx-project-digest"},signal:AbortSignal.timeout(15000)});
  if (!response.ok) return {error:response.status};
  return response.json();
}
const lines = ["# Engineering and product intelligence","", "Generated: " + new Date().toISOString(),"", "| Repository | Latest Action | Recent completed runs | Open issues |", "|---|---|---|---:|"];
for (const repo of repos) {
  const metadata = await request("repos/thembaxx/" + repo);
  if (metadata.error) { lines.push("| " + repo + " | Unavailable (" + metadata.error + ") | — | — |"); continue; }
  const runs = await request("repos/thembaxx/" + repo + "/actions/runs?per_page=10");
  const rows = (runs.workflow_runs || []).filter(r => r.status === "completed");
  const latest = rows[0];
  const recent = rows.slice(0,10);
  const failures = recent.filter(r => r.conclusion === "failure").length;
  const latestText = latest ? "[" + (latest.conclusion || "unknown") + "](" + latest.html_url + ")" : "No recent runs";
  lines.push("| " + repo + " | " + latestText + " | " + failures + " failed / " + recent.length + " completed | " + metadata.open_issues_count + " |");
}
lines.push("", "## Data not connected", "", "Visitors, retention, revenue, payments, conversion and customer satisfaction are **unavailable**. GitHub Actions results are engineering signals, not evidence of product-market fit.", "", "## Suggested action", "", "Inspect persistent failures and open issues before accepting automated dependency PRs. Prioritize product improvements only when grounded in real customer data.");
const report = lines.join("\n") + "\n";
fs.mkdirSync("automation/reports", {recursive:true});
fs.writeFileSync("automation/reports/project-digest.md", report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
process.stdout.write(report);
