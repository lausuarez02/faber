import { useRef, useState, type DragEvent } from "react";
import { Camera, ImageUp, Video, VideoOff } from "lucide-react";
import { CAMERA_SCENES } from "@faber/sim-core";
import { useLive } from "../live/liveStore.ts";
import { imageFileToJpeg, showCamera, startWebcam, stopWebcam, useCameraUi } from "./camera.ts";
import "./interact.css";

/**
 * Round 13: the Inspector's camera section for a part with a camera (a board such as the XIAO
 * ESP32-S3 Sense, an OV2640 module). What the camera sees goes to the running simulation only (never
 * saved in the project): a test scene, a picture picked or dropped here, or the webcam.
 */
export function CameraPanel({ part, sensor }: { part: string; sensor: string }) {
  const connected = useLive((s) => s.connected);
  const webcam = useCameraUi((s) => s.webcam);
  const sent = useCameraUi((s) => s.sent);
  const shown = useCameraUi((s) => s.shown[part]);
  const error = useCameraUi((s) => s.error);
  const [over, setOver] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const mine = webcam === part;

  const picture = async (f: Blob | undefined) => {
    if (!f) return;
    if (!/^image\//.test(f.type)) {
      useCameraUi.setState({ error: `That is not an image (${f.type || "unknown type"}). Fix: drop a PNG or JPEG photo.` });
      return;
    }
    try {
      showCamera(part, { image: await imageFileToJpeg(f) }, (f as File).name || "a picture");
    } catch {
      useCameraUi.setState({ error: "The browser could not open that image. Fix: use a PNG or JPEG." });
    }
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void picture(e.dataTransfer.files[0]);
  };

  return (
    <div
      className={`insp-camera ${over ? "is-over" : ""}`}
      data-testid="camera-panel"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <div className="insp-summary">
        <Camera size={14} strokeWidth={1.6} aria-hidden /> Camera · {sensor}
      </div>
      <p className="small muted">
        What the camera sees in the simulator (the firmware reads it with esp_camera_fb_get). It is not saved in the project; tests use a camera_frame step.
        {shown ? <span data-testid="camera-shown"> Now: {shown}.</span> : null}
      </p>
      <div className="field">
        <label htmlFor={`camera-scene-${part}`}>Test scene</label>
        <select id={`camera-scene-${part}`} data-testid="camera-scene" disabled={!connected} defaultValue="" onChange={(e) => e.target.value && showCamera(part, { scene: e.target.value }, `the ${e.target.value} scene`)}>
          <option value="" disabled>
            Pick a scene…
          </option>
          {CAMERA_SCENES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="insp-row">
        <button type="button" className="btn" data-testid="camera-picture" disabled={!connected} onClick={() => file.current?.click()}>
          <ImageUp size={15} strokeWidth={1.6} aria-hidden /> Show a picture…
        </button>
        <input ref={file} type="file" accept="image/*" hidden data-testid="camera-file" onChange={(e) => void picture(e.target.files?.[0])} />
        {mine ? (
          <button type="button" className="btn btn-danger" data-testid="camera-webcam-off" onClick={stopWebcam}>
            <VideoOff size={15} strokeWidth={1.6} aria-hidden /> Webcam off
          </button>
        ) : (
          <button type="button" className="btn" data-testid="camera-webcam" disabled={!connected} onClick={() => void startWebcam(part)} title="The browser asks for permission; frames go only to the simulator on this computer">
            <Video size={15} strokeWidth={1.6} aria-hidden /> Use my webcam
          </button>
        )}
      </div>
      {mine ? (
        <p className="small insp-webcam-on" data-testid="camera-webcam-on">
          <span className="rec-dot" aria-hidden /> Webcam on: {sent} frame{sent === 1 ? "" : "s"} sent to the simulator on this computer (nowhere else). It turns off after 3 minutes or when you leave the page.
        </p>
      ) : null}
      {!connected ? <p className="small muted">Connect to faber serve to show the camera something: its board runs in the ESP32 emulator there.</p> : null}
      {error ? (
        <p className="small insp-error" role="alert" data-testid="camera-error">
          {error}
        </p>
      ) : null}
      <p className="small muted">Or drop an image here.</p>
    </div>
  );
}

/** A small pill while the webcam is open, wherever the person is in the app. */
export function WebcamIndicator() {
  const webcam = useCameraUi((s) => s.webcam);
  if (!webcam) return null;
  return (
    <button type="button" className="webcam-pill" data-testid="webcam-indicator" onClick={stopWebcam} title="Your webcam feeds the simulated camera. Click to turn it off.">
      <span className="rec-dot" aria-hidden /> Webcam → {webcam} · off
    </button>
  );
}
