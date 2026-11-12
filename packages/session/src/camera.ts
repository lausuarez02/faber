// Round 13: what a camera sees, for the scenario step camera_frame, the tool set_camera_frame and the
// browser (an image dropped on the part, webcam frames). Cameras are a general capability: any part
// with a camera (part.json "camera") takes a test scene or a still image.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { Project } from "@jumper/project-format";
import { CAMERA_SCENES, decodeImage, type PartRegistry } from "@jumper/sim-core";
import { fail } from "./errors.ts";

/** Largest image accepted as a camera source (bytes): a phone photo fits, a raw video frame does not need more. */
export const CAMERA_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Parts in the project that carry a camera. */
export function cameraParts(project: Project, registry: PartRegistry): { id: string; type: string; sensor: string }[] {
  return project.parts.flatMap((p) => {
    const cam = registry.get(p.type)?.spec.camera;
    return cam ? [{ id: p.id, type: p.type, sensor: cam.sensor }] : [];
  });
}

/** The camera a step / tool means: the named part, or the only camera. */
export function pickCamera(project: Project, registry: PartRegistry, part?: string): string {
  const cams = cameraParts(project, registry);
  if (part) {
    const p = project.parts.find((x) => x.id === part);
    if (!p) fail("unknown-part", `No part '${part}'`, `the project has ${project.parts.map((x) => x.id).join(", ") || "no parts"}`, cams.length ? `use "part": "${cams[0]!.id}"` : "place a camera first");
    if (!cams.some((c) => c.id === part)) fail("not-a-camera", `${part} is not a camera`, `${p.type} has no camera`, cams.length ? `use "part": "${cams[0]!.id}"` : 'place one first: place_part seeed-xiao-esp32s3-sense (a board with a camera) or ov2640-camera (a module for an ESP32 board)');
    return part;
  }
  if (!cams.length) fail("no-camera", "This project has no camera", "no part in it carries a camera", 'place one: place_part seeed-xiao-esp32s3-sense (a XIAO ESP32-S3 with a camera) or ov2640-camera (a module for an ESP32 / ESP32-S3 board)');
  if (cams.length > 1) fail("which-camera", "Which camera?", `the project has ${cams.length} cameras (${cams.map((c) => c.id).join(", ")})`, `pass "part": "${cams[0]!.id}"`);
  return cams[0]!.id;
}

export type CameraSourceSpec = { scene: string } | { image: string };

/** "face" → a scene; anything else → an image path. Objects pass through. */
export function cameraSourceSpec(v: string | { scene?: string; image?: string }): CameraSourceSpec {
  if (typeof v === "string") return (CAMERA_SCENES as readonly string[]).includes(v) ? { scene: v } : { image: v };
  if (v.scene && v.image) fail("bad-camera-frame", "camera_frame has both a scene and an image", "it can show one thing", 'pass {"scene": "face"} or {"image": "tests/cat.jpg"}');
  if (v.scene) return { scene: v.scene };
  if (v.image) return { image: v.image };
  fail("bad-camera-frame", "camera_frame says nothing to show", "it needs a scene or an image", `pass a scene (${CAMERA_SCENES.join(", ")}) or {"image": "tests/cat.jpg"}`);
}

/** Reads an image inside the project folder (or a data: URL) as a data: URL the camera parts take. */
export function cameraImageDataUrl(dir: string, image: string): string {
  if (image.startsWith("data:image/")) {
    checkDecodes(Buffer.from(image.slice(image.indexOf(",") + 1), "base64"), "the image");
    return image;
  }
  const abs = resolve(dir, image);
  const rel = relative(dir, abs);
  if (isAbsolute(image) || rel.startsWith("..") || normalize(rel) !== rel) fail("outside-project", `Cannot read ${image}`, "camera images must be files inside the project folder", `copy it into the project (e.g. tests/${image.split(/[\\/]/).pop()}) and pass that path`);
  if (!existsSync(abs) || !statSync(abs).isFile()) fail("no-image", `No image at ${image}`, `there is no file ${rel} in the project`, "write the image into the project first (a PNG or JPEG), or use a test scene such as \"face\"");
  const ext = extname(abs).toLowerCase();
  if (![".png", ".jpg", ".jpeg"].includes(ext)) fail("bad-image", `${image} is not a PNG or JPEG`, `camera images are .png or .jpg files (got ${ext || "no extension"})`, "convert it to PNG or JPEG");
  const bytes = readFileSync(abs);
  if (bytes.length > CAMERA_IMAGE_MAX_BYTES) fail("image-too-big", `${image} is ${Math.round(bytes.length / 1e6)} MB`, `camera images are limited to ${CAMERA_IMAGE_MAX_BYTES / 1024 / 1024} MB`, "scale it down (the camera renders at most 1600 × 1200 anyway)");
  checkDecodes(bytes, image);
  return `data:image/${ext === ".png" ? "png" : "jpeg"};base64,${bytes.toString("base64")}`;
}

function checkDecodes(bytes: Uint8Array, what: string): void {
  try {
    decodeImage(new Uint8Array(bytes));
  } catch (err) {
    fail("bad-image", `Cannot read ${what}`, (err as Error).message, "use a PNG or a baseline JPEG");
  }
}

/** The props that make `part` see `src` (applied live with sim.setProp, never saved in jumper.json). */
export function cameraProps(dir: string, src: CameraSourceSpec): { camera_source: string; camera_image: string } {
  if ("scene" in src) {
    if (!(CAMERA_SCENES as readonly string[]).includes(src.scene)) fail("bad-scene", `No test scene '${src.scene}'`, `the scenes are ${CAMERA_SCENES.join(", ")}`, "pick one, or pass an image file");
    return { camera_source: src.scene, camera_image: "" };
  }
  return { camera_source: "image", camera_image: cameraImageDataUrl(dir, src.image) };
}

/** A project-relative path for messages. */
export const projectPath = (dir: string, p: string) => relative(dir, join(dir, p));
