import { describeEspBoard } from "../../lib/espBoardSuite.ts";

describeEspBoard("seeed-xiao-esp32c3", { gnd: "GND", charger: { mA: 380 } });
