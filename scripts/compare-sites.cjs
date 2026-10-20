const fs = require("node:fs");
const path = require("node:path");
const {PNG} = require(process.env.PNGJS_MODULE || "pngjs");
const current = "screenshots";
const baseline = process.env.BASELINE_DIR || "";
const lines = ["## Visual change review", "", "| Screenshot | Pixels changed | Review |", "|---|---:|---|"];
let flagged = 0, compared = 0;
if (!baseline || !fs.existsSync(baseline)) {
  lines.push("| All | — | First capture: no prior baseline |");
} else {
  for (const name of fs.readdirSync(current).filter(x=>x.endsWith(".png"))) {
    const a = path.join(current,name), b = path.join(baseline,name);
    if (!fs.existsSync(b)) { lines.push("| " + name + " | — | New screenshot |"); continue; }
    try {
      const now = PNG.sync.read(fs.readFileSync(a));
      const before = PNG.sync.read(fs.readFileSync(b));
      if (now.width!==before.width || now.height!==before.height) {lines.push("| "+name+" | — | Dimensions changed |");flagged++;continue;}
      let changed=0;
      for (let i=0;i<now.data.length;i+=4) {
        const delta=Math.max(Math.abs(now.data[i]-before.data[i]),Math.abs(now.data[i+1]-before.data[i+1]),Math.abs(now.data[i+2]-before.data[i+2]));
        if (delta>30) changed++;
      }
      const pct=100*changed/(now.width*now.height);
      const review=pct>8?"Inspect visual change":"No major change detected";
      if (pct>8) flagged++;
      compared++;
      lines.push("| "+name+" | "+pct.toFixed(1)+"% | "+review+" |");
    } catch(e) {flagged++;lines.push("| "+name+" | — | Comparison error: "+String(e.message).replaceAll("|","/")+" |");}
  }
}
lines.push("", flagged+" screenshot(s) flagged out of "+compared+" comparisons. Different clocks, dynamic content and animations can cause false positives.", "", "Visual changes are reported for human review and do not automatically fail deployment.");
const report=lines.join("\n")+"\n";
process.stdout.write(report);
if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,report);
