// Live screen texture for the 3D device: the display part's visual state, painted by the same
// painters as the canvas (renderers/displays/paint.ts), upscaled with visible pixel gaps so the
// OLED reads as a real panel up close. Redrawn only when the frame actually changes.
import * as THREE from "three";
import { colorFrameToRgba, type ColorFrame, type VisualState } from "@fabwright/sim-core";
import { painterFor, type RgbaImage } from "../../renderers/displays/paint.ts";

export interface ScreenTexture {
  texture: THREE.CanvasTexture;
  /** Repaint from the part state; returns true when the texture changed. */
  update(state: VisualState | undefined): boolean;
  /** Display brightness 0..1 (for emissive intensity). */
  readonly level: number;
  dispose(): void;
}

const SCALE = 4;

export function createScreenTexture(screen: string): ScreenTexture {
  const paint = painterFor(screen)!;
  let img: RgbaImage = paint({});
  const src = document.createElement("canvas");
  src.width = img.width;
  src.height = img.height;
  const sctx = src.getContext("2d")!;
  const out = document.createElement("canvas");
  out.width = img.width * SCALE;
  out.height = img.height * SCALE;
  const octx = out.getContext("2d")!;
  // Pixel-gap mask: one darker line per pixel row and column (a real OLED's dot pitch).
  const grid = document.createElement("canvas");
  grid.width = out.width;
  grid.height = out.height;
  const g = grid.getContext("2d")!;
  g.fillStyle = "rgba(0,0,0,0.55)";
  for (let x = 0; x < grid.width; x += SCALE) g.fillRect(x + SCALE - 1, 0, 1, grid.height);
  for (let y = 0; y < grid.height; y += SCALE) g.fillRect(0, y + SCALE - 1, grid.width, 1);
  const texture = new THREE.CanvasTexture(out);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  let key = "";
  let level = 0;
  let imageData: ImageData | undefined;

  const draw = () => {
    if (!imageData || imageData.width !== img.width || imageData.height !== img.height) {
      src.width = img.width;
      src.height = img.height;
      out.width = img.width * SCALE;
      out.height = img.height * SCALE;
      imageData = sctx.createImageData(img.width, img.height);
    }
    imageData.data.set(img.data);
    sctx.putImageData(imageData, 0, 0);
    octx.imageSmoothingEnabled = false;
    octx.clearRect(0, 0, out.width, out.height);
    octx.drawImage(src, 0, 0, out.width, out.height);
    if (grid.width === out.width) octx.drawImage(grid, 0, 0);
    texture.needsUpdate = true;
  };
  draw();

  return {
    texture,
    get level() {
      return level;
    },
    update(state) {
      const s = state ?? {};
      const k = `${String(s.frame)}|${String(s.on)}|${String(s.backlight)}|${String(s.brightness)}|${String(s.color)}|${String(s.blinkOn)}|${typeof s.pixels === "string" ? s.pixels.length : 0}`;
      if (k === key) return false;
      key = k;
      img = paint(s, img);
      level = s.on === false ? 0 : Math.min(1, Math.max(0.15, Number(s.brightness) || (s.on ? 1 : 0)));
      draw();
      return true;
    },
    dispose() {
      texture.dispose();
    },
  };
}

export interface ColorScreenTexture {
  texture: THREE.CanvasTexture;
  /** Repaint from the panel's frame when its version changed; returns true when it did. */
  update(frame: ColorFrame | undefined, state: VisualState | undefined): boolean;
  readonly level: number;
  /** width / height of the last frame (rotation changes it). */
  readonly aspect: number;
  dispose(): void;
}

/** Live texture for a colour TFT (RGB565 frame from Simulation.framebuffer), redrawn per frame version. */
export function createColorScreenTexture(blank = "#000"): ColorScreenTexture {
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 240;
  const g = c.getContext("2d")!;
  g.fillStyle = blank;
  g.fillRect(0, 0, c.width, c.height);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  let img: ImageData | undefined;
  let key = "";
  let level = 0;
  let aspect = 4 / 3;
  return {
    texture,
    get level() {
      return level;
    },
    get aspect() {
      return aspect;
    },
    update(frame, state) {
      const on = frame ? frame.on : false;
      const k = `${frame?.version ?? -1}|${on}|${String(state?.backlight)}|${frame?.width}x${frame?.height}`;
      if (k === key) return false;
      key = k;
      level = on ? Math.min(1, Math.max(0.15, Number(state?.backlight ?? 1))) : 0;
      if (!frame) return false;
      if (c.width !== frame.width || c.height !== frame.height) {
        c.width = frame.width;
        c.height = frame.height;
        img = undefined;
        texture.dispose(); // new size: let three allocate a fresh GPU texture
      }
      aspect = frame.width / frame.height;
      if (!on) {
        g.fillStyle = "#000";
        g.fillRect(0, 0, c.width, c.height);
      } else {
        img ??= g.createImageData(frame.width, frame.height);
        colorFrameToRgba(frame, img.data);
        g.putImageData(img, 0, 0);
      }
      texture.needsUpdate = true;
      return true;
    },
    dispose() {
      texture.dispose();
    },
  };
}

export interface PanelTexture {
  /** The texture to show now: the frame texture once the part has frames, else the pixel painter's. */
  readonly texture: THREE.CanvasTexture;
  /** Repaint from the part's frame (e-paper, memory LCD, any panel whose model has a framebuffer) or its visual state. */
  update(frame: ColorFrame | undefined, state: VisualState | undefined): boolean;
  readonly level: number;
  /** True while the frame texture is the one shown. */
  readonly framed: boolean;
  dispose(): void;
}

/**
 * Round 17: a display the Device view knows only by its drawing (category display with a
 * data-screen="WxH" rect): drawn from Simulation.framebuffer when the model has one (an e-paper or
 * a memory LCD keeps its picture there), else from the `pixels` in its visual state like an OLED.
 */
export function createPanelTexture(screen: string, blank = "#000"): PanelTexture {
  const rgb = createColorScreenTexture(blank);
  const mono = painterFor(screen) ? createScreenTexture(screen) : undefined;
  // until the part has frames or pixels, its blank glass (an e-paper's paper colour), not a black OLED
  let framed = true;
  let gotFrame = false;
  return {
    get texture() {
      return framed || !mono ? rgb.texture : mono.texture;
    },
    get level() {
      if (!gotFrame && framed) return 1; // the blank glass in room light
      return framed || !mono ? rgb.level : mono.level;
    },
    get framed() {
      return framed;
    },
    update(frame, state) {
      if (frame) {
        framed = true;
        gotFrame = true;
        // a panel's glass is lit by the room, not a backlight: full level whenever it shows a frame
        return rgb.update(frame, state);
      }
      if (!mono || typeof state?.pixels !== "string") return false; // keep the last frame or the blank glass
      framed = false;
      return mono.update(state);
    },
    dispose() {
      rgb.dispose();
      mono?.dispose();
    },
  };
}
