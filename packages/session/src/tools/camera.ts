import { CAMERA_SCENES } from "@jumper/sim-core";
import { cameraParts, cameraProps, cameraSourceSpec, pickCamera } from "../camera.ts";
import { fail } from "../errors.ts";
import type { ToolModule } from "./types.ts";

/**
 * Round 13 (camera): cameras are a general capability. Any part with a camera (a board such as the
 * XIAO ESP32-S3 Sense, an OV2640 module on an ESP32) sees what this sets: a test scene or an image.
 * The firmware gets it through Espressif's esp32-camera API (simulation build: frames from Jumper).
 */
export const cameraTools: ToolModule = {
  name: "camera",
  tools: [
    {
      name: "set_camera_frame",
      title: "Show the camera something",
      description: `What the camera sees in the simulator, from now on (the running device and the next runs, until set again; never saved in jumper.json): a test scene ${CAMERA_SCENES.map((s) => `"${s}"`).join(", ")} with {"scene": "face"}, or a still image in the project (PNG or baseline JPEG) with {"image": "tests/cat.jpg"}. {"part": "cam1"} picks the camera when there are several. The firmware reads frames with esp_camera_fb_get() at its own frame size and format; the canvas shows the last picture in the lens. In tests use the scenario step {"camera_frame": "face"} or {"camera_frame": {"image": "tests/cat.jpg"}} instead (each test starts from the test card). The person can also drop an image on the camera or use their webcam in the canvas.`,
      inputSchema: {
        type: "object",
        properties: {
          scene: { type: "string", enum: [...CAMERA_SCENES], description: "A test scene." },
          image: { type: "string", description: 'A PNG / JPEG path inside the project (e.g. "tests/cat.jpg"), or a data:image/png|jpeg;base64 URL.' },
          part: { type: "string", description: "The camera part (default: the only one)." },
        },
      },
    },
  ],
  ops: {
    async set_camera_frame(args, x) {
      const s = x.session;
      const part = pickCamera(s.project, s.registry, typeof args.part === "string" ? args.part : undefined);
      if (args.scene === undefined && args.image === undefined) fail("bad-arg", "set_camera_frame needs a scene or an image", "nothing to show was given", `pass {"scene": "face"} (${CAMERA_SCENES.join(", ")}) or {"image": "tests/cat.jpg"}`);
      const src = cameraSourceSpec({ ...(typeof args.scene === "string" ? { scene: args.scene } : {}), ...(typeof args.image === "string" ? { image: args.image } : {}) });
      const props = cameraProps(s.dir, src);
      s.setCameraInput(part, props);
      const what = "scene" in src ? `the "${src.scene}" scene` : src.image.startsWith("data:") ? "an image" : src.image;
      x.summary(`${part} sees ${what}`);
      x.target(part);
      const others = cameraParts(s.project, s.registry).filter((c) => c.id !== part);
      return {
        part,
        sees: "scene" in src ? src.scene : src.image.startsWith("data:") ? "image (data URL)" : src.image,
        ...(others.length ? { other_cameras: others.map((c) => c.id) } : {}),
        note: "applies to the running simulation and the next runs (not saved in the project). Tests: use a camera_frame step.",
        next: "run, then read the part's camera_frames / camera_size (get_part_state or the run's parts), or a screenshot to see the preview",
      };
    },
  },
};
