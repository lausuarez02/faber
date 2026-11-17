/**
 * Round 12, track kit: the shopping list. Every part of the project (from the factory BOM, so the two
 * never disagree) with its exact variant, the store links the part data has, prices and alternatives,
 * plus the things people forget, found by rules over the part data (never per project):
 * a microSD card for a part with a card slot, the mating plug for a cell's JST lead, the USB cable
 * each connector needs, wire / heat-shrink / solder / tape for a soldered build, headers and a
 * breadboard for a breadboard build, screws and inserts for a screwed case, filament for the case,
 * the magnet a reed / Hall switch senses (round 15).
 */
import { firmwareUsesCard } from "@fabwright/enclosure";
import { buildNets, type Project } from "@fabwright/project-format";
import type { PartRegistry, PartSpec } from "@fabwright/sim-core";
import { wireTotals, type WireCut } from "../assembly.ts";
import { bomLines } from "../manufacturing.ts";
import type { KitLink, ShopLine, Shopping, ShopSection, StoreTotal } from "./types.ts";

export type Region = "global" | "us" | "eu" | "uk";

/** Where a store serves from. Unknown stores are "global". */
const STORE_REGION: Record<string, string> = {
  aliexpress: "global (ships from China, 1 to 3 weeks)",
  lcsc: "global (ships from China)",
  amazon: "US",
  adafruit: "US",
  digikey: "global",
  mouser: "global",
  seeed: "global",
  "arduino store": "global",
  dfrobot: "global",
  "raspberry pi": "global (approved resellers)",
  waveshare: "global",
  st: "global",
};

const AMAZON: Record<Region, string> = { global: "www.amazon.com", us: "www.amazon.com", eu: "www.amazon.de", uk: "www.amazon.co.uk" };

function storeKey(vendor: string): string {
  const v = vendor.toLowerCase();
  for (const k of Object.keys(STORE_REGION)) if (v.startsWith(k)) return k;
  return v;
}

/** A store's name without its notes ("Amazon (search)" → "Amazon"). */
export function storeName(vendor: string): string {
  return vendor.replace(/\s*\(.*\)\s*$/, "").trim() || vendor;
}

function isSearch(url: string): boolean {
  return /[?&](k|q|keywords|keyword|search)=|\/w\/wholesale-|\/search/i.test(url);
}

/** A part's link for the region: Amazon searches move to the region's Amazon; everything else stays. */
export function regionalLink(vendor: string, url: string, region: Region): KitLink {
  const key = storeKey(vendor);
  let u = url;
  let reg = STORE_REGION[key] ?? "global";
  if (key === "amazon" && isSearch(url)) {
    u = url.replace(/^https:\/\/(www\.)?amazon\.[a-z.]+/, `https://${AMAZON[region]}`);
    reg = region === "eu" ? "EU" : region === "uk" ? "UK" : "US";
  }
  return { store: storeName(vendor), region: reg, url: u, kind: isSearch(u) ? "search" : "product" };
}

