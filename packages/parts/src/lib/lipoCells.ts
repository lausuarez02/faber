// Round 17: common flat 1S LiPo pouch cells, the sizes a thin case is planned around. The code is
// thickness in tenths of a mm, then width and length in mm (503035 = 5.0 x 30 x 35 mm, 523450 =
// 5.2 x 34 x 50 mm). Capacities are typical rated figures from cell makers' and
// distributors' tables; the same code is sold from about -15 % to +20 % of them (and some listings
// overstate wildly), so a design reads the cell actually bought. Sizes exclude the protection board
// and leads: allow about 3 mm at the lead end and 10 % swell in thickness (the case adds it).
//
// Sources: PowerStream LiPo catalog (powerstream.com/wp/li-pol: 401730 150 mAh, 402030 190 mAh,
// 502030 250 mAh, 603030 480 mAh), a cell maker's model list (mikrocontroller.net attachment 102205:
// 402030 200-210 mAh, 502030 250 / 240 mAh), Adafruit 1578 (500 mAh, 29 x 36 x 4.75 mm, a 503035
// class cell), the round 15 build's 503035 500 mAh cell (amazon.it B0CSS46BMW) and common 523450
// 1000 mAh listings.

export interface LipoPouchCell {
  /** Thickness / width / length code, e.g. "402030". */
  code: string;
  /** Typical rated capacity, mAh. */
  mAh: number;
  /** Width (along the leads' edge), length and thickness in mm, the cell body without its protection board. */
  w: number;
  h: number;
  d: number;
  /** Typical mass, g. */
  mass_g: number;
  /** Where the figures come from. */
  source: string;
}

export const LIPO_POUCH_CELLS: readonly LipoPouchCell[] = [
  { code: "401730", mAh: 150, w: 17, h: 30, d: 4, mass_g: 3, source: "PowerStream catalog (150 mAh, 2.8 g); other makers list 160-180 mAh" },
  { code: "402030", mAh: 190, w: 20, h: 30, d: 4, mass_g: 4, source: "PowerStream catalog (190 mAh, 3.8 g); other makers 180-210 mAh" },
  { code: "502030", mAh: 250, w: 20, h: 30, d: 5, mass_g: 5, source: "PowerStream catalog (250 mAh, 5 g); maker list 250 nominal / 240 min" },
  { code: "503035", mAh: 500, w: 30, h: 35, d: 5, mass_g: 10, source: "common 500 mAh listings (round 15 build: amazon.it B0CSS46BMW); Adafruit 1578 500 mAh is 29 x 36 x 4.75 mm" },
  { code: "603030", mAh: 500, w: 30, h: 30, d: 6, mass_g: 10, source: "PowerStream catalog (480 mAh, 9.6 g); other listings 500-600 mAh" },
  { code: "523450", mAh: 1000, w: 34, h: 50, d: 5.2, mass_g: 20, source: "common 1000 mAh listings" },
];

/** The thinnest common cell that holds at least `mAh` and fits under `maxThickness` mm (or undefined). */
export function thinnestCell(mAh: number, maxThickness = Number.POSITIVE_INFINITY): LipoPouchCell | undefined {
  return [...LIPO_POUCH_CELLS].filter((c) => c.mAh >= mAh && c.d <= maxThickness).sort((a, b) => a.d - b.d || a.w * a.h - b.w * b.h)[0];
}
