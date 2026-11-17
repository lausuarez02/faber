// Round 13: what a camera part sees, from the page. Cameras run with their board in the ESP32 emulator
// next to `faber serve`, so every input goes to the session as set_camera_frame (a live command):
// a test scene, an image the person picks or drops (re-encoded here as a baseline JPEG), or frames
// from their webcam. The webcam is opened only when the person turns it on, shows an indicator while
// it is open, sends a small frame every WEBCAM_MS to the simulator on this computer only, and closes
// when turned off, after WEBCAM_MAX_MS, when the page is hidden, or when another project opens.
import { create } from "zustand";
import { sendLiveCommand } from "../live/command.ts";

export const WEBCAM_MS = 700;
export const WEBCAM_MAX_MS = 3 * 60_000;
const FRAME_W = 320;
const FRAME_H = 240;

interface CameraUi {
  /** Camera part the webcam feeds (undefined = off). */
  webcam?: string;
  /** Frames sent since it was turned on. */
  sent: number;
  /** What each camera was last shown from the page (for the panel). */
  shown: Record<string, string>;
  error?: string;
}

export const useCameraUi = create<CameraUi>()(() => ({ sent: 0, shown: {} }));

/** Sends what `part` sees to the session. False (with the reason in the store) when the page is not connected. */
export function showCamera(part: string, src: { scene: string } | { image: string }, label: string): boolean {
  const ok = sendLiveCommand("set_camera_frame", { part, ...src });
  useCameraUi.setState((s) => ({
    shown: ok ? { ...s.shown, [part]: label } : s.shown,
    error: ok ? undefined : "This page is not connected to faber serve, where the camera's board runs. Fix: open the project from faber serve (or wait for the Live bar to say connected), then try again.",
  }));
  return ok;
}

/** Any image the browser can open, as a baseline JPEG data URL at most `maxW` wide. */
export async function imageFileToJpeg(file: Blob, maxW = 800): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxW / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

let stream: MediaStream | undefined;
let video: HTMLVideoElement | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let stopAt = 0;

/** Opens the webcam (the browser asks for permission) and feeds `part` until stopWebcam(). */
export async function startWebcam(part: string): Promise<void> {
  stopWebcam();
  if (!navigator.mediaDevices?.getUserMedia) {
    useCameraUi.setState({ error: "This browser gives no camera access here (it needs https or localhost). Fix: open Faber at http://localhost, or show the camera a picture instead." });
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  } catch (err) {
    const name = (err as DOMException).name;
    useCameraUi.setState({
      error:
        name === "NotAllowedError"
          ? "The browser was not allowed to use the camera. Fix: allow camera access for this page (the camera icon in the address bar), then turn the webcam on again."
          : name === "NotFoundError"
            ? "No camera was found on this computer. Fix: plug one in, or show the camera a picture instead."
            : `The webcam did not start (${name || (err as Error).message}). Fix: close other apps that use the camera, then try again.`,
    });
    return;
  }
  video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play().catch(() => {});
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  const ctx = canvas.getContext("2d")!;
  stopAt = Date.now() + WEBCAM_MAX_MS;
  useCameraUi.setState({ webcam: part, sent: 0, error: undefined });
  const send = () => {
    if (!video || video.readyState < 2) return;
    if (Date.now() > stopAt || document.hidden) {
      stopWebcam();
      return;
    }
    // cover-crop the webcam picture to 4:3
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(FRAME_W / vw, FRAME_H / vh);
    const w = FRAME_W / s, h = FRAME_H / s;
    ctx.drawImage(video, (vw - w) / 2, (vh - h) / 2, w, h, 0, 0, FRAME_W, FRAME_H);
    if (showCamera(part, { image: canvas.toDataURL("image/jpeg", 0.8) }, "webcam")) useCameraUi.setState((st) => ({ sent: st.sent + 1 }));
    else stopWebcam();
  };
  send();
  timer = setInterval(send, WEBCAM_MS);
}

export function stopWebcam(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = undefined;
  if (video) video.srcObject = null;
  video = undefined;
  if (useCameraUi.getState().webcam) useCameraUi.setState({ webcam: undefined });
}

if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => document.hidden && stopWebcam());
