/**
 * Round 12, track kit: the build kit on disk. <project>/build-kit/<slug>-kit/ (+ .zip next to it):
 * kit.html (everything, pictures inlined), kit.pdf (when Playwright's Chromium is there), KIT.md,
 * SHOPPING.md / SHOPPING.csv, PRINT-LIST.md, case/ (the files to print and the renders), firmware/
 * (the file to flash) and sd-card/ (clips) when the project has them.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { hexToUf2 } from "@jumper/sim-backends";
import { fail } from "../errors.ts";
import { clearDir, writeText, zipFolder } from "../manufacturing.ts";
import { projectSlug } from "../projects-registry.ts";
import { loadPlaywright } from "../screenshot.ts";
import type { ProjectSession } from "../session.ts";
import { sdCardFiles } from "../voice.ts";
import { relayPack } from "@jumper/device-net";
import { networkConfigOf } from "../device-network.ts";
import { kitHtml, kitMarkdown, printListMd, shoppingMd } from "./render.ts";
import { shoppingCsv } from "./shopping.ts";
import type { BuildKit } from "./types.ts";

/** Pictures the kit refers to (case/renders/*.png), as data: URIs for the self-contained page. */
export function kitImages(projectDir: string, kit: BuildKit): Record<string, string> {
  const want = new Set<string>(["case/renders/front.png", ...kit.steps.flatMap((s) => (s.image ? [s.image] : []))]);
  const out: Record<string, string> = {};
  for (const rel of want) {
    const abs = resolve(projectDir, rel);
    if (relative(projectDir, abs).startsWith("..") || !existsSync(abs)) continue;
    const ext = rel.split(".").pop()!.toLowerCase();
    const type = ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : undefined;
    if (!type) continue;
    out[rel] = `data:${type};base64,${readFileSync(abs).toString("base64")}`;
  }
  return out;
}

let pdfBroken: string | undefined;
/** The page printed to PDF with Playwright's Chromium, when it is installed. */
export async function htmlToPdf(html: string): Promise<{ pdf?: Uint8Array; why?: string }> {
  if (process.env.JUMPER_CASE_PDF === "0") return { why: "PDF output is turned off (JUMPER_CASE_PDF=0)" };
  if (pdfBroken) return { why: pdfBroken };
  const pw = loadPlaywright();
  if (!pw) return { why: "Playwright is not installed" };
  try {
    const browser = await pw.chromium.launch();
    try {
      const page = (await browser.newPage()) as unknown as { setContent(h: string, o?: object): Promise<void>; emulateMedia(o: object): Promise<void>; pdf(o: object): Promise<Buffer> };
      await page.emulateMedia({ media: "print", colorScheme: "light" });
      await page.setContent(html, { waitUntil: "load" });
      const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" } });
      return { pdf: new Uint8Array(pdf) };
    } finally {
      await browser.close();
    }
  } catch (e) {
    pdfBroken = `Playwright's Chromium could not print (${(e as Error).message.split("\n")[0]})`;
    return { why: pdfBroken };
  }
}

export interface KitFiles {
  dir: string;
  zip?: string;
  zip_bytes?: number;
  html: string;
  pdf?: string;
  markdown: string;
  csv: string;
  files: string[];
  missing: { item: string; why: string; fix: string; say: string }[];
}

