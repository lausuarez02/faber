/**
 * Round 12, track kit: the build kit, everything a person needs to make the device themselves:
 * what to buy (and where), what to print (and how), the tools, the steps to put it inside the
 * case, how to flash the board, and what to do when something does not work. One shape for every
 * project; get_build_kit returns it, the web "Build it" panel shows it, the files render from it.
 * (The web keeps a structural copy of these types: apps/web/src/kit/api.ts.)
 */

export interface KitLink {
  store: string;
  /** Where the store ships from / serves: "global", "US", "EU", "UK", "CN". */
  region: string;
  url: string;
  /** "product" = a page for this part; "search" = a store search for the description. */
  kind: "product" | "search";
}

export type ShopSection = "electronics" | "build" | "case";

export interface ShopLine {
  /** Stable id for checkboxes: "part:<type>|<props>" or "extra:<what>". */
  id: string;
  section: ShopSection;
  qty: number;
  /** Plain name, "LiPo battery 1S (3.7 V, with protection)". */
  name: string;
  /** The exact variant to pick on the store page: value, size, connector ("500 mAh, 503035, JST-PH 2.0"). */
  variant: string;
  /** Words to search or quote from when a link is missing or out of stock. */
  ask_for: string;
  /** Project part ids on this line ("bat", "r1 r2"); empty for extras. */
  refs: string;
  unit_usd: number | null;
  ext_usd: number | null;
  /** Typical single-unit price (part data) or a rough estimate for consumables. */
  price_note: string;
  /** First = the store the totals count it under. */
  links: KitLink[];
  /** Set when no store link is known: say so instead of inventing one. */
  no_link?: string;
  /** Other ways to get it (another store, a compatible board, any matching module). */
  alternatives: string[];
  /** Why it is on the list (consumables, the things people forget). */
  why?: string;
  /** Things most makers already have (USB cable, solder, wire): totals list them apart. */
  may_have: boolean;
  /** "catalog", "agent-made", "stand-in", "assembly", "case". */
  source: string;
}

export interface StoreTotal {
  store: string;
  lines: number;
  total_usd: number;
}

export interface Shopping {
  lines: ShopLine[];
  /** Per store (the first link of each line), not counting lines most people already have. */
  stores: StoreTotal[];
  /** Everything, may_have lines included. */
  grand_total_usd: number;
  /** What to spend when the may_have things are already at hand. */
  to_buy_usd: number;
  /** Lines without a price (counted as 0). */
  unpriced: string[];
  notes: string[];
}

export interface PrintItem {
  /** "stl/front.stl" (relative to case/). */
  file: string;
  body: string;
  /** "Front shell", "Button cap for pet". */
  label: string;
  material: string;
  color: string;
  color_hex?: string;
  /** In words: "front face on the bed (window side down), open side up". */
  orientation: string;
  supports: boolean;
  layer_mm: number;
  infill_pct: number;
  walls: number;
  /** Printed grams including about 5 % for the brim and the purge. */
  grams: number;
  minutes: number;
  /** Mesh numbers behind the estimate. */
  volume_cm3?: number;
  height_mm?: number;
  /** The STL's measured bounding box as it lies on the bed: [width x, depth y, print height z] in mm. */
  size_mm?: [number, number, number];
  /** "mesh" (estimated from the STL), "slicer:<name>" (sliced on this computer), "report" (no STL: from the case report's mass), "none". */
  source: string;
  note?: string;
}

export interface PrintPlan {
  process: "fdm" | "resin" | "injection" | "none";
  items: PrintItem[];
  /** The 3MF build plate with every body, when there is one. */
  plate?: string;
  total_grams: number;
  total_minutes: number;
  /** The formula, in words (shown under the table). */
  method: string;
  slicer: { found: boolean; name?: string; path?: string; used: boolean; why?: string };
  /** Sending the files to a print service. */
  service: { files: string[]; material: string; say: string[] };
  settings: string[];
  stale?: string;
}

export interface KitTool {
  name: string;
  why: string;
  need: "required" | "recommended" | "optional";
}

