import { describe, expect, it } from "vitest";
import { DEFAULT_CAMERA_SETTINGS } from "@jumper/sim-core";
import { describeEspBoard } from "../../lib/espBoardSuite.ts";
import { mount, need } from "../../lib/bench.ts";
import { registry } from "../../registry.gen.ts";

const def = need(registry.get("seeed-xiao-esp32s3-sense"), "seeed-xiao-esp32s3-sense");
const bench = () => {
  const b = mount(def, { props: { camera_source: "test-card" } });
  b.solve();
  return { model: b.model, spec: def.spec };
};

describeEspBoard("seeed-xiao-esp32s3-sense", { gnd: "GND", led: { key: "led_user", pin: "GPIO21", activeLow: true }, charger: { mA: 50 } });

describe("seeed-xiao-esp32s3-sense camera", () => {
  it("is a camera on its own GPIOs and renders what it is set to see, with a preview", () => {
    const b = bench();
    const cam = b.model.camera!;
    expect(cam.sensor).toBe("OV2640");
    expect(b.spec.camera?.pins.xclk).toBe("GPIO10");
    cam.cameraInit?.({ cycle: 0, pins: {}, xclkHz: 20e6, format: "jpeg", frameSize: 6, quality: 12, fbCount: 1, fbInPsram: true });
    const f = cam.cameraCapture({ cycle: 0, format: "jpeg", width: 320, height: 240, quality: 12, settings: DEFAULT_CAMERA_SETTINGS, capacity: 15360, xclkHz: 20e6 })!;
    expect([f.data[0], f.data[1]]).toEqual([0xff, 0xd8]);
    const v = b.model.visualState();
    expect(v.has_preview).toBe(true);
    expect(String(v.camera_preview)).toMatch(/^data:image\/jpeg;base64,/);
    expect(v.camera_label).toBe("OV2640 · 320×240 JPEG");
    b.model.setProp("camera_source", "black");
    const black = cam.cameraCapture({ cycle: 0, format: "grayscale", width: 8, height: 8, quality: 12, settings: DEFAULT_CAMERA_SETTINGS, capacity: 64, xclkHz: 20e6 })!;
    expect(Math.max(...black.data)).toBe(0);
  });

  it("an unreadable image falls back to the test card and says why", () => {
    const b = bench();
    b.model.setProp("camera_source", "image");
    b.model.setProp("camera_image", "data:image/png;base64,AAAA");
    const f = b.model.camera!.cameraCapture({ cycle: 0, format: "rgb565", width: 16, height: 16, quality: 12, settings: DEFAULT_CAMERA_SETTINGS, capacity: 512, xclkHz: 20e6 });
    expect(f?.data.length).toBe(512);
    expect(b.model.diagnostics?.().map((d) => d.code)).toContain("camera-image");
  });
});

describe("seeed-xiao-esp32s3-sense microphone", () => {
  it("is an I2S source on the board: silence by default, a 1 kHz tone at 70 dB SPL when set", () => {
    const b = mount(def, {});
    b.solve();
    const req = { cycle: 0, sampleRate: 16000, bits: 16, channels: 1, frames: 160 };
    expect(Math.max(...b.model.i2s!.i2sProvide!(req)!)).toBe(0);
    b.setProp("mic_sound", "tone");
    const s = b.model.i2s!.i2sProvide!(req)!;
    const rms = Math.sqrt(s.reduce((a, v) => a + (v / 32767) ** 2, 0) / s.length);
    expect(20 * Math.log10(rms)).toBeCloseTo(70 - 94 - 26, 0);
  });
});
