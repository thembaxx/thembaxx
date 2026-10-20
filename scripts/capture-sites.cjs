const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const sites = JSON.parse(fs.readFileSync("automation/sites.json","utf8"));
(async () => {
  fs.mkdirSync("screenshots", {recursive:true});
  const browser = await chromium.launch({headless:true});
  const failures = [];
  try {
    for (const site of sites) {
      for (const [name,width,height] of [["desktop",1440,900],["mobile",390,844],["tablet",820,1180]]) {
        const context = await browser.newContext({viewport:{width,height},deviceScaleFactor:1,reducedMotion:"reduce",colorScheme:"light"});
        const page = await context.newPage();
        try {
          const res = await page.goto(site.url,{waitUntil:"domcontentloaded",timeout:30000});
          if (!res || !res.ok()) throw new Error("HTTP " + (res?.status() || "unavailable"));
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({path:path.join("screenshots",site.id + "-" + name + ".png"),fullPage:false,animations:"disabled"});
          process.stdout.write("Captured " + site.id + " " + name + "\n");
        } catch (error) { failures.push(site.id + " " + name + ": " + error.message); }
        finally { await context.close(); }
      }
    }
  } finally { await browser.close(); }
  const result = "## Live UI screenshots\n\n" + (failures.length ? failures.map(x => "- " + x).join("\n") : "All configured captures succeeded.") + "\n";
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, result);
  if (failures.length) process.exitCode = 1;
})().catch(e => {console.error(e);process.exitCode=1;});
