import { appendFile, mkdir, writeFile } from "node:fs/promises";

const owner = "thembaxx";
const token = process.env.REPO_AUDIT_TOKEN || process.env.GITHUB_TOKEN;
const headers = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "thembaxx-repository-inventory/1.0",
  ...(token ? { authorization: "Bearer " + token } : {}),
};
const exclusions = new Set(["lumni", "lumnie", "matricmaster-ai"]);
const errors = [];

async function api(path) {
  const url = new URL(path, "https://api.github.com");
  if (url.origin !== "https://api.github.com") throw new Error("Unexpected API origin");
  const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { status: res.status, data: null };
  return { status: res.status, data: await res.json() };
}

const repos = [];
const path = process.env.REPO_AUDIT_TOKEN
  ? "/user/repos?affiliation=owner&per_page=100"
  : "/users/" + owner + "/repos?type=owner&per_page=100";
for (let page = 1; page <= 4; page++) {
  const endpoint = path + (path.includes("?") ? "&" : "?") + "page=" + page;
  const result = await api(endpoint);
  if (result.status !== 200 || !Array.isArray(result.data)) {
    throw Error("Cannot list repository inventory (HTTP " + result.status + ")");
  }
  repos.push(...result.data.filter(r => r.owner?.login?.toLowerCase() === owner));
  if (result.data.length < 100) break;
}
const scoped = repos.filter(r => !exclusions.has(r.name.toLowerCase()) && r.name !== owner && r.name !== "portfolio-");
const output = [];
for (const r of scoped) {
  const name = r.name;
  if (!/^[\w.-]+$/.test(name)) { errors.push("Unsupported repository identifier"); continue; }
  const age = r.pushed_at ? Math.floor((Date.now() - Date.parse(r.pushed_at)) / 86400000) : null;
  let githubWorkflows = "unknown";
  if (r.size === 0) {
    githubWorkflows = "empty-repository";
  } else {
    const workflows = await api("/repos/" + owner + "/" + encodeURIComponent(name) + "/contents/.github/workflows");
    githubWorkflows = workflows.status === 200 && Array.isArray(workflows.data)
      ? workflows.data.filter(x => /\.ya?ml$/i.test(x.name)).length
      : workflows.status === 404 ? 0 : "unknown";
  }
  output.push({
    repo: name, url: r.html_url, visibility: r.private ? "private" : "public",
    archived: !!r.archived, updatedAt: r.pushed_at,
    inactiveDays: Number.isFinite(age) ? age : null,
    githubWorkflowCount: githubWorkflows,
    attention: githubWorkflows === 0 && !r.archived && r.size > 0 ? "no-github-workflows"
      : Number.isFinite(age) && age > 90 ? "inactive" : "none",
  });
}
const result = {
  generatedAt: new Date().toISOString(),
  scope: process.env.REPO_AUDIT_TOKEN ? "Owner-authorized repositories visible to configured token" : "Public owner repositories only",
  excluded: [...exclusions], projects: output, errors,
};
await mkdir("reports", { recursive: true });
await writeFile("reports/repo-inventory.json", JSON.stringify(result, null, 2) + "\n");
const missing = output.filter(x => x.attention === "no-github-workflows");
const inactive = output.filter(x => x.attention === "inactive");
const table = missing.slice(0, 25).map(x => "| [" + x.repo + "](" + x.url + ") | " +
  (x.inactiveDays === null ? "unknown" : x.inactiveDays + " days") + " |");
const summary = [
  "## Repository automation inventory", "",
  "- Scanned: " + output.length + " repositories",
  "- Missing GitHub workflow directory: " + missing.length,
  "- Inactive (>90 days): " + inactive.length,
  "- Coverage: " + result.scope,
  "- Explicitly excluded: " + [...exclusions].join(", "), "",
  "### Repositories without GitHub workflows",
  "| Repository | Time since last push |", "| --- | ---: |",
  ...table, "",
  "A missing GitHub Actions workflow does not prove there is no external CI.",
  "Private repositories may be absent without a configured owner-authorized token.",
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
if (errors.length) console.warn("Partial inventory; inspect the report.");
