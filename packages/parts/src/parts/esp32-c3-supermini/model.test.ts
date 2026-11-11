import { describeEspBoard } from "../../lib/espBoardSuite.ts";

describeEspBoard("esp32-c3-supermini", { gnd: "GND", led: { key: "led_user", pin: "GPIO8", activeLow: true } });