export interface KitWire {
  wire: string;
  from: string;
  to: string;
  /** "XIAO RP2040 pin 3V3", what the person sees. */
  from_label: string;
  to_label: string;
  color: string;
  length_mm: number;
  gauge_awg: number;
}

export interface KitStep {
  n: number;
  title: string;
  /** Instructions, one action per line. */
  do: string[];
  /** Picture, relative to the project (case/renders/inside.png) or a kit file. */
  image?: string;
  image_alt?: string;
  parts: string[];
  wires: KitWire[];
  cautions: string[];
  /** How to know the step worked before going on. */
  check?: string;
  /** Rough minutes for this step. */
  minutes?: number;
}

export interface FlashPlan {
  board: string;
  board_type: string;
  language: string;
  /** "uf2-drag" | "esptool" | "avrdude" | "arduino-cli" | "mpremote" | "dfu" | "stlink" | "none". */
  method: string;
  /** The firmware file in the project (firmware/main.hex) and in the downloaded kit (firmware/firmware.uf2). */
  file?: string;
  kit_file?: string;
  built: "fresh" | "stale" | "missing" | "none";
  steps: string[];
  commands: { label: string; cmd: string }[];
  /** Software to install first, with its licence when it matters. */
  needs: string[];
  /** USB cable the board takes. */
  cable?: string;
  why_missing?: string;
}

/** Round 13: how the device reaches its APIs on the real network (keys, relay, tokens, Wi-Fi, cost). */
export interface ConnectPlan {
  /** Said first when the board cannot reach the network at all (no Wi-Fi). */
  warning?: string;
  summary: string;
  /** False when no host needs a key (the device calls the APIs directly). */
  needs_relay: boolean;
  hosts: { host: string; secrets: string[]; relayed: boolean }[];
  /** Secret names with whether they are set on this machine (.env or environment); never values. */
  secrets: { name: string; hosts: string[]; set: boolean }[];
  /** Devices that have a token (names from .env RELAY_DEVICE_TOKENS). */
  devices: string[];
  steps: { title: string; do: string[]; commands?: { label: string; cmd: string }[] }[];
  /** Cost per call, in general terms, and the worst case the relay's rate limit allows. */
  cost: string[];
  notes: string[];
}

export interface TroubleRow {
  problem: string;
  why: string;
  fix: string;
  /** "fidelity", "check_design", "case", "part", "general". */
  source: string;
}

export interface BuildKit {
  project: string;
  /** "soldered" or "breadboard". */
  style: "soldered" | "breadboard";
  summary: string;
  size_mm?: { w: number; h: number; d: number };
  shopping: Shopping;
  print: PrintPlan;
  tools: { items: KitTool[]; skill: "beginner" | "intermediate" | "experienced"; skill_why: string; time: { print_h: number; build_h: number; total_h: number; note: string } };
  steps: KitStep[];
  /** "assembly-plan" when the case engine's plan was used, else "derived" (from the case report and the wiring). */
  steps_source: string;
  flash: FlashPlan;
  /** Round 13: present when the project reaches the network (fabwright.json network). */
  connect?: ConnectPlan;
  /** Round 14: battery life from each load's duty cycle (when the device has a LiPo cell). */
  power?: import("../power-budget.ts").PowerBudget;
  /** Round 15: what the case holds that is not electronics (a tin, a card deck): its room, opening and how to check the fit. */
  holds?: { id: string; name: string; object_mm: { w: number; h: number; d: number }; room_mm: { w: number; h: number; d: number }; clearance_mm: number; opening?: string; how: string; wall_mm: number; source: string; measure: string }[];
  troubleshooting: TroubleRow[];
  missing: { item: string; why: string; fix: string; say: string }[];
  /** The design check's errors and warnings about the circuit: fix them (or accept them knowingly) before buying. */
  check_first: { severity: "error" | "warning"; code: string; problem: string; why: string; fix: string }[];
  /** Region the links were picked for. */
  region: string;
}
