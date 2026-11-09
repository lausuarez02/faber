// Studio lighting with no network: an environment built from light panels (Lightformers), a key
// light that casts soft shadows and a seamless floor that fades into the page background.
import { Environment, Lightformer } from "@react-three/drei";
import * as THREE from "three";
import { useMemo } from "react";

export function StudioLights({ shadowSize = 12, keyPos = [6, 12, 8] as [number, number, number], castShadow = true }: { shadowSize?: number; keyPos?: [number, number, number]; castShadow?: boolean }) {
  return (
    <>
      <ambientLight intensity={0.22} />
      <directionalLight
        position={keyPos}
        intensity={1.6}
        castShadow={castShadow}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-radius={6}
        shadow-camera-left={-shadowSize}
        shadow-camera-right={shadowSize}
        shadow-camera-top={shadowSize}
        shadow-camera-bottom={-shadowSize}
        shadow-camera-near={0.5}
        shadow-camera-far={80}
      />
      <directionalLight position={[-8, 5, -6]} intensity={0.35} color="#cfd8ff" />
      <Environment resolution={256} frames={1}>
        <color attach="background" args={["#0b0b0b"]} />
        {/* Big soft key from the top, two strip lights for rims, a warm card low on the side. */}
        <Lightformer form="rect" intensity={2.2} position={[0, 6, 2]} rotation-x={Math.PI / 2} scale={[10, 6, 1]} />
        <Lightformer form="rect" intensity={1.4} position={[-6, 2, 2]} rotation-y={Math.PI / 2} scale={[2, 10, 1]} />
        <Lightformer form="rect" intensity={1.1} position={[6, 2, -1]} rotation-y={-Math.PI / 2} scale={[2, 10, 1]} />
        <Lightformer form="ring" intensity={0.8} color="#ffe9d6" position={[2, -1, 6]} scale={3} />
      </Environment>
    </>
  );
}

/** A floor disc whose edge fades to transparent, so the device sits in the page, not on a box. */
export function StudioFloor({ radius = 30, y = 0, color = "#121212", receiveShadow = true }: { radius?: number; y?: number; color?: string; receiveShadow?: boolean }) {
  const alpha = useMemo(() => radialFade(), []);
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={y} receiveShadow={receiveShadow}>
      <circleGeometry args={[radius, 96]} />
      <meshStandardMaterial color={color} roughness={0.92} metalness={0} alphaMap={alpha} transparent depthWrite={false} />
    </mesh>
  );
}

let fade: THREE.CanvasTexture | undefined;
function radialFade(): THREE.CanvasTexture {
  if (fade) return fade;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "#fff");
  grad.addColorStop(0.55, "#fff");
  grad.addColorStop(1, "#000");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  fade = new THREE.CanvasTexture(c);
  return fade;
}

/** Soft round glow sprite (LEDs, sonar hit point). */
let glow: THREE.CanvasTexture | undefined;
export function glowTexture(): THREE.CanvasTexture {
  if (glow) return glow;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glow = new THREE.CanvasTexture(c);
  return glow;
}

export const LED_RGB: Record<string, string> = {
  red: "#ff3b30",
  green: "#3ddc97",
  blue: "#4da3ff",
  yellow: "#ffd43b",
  white: "#ffffff",
  orange: "#ff8a1f",
};

export function ledColor(c: unknown): string {
  const s = String(c ?? "red").toLowerCase();
  return LED_RGB[s] ?? (s.startsWith("#") ? s : "#ff3b30");
}
