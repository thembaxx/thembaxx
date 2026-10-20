import { readFile, appendFile, mkdir, writeFile } from "node:fs/promises";

const repos = JSON.parse(await readFile("automation/projects.json", "utf8"));
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required for the GitHub-only report");
const owner = "thembaxx";
const since = new Date(Date.now() - 14 * 86400000).toISOString();
const headers = { Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28" };

async function github(path) {
  const url = new URL(path, "https://api.github.com");
  if (url.origin !== "https://api.github.com" || !url.pathname.startsWith("/repos/thembaxx/")) {
    throw new Error("Unexpected API path");
  }
  const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("GitHub API " + response.status + " for " + url.pathname);
  return response.json();
}

const report = [];
for (const name of repos) {
  if (["lumni", "lumnie", "matricmaster-ai"].includes(name)) continue;
  const item = { repository: owner + "/" + name, windowDays: 14, ci: { success: 0, failure: 0, cancelled: 0, skipped: 0 }, latest: null, openIssues: null, errors: [] };
  try {
    const path = "/repos/" + owner + "/" + encodeURIComponent(name);
    const [runs, meta] = await Promise.all([
      github(path + "/actions/runs?per_page=100"),
      github(path),
    ]);
    item.openIssues = meta.open_issues_count ?? null;
    const recent = (runs.workflow_runs || []).filter(r => r.created_at >= since && r.event !== "dynamic");
    for (const run of recent) {
      if (Object.hasOwn(item.ci, run.conclusion)) item.ci[run.conclusion]++;
      else if (!run.conclusion) item.ci.inProgress = (item.ci.inProgress || 0) + 1;
    }
    item.latest = recent[0] ? { name: recent[0].name, conclusion: recent[0].conclusion, url: recent[0].html_url } : null;
    item.sampleMayBeTruncated = runs.total_count > (runs.workflow_runs || []).length && recent.length === (runs.workflow_runs || []).length;
  } catch (error) {
    item.errors.push(error.message);
  }
  report.push(item);
}

const result = {
  generatedAt: new Date().toISOString(),
  methodology: "GitHub Actions and repository metadata only; no visitor counts, revenue, conversion or product usage inferred.",
  windowDays: 14,
  projects: report,
};
await mkdir("reports", { recursive: true });
await writeFile("reports/project-intelligence.json", JSON.stringify(result, null, 2) + "\n");
const table = report.map(p => {
  const state = p.errors.length ? "Unavailable" : p.ci.failure ? "Review failures" : p.ci.success ? "Checks passing" : "No recent checks";
  return "| [" + p.repository.split("/")[1] + "](https://github.com/" + p.repository + ") | " + state + " | " + p.ci.success + " | " + p.ci.failure + " |";
});
const output = [
  "## Weekly project intelligence", "",
  "14-day repository and CI signals, **not product usage or monetization metrics**.", "",
  "| Repository | CI signal | Successful runs | Failed runs |",
  "| --- | --- | ---: | ---: |", ...table,
  "", "Missing product analytics are **unknown**, never zero.",
  "Runs listed are a bounded GitHub API sample; check individual repositories for full histories.",
].join("\n");
console.log(output);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, output + "\n");
if (report.some(p => p.errors.length)) console.warn("Some repository data unavailable; see report JSON.");
