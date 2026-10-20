import { mkdir, writeFile, appendFile } from "node:fs/promises";

const sites = [
  ["Hydromental", "https://hydromental.vercel.app"],
  ["CityLit", "https://citylit.vercel.app"],
  ["ProcodiApp", "https://procodiapp.vercel.app"],
  ["Leesmaat", "https://leesmaat.vercel.app"],
  ["MyPets", "https://mypets-pi.vercel.app"],
];
const results = [];

async function readJson(url) {
  const response = await fetch(url, {
    redirect: "manual", signal: AbortSignal.timeout(12000),
    headers: { accept: "application/manifest+json, application/json", "user-agent": "Thembaxx-PWA-Audit/1.0" },
  });
  if (response.status >= 300 && response.status < 400) throw Error("redirect to unexpected location");
  if (!response.ok) throw Error("HTTP " + response.status);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 100000) throw Error("Manifest too large");
  const content = await response.text();
  if (content.length > 100000) throw Error("Manifest too large");
  return JSON.parse(content);
}

async function iconExists(url) {
  const response = await fetch(url, {
    method: "GET", redirect: "manual", signal: AbortSignal.timeout(12000),
    headers: { "user-agent": "Thembaxx-PWA-Audit/1.0" },
  });
  await response.body?.cancel();
  return response.ok;
}

for (const [name, origin] of sites) {
  const errors = [];
  const warnings = [];
  const site = new URL(origin);
  let manifest = null;
  for (const route of ["/manifest.webmanifest", "/manifest.json"]) {
    try {
      manifest = await readJson(new URL(route, site));
      break;
    } catch (error) {
      if (route === "/manifest.json") errors.push("Manifest not available: " + error.message);
    }
  }
  if (manifest) {
    if (typeof manifest.name !== "string" || !manifest.name.trim()) errors.push("Missing app name");
    try {
      const start = new URL(manifest.start_url || "/", site);
      if (start.origin !== site.origin) errors.push("Start URL is off-origin");
    } catch { errors.push("Invalid start URL"); }
    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    for (const px of [192, 512]) {
      if (!icons.some(i => String(i.sizes || "").split(/\s+/).includes(px + "x" + px))) {
        warnings.push("No declared " + px + "x" + px + " icon");
      }
    }
    if (!icons.some(i => String(i.purpose || "any").split(/\s+/).includes("maskable"))) {
      warnings.push("No declared maskable icon");
    }
    const firstIcon = icons.find(i => typeof i.src === "string");
    if (!firstIcon) errors.push("No app icon declared");
    else {
      try {
        const url = new URL(firstIcon.src, site);
        if (url.origin !== site.origin) errors.push("Icon is off-origin");
        else if (!await iconExists(url)) errors.push("Declared icon fails HTTP check");
      } catch (error) { errors.push("Icon URL invalid: " + error.message); }
    }
  }
  results.push({ name, origin, status: errors.length ? "FAIL" : warnings.length ? "WARN" : "PASS", errors, warnings });
}

await mkdir("reports", { recursive: true });
await writeFile("reports/pwa-health.json", JSON.stringify({checkedAt:new Date().toISOString(),results}, null, 2) + "\n");
const output = [
  "## Public PWA readiness audit", "",
  "A manifest and icon availability audit, **not** proof of successful installation on iOS or Android.", "",
  "| App | Status | Findings |",
  "| --- | --- | --- |",
  ...results.map(r => "| " + r.name + " | " + r.status + " | " +
    [...r.errors,...r.warnings].map(s=>s.replaceAll("|","/")).join("; ").slice(0,280) + " |"),
].join("\n");
console.log(output);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, output + "\n");
if (results.some(x=>x.status==="FAIL")) process.exitCode=1;
