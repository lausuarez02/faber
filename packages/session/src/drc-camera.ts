// Round 13: design checks for cameras (a general capability: any part with part.json "camera").
//   camera-board      the firmware board cannot run esp32-camera (no camera interface on its chip)
//   camera-pins       the sketch's camera_config_t pins differ from where the camera is (built in or wired)
//   camera-unwired    a camera module's signal pins are not all on board GPIOs
//   camera-psram      frame buffers in PSRAM on a board without PSRAM, or PSRAM turned off in the build
//   camera-battery    camera + Wi-Fi bursts against what the cell can give, with a battery-life estimate
//   camera-indicator  (round 14) nothing on the device (LED, screen, the board's LED in the firmware) shows the camera is in use
import { buildNets, type Project } from "@jumper/project-format";
import { CAMERA_PIN_ROLES, CAMERA_REQUIRED_ROLES, CAMERA_SENSORS, type CameraPinRole, type CameraSensorId, type PartRegistry, type PartSpec } from "@jumper/sim-core";
import type { DesignIssue } from "./drc.ts";

/** Chips whose camera interface esp32-camera drives (ESP32: I2S camera mode; S3: LCD_CAM). */
const CAMERA_CHIPS = new Set(["esp32", "esp32s3"]);
/** A small LiPo pouch gives about 1C continuously without sagging below 3.5 V. */
const CELL_C_RATE = 1;
/** Wi-Fi transmit bursts of an ESP32-family board (datasheet: up to about 340 mA at +20 dBm). */
const WIFI_BURST_MA = 300;

const NET_HINT = /#\s*include\s*[<"](WiFi|HTTPClient|NetworkClientSecure|WiFiClientSecure|PubSubClient|WebSocketsClient|esp_http_client)\.h[>"]/;

