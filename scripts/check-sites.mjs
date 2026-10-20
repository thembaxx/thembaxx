import fs from "node:fs";
const sites = JSON.parse(fs.readFileSync(new URL("../automation/sites.json", import.meta.url), "utf8"));
const summary = process.env.GITHUB_STEP_SUMMARY;
const rows = ["## Production endpoint checks", "", "| Site | Route | HTTP | Duration | Result |", "|---|---|---:|---:|---|"];
let failures = 0;
for (const site of sites) {
  const origin = new URL(site.url);
  if (origin.protocol !== "https:" || !["vercel.app"].some(x => origin.hostname.endsWith("." + x)) || origin.pathname !== "/") throw new Error("Invalid configured origin for " + site.id);
  for (const path of site.paths) {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid path");
    const url = new URL(path, origin);
    let status = "ERR", outcome = "FAIL", duration = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = Date.now();
      try {
        const response = await fetch(url, {redirect:"follow", cache:"no-store", signal:AbortSignal.timeout(15000), headers:{"user-agent":"thembaxx-portfolio-health/1.0"}});
        status = String(response.status); duration = Date.now() - start;
        if (response.ok) { outcome = "OK"; break; }
        if ([401,403].includes(response.status)) { outcome = "PROTECTED"; break; }
        if (![408,429,500,502,503,504].includes(response.status)) break;
      } catch (error) { duration = Date.now() - start; status = String(error?.cause?.code || error?.name || "NETWORK").replaceAll("|", ""); }
    }
    if (outcome === "FAIL") failures++;
    rows.push("| " + site.id + " | " + path + " | " + status + " | " + duration + "ms | " + outcome + " |");
  }
}
rows.push("", failures ? "**" + failures + " failing route(s).**" : "All public routes responded successfully or require access credentials.", "", "A PROTECTED result means the endpoint requires authentication; availability cannot be confirmed.");
const report = rows.join("\n") + "\n";
process.stdout.write(report);
if (summary) fs.appendFileSync(summary, report);
if (failures) process.exitCode = 1;