/** Write the kit's files. `into` (a folder) writes them there flat (the factory pack's build-kit/); otherwise <project>/build-kit/<slug>-kit/ + zip. */
export async function writeKitFiles(s: ProjectSession, kit: BuildKit, o: { into?: string; zip?: boolean; pdf?: boolean; firmware?: boolean; caseFiles?: boolean } = {}): Promise<KitFiles> {
  const slug = projectSlug(kit.project);
  const outRoot = join(s.dir, "build-kit");
  const root = o.into ?? join(outRoot, `${slug}-kit`);
  if (!o.into && relative(s.dir, root).startsWith("..")) fail("bad-arg", "The kit folder must be inside the project", `${root} is outside ${s.dir}`, "use the default folder");
  clearDir(root);
  const missing: KitFiles["missing"] = [...kit.missing];
  const files: string[] = [];
  const put = (rel: string, data: string | Uint8Array) => {
    writeText(root, rel, data);
    files.push(rel);
  };
  // case files to print + renders (the kit's paths: case/...)
  if (o.caseFiles !== false) {
    for (const i of kit.print.items) {
      const abs = join(s.dir, "case", i.file);
      if (existsSync(abs)) put(`case/${i.file}`, readFileSync(abs));
    }
    if (kit.print.plate && existsSync(join(s.dir, "case", kit.print.plate))) put(`case/${kit.print.plate}`, readFileSync(join(s.dir, "case", kit.print.plate)));
    for (const r of ["front", "back", "inside", "exploded"]) {
      const abs = join(s.dir, "case", "renders", `${r}.png`);
      if (existsSync(abs)) put(`case/renders/${r}.png`, readFileSync(abs));
    }
    // the steps' own pictures (the case engine's assembly plan: case/assembly/step-NN.png)
    for (const img of new Set(kit.steps.flatMap((st) => (st.image?.startsWith("case/") && !st.image.startsWith("case/renders/") ? [st.image] : [])))) {
      const abs = resolve(s.dir, img);
      if (!relative(s.dir, abs).startsWith("..") && existsSync(abs)) put(img, readFileSync(abs));
    }
  }
  // the file to flash
  if (o.firmware !== false && kit.flash.method !== "none" && kit.flash.kit_file) {
    if (kit.flash.language === "micropython") {
      const abs = join(s.dir, "firmware", "main.py");
      if (existsSync(abs)) put("firmware/main.py", readFileSync(abs));
    } else {
      const dev = await s.deviceFirmware();
      if ("data" in dev) {
        if (dev.format === "bin") put("firmware/firmware.bin", dev.data as Uint8Array);
        else {
          put("firmware/firmware.hex", dev.data as string);
          if (kit.flash.kit_file.endsWith(".uf2")) put("firmware/firmware.uf2", hexToUf2(dev.data as string));
        }
      } else if (!missing.some((m) => m.item === "firmware file")) missing.push({ item: "firmware file", why: dev.error, fix: dev.fix, say: "press Run (or Build), then download the kit again" });
    }
  }
  if (!o.into) for (const [p, text] of Object.entries(sdCardFiles(s.project, s.registry))) put(`sd-card/${p}`, text);
  // round 13: the relay the Connect section sets up (the factory pack has it at ../relay already)
  if (!o.into && kit.connect?.needs_relay) {
    try {
      for (const [p, text] of Object.entries(relayPack(networkConfigOf(s.project), s.project.name))) put(`relay/${p}`, text);
    } catch {
      // a bad network config is reported by the Connect section's own checks
    }
  }
  const html = kitHtml(kit, kitImages(s.dir, kit));
  put("kit.html", html);
  put("KIT.md", kitMarkdown(kit));
  put("SHOPPING.md", shoppingMd(kit));
  put("SHOPPING.csv", shoppingCsv(kit.shopping));
  put("PRINT-LIST.md", printListMd(kit));
  let pdf: string | undefined;
  if (o.pdf !== false) {
    const r = await htmlToPdf(html);
    if (r.pdf) {
      put("kit.pdf", r.pdf);
      pdf = join(root, "kit.pdf");
    } else missing.push({ item: "kit.pdf", why: r.why ?? "no PDF printer", fix: "pnpm --filter @jumper/web exec playwright install chromium, then make the kit again (kit.html prints to PDF from any browser)", say: "open kit.html and print it to PDF from the browser" });
  }
  let zip: string | undefined;
  if (o.zip !== false && !o.into) {
    zip = join(outRoot, `${slug}-kit.zip`);
    writeFileSync(zip, zipFolder(root, `${slug}-kit`));
  }
  return { dir: root, ...(zip ? { zip, zip_bytes: statSync(zip).size } : {}), html: join(root, "kit.html"), ...(pdf ? { pdf } : {}), markdown: join(root, "KIT.md"), csv: join(root, "SHOPPING.csv"), files, missing };
}
