// GC9A01 1.28in round 240x240 IPS on SPI: the MIPI-DCS controller (lib/mipiPanel.ts) with the
// GC9A01's geometry: native orientation upright, BGR glass, a glass that needs INVON for true
// colours, and a round visible area (pixels outside the circle never show). The module around it
// (supply, backlight, RESET / DC, 3.3 V logic check) is the shared TFT module of ili9341-tft.
import type { PartModelFactory } from "@faber/sim-core";
import type { PanelOptions } from "../../lib/mipiPanel.ts";
import { MADCTL } from "../../lib/mipiPanel.ts";
import { createTftModule } from "../ili9341-tft/model.ts";

export const GC9A01_PANEL: PanelOptions = {
  nativeW: 240,
  nativeH: 240,
  viewer: "native",
  bgrPanel: true,
  invertGlass: true,
  roundGlass: true,
  id4: [0x00, 0x9a, 0x01],
  rotationTable: [0, MADCTL.MX | MADCTL.MV, MADCTL.MX | MADCTL.MY, MADCTL.MY | MADCTL.MV],
};

export const create: PartModelFactory = (ctx) => createTftModule(ctx, { panel: GC9A01_PANEL, chip: "GC9A01", backlightMa: 15, logicMa: 10 });
