import { describeEspBoard } from "../../lib/espBoardSuite.ts";

describeEspBoard("seeed-xiao-esp32s3", { gnd: "GND", led: { key: "led_user", pin: "GPIO21", activeLow: true }, charger: { mA: 50 } });