/** Store searches for words (things the part data has no link for). */
export function searchLinks(words: string, region: Region): KitLink[] {
  const q = encodeURIComponent(words.replace(/[(),]/g, " ").replace(/\s+/g, " ").trim());
  const ali = `https://www.aliexpress.com/w/wholesale-${words.replace(/[^\w.]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}.html`;
  return [
    { store: "AliExpress", region: STORE_REGION.aliexpress!, url: ali, kind: "search" },
    { store: "Amazon", region: region === "eu" ? "EU" : region === "uk" ? "UK" : "US", url: `https://${AMAZON[region]}/s?k=${q}`, kind: "search" },
  ];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "JST-PH 2.0" from a part's words, or undefined. */
export function jstOf(text: string): { family: string; pitch: string } | undefined {
  const m = /JST[- ]?(PH|SH|XH|ZH|GH)\s*([0-9.]+)?/i.exec(text);
  if (!m) return undefined;
  const fam = m[1]!.toUpperCase();
  const pitch = m[2] ?? ({ PH: "2.0", SH: "1.0", XH: "2.5", ZH: "1.5", GH: "1.25" } as Record<string, string>)[fam]!;
  return { family: `JST-${fam}`, pitch };
}

function shortName(spec: PartSpec | undefined): string {
  return spec ? spec.name.replace(/\s*\(.*\)\s*$/, "") : "part";
}

function words(spec: PartSpec | undefined): string {
  return spec ? [spec.name, spec.description, spec.footprint, spec.sourcing?.package, spec.sourcing?.generic].filter(Boolean).join(" ") : "";
}

export interface ShoppingInput {
  project: Project;
  registry: PartRegistry;
  soldered: boolean;
  cuts: WireCut[];
  region: Region;
  prefer?: string;
  /** Screws that close the case (closure "screws"). */
  screws?: { count: number; size: string; inserts: string };
  /** A part's size for its props when they change it (a LiPo's capacity picks the pouch), in words. */
  sizeOf?: (type: string, props: Record<string, unknown> | undefined) => string | undefined;
  /** Grams of filament the print list needs (0 / undefined: no case to print). */
  filament?: { grams: number; material: string; color: string };
  /** The firmware's source text (all files), when known: a board's own card slot needs a card only when it uses one. */
  firmwareText?: string;
  /** The case engine's assembly plan consumables (Kapton, the foam pad under a cell, ...): joined into the matching line, or a line of their own. */
  consumables?: { item: string; qty: number | string; why: string }[];
}

/** Which kit line a plan consumable is (by what it is, not by project); unmatched ones get a line of their own. */
const CONSUMABLE_LINE: [RegExp, string][] = [
  [/hook-?up wire|stranded wire|\bwire\b.*AWG/i, "extra:wire"],
  [/heat-?shrink/i, "extra:heat-shrink"],
  [/^solder\b/i, "extra:solder"],
  [/kapton/i, "extra:kapton"],
  [/foam tape/i, "extra:foam-tape"],
  [/\bscrews?\b/i, "extra:screws"],
  [/inserts?\b/i, "extra:inserts"],
];

export function shoppingList(inp: ShoppingInput): Shopping {
  const { project, registry, region } = inp;
  const lines: ShopLine[] = [];
  const notes: string[] = [];
  const specOf = (id: string) => registry.get(project.parts.find((p) => p.id === id)?.type ?? "")?.spec;

  // ---- the parts: the factory BOM's part lines (same grouping, values and prices)
  const bom = bomLines(project, registry, { soldered: false, cuts: [] }).filter((l) => l.source !== "assembly" && l.source !== "case");
  for (const b of bom) {
    const first = project.parts.find((p) => p.id === b.refs.split(" ")[0]);
    const spec = first ? registry.get(first.type)?.spec : undefined;
    const standIn = !!first?.standIn;
    const sized = first && !standIn ? inp.sizeOf?.(first.type, first.props) : undefined;
    const jst = jstOf(spec?.sourcing?.package ?? "");
    const pkg = sized ? `${sized}${jst ? `, ${jst.family} ${jst.pitch} lead` : ""}` : spec?.sourcing?.package;
    const variant = [b.value, standIn ? "" : pkg].filter(Boolean).join(", ") || (spec?.footprint ?? "");
    // props that pick another size (a 250 mAh cell is the 502030, not the default 503035): the part's words and its
    // store searches name the default size, so drop the default's sizes from the words and search for this variant
    const generic = sized ? withoutDefaultSize(spec?.sourcing?.generic ?? spec?.name ?? b.name) : (spec?.sourcing?.generic ?? spec?.name ?? b.name);
    const askFor = standIn ? `${first!.standIn}` : sized ? withValue(withValue(generic, b.value), sized) : withValue(generic, b.value);
    let links = standIn ? [] : (spec?.buy_links ?? []).map((l) => regionalLink(l.vendor, l.url, region));
    if (sized && !standIn) {
      const variantWords = [shortSpecName(spec?.name ?? b.name), b.value, sized.replace(/\s*\([^)]*\)/g, ""), jst?.family ?? ""].filter(Boolean).join(" ");
      const searches = searchLinks(variantWords, region);
      links = [...links.filter((l) => l.kind === "product"), ...links.filter((l) => l.kind === "search").map((l) => searches.find((x) => x.store === l.store) ?? searches[0]!).filter((l, i, a) => a.findIndex((x) => x.url === l.url) === i)];
      if (!links.length) links = searches;
    }
    if (inp.prefer) links = [...links.filter((l) => l.store.toLowerCase() === inp.prefer!.toLowerCase()), ...links.filter((l) => l.store.toLowerCase() !== inp.prefer!.toLowerCase())];
    let noLink: string | undefined;
    if (!links.length) {
      noLink = standIn ? `Fabwright simulated it with a stand-in, so it has no link for the real ${first!.standIn}: search for it by name and check its datasheet` : "The part data has no store link: these are store searches for its description";
      links = searchLinks(askFor, region);
    }
    const alternatives: string[] = [];
    if (spec?.category === "board" && spec.mcu) {
      const same = registry.list().filter((d) => d.spec.id !== spec.id && d.spec.category === "board" && d.spec.mcu?.chip === spec.mcu!.chip).map((d) => d.spec.name);
      if (same.length) alternatives.push(`Same chip, other board (the sketch keeps working; the pins and the case change): ${same.join(", ")}`);
    }
    if (spec?.sourcing?.generic && !standIn) alternatives.push(`Any module sold as: ${sized ? withValue(withValue(generic, b.value), sized) : withValue(spec.sourcing.generic, b.value)}`);
    lines.push({
      id: `part:${first?.type ?? b.name}|${b.value}|${b.refs}`,
      section: "electronics",
      qty: b.qty,
      name: b.name,
      variant,
      ask_for: askFor,
      refs: b.refs,
      unit_usd: b.unit_usd === "" ? null : b.unit_usd,
      ext_usd: b.ext_usd === "" ? null : b.ext_usd,
      price_note: b.unit_usd === "" ? "no price in the part data" : "typical single-unit price",
      links,
      ...(noLink ? { no_link: noLink } : {}),
      alternatives,
      may_have: false,
      source: b.source,
      ...(settingsWords(first, spec, b.value) ? { why: settingsWords(first, spec, b.value) } : {}),
      ...(standIn || b.source === "agent-made" ? { why: [settingsWords(first, spec, b.value), partNote(b.notes)].filter(Boolean).join(". ") } : {}),
    });
  }

  const extra = (section: ShopSection, key: string, qty: number, name: string, variant: string, askFor: string, unit: number | null, why: string, mayHave: boolean, priceNote = "rough estimate") => {
    lines.push({ id: `extra:${key}`, section, qty, name, variant, ask_for: askFor, refs: "", unit_usd: unit, ext_usd: unit === null ? null : round2(unit * qty), price_note: unit === null ? "no price" : priceNote, links: searchLinks(askFor, region), alternatives: [], why, may_have: mayHave, source: section === "case" ? "case" : "assembly" });
  };

  // ---- things people forget (rules over the part data)
  // a card slot (DFPlayer, SD modules) needs its card
  // A board with a slot (XIAO ESP32-S3 Sense) needs a card only when its firmware reads one (SD / SD_MMC / FFat on a card).
  const usesCard = inp.firmwareText === undefined || firmwareUsesCard(inp.firmwareText);
  const cardParts = project.parts.filter((p) => {
    const spec = registry.get(p.type)?.spec;
    return /micro\s?-?SD|TF card/i.test(words(spec)) && (spec?.category !== "board" || usesCard);
  });
  if (cardParts.length) extra("electronics", "microsd", cardParts.length, "microSD card", "1 to 32 GB, any class, formatted FAT32", "microSD card 8GB", 3, `${cardParts.map((p) => `${p.id} (the ${shortName(registry.get(p.type)?.spec)})`).join(", ")} read${cardParts.length > 1 ? "" : "s"} its files from it${project.parts.some((p) => registry.get(p.type)?.spec.props?.some((x) => x.id === "clips")) ? " (the sound clips: the Flash steps say how to make them)" : ""}`, true);

  // round 15: a magnet-sensing part (reed switch, Hall switch: any part with a magnet_d_mm prop)
  // needs the magnet it senses, of the size and grade the design was checked with
  const magnets = new Map<string, string[]>();
  for (const p of project.parts) {
    const spec = registry.get(p.type)?.spec;
    const def = (id: string) => p.props?.[id] ?? spec?.props?.find((x) => x.id === id)?.default;
    if (!spec?.props?.some((x) => x.id === "magnet_d_mm")) continue;
    const key = `${def("magnet_d_mm")}x${def("magnet_t_mm") ?? 2} mm ${def("magnet_grade") ?? "N35"}`;
    magnets.set(key, [...(magnets.get(key) ?? []), p.id]);
  }
  for (const [key, ids] of magnets) {
    const [size, grade] = key.split(" mm ");
    const ferrite = /ferrite/i.test(grade!);
    extra("electronics", `magnet-${size}`, ids.length, ferrite ? "Ferrite disc magnet" : "Neodymium disc magnet", `${size!.replace("x", " mm across x ")} mm thick, ${grade}, axially magnetised (a pack; one per sensor)`, ferrite ? `ferrite disc magnet ${size}mm` : `neodymium disc magnet ${size}mm ${grade}`, ferrite ? 0.3 : 0.4, `${ids.join(", ")} sense${ids.length > 1 ? "" : "s"} this magnet (its size and grade set the switching distance the design was checked with: a smaller or weaker one switches closer). Glue it to the moving side (a lid) facing the sensor, with CA glue`, false);
  }

  // a JST lead needs a mating socket on whatever it plugs into, unless that part has one
  const nets = buildNets(project);
  const neighbours = (id: string) => new Set(nets.filter((n) => n.pins.some((r) => r.part === id)).flatMap((n) => n.pins.map((r) => r.part)).filter((x) => x !== id));
  for (const p of project.parts) {
    const spec = registry.get(p.type)?.spec;
    const jst = jstOf([spec?.sourcing?.package, spec?.sourcing?.generic, spec?.footprint].filter(Boolean).join(" "));
    if (!jst || !spec) continue;
    const hasMate = [...neighbours(p.id)].some((n) => (specOf(n)?.mechanical?.features ?? []).some((f) => f.kind === "connector" && (f.connector ?? "").toLowerCase().startsWith(jst.family.toLowerCase())));
    if (hasMate) continue;
    const pins = spec.pins.filter((x) => x.type === "power" || x.type === "ground").length || 2;
    extra("electronics", `jst-${p.id}`, 1, `${jst.family} ${jst.pitch} mm socket with leads`, `${pins}-pin, female socket with ~10 cm leads (the "pigtail" that mates with ${p.id}'s plug)`, `${jst.family} ${jst.pitch}mm ${pins} pin connector with wire`, 0.5, `${p.id} (the ${shortName(spec)}) comes with a ${jst.family} plug; solder this socket where it connects, so it can be unplugged. Check the red wire goes to + on both: cells from different shops come with the plug wired either way round`, false);
  }

  // USB cables for every connector a person plugs into
  const usb = new Map<string, string[]>();
  for (const p of project.parts) for (const f of registry.get(p.type)?.spec.mechanical?.features ?? []) {
    if (f.kind !== "connector" || !/usb/i.test(f.connector ?? "")) continue;
    const k = (f.connector ?? "usb").toLowerCase();
    usb.set(k, [...(usb.get(k) ?? []), p.id]);
  }
  for (const [k, ids] of usb) {
    const label = k === "usb-c" ? "USB-C" : k === "micro-usb" ? "Micro-USB" : k === "usb-b" ? "USB-B" : k.toUpperCase();
    extra("build", `cable-${k}`, 1, `${label} cable that carries data`, `${label} to your computer's port (USB-A or USB-C); not a charge-only cable`, `${label} data cable`, 3, `to flash and charge ${ids.join(", ")}; charge-only cables (often the thin ones that came with a gadget) power the board but the computer never sees it`, true);
  }
  if (!usb.size) {
    const board = project.parts.find((p) => registry.get(p.type)?.spec.category === "board");
    if (board) extra("build", "cable-usb", 1, "USB cable that carries data", `the one that fits ${registry.get(board.type)?.spec.name ?? board.type}`, "USB data cable", 3, "to flash the board", true);
  }

  if (inp.soldered) {
    const used = [...new Set(inp.cuts.map((c) => c.color).filter((c) => c !== "any"))];
    for (const t of wireTotals(inp.cuts)) {
      const colours = [...new Set(inp.cuts.filter((c) => c.gauge_awg === t.gauge_awg).map((c) => c.color).filter((c) => c !== "any"))];
      extra("build", `wire-${t.gauge_awg}`, 1, `Silicone stranded wire ${t.gauge_awg} AWG`, `${(t.total_mm / 1000).toFixed(1)} m in total (${t.count} cuts + 20 %)${colours.length ? `; colours ${colours.join(", ")}` : ""}`, `silicone wire ${t.gauge_awg}AWG set`, 4, t.gauge_awg <= 24 ? "power and ground: carries the battery current" : "signals; thin and flexible so it folds into the case", true);
    }
    if (!inp.cuts.length && project.wires.length) extra("build", "wire", 1, "Silicone stranded wire 26 AWG", "a few colours", "silicone wire 26AWG set", 4, "for the connections", true);
    extra("build", "heat-shrink", 1, "Heat-shrink tube", "1.5 mm and 3 mm, 2:1 (an assorted kit)", "heat shrink tubing assortment", 3, "over every joint and bare resistor lead so nothing shorts when the case closes", true);
    extra("build", "solder", 1, "Solder wire", "0.6 to 0.8 mm, rosin (flux) core; lead-free or 63/37", "solder wire 0.8mm rosin core", 6, "for every connection", true);
    extra("build", "kapton", 1, "Kapton tape", "10 mm wide", "kapton tape 10mm", 3, "over bare pads and solder joints that face the battery, a metal can or another board", true);
    if (used.length > 0 && !used.includes("red")) notes.push("Wire colours come from the canvas; use red for + and black for ground on the power wires anyway, it makes mistakes easy to spot.");
  } else if (project.wires.length) {
    extra("build", "breadboard", 1, "Solderless breadboard", "830 points (full size) or 400 points", "breadboard 830", 3, "holds the parts while you wire them", true);
    extra("build", "dupont", project.wires.length, "Jumper wires (Dupont)", "20 cm, male-male and male-female (a mixed pack of 40 is plenty)", "dupont jumper wire 20cm", 0.05, "one per connection", true);
    const modules = project.parts.filter((p) => ["display", "sensor", "power", "audio", "actuator", "comms"].includes(registry.get(p.type)?.spec.category ?? "") && (registry.get(p.type)?.spec.pins.length ?? 0) > 2);
    if (modules.length) extra("build", "headers", 1, "Male header pins 2.54 mm", "one 40-pin strip (break it to length)", "male header 2.54mm 40 pin", 1, `many modules (${modules.map((m) => m.id).join(", ")}) ship with their pins loose: solder them on to plug into the breadboard`, true);
  }

  if (project.enclosure) {
    extra("case", "foam-tape", 1, "Double-sided foam tape", "1 mm thick, 10 mm wide", "double sided foam tape 1mm", 2, "holds the modules that have no screw post inside the case", true);
    if (inp.screws) {
      extra("case", "screws", inp.screws.count, "Screw", inp.screws.size, "M2 x 6mm screw", 0.05, "closes the case", true, "a pack of 50 costs about 3 USD");
      extra("case", "inserts", inp.screws.count, "Heat-set insert", inp.screws.inserts, "M2 x 3mm brass heat set insert", 0.08, "pressed into the front shell with a soldering iron; the screws bite into them", false, "a pack of 50 costs about 4 USD");
    }
    if (inp.filament && inp.filament.grams > 0) {
      const g = Math.ceil(inp.filament.grams);
      lines.push({ id: "extra:filament", section: "case", qty: 1, name: `${inp.filament.material} filament`, variant: `${inp.filament.color}, 1.75 mm; this case uses about ${g} g`, ask_for: `${inp.filament.material} filament 1.75mm ${inp.filament.color}`, refs: "", unit_usd: round2(g * 0.022), ext_usd: round2(g * 0.022), price_note: "the grams it uses at about 22 USD per kg spool (a whole spool costs 15 to 25 USD)", links: searchLinks(`${inp.filament.material} filament 1.75mm ${inp.filament.color}`, region), alternatives: ["A print service prints it for you instead (see the print list): skip the filament then"], why: "only if you print it yourself", may_have: true, source: "case" });
    }
  }

  // ---- the assembly plan's consumables: its reason joins the matching line; what the kit had no line for gets one
  for (const c of inp.consumables ?? []) {
    const key = CONSUMABLE_LINE.find(([re]) => re.test(c.item))?.[1];
    const awg = /(\d+)\s*AWG/i.exec(c.item)?.[1];
    const line = key ? (lines.find((l) => awg && l.id === `${key}-${awg}`) ?? lines.find((l) => l.id === key || l.id.startsWith(`${key}-`))) : undefined;
    if (line) {
      if (!(line.why ?? "").includes(c.why)) line.why = [line.why, `the assembly plan: ${c.why} (${c.qty})`].filter(Boolean).join("; ");
      continue;
    }
    if (key) continue; // e.g. screws on a snap-fit case: the kit's own rules decided there is nothing to buy
    const slug = c.item.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    extra("build", `plan-${slug}`, 1, c.item, String(c.qty), c.item.replace(/\s*\(.*?\)/g, ""), 2, c.why, false);
  }

  lines.forEach((l) => {
    if (!l.links.length && !l.no_link) l.no_link = "No store link known";
  });

  // ---- totals
  const by = new Map<string, StoreTotal>();
  for (const l of lines) {
    if (l.may_have) continue;
    const store = l.links[0]?.store ?? "Any store";
    const t = by.get(store) ?? { store, lines: 0, total_usd: 0 };
    t.lines++;
    t.total_usd = round2(t.total_usd + (l.ext_usd ?? 0));
    by.set(store, t);
  }
  const grand = round2(lines.reduce((a, l) => a + (l.ext_usd ?? 0), 0));
  const toBuy = round2(lines.filter((l) => !l.may_have).reduce((a, l) => a + (l.ext_usd ?? 0), 0));
  const unpriced = lines.filter((l) => l.ext_usd === null).map((l) => l.name);
  notes.push("Prices are typical single-unit prices in USD from the part data (consumables are rough estimates); shipping and tax are not included. Small parts (resistors, diodes) usually come in packs of 10 or more.");
  if (lines.some((l) => l.links.some((k) => k.store === "AliExpress"))) notes.push("AliExpress is cheapest but takes 1 to 3 weeks; Amazon / DigiKey / Adafruit arrive in days for a few dollars more.");
  return { lines, stores: [...by.values()].sort((a, b) => b.total_usd - a.total_usd), grand_total_usd: grand, to_buy_usd: toBuy, unpriced, notes };
}

