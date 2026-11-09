// A generic Uno-sized dev board (68.6 x 53.4 mm, 1 unit = 10 cm): PCB with a drawn top (traces,
// pads, silkscreen outlines; original artwork, no vendor marks), USB-B, barrel jack, the DIP chip,
// female headers with their holes, a crystal and the reset button.
import { useMemo } from "react";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";

let pcbTex: THREE.CanvasTexture | undefined;
function pcbTexture(): THREE.CanvasTexture {
  if (pcbTex) return pcbTex;
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 792;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0e5566";
  g.fillRect(0, 0, c.width, c.height);
  // copper pours / traces (slightly lighter under the mask)
  g.strokeStyle = "rgba(120, 200, 215, 0.16)";
  g.lineWidth = 5;
  g.lineCap = "round";
  g.lineJoin = "round";
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 46; i++) {
    let x = 150 + rnd() * 760;
    let y = 120 + rnd() * 560;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      if (k % 2) x += (rnd() - 0.5) * 300;
      else y += (rnd() - 0.5) * 260;
      g.lineTo(Math.max(40, Math.min(990, x)), Math.max(40, Math.min(750, y)));
    }
    g.stroke();
  }
  // vias
  g.fillStyle = "rgba(210, 180, 90, 0.85)";
  for (let i = 0; i < 70; i++) {
    g.beginPath();
    g.arc(80 + rnd() * 880, 80 + rnd() * 640, 4, 0, Math.PI * 2);
    g.fill();
  }
  // silkscreen
  g.strokeStyle = "rgba(240, 244, 246, 0.85)";
  g.lineWidth = 3;
  g.strokeRect(330, 420, 520, 120); // chip outline
  g.strokeRect(160, 30, 760, 70); // top header
  g.strokeRect(330, 690, 600, 70); // bottom header
  g.beginPath();
  g.arc(965, 70, 26, 0, Math.PI * 2); // mounting hole ring
  g.stroke();
  g.beginPath();
  g.arc(965, 720, 26, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(60, 740, 26, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = "rgba(240, 244, 246, 0.9)";
  g.font = "600 30px ui-sans-serif, system-ui, sans-serif";
  g.fillText("DIGITAL (PWM ~)", 420, 140);
  g.fillText("POWER", 360, 670);
  g.fillText("ANALOG IN", 660, 670);
  g.font = "600 22px ui-monospace, monospace";
  g.fillText("TX", 520, 300);
  g.fillText("RX", 520, 340);
  g.fillText("L", 520, 220);
  g.fillText("ON", 860, 330);
  // mounting holes
  for (const [x, y] of [[965, 70], [965, 720], [60, 740]] as const) {
    g.fillStyle = "#c9a646";
    g.beginPath();
    g.arc(x, y, 18, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#050505";
    g.beginPath();
    g.arc(x, y, 11, 0, Math.PI * 2);
    g.fill();
  }
  pcbTex = new THREE.CanvasTexture(c);
  pcbTex.colorSpace = THREE.SRGBColorSpace;
  pcbTex.anisotropy = 8;
  return pcbTex;
}

let holesTex: THREE.CanvasTexture | undefined;
function headerTexture(): THREE.CanvasTexture {
  if (holesTex) return holesTex;
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "#171717";
  g.fillRect(0, 0, 512, 32);
  g.fillStyle = "#030303";
  for (let i = 0; i < 16; i++) g.fillRect(8 + i * 32, 8, 16, 16);
  holesTex = new THREE.CanvasTexture(c);
  holesTex.colorSpace = THREE.SRGBColorSpace;
  return holesTex;
}

export function Board({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  const top = useMemo(() => pcbTexture(), []);
  const holes = useMemo(() => headerTexture(), []);
  const edge = "#0b4452";
  return (
    <group position={position} scale={scale}>
      {/* PCB: textured top face, plain sides */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[0.686, 0.016, 0.534]} />
        <meshStandardMaterial attach="material-0" color={edge} roughness={0.6} />
        <meshStandardMaterial attach="material-1" color={edge} roughness={0.6} />
        <meshStandardMaterial attach="material-2" map={top} roughness={0.45} />
        <meshStandardMaterial attach="material-3" color={edge} roughness={0.6} />
        <meshStandardMaterial attach="material-4" color={edge} roughness={0.6} />
        <meshStandardMaterial attach="material-5" color={edge} roughness={0.6} />
      </mesh>
      {/* USB-B and barrel jack on the left edge */}
      <mesh position={[-0.29, 0.064, -0.12]} castShadow>
        <boxGeometry args={[0.16, 0.11, 0.12]} />
        <meshStandardMaterial color="#d9dbde" metalness={0.55} roughness={0.32} />
      </mesh>
      <mesh position={[-0.3, 0.06, 0.17]} castShadow>
        <boxGeometry args={[0.14, 0.1, 0.09]} />
        <meshStandardMaterial color="#0d0d0d" roughness={0.55} />
      </mesh>
      {/* DIP chip */}
      <RoundedBox args={[0.35, 0.03, 0.075]} radius={0.004} smoothness={1} position={[0.12, 0.024, 0.09]} castShadow>
        <meshStandardMaterial color="#141414" roughness={0.45} />
      </RoundedBox>
      {/* crystal + reset button */}
      <mesh position={[-0.02, 0.02, -0.02]} castShadow>
        <boxGeometry args={[0.11, 0.035, 0.045]} />
        <meshStandardMaterial color="#d9dbde" metalness={0.55} roughness={0.3} />
      </mesh>
      <mesh position={[-0.27, 0.02, -0.23]} castShadow>
        <boxGeometry args={[0.06, 0.025, 0.06]} />
        <meshStandardMaterial color="#cfcfcf" metalness={0.7} roughness={0.35} />
      </mesh>
      {/* female headers (holes on top) */}
      {[
        [0.06, -0.235, 0.52],
        [0.13, 0.235, 0.4],
      ].map(([x, z, len]) => (
        <mesh key={z} position={[x!, 0.0505, z!]} castShadow>
          <boxGeometry args={[len!, 0.085, 0.026]} />
          <meshStandardMaterial attach="material-0" color="#121212" roughness={0.6} />
          <meshStandardMaterial attach="material-1" color="#121212" roughness={0.6} />
          <meshStandardMaterial attach="material-2" map={holes} roughness={0.55} />
          <meshStandardMaterial attach="material-3" color="#121212" roughness={0.6} />
          <meshStandardMaterial attach="material-4" color="#121212" roughness={0.6} />
          <meshStandardMaterial attach="material-5" color="#121212" roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}
