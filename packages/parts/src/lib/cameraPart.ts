// Shared camera behaviour for parts that are (or carry) an image sensor (round 13): the OV2640 module,
// a board with a built-in camera (XIAO ESP32-S3 Sense). What the camera sees comes from props: a named
// test scene, or a still image (a data URL of a PNG / JPEG: a scenario's camera_frame step, the agent's
// set_camera_frame, an image the person drops in, or a frame from their webcam). Frames are rendered at
// the size and format the firmware asks for (sim-core camera.ts). Deterministic.
import { CAMERA_SCENES, cameraSourceOf, previewDataUrl, renderCameraFrame, type CameraDevice, type CameraFrame, type CameraImage, type CameraScene, type CameraSensorId, type PartContext, type VisualState } from "@faber/sim-core";
import { str } from "./props.ts";

/** Props every camera part has (part.json "props"). */
export const CAMERA_PROPS = { source: "camera_source", image: "camera_image" } as const;
/** How long after a capture the camera counts as "on" for the indicator (virtual ms). */
const ON_MS = 1500;

export interface CameraPart {
  device: CameraDevice;
  visual(): VisualState;
  setProp(id: string, value: unknown): boolean;
  /** Last problem with the source (an image that could not be read), for diagnostics. */
  problem(): string | undefined;
  readonly capturing: boolean;
}

export function createCameraPart(ctx: PartContext, opts: { sensor: CameraSensorId; powered: () => boolean }): CameraPart {
  let sourceName = str(ctx.props[CAMERA_PROPS.source], "test-card");
  let imageText = str(ctx.props[CAMERA_PROPS.image], "");
  let image: CameraImage | CameraScene | undefined;
  let problem: string | undefined;
  let frames = 0;
  let inited = false;
  let lastMs = -1e9;
  let preview = "";
  let last: Pick<CameraFrame, "width" | "height" | "format"> | undefined;

  const source = (): CameraImage | CameraScene => {
    if (sourceName !== "image") return (CAMERA_SCENES as readonly string[]).includes(sourceName) ? (sourceName as CameraScene) : "test-card";
    if (image === undefined) {
      try {
        image = imageText ? cameraSourceOf(imageText) : "test-card";
        problem = undefined;
      } catch (err) {
        problem = `${ctx.id}: the camera image could not be read (${(err as Error).message}); the camera shows the test card instead.`;
        image = "test-card";
      }
    }
    return image;
  };

  const device: CameraDevice = {
    sensor: opts.sensor,
    cameraPowered: opts.powered,
    cameraInit() {
      inited = true;
    },
    cameraDeinit() {
      inited = false;
    },
    cameraCapture(req) {
      if (!opts.powered()) return undefined;
      const f = renderCameraFrame(source(), req);
      frames++;
      lastMs = ctx.now();
      last = { width: f.width, height: f.height, format: f.format };
      if (f.rgba) preview = previewDataUrl(f.rgba, f.width, f.height);
      return f;
    },
  };

  return {
    device,
    get capturing() {
      return inited && ctx.now() - lastMs <= ON_MS;
    },
    visual(): VisualState {
      const on = inited && ctx.now() - lastMs <= ON_MS;
      return {
        camera_on: on,
        camera_ready: inited,
        camera_frames: frames,
        // round 14: when the last picture was taken (virtual ms; -1 before the first), for tests that
        // check what happened before a capture (a spoken countdown) and for the capture indicator
        camera_last_ms: frames ? Math.round(lastMs * 1000) / 1000 : -1,
        camera_preview: preview,
        has_preview: preview !== "",
        camera_size: last ? `${last.width}×${last.height} ${last.format.toUpperCase()}` : "",
        camera_source: sourceName === "image" ? "image" : sourceName,
      };
    },
    setProp(id, value) {
      if (id === CAMERA_PROPS.source) {
        sourceName = str(value as string, "test-card");
        image = undefined;
        return true;
      }
      if (id === CAMERA_PROPS.image) {
        imageText = str(value as string, "");
        image = undefined;
        return true;
      }
      return false;
    },
    problem: () => problem,
  };
}

/** part.json props for a camera (shared by every camera part). */
export const CAMERA_PROP_SPECS = [
  { id: "camera_source", label: "Camera sees", type: "enum", default: "test-card", options: [...CAMERA_SCENES, "image"], description: "What the camera sees in the simulator: a test scene, or 'image' (the still in camera_image: a scenario's camera_frame step, set_camera_frame, an image dropped on the part, or the webcam)." },
  { id: "camera_image", label: "Camera image", type: "text", default: "", description: "A PNG or JPEG as a data URL (or base64), shown to the camera when 'Camera sees' is 'image'. Set at run time by tests, the agent or the browser; usually left empty in the project." },
] as const;