/** The settings a part was designed with, in words ("Charge current: 400 mA"), leaving out defaults and what the variant already says. */
function settingsWords(p: { props?: Record<string, unknown> } | undefined, spec: PartSpec | undefined, value: string): string {
  if (!p?.props || !spec?.props) return "";
  const out: string[] = [];
  for (const [k, v] of Object.entries(p.props)) {
    const def = spec.props.find((d) => d.id === k);
    if (!def || def.type === "text" || v === def.default || v === undefined || v === null) continue;
    // the props the value is made of ("100k" is the resistance) are already in the variant
    if (value && ["resistance", "capacitance", "inductance", "capacity", "value", "model", "variant", "chip"].includes(k)) continue;
    const unit = (def as { unit?: string }).unit ?? "";
    const val = `${v}${unit && unit !== "×" ? ` ${unit}` : ""}`;
    if (value && (value.includes(String(v)) || value.replace(/\s/g, "").includes(val.replace(/\s/g, "")))) continue;
    const usual = def.default === undefined || def.default === null || typeof def.default === "boolean" ? "" : ` (it usually comes set to ${def.default}${unit && unit !== "×" ? ` ${unit}` : ""}: change it before first use)`;
    // how to set it on the real part, when the part data says (a resistor to swap, a jumper to bridge, a trimmer)
    const how = def.type === "number" && def.description && /\b(set by|resistor|R_?PROG|jumper|solder pad|bridge|trimmer|potentiometer|DIP)\b/i.test(def.description) ? ` How: ${def.description.replace(/\.?\s*$/, ".")}` : "";
    out.push(`${def.label}: ${val}${def.type === "number" ? usual : ""}${how}`);
  }
  return out.length ? `Set up as: ${out.join("; ")}` : "";
}

