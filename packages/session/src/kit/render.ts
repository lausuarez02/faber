/**
 * Round 12, track kit: the build kit as files a person reads: KIT.md (everything), SHOPPING.md /
 * SHOPPING.csv, PRINT-LIST.md, and one self-contained kit.html (pictures inlined, ticks remembered
 * in the browser, prints to PDF). Plain words, no tool names.
 */
import type { BuildKit, KitStep, ShopLine } from "./types.ts";
import { shoppingCsv } from "./shopping.ts";

const usd = (n: number | null) => (n === null ? "–" : `$${n.toFixed(2)}`);
const h = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const mdCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

const SECTION: Record<string, string> = { electronics: "Electronics", build: "For the build", case: "For the case" };

export function shoppingMd(k: BuildKit): string {
  const out = [`# Shopping list: ${k.project}`, ""];
  for (const sec of ["electronics", "build", "case"] as const) {
    const lines = k.shopping.lines.filter((l) => l.section === sec);
    if (!lines.length) continue;
    out.push(`## ${SECTION[sec]}`, "", "| ✓ | Qty | What | Exact variant | Where | Price |", "| --- | --- | --- | --- | --- | --- |");
    for (const l of lines) {
      const where = l.links.map((x) => `[${x.store}${x.kind === "search" ? " (search)" : ""}](${x.url})`).join(" · ");
      out.push(`| [ ] | ${l.qty} | **${mdCell(l.name)}**${l.refs ? ` (${l.refs})` : ""}${l.may_have ? " *(you may have it)*" : ""}${l.why ? `<br>${mdCell(l.why)}` : ""} | ${mdCell(l.variant || l.ask_for)} | ${where}${l.no_link ? `<br>*${mdCell(l.no_link)}*` : ""} | ${usd(l.ext_usd)} |`);
    }
    out.push("");
  }
  out.push("## Totals", "", "| Store | Lines | Total |", "| --- | --- | --- |", ...k.shopping.stores.map((s) => `| ${s.store} | ${s.lines} | ${usd(s.total_usd)} |`), `| **To buy** | | **${usd(k.shopping.to_buy_usd)}** |`, `| Everything, with what you may already have | | ${usd(k.shopping.grand_total_usd)} |`, "");
  const alts = k.shopping.lines.filter((l) => l.alternatives.length);
  if (alts.length) {
    out.push("## Alternatives", "");
    for (const l of alts) out.push(`- **${l.name}**: ${l.alternatives.join("; ")}`);
    out.push("");
  }
  out.push(...k.shopping.notes.map((n) => `> ${n}`), "");
  return out.join("\n");
}

