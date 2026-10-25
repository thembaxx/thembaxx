import { appendFile, mkdir, writeFile } from "node:fs/promises";

const owner = "thembaxx";
const token = process.env.REPO_AUDIT_TOKEN || process.env.GITHUB_TOKEN;
const headers = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "thembaxx-repository-inventory/1.0",
  ...(token ? { authorization: "Bearer " + token } : {}),
};
const exclusions = new Set(); // Scope is all currently unarchived owner repositories.
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
const scoped = repos.filter(r => !r.archived && !exclusions.has(r.name.toLowerCase()));
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
  // These are configuration signals, not proof that a command passes in CI.
  const root = "/repos/" + owner + "/" + encodeURIComponent(name) + "/contents/";
  const [readme, manifest] = r.size === 0
    ? [{ status: 404 }, { status: 404 }]
    : await Promise.all([api(root + "README.md"), api(root + "package.json")]);
  let scripts = null;
  let toolchain = null;
  if (manifest.status === 200 && manifest.data?.type === "file" && manifest.data.content) {
    try {
      const pkg = JSON.parse(Buffer.from(manifest.data.content.replace(/\\s/g, ""), "base64").toString("utf8"));
      scripts = Object.keys(pkg.scripts || {}).sort();
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      toolchain = Object.fromEntries(["typescript", "oxlint", "oxfmt", "eslint"].filter(k => deps[k]).map(k => [k, deps[k]]));
    } catch (error) {
      errors.push(name + ": unable to parse package manifest: " + error.message);
    }
  }
  const recommendations = [];
  if (readme.status === 404 && r.size > 0) recommendations.push("missing-readme");
  if (githubWorkflows === 0 && r.size > 0) recommendations.push("no-github-workflows");
  if (Array.isArray(scripts)) {
    if (!scripts.includes("typecheck") && toolchain?.typescript) recommendations.push("missing-typecheck-command");
    if (!scripts.includes("lint")) recommendations.push("missing-lint-command");
    if (toolchain?.oxfmt && !scripts.includes("format:check")) recommendations.push("missing-format-check-command");
    if (!scripts.some(s => s === "test" || s === "test:e2e" || s.startsWith("test:"))) recommendations.push("no-test-command");
  }
  if (![200, 404].includes(readme.status)) errors.push(name + ": README lookup returned HTTP " + readme.status);
  if (![200, 404].includes(manifest.status)) errors.push(name + ": package lookup returned HTTP " + manifest.status);
  output.push({
    repo: name, url: r.html_url, visibility: r.private ? "private" : "public",
    archived: !!r.archived, updatedAt: r.pushed_at,
    inactiveDays: Number.isFinite(age) ? age : null,
    githubWorkflowCount: githubWorkflows,
    readme: readme.status === 200 ? "present" : readme.status === 404 ? "missing" : "unknown",
    packageManifest: manifest.status === 200 ? "present" : manifest.status === 404 ? "missing" : "unknown",
    scripts, toolchain, recommendations,
    attention: githubWorkflows === 0 && !r.archived && r.size > 0 ? "no-github-workflows"
      : Number.isFinite(age) && age > 90 ? "inactive" : "none",
  });
}
const result = {
  generatedAt: new Date().toISOString(),
  scope: process.env.REPO_AUDIT_TOKEN ? "Owner-authorized repositories visible to configured token" : "Public owner repositories only",
  excluded: [...exclusions], archivedExcluded: repos.filter(r => r.archived).length, projects: output, errors,
};
await mkdir("reports", { recursive: true });
await writeFile("reports/repo-inventory.json", JSON.stringify(result, null, 2) + "\n");
const missing = output.filter(x => x.attention === "no-github-workflows");
const inactive = output.filter(x => x.attention === "inactive");
const missingReadme = output.filter(x => x.recommendations.includes("missing-readme"));
const missingChecks = output.filter(x => x.recommendations.some(k => k.startsWith("missing-") || k === "no-test-command"));
const table = missing.slice(0, 25).map(x => "| [" + x.repo + "](" + x.url + ") | " +
  (x.inactiveDays === null ? "unknown" : x.inactiveDays + " days") + " |");
const summary = [
  "## Repository automation inventory", "",
  "- Scanned: " + output.length + " repositories",
  "- Missing GitHub workflow directory: " + missing.length,
  "- Inactive (>90 days): " + inactive.length,
  "- Coverage: " + result.scope,
  "- Archived excluded: " + result.archivedExcluded,
  "- Missing READMEs: " + missingReadme.length,
  "- Repositories with a missing quality script: " + missingChecks.length,
  "- Explicitly excluded: " + [...exclusions].join(", "), "",
  "### Missing README files",
  ...missingReadme.map(x => "- [" + x.repo + "](" + x.url + ")"), "",
  "### Repositories missing quality commands",
  ...missingChecks.map(x => "- [" + x.repo + "](" + x.url + "): " + x.recommendations.join(", ")), "",
  "### Repositories without GitHub workflows",
  "| Repository | Time since last push |", "| --- | ---: |",
  ...table, "",
  "Missing scripts and workflow names are configuration signals, not tested failures or proof of no external CI.",
  "Private repositories may be absent without a configured owner-authorized token.",
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
if (errors.length) console.warn("Partial inventory; inspect the report.");