function partNote(notes: string): string {
  return notes.split("; ").filter((n) => !/^[\w.]+=/.test(n)).join("; ");
}

/** "LiPo 3.7 V 1S pouch cell, JST-PH 2.0 lead (503035 for 500 mAh)" → without the parenthesis naming the default size. */
function withoutDefaultSize(words: string): string {
  return words.replace(/\s*\([^)]*\b\d+(?:\.\d+)?\s*(?:mAh|mm|in|")[^)]*\)/gi, "").trim();
}

/** "LiPo battery 1S (3.7 V, with protection)" → "LiPo battery 1S". */
function shortSpecName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, "");
}

function withValue(generic: string, value: string): string {
  if (!value) return generic;
  return /\(value as in the BOM\)/.test(generic) ? generic.replace(/\(value as in the BOM\)/, value) : generic.includes(value) ? generic : `${generic}, ${value}`;
}

/** SHOPPING.csv: one row per line and link (a line with three stores has three rows; qty and prices on the first). */
export function shoppingCsv(s: Shopping): string {
  const q = (v: unknown) => {
    const t = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const cols = ["section", "qty", "name", "variant", "ask_for", "refs", "unit_usd", "ext_usd", "store", "store_region", "link_kind", "url", "no_link", "may_already_have", "why"];
  const rows = [cols.join(",")];
  for (const l of s.lines) {
    const links = l.links.length ? l.links : [undefined];
    links.forEach((k, i) => rows.push([l.section, i ? "" : l.qty, l.name, l.variant, l.ask_for, l.refs, i ? "" : (l.unit_usd ?? ""), i ? "" : (l.ext_usd ?? ""), k?.store ?? "", k?.region ?? "", k?.kind ?? "", k?.url ?? "", i ? "" : (l.no_link ?? ""), l.may_have ? "yes" : "", i ? "" : (l.why ?? "")].map(q).join(",")));
  }
  return rows.join("\n") + "\n";
}
