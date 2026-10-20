import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const sites = JSON.parse(readFileSync(resolve(root, "sites.json"), "utf8"));
const results = [];
const fetchPage = async (url) => {
  const start = performance.now();
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: { "user-agent": "thembaxx-portfolio-health/1.0" },
    cache: "no-store",
  });
  return { response, durationMs: Math.round(performance.now() - start) };
};

for (const site of sites) {
  const record = { id: site.id, url: site.url, status: "FAIL", notes: [], checkedAt: new Date().toISOString() };
  try {
    const target = new URL(site.url);
    if (target.protocol !== "https:" || target.username || target.password) throw Error("Expected a public HTTPS URL");
    const { response, durationMs } = await fetchPage(site.url);
    record.httpStatus = response.status;
    record.durationMs = durationMs;
    record.destination = response.url;
    if (!response.ok) throw Error("HTTP " + response.status);
    if (new URL(response.url).hostname !== target.hostname) throw Error("Unexpected redirect to " + new URL(response.url).hostname);
    const type = response.headers.get("content-type") || "";
    if (!type.includes("text/html")) throw Error("Expected HTML but received " + type);
    const html = await response.text();
    if (!/<html\b/i.test(html)) throw Error("HTML document missing");
    if (/<title[^>]*>\s*(?:Authentication Required|Vercel Authentication)/i.test(html)) throw Error("Protected preview/login page");
    if (site.pwa) {
      const rel = html.match(/<link\b(?=[^>]*\brel=["']manifest["'])[^>]*>/i)?.[0];
      const path = rel?.match(/\bhref=["']([^"']+)["']/i)?.[1] || "/manifest.webmanifest";
      const manifestUrl = new URL(path, target);
      if (manifestUrl.origin !== target.origin) throw Error("Cross-origin PWA manifest");
      const mf = await fetchPage(manifestUrl);
      if (!mf.response.ok) record.notes.push("PWA manifest unavailable (" + mf.response.status + ")");
      else {
        try {
          const manifest = await mf.response.json();
          if (!Array.isArray(manifest.icons) || !manifest.icons.length) record.notes.push("Manifest missing icons");
        } catch { record.notes.push("Manifest is not valid JSON"); }
      }
    }
    record.status = "OK";
  } catch (error) { record.notes.push(String(error?.message || error)); }
  results.push(record);
  console.log(record.id + ": " + record.status + " " + (record.httpStatus || "-") + " " + record.notes.join("; "));
}

const output = resolve(process.env.REPORT_DIR || "site-health");
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "health.json"), JSON.stringify(results, null, 2) + "\n");
const header = ["## Portfolio production health", "", "| App | HTTP | Time | Result | Notes |", "| --- | ---: | ---: | --- | --- |"];
for (const item of results) header.push("| " + item.id + " | " + (item.httpStatus || "-") + " | " + (item.durationMs || "-") + "ms | " + item.status + " | " + item.notes.join("; ").replaceAll("|", "/") + " |");
const summary = header.join("\n") + "\n";
writeFileSync(resolve(output, "summary.md"), summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
if (results.some((item) => item.status !== "OK")) process.exitCode = 1;