/** camera_config_t pins the sketch sets ("config.pin_xclk = XCLK_GPIO_NUM;" with #defines, or numbers). */
export function sketchCameraPins(src: string): Partial<Record<CameraPinRole, number>> | undefined {
  if (!/esp_camera\.h/.test(src)) return undefined;
  const defines = new Map<string, string>();
  for (const m of src.matchAll(/^\s*#\s*define\s+(\w+)\s+(-?\w+)/gm)) defines.set(m[1]!, m[2]!);
  for (const m of src.matchAll(/\b(?:const\s+)?(?:int|int8_t|uint8_t|gpio_num_t)\s+(\w+)\s*=\s*(-?\d+)\s*;/g)) defines.set(m[1]!, m[2]!);
  const val = (v: string): number | undefined => {
    for (let i = 0; i < 4 && defines.has(v); i++) v = defines.get(v)!;
    const n = Number(v.replace(/^GPIO_NUM_/, ""));
    return Number.isInteger(n) ? n : undefined;
  };
  const out: Partial<Record<CameraPinRole, number>> = {};
  const alias: Record<string, CameraPinRole> = { sccb_sda: "sda", sccb_scl: "scl", sscb_sda: "sda", sscb_scl: "scl" };
  for (const m of src.matchAll(/\.pin_(\w+)\s*=\s*([-\w]+)\s*;/g)) {
    const role = (alias[m[1]!] ?? m[1]!) as CameraPinRole;
    if (!(CAMERA_PIN_ROLES as readonly string[]).includes(role)) continue;
    const n = val(m[2]!);
    if (n !== undefined) out[role] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

const gpioNum = (pin: string | undefined): number | undefined => {
  const m = /^GPIO(\d+)$/.exec(pin ?? "");
  return m ? Number(m[1]) : undefined;
};

export function cameraChecks(project: Project, registry: PartRegistry, firmwareSource = ""): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const spec = (type: string) => registry.get(type)?.spec;
  const cams = project.parts.filter((p) => spec(p.type)?.camera);
  if (!cams.length) return issues;
  const boardPart = project.parts.find((p) => p.id === project.firmware?.board) ?? project.parts.find((p) => spec(p.type)?.mcu);
  const board = boardPart ? spec(boardPart.type) : undefined;
  const nets = buildNets(project);
  const gpioOf = (part: string, pin: string): string | undefined => {
    if (!boardPart || !board) return undefined;
    const net = nets.find((n) => n.pins.some((x) => x.part === part && x.pin === pin));
    const b = net?.pins.find((x) => x.part === boardPart.id && board.pins.find((pp) => pp.id === x.pin && (pp.type === "digital" || pp.type === "analog")));
    return b?.pin;
  };

  // Round 14 (privacy): people near a camera should be able to see when it takes a picture. Any
  // project with a camera needs something on the device that shows it: an LED, a screen, or the
  // board's own LED driven by the firmware.
  const indicators = project.parts.filter((p) => {
    if (cams.includes(p) && !spec(p.type)?.bindings?.some((b) => /^led/.test(b.key))) return false;
    const sp = spec(p.type);
    if (!sp) return false;
    if (sp.category === "display" || /data-screen="/.test(registry.get(p.type)?.svg ?? "")) return true;
    if (sp.category === "board") return false;
    return /(^|-)(led|leds|neopixel|ws2812|sk6812|apa102)(-|$)/.test(p.type) || (sp.tags ?? []).some((t) => /^(led|neopixel|indicator|light)$/.test(t)) || !!sp.bindings?.some((b) => b.key === "brightness" || b.key === "on");
  });
  const boardLed = board?.bindings?.find((b) => /^led/.test(b.key));
  const firmwareUsesBoardLed = !!boardLed && /\bLED_BUILTIN\b|\bBUILTIN_LED\b/.test(firmwareSource);
  if (!indicators.length && !firmwareUsesBoardLed) {
    issues.push({
      severity: "warning",
      code: "camera-indicator",
      message: `${cams.map((c) => c.id).join(", ")} can take pictures, but nothing on the device shows when it does: no LED, no screen${boardLed ? `, and the firmware does not drive ${boardPart!.id}'s own LED (LED_BUILTIN)` : ""}. People near a camera should be able to see that it is about to take, or is taking, a picture (it is a matter of trust and privacy, and some places require a visible signal). Fix: add an LED with its resistor on a free GPIO (place_part led, then connect) and light it while the camera is on; or show it on a screen${boardLed ? `; or drive LED_BUILTIN (${boardLed.description?.split(";")[0] ?? "the board's LED"}) while capturing` : ""}. A spoken or on-screen countdown before each picture helps too.`,
      parts: cams.map((c) => c.id),
    });
  }

  // which chip runs it
  if (board?.mcu && !CAMERA_CHIPS.has(board.mcu.chip)) {
    issues.push({ severity: "error", code: "camera-board", message: `${cams.map((c) => c.id).join(", ")} ${cams.length > 1 ? "are cameras" : "is a camera"}, but ${boardPart!.id} (${board.name}, ${board.mcu.chip}) has no camera interface: Espressif's esp32-camera driver runs on the ESP32 and ESP32-S3 only (their I2S camera mode / LCD_CAM with DMA), and a ${board.mcu.chip} cannot read a parallel camera fast enough. Fix: use a XIAO ESP32-S3 Sense (camera built in) or an ESP32 / ESP32-S3 board with an OV2640 module.`, parts: [boardPart!.id, ...cams.map((c) => c.id)] });
    return issues;
  }

  const asked = sketchCameraPins(firmwareSource);
  for (const cam of cams) {
    const s = spec(cam.type)!;
    const pins = s.camera!.pins;
    const onBoard = cam.id === boardPart?.id;
    // where each signal is: the board's own GPIO, or the GPIO a module pin is wired to
    const where: Partial<Record<CameraPinRole, string>> = {};
    const unwired: string[] = [];
    for (const role of CAMERA_PIN_ROLES) {
      const p = pins[role];
      if (!p) continue;
      const g = onBoard ? p : gpioOf(cam.id, p);
      if (g) where[role] = g;
      else if (CAMERA_REQUIRED_ROLES.includes(role)) unwired.push(`${cam.id}.${p}`);
    }
    if (!onBoard && unwired.length) {
      issues.push({ severity: "error", code: "camera-unwired", message: `${cam.id} (${s.name}): ${unwired.join(", ")} ${unwired.length > 1 ? "are" : "is"} not wired to a GPIO of ${boardPart?.id ?? "the board"}, so esp_camera_init cannot find the camera ("Camera probe failed"). The driver needs all 8 data lines, PCLK, VSYNC, HREF, XCLK and SIOD / SIOC on free GPIOs (not flash, PSRAM or input-only pins for XCLK / SIOD / SIOC). Fix: wire each to a free GPIO and put the same numbers in camera_config_t.`, parts: [cam.id], pins: unwired });
    }
    if (asked) {
      const diff: string[] = [];
      for (const role of CAMERA_REQUIRED_ROLES) {
        const want = gpioNum(where[role]);
        const got = asked[role];
        if (want === undefined || got === undefined) continue;
        if (want !== got) diff.push(`pin_${role === "sda" ? "sccb_sda" : role === "scl" ? "sccb_scl" : role} = ${got}, but ${cam.id}'s ${role.toUpperCase()} is on GPIO${want}`);
      }
      if (diff.length) {
        issues.push({ severity: "error", code: "camera-pins", message: `The sketch's camera_config_t does not match where ${cam.id} is: ${diff.slice(0, 4).join("; ")}${diff.length > 4 ? `; and ${diff.length - 4} more` : ""}. esp_camera_init will fail with "Camera probe failed" (ESP_ERR_NOT_FOUND), in Jumper and on the board. Fix: ${onBoard ? `use the ${s.name}'s camera pins (get_part ${s.id} lists them)` : "use the GPIOs the camera is wired to, or rewire it"}.`, parts: [cam.id] });
      }
    }
  }

  // PSRAM: where frame buffers can live
  const psramMB = board?.mcu?.psram?.sizeMB ?? 0;
  const wantsPsram = /CAMERA_FB_IN_PSRAM/.test(firmwareSource) || (/esp_camera\.h/.test(firmwareSource) && !/CAMERA_FB_IN_DRAM/.test(firmwareSource));
  const bigFrame = /FRAMESIZE_(VGA|SVGA|XGA|HD|SXGA|UXGA|FHD|QXGA|QHD|WQXGA|QSXGA|5MP|P_HD|P_3MP|P_FHD)\b/.test(firmwareSource);
  if (board?.mcu && !psramMB && /esp_camera\.h/.test(firmwareSource)) {
    if (wantsPsram || bigFrame) {
      issues.push({ severity: "warning", code: "camera-psram", message: `${boardPart!.id} (${board.name}) has no PSRAM, but the sketch ${wantsPsram ? "puts camera frame buffers in PSRAM (fb_location CAMERA_FB_IN_PSRAM, the default)" : "asks for a large frame size"}: esp_camera_init fails with ESP_ERR_NO_MEM on the board. Internal RAM holds about one QVGA JPEG or a 96×96 RGB565 frame. Fix: fb_location = CAMERA_FB_IN_DRAM, fb_count = 1 and FRAMESIZE_QVGA or smaller, or a board with PSRAM (XIAO ESP32-S3 Sense, ESP32-CAM).`, parts: [boardPart!.id] });
    }
  } else if (psramMB && /esp_camera\.h/.test(firmwareSource) && wantsPsram) {
    const fqbn = project.firmware?.build?.fqbn ?? "";
    if (fqbn && !/PSRAM=(opi|enabled)/.test(fqbn)) {
      issues.push({ severity: "warning", code: "camera-psram", message: `The sketch puts camera frame buffers in PSRAM, but the build has PSRAM turned off (firmware.build.fqbn "${fqbn}" has no PSRAM option): on the ${board!.name} esp_camera_init fails with ESP_ERR_NO_MEM. Fix: set_firmware with fqbn "${board!.mcu!.fqbn ?? `${fqbn}:PSRAM=opi`}" (Tools > PSRAM: ${board!.mcu!.psram?.mode === "octal" ? "OPI PSRAM" : "Enabled"}). (Jumper's emulator has no PSRAM either way: in the simulator frame buffers go in internal RAM.)`, parts: [boardPart!.id] });
    }
  }

  // Battery: the camera and Wi-Fi bursts against the cell
  const cells = project.parts.filter((p) => p.type === "lipo-battery");
  if (cells.length && board) {
    const sensor = (spec(cams[0]!.type)!.camera!.sensor ?? "OV2640") as CameraSensorId;
    const camMa = spec(cams[0]!.type)!.camera!.activeMa ?? CAMERA_SENSORS[sensor].activeMa;
    const net = NET_HINT.test(firmwareSource);
    const boardPeak = board.current_ma?.max ?? 0;
    const camIncluded = cams.some((c) => c.id === boardPart?.id);
    const peak = Math.round(camIncluded ? boardPeak : boardPeak + camMa);
    const typ = Math.round((board.current_ma?.typ ?? 0) + (camIncluded ? 0 : camMa));
    for (const cell of cells) {
      const cap = Number(cell.props?.capacity ?? spec("lipo-battery")?.props?.find((p) => p.id === "capacity")?.default ?? 500);
      const safe = cap * CELL_C_RATE;
      const hours = typ > 0 ? cap / typ : 0;
      const life = `About ${hours >= 1 ? `${Math.round(hours * 10) / 10} h` : `${Math.round(hours * 60)} min`} on ${cap} mAh at ${typ} mA (camera on${net ? ", Wi-Fi connected" : ""}); taking a picture every few seconds and sleeping in between lasts much longer (estimate, not measured).`;
      if (peak > safe) {
        issues.push({ severity: "warning", code: "camera-battery", message: `The camera${net ? " and Wi-Fi" : ""} draw up to about ${peak} mA in bursts (${board.name}${camIncluded ? " with its camera" : ` + ${camMa} mA camera`}${net ? `, Wi-Fi transmit up to about ${WIFI_BURST_MA} mA` : ""}), more than the ${cap} mAh cell gives comfortably (about ${Math.round(safe)} mA at 1C): its voltage sags during a photo or an upload and the board can brown out and reset. ${life} Fix: a cell of ${Math.ceil((peak / CELL_C_RATE) / 50) * 50} mAh or more (or one rated 2C), and keep frames small (QVGA JPEG) when sending them.`, parts: [cell.id, ...(boardPart ? [boardPart.id] : [])] });
      } else {
        issues.push({ severity: "info", code: "camera-battery", message: `Camera power: up to about ${peak} mA in bursts${net ? " (photo + Wi-Fi upload)" : ""}, within what the ${cap} mAh cell gives. ${life}`, parts: [cell.id] });
      }
    }
  }
  return issues;
}

/** The camera pins of a part spec, as "ROLE GPIOn" text for get_part and hints. */
export function cameraPinText(s: PartSpec): string {
  const p = s.camera?.pins ?? {};
  return CAMERA_PIN_ROLES.filter((r) => p[r]).map((r) => `${r.toUpperCase()} ${p[r]}`).join(", ");
}
