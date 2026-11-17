// ST7735 1.8in 128x160 colour TFT (black-tab glass) on SPI: the same MIPI-DCS controller model
// as the ILI9341 (lib/mipiPanel.ts) with the ST7735's geometry, RGB glass and rotation table.
import type { PartModelFactory } from "@faber/sim-core";
import type { PanelOptions } from "../../lib/mipiPanel.ts";
import { createTftModule } from "../ili9341-tft/model.ts";

export const ST7735_PANEL: PanelOptions = {
  nativeW: 128,
  nativeH: 160,
  viewer: "portrait",
  portraitFlip: true,
  bgrPanel: false,
  id4: [0x7c, 0x89, 0xf0],
};

export const create: PartModelFactory = (ctx) => createTftModule(ctx, { panel: ST7735_PANEL, chip: "ST7735", backlightMa: 30 });
