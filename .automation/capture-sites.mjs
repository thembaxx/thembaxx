import { chromium } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const sites = JSON.parse(readFileSync(resolve(root, "sites.json"), "utf8")).filter((s) => s.screenshot);
const output = resolve("site-screenshots");
const baseline = resolve("site-screenshots-baseline");
const viewports = [{ id: "desktop", width: 1440, height: 900, mobile: false }, { id: "mobile", width: 390, height: 844, mobile: true }, { id: "tablet", width: 820, height: 1180, mobile: true }];
const browser = await chromium.launch({ headless: true });
const report = [];
try {
  for (const site of sites) {
    for (const view of viewports) {
      const item = { site: site.id, viewport: view.id, status: "failed" };
      const file = resolve(output, site.id, view.id + ".png");
      let context;
      try {
        context = await browser.newContext({ viewport: { width: view.width, height: view.height }, deviceScaleFactor: 1, isMobile: view.mobile, hasTouch: view.mobile, reducedMotion: "reduce", colorScheme: "light" });
        const page = await context.newPage();
        const response = await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (!response?.ok()) throw Error("HTTP " + (response?.status() || "unavailable"));
        if (new URL(page.url()).hostname !== new URL(site.url).hostname) throw Error("Unexpected redirect");
        if (/Authentication Required|Vercel Authentication/i.test(await page.title())) throw Error("Protected page");
        await page.waitForTimeout(1500);
        mkdirSync(dirname(file), { recursive: true });
        await page.screenshot({ path: file, fullPage: false, animations: "disabled" });
        item.status = "captured";
        const old = resolve(baseline, site.id, view.id + ".png");
        if (existsSync(old)) {
          const before = PNG.sync.read(readFileSync(old));
          const after = PNG.sync.read(readFileSync(file));
          if (before.width === after.width && before.height === after.height) {
            const diff = new PNG({ width: after.width, height: after.height });
            const changed = pixelmatch(before.data, after.data, diff.data, after.width, after.height, { threshold: 0.15 });
            item.diffPercent = Math.round(changed / (after.width * after.height) * 10000) / 100;
            if (item.diffPercent >= 10) {
              writeFileSync(resolve(output, site.id, view.id + "-diff.png"), PNG.sync.write(diff));
              item.status = "review-diff";
            }
          } else item.status = "review-size";
        }
      } catch (error) { item.error = String(error?.message || error).slice(0, 200); }
      finally { await context?.close(); }
      report.push(item);
      console.log(item.site + " " + item.viewport + ": " + item.status + " " + (item.error || ""));
    }
  }
} finally { await browser.close(); }
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
const summary = "## Production screenshot audit\n\n| Site | Viewport | Status | Changed pixels (%) |\n| --- | --- | --- | ---: |\n" + report.map((x) => "| " + x.site + " | " + x.viewport + " | " + x.status + " | " + (x.diffPercent ?? "-") + " |").join("\n") + "\n";
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (report.some((x) => x.status === "failed")) process.exitCode = 1;
