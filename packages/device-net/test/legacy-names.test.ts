// Firmware built before the rename from Jumper asks for "JumperNet" and may speak JUMPER-FLOW/1.
import { describe, expect, it } from "vitest";
import { decideJoin, type WifiState } from "../src/netstack/wifi.ts";

const wifi = (aps: WifiState["aps"]): WifiState => ({ up: true, aps, rssi: -55 }) as WifiState;

describe("the sandbox Wi-Fi under its old name", () => {
  it('"JumperNet" joins the FabwrightNet access point, with its password checked', () => {
    expect(decideJoin(wifi([{ ssid: "FabwrightNet", password: "pw" }] as WifiState["aps"]), "JumperNet", "pw")).toMatchObject({ ok: true });
    expect(decideJoin(wifi([{ ssid: "FabwrightNet", password: "pw" }] as WifiState["aps"]), "JumperNet", "nope")).toMatchObject({ ok: false });
    expect(decideJoin(wifi([{ ssid: "Home" }] as WifiState["aps"]), "JumperNet", "")).toMatchObject({ ok: false });
  });
});
