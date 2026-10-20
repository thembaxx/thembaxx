import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";

const owner = "thembaxx";
const projects = JSON.parse(await readFile("automation/projects.json", "utf8"));
const token = process.env.GITHUB_TOKEN;
if (!token) throw Error("GITHUB_TOKEN required");
const since = new Date(Date.now() - 7 * 86400000);
const headers = { Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28" };

const shipped = [];
const unavailable = [];
for (const name of projects) {
  if (["lumni", "lumnie", "matricmaster-ai"].includes(name)) continue;
  try {
    const response = await fetch("https://api.github.com/repos/" + owner + "/" + encodeURIComponent(name) + "/pulls?state=closed&sort=updated&direction=desc&per_page=50", {
      headers, signal: AbortSignal.timeout(15000), redirect: "manual",
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const pulls = await response.json();
    for (const pr of pulls) {
      if (!pr.merged_at || Date.parse(pr.merged_at) < since.getTime()) continue;
      const url = new URL(pr.html_url);
      if (url.hostname !== "github.com" || url.pathname.split("/")[1] !== owner) continue;
      const title = String(pr.title).replace(/[\r\n]/g, " ").replace(/[<>]/g, "").slice(0, 160);
      shipped.push({ project: name, title, url: url.href, mergedAt: pr.merged_at });
    }
  } catch (error) {
    unavailable.push({ project: name, reason: error.message });
  }
}
shipped.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
const output = [
  "# Weekly project release and content draft",
  "",
  "Generated from **actually merged pull requests** in the previous seven days.",
  "This is a draft, not published marketing, and PR titles are not proof of functioning production features.",
  "",
  "## Verified repository changes",
  "",
  ...(shipped.length
    ? shipped.map(s => "- **" + s.project + "**: [" + s.title.replace(/[[\]()]/g, "") + "](" + s.url + ") — merged " + s.mergedAt.slice(0, 10))
    : ["No merged pull requests found in this seven-day window."]),
  "",
  "## Suggested LinkedIn draft structure",
  "",
  "This week I worked on practical frontend and product engineering improvements across several projects.",
  "Select the relevant merged changes above, confirm the corresponding deployment and user experience, then explain the problem, the implementation and the result.",
  "Include a genuine project screenshot; do not claim an unverified performance or business outcome.",
  "",
  "## Data limitations",
  "",
  "Public GitHub repository activity only; confidential repositories are deliberately excluded.",
  ...(unavailable.length ? unavailable.map(x => "- Could not inspect " + x.project + ": " + x.reason) : []),
];
await mkdir("reports", { recursive: true });
await writeFile("reports/weekly-release-draft.md", output.join("\n") + "\n");
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, "## Weekly content draft\n\n" + shipped.length + " merged PRs identified. See the attached draft artifact.\n");
console.log("Merged PRs: " + shipped.length + "; unavailable repos: " + unavailable.length);
