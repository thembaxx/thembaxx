import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";

const sites = JSON.parse(await readFile(new URL("../automation/sites.json", import.meta.url), "utf8"));
const rows = [];
const retries = 2;

async function check(site) {
  const uri = new URL(site.url);
  if (uri.protocol !== "https:" || uri.username || uri.password || uri.search || uri.hash || uri.port) {
    throw Error("Invalid configured site URL");
  }
  let result = { name: site.name, url: uri.href, status: "FAILED", http: 0, milliseconds: 0 };
  for (let attempt = 0; attempt < retries; attempt++) {
    const start = performance.now();
    try {
      const res = await fetch(uri, {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": "Thembaxx-Portfolio-Health/1.0" },
      });
      result = { ...result, http: res.status, milliseconds: Math.round(performance.now() - start) };
      if (res.status >= 200 && res.status < 300) {
        result.status = "OK";
        return result;
      }
      if (res.status === 401 || res.status === 403) {
        result.status = "PROTECTED";
        return result;
      }
      result.status = res.status >= 300 && res.status < 400 ? "REDIRECT" : "HTTP_ERROR";
    } catch (error) {
      result = { ...result, status: "NETWORK_ERROR", error: String(error.message).slice(0, 120) };
    }
    if (attempt + 1 < retries) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return result;
}

for (const site of sites) {
  rows.push(await check(site));
}
await mkdir("reports", { recursive: true });
await writeFile("reports/site-health.json", JSON.stringify({
  checkedAt: new Date().toISOString(), results: rows
}, null, 2) + "\n");

const report = [
  "## Portfolio site health",
  "",
  "HTTP is a reachability signal, not a complete application, auth or checkout test.",
  "Protected deployments require a separate authenticated smoke test.",
  "",
  "| Site | HTTP | Result | Duration |",
  "| --- | ---: | --- | ---: |",
  ...rows.map(r => "| " + r.name.replaceAll("|", "") + " | " + r.http + " | " + r.status + " | " + r.milliseconds + " ms |"),
  "",
];
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, report.join("\n") + "\n");
}
console.log(report.join("\n"));
if (rows.some(r => r.status !== "OK")) process.exitCode = 1;