export function printListMd(k: BuildKit): string {
  const p = k.print;
  const out = [`# What to print: ${k.project}`, ""];
  if (p.stale) out.push(`> **${p.stale}**`, "");
  if (!p.items.length) {
    out.push("Nothing to print yet: the project has no case.", "");
    return out.join("\n");
  }
  out.push("| ✓ | File | Material | Colour | Lay it | Supports | Layer | Infill | About | Time |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const i of p.items) out.push(`| [ ] | case/${i.file} (${i.label}) | ${i.material} | ${i.color}${i.color_hex ? ` ${i.color_hex}` : ""} | ${mdCell(i.orientation)} | ${i.supports ? "yes" : "no"} | ${i.layer_mm} mm | ${i.infill_pct} % | ${i.grams} g | ${fmtMin(i.minutes)} |`);
  out.push("", `Total about **${Math.round(p.total_grams)} g** and **${fmtMin(p.total_minutes)}**.${p.plate ? ` Or open \`case/${p.plate}\`: one build plate with every part already laid out.` : ""}`, "", `*${p.method}*`, "");
  if (p.slicer.why) out.push(`> ${p.slicer.why}`, "");
  out.push("## Settings", "", ...p.settings.map((s) => `- ${s}`), "", "## Or send it to a print service", "", ...p.service.say.map((s) => `- ${s}`), "");
  return out.join("\n");
}

export function fmtMin(m: number): string {
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

function stepMd(s: KitStep): string[] {
  const out = [`### ${s.n}. ${s.title}`, ""];
  if (s.image) out.push(`![${s.image_alt ?? s.title}](${s.image})`, "");
  out.push(...s.do.map((d) => `- ${d}`));
  if (s.wires.length) {
    out.push("", "| ✓ | Wire | From | To | Colour | Cut | Gauge |", "| --- | --- | --- | --- | --- | --- | --- |", ...s.wires.map((w) => `| [ ] | ${w.wire} | ${mdCell(w.from_label)} | ${mdCell(w.to_label)} | ${w.color} | ${w.length_mm} mm | ${w.gauge_awg} AWG |`));
  }
  for (const c of s.cautions) out.push("", `> ⚠ ${c}`);
  if (s.check) out.push("", `**Check before going on:** ${s.check}`);
  out.push("");
  return out;
}

export function kitMarkdown(k: BuildKit): string {
  const out = [`# Build it yourself: ${k.project}`, "", k.summary, ""];
  if (k.missing.length) out.push("## Not ready yet", "", ...k.missing.map((m) => `- **${m.item}**: ${m.why}. To fix it: ${m.say}.`), "");
  out.push(shoppingMd(k).replace(/^# .*\n/, "## Buy\n").replace(/^## /gm, "### ").replace(/^### Buy/m, "## Buy"));
  out.push("## Tools", "", ...k.tools.items.map((t) => `- [ ] **${t.name}** (${t.need}): ${t.why}`), "", `**Skill:** ${k.tools.skill_why}`, "", `**Time:** ${k.tools.time.note}`, "");
  out.push(printListMd(k).replace(/^# .*\n/, "## Print\n").replace(/^## (?!Print)/gm, "### "));
  out.push("## Assemble", "", ...k.steps.flatMap(stepMd));
  out.push(...flashMd(k));
  out.push("## If something does not work", "", "| Problem | Why | Fix |", "| --- | --- | --- |", ...k.troubleshooting.map((t) => `| ${mdCell(t.problem)} | ${mdCell(t.why)} | ${mdCell(t.fix)} |`), "");
  return out.join("\n");
}

function flashMd(k: BuildKit): string[] {
  const f = k.flash;
  const out = ["## Flash", "", `Board: **${f.board}**${f.kit_file ? `. File: \`${f.kit_file}\` in this kit (made from \`${f.file}\` in the project)` : ""}.`, ""];
  if (f.why_missing) out.push(`> ${f.why_missing}.`, "");
  out.push(...f.steps.map((s, i) => `${i + 1}. ${s}`), "");
  for (const c of f.commands) out.push(`${c.label}:`, "", "```sh", c.cmd, "```", "");
  if (f.needs.length) out.push(`You need: ${f.needs.map((n) => n.replace(/\.$/, "")).join("; ")}.`, "");
  return out;
}

/** The whole kit as one CSV (the shopping list; the other parts are tables in KIT.md). */
export function kitCsv(k: BuildKit): string {
  return shoppingCsv(k.shopping);
}

const CSS = `
:root{--bg:#fbfaf7;--fg:#1b1d21;--muted:#5d636d;--line:#e2ded6;--card:#ffffff;--accent:#2f6f4f;--warn:#9a5b00;--warnbg:#fff6e5;--bad:#a12a2a}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121417;--fg:#e8e6e1;--muted:#9aa1ab;--line:#2a2e35;--card:#1a1d22;--accent:#7cc79f;--warn:#f1b65a;--warnbg:#2a2214;--bad:#ff8a80}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:20px;margin:36px 0 10px;padding-top:8px;border-top:1px solid var(--line)}h3{font-size:16px;margin:22px 0 8px}
p,li{max-width:72ch}.muted{color:var(--muted)}.summary{font-size:16px}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}nav a{border:1px solid var(--line);border-radius:999px;padding:4px 12px;text-decoration:none;color:var(--fg);background:var(--card)}
.table{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;min-width:560px}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}tr:last-child td{border-bottom:0}
td.num{white-space:nowrap;text-align:right}a{color:var(--accent);word-break:break-word}
.why{color:var(--muted);font-size:13px}.tag{display:inline-block;font-size:11px;border:1px solid var(--line);border-radius:6px;padding:0 6px;margin-left:4px;color:var(--muted)}
.box{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--card);margin:12px 0}
.warn{background:var(--warnbg);border-color:var(--warn)}.warn b{color:var(--warn)}
.step{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:14px;margin:14px 0}.step h3,.step img,.check,.caution{break-inside:avoid;break-after:auto}.step h3{break-after:avoid}
.step h3{margin-top:0}.step img{max-width:100%;max-height:340px;display:block;margin:6px 0 10px;border-radius:8px;background:#0d0f12}
.check{border-left:3px solid var(--accent);padding:4px 10px;margin-top:10px}.caution{border-left:3px solid var(--warn);padding:4px 10px;margin-top:8px}
pre{background:#0d0f12;color:#e8e6e1;padding:10px 12px;border-radius:8px;overflow-x:auto;font-size:13px;white-space:pre-wrap;word-break:break-all}
input[type=checkbox]{width:18px;height:18px;vertical-align:middle}
.totals td{font-weight:600}
@media print{nav,.noprint{display:none}body{background:#fff;color:#000}.table,.step,.box{border-color:#bbb}a{color:#000}pre{background:#f2f2f2;color:#000}h2{break-after:avoid}}
`;

/** One self-contained page (pictures as data: URIs from `images`, keyed by their kit path). */
export function kitHtml(k: BuildKit, images: Record<string, string> = {}): string {
  const cb = (id: string) => `<input type="checkbox" data-tick="${h(id)}" aria-label="Done">`;
  const linkHtml = (l: ShopLine) => l.links.map((x) => `<a href="${h(x.url)}" rel="noopener">${h(x.store)}</a>${x.kind === "search" ? '<span class="tag">search</span>' : ""}`).join(" · ");
  const shop = (["electronics", "build", "case"] as const)
    .map((sec) => {
      const lines = k.shopping.lines.filter((l) => l.section === sec);
      if (!lines.length) return "";
      return `<h3>${SECTION[sec]}</h3><div class="table"><table><thead><tr><th></th><th>Qty</th><th>What</th><th>Exact variant</th><th>Where</th><th>Price</th></tr></thead><tbody>${lines
        .map(
          (l) =>
            `<tr><td>${cb(`buy:${l.id}`)}</td><td class="num">${l.qty}</td><td><b>${h(l.name)}</b>${l.refs ? ` <span class="muted">(${h(l.refs)})</span>` : ""}${l.may_have ? '<span class="tag">you may have it</span>' : ""}${l.why ? `<div class="why">${h(l.why)}</div>` : ""}</td><td>${h(l.variant || l.ask_for)}</td><td>${linkHtml(l)}${l.no_link ? `<div class="why">${h(l.no_link)}</div>` : ""}</td><td class="num">${usd(l.ext_usd)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`;
    })
    .join("");
  const totals = `<div class="table"><table class="totals"><tbody>${k.shopping.stores.map((s) => `<tr><td>${h(s.store)}</td><td class="num">${s.lines} line${s.lines > 1 ? "s" : ""}</td><td class="num">${usd(s.total_usd)}</td></tr>`).join("")}<tr><td>To buy</td><td></td><td class="num">${usd(k.shopping.to_buy_usd)}</td></tr><tr><td class="muted">Everything, with what you may already have</td><td></td><td class="num muted">${usd(k.shopping.grand_total_usd)}</td></tr></tbody></table></div>`;
  const alts = k.shopping.lines.filter((l) => l.alternatives.length);
  const p = k.print;
  const printSec = p.items.length
    ? `${p.stale ? `<div class="box warn"><b>${h(p.stale)}</b></div>` : ""}<div class="table"><table><thead><tr><th></th><th>File</th><th>Material, colour</th><th>Lay it</th><th>Supports</th><th>Layer / infill</th><th>About</th></tr></thead><tbody>${p.items
        .map((i) => `<tr><td>${cb(`print:${i.file}`)}</td><td><b>${h(i.label)}</b><div class="why">case/${h(i.file)}</div></td><td>${h(i.material)}, ${h(i.color)}${i.color_hex ? ` <span class="muted">${h(i.color_hex)}</span>` : ""}</td><td>${h(i.orientation)}</td><td>${i.supports ? "yes" : "no"}</td><td>${i.layer_mm} mm, ${i.infill_pct} %</td><td class="num">${i.grams} g<br>${fmtMin(i.minutes)}</td></tr>`)
        .join("")}</tbody></table></div><p>Total about <b>${Math.round(p.total_grams)} g</b> and <b>${fmtMin(p.total_minutes)}</b>.${p.plate ? ` Or open <code>case/${h(p.plate)}</code>: one build plate with every part already laid out.` : ""}</p><p class="why">${h(p.method)}</p>${p.slicer.why ? `<p class="why">${h(p.slicer.why)}</p>` : ""}<h3>Settings</h3><ul>${p.settings.map((s) => `<li>${h(s)}</li>`).join("")}</ul><h3>Or send it to a print service</h3><ul>${p.service.say.map((s) => `<li>${h(s)}</li>`).join("")}</ul>`
    : `<p class="muted">Nothing to print yet: the project has no case.</p>`;
  const steps = k.steps
    .map((s) => {
      const src = s.image ? images[s.image] : undefined;
      return `<section class="step" id="step-${s.n}"><h3>${cb(`step:${s.n}`)} ${s.n}. ${h(s.title)}${s.minutes ? ` <span class="tag">about ${s.minutes} min</span>` : ""}</h3>${src ? `<img src="${src}" alt="${h(s.image_alt ?? s.title)}">` : ""}<ul>${s.do.map((d) => `<li>${h(d)}</li>`).join("")}</ul>${
        s.wires.length
          ? `<div class="table"><table><thead><tr><th></th><th>Wire</th><th>From</th><th>To</th><th>Colour</th><th>Cut</th></tr></thead><tbody>${s.wires.map((w) => `<tr><td>${cb(`wire:${s.n}:${w.wire}`)}</td><td>${h(w.wire)}</td><td>${h(w.from_label)}</td><td>${h(w.to_label)}</td><td>${h(w.color)}</td><td class="num">${w.length_mm} mm<br><span class="muted">${w.gauge_awg} AWG</span></td></tr>`).join("")}</tbody></table></div>`
          : ""
      }${s.cautions.map((c) => `<div class="caution"><b>Careful:</b> ${h(c)}</div>`).join("")}${s.check ? `<div class="check"><b>Check before going on:</b> ${h(s.check)}</div>` : ""}</section>`;
    })
    .join("");
  const f = k.flash;
  const flash = `<p>Board: <b>${h(f.board)}</b>${f.kit_file ? `. File: <code>${h(f.kit_file)}</code> in the download (made from <code>${h(f.file ?? "")}</code> in the project)` : ""}. Cable: ${h(f.cable ?? "USB data cable")}.</p>${f.why_missing ? `<div class="box warn"><b>${h(f.why_missing)}.</b></div>` : ""}<ol>${f.steps.map((s) => `<li>${h(s)}</li>`).join("")}</ol>${f.commands.map((c) => `<p>${h(c.label)}:</p><pre>${h(c.cmd)}</pre>`).join("")}${f.needs.length ? `<p class="why">You need: ${h(f.needs.map((n) => n.replace(/\.$/, "")).join("; "))}.</p>` : ""}`;
  const groups: [string, (s: string) => boolean][] = [["Common problems", (s) => s === "general" || s === "part" || s === "case"], ["What Jumper's checks said", (s) => s === "check_design"], ["Check on the real device", (s) => s === "fidelity"]];
  const trouble = groups
    .map(([title, f2]) => {
      const rows = k.troubleshooting.filter((t) => f2(t.source));
      if (!rows.length) return "";
      return `<h3>${h(title)}</h3><div class="table"><table><thead><tr><th>Problem</th><th>Why</th><th>Fix</th></tr></thead><tbody>${rows.map((t) => `<tr><td><b>${h(t.problem)}</b></td><td>${h(t.why)}</td><td>${h(t.fix)}</td></tr>`).join("")}</tbody></table></div>`;
    })
    .join("");
  const missing = k.missing.length ? `<div class="box warn"><b>Not ready yet</b><ul>${k.missing.map((m) => `<li><b>${h(m.item)}</b>: ${h(m.why)}. To fix it: ${h(m.say)}.</li>`).join("")}</ul></div>` : "";
  const hero = images["case/renders/front.png"] ? `<img src="${images["case/renders/front.png"]}" alt="The finished case" style="max-width:280px;width:100%;border-radius:12px;background:#0d0f12;float:right;margin:0 0 12px 16px">` : "";
  const key = `jumper-kit:${k.project}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(k.project)} build kit</title><style>${CSS}</style></head><body><main>
${hero}<h1>Build it yourself: ${h(k.project)}</h1><p class="summary">${h(k.summary)}</p>
<nav class="noprint"><a href="#buy">Buy</a><a href="#tools">Tools</a><a href="#print">Print</a><a href="#assemble">Assemble</a><a href="#flash">Flash</a><a href="#help">If it does not work</a></nav>${missing}
<h2 id="buy">1. Buy</h2>${shop}<h3>Totals</h3>${totals}${alts.length ? `<h3>Alternatives</h3><ul>${alts.map((l) => `<li><b>${h(l.name)}</b>: ${l.alternatives.map((a) => h(a)).join("; ")}</li>`).join("")}</ul>` : ""}${k.shopping.notes.map((n) => `<p class="why">${h(n)}</p>`).join("")}
<h2 id="tools">2. Tools</h2><ul>${k.tools.items.map((t) => `<li>${cb(`tool:${t.name}`)} <b>${h(t.name)}</b> <span class="tag">${t.need}</span> <span class="why">${h(t.why)}</span></li>`).join("")}</ul><p><b>Skill:</b> ${h(k.tools.skill_why)}</p><p><b>Time:</b> ${h(k.tools.time.note)}</p>
<h2 id="print">3. Print</h2>${printSec}
<h2 id="assemble">4. Assemble</h2>${steps}
<h2 id="flash">5. Flash</h2>${flash}
<h2 id="help">If something does not work</h2>${trouble}
<p class="why">Made by Jumper. Ticks are remembered in this browser only.</p>
</main><script>(function(){var K=${JSON.stringify(key)};var s={};try{s=JSON.parse(localStorage.getItem(K)||"{}")||{}}catch(e){s={}}document.querySelectorAll("input[data-tick]").forEach(function(c){var id=c.getAttribute("data-tick");c.checked=!!s[id];c.addEventListener("change",function(){s[id]=c.checked;try{localStorage.setItem(K,JSON.stringify(s))}catch(e){}})})})();</script></body></html>`;
}
