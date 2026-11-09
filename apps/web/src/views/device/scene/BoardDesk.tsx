// Fallback presentation: the main board on a desk with a small breadboard holding the project's
// LEDs (lit from the simulation), plus the board's own "L" LED.
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { ContactShadows, RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { useDeviceSource } from "../context.ts";
import type { DeviceLayout } from "../classify.ts";
import { Board } from "./Board.tsx";
import { Led } from "./Handheld.tsx";
import { glowTexture } from "./Studio.tsx";

export function BoardDesk({ layout }: { layout: DeviceLayout }) {
  const leds = layout.leds.slice(0, 10);
  return (
    <group>
      <Board position={[-1.6, 0.05, 0]} scale={5} />
      {layout.board ? <BoardLed boardId={layout.board.id} /> : null}
      {/* breadboard */}
      <group position={[2.6, 0.18, 0]}>
        <RoundedBox args={[3.2, 0.36, 2.2]} radius={0.08} smoothness={3} castShadow receiveShadow>
          <meshStandardMaterial color="#ecebe6" roughness={0.7} />
        </RoundedBox>
        <mesh position={[0, 0.182, 0]} rotation-x={-Math.PI / 2}>
          <planeGeometry args={[3.0, 2.0]} />
          <meshStandardMaterial map={breadboardTexture()} transparent roughness={0.7} depthWrite={false} />
        </mesh>
        {leds.map((l, i) => (
          <group key={l.id} position={[-1.2 + (i % 5) * 0.6, 0.18, i < 5 ? -0.5 : 0.5]}>
            <mesh position={[0, 0.18, 0]} castShadow>
              <cylinderGeometry args={[0.13, 0.13, 0.36, 24]} />
              <meshStandardMaterial color="#222" transparent opacity={0.0} />
            </mesh>
            <Led partId={l.id} color={l.color} position={[0, 0.0, 0]} size={0.2} />
          </group>
        ))}
      </group>
      <ContactShadows position={[0, 0.002, 0]} opacity={0.6} scale={14} blur={2.4} far={4} resolution={512} />
    </group>
  );
}

function BoardLed({ boardId }: { boardId: string }) {
  const source = useDeviceSource();
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const sprite = useRef<THREE.Sprite>(null);
  useFrame(() => {
    const on = Number(source.partState(boardId)?.led_l ?? 0) > 0;
    mat.current?.color.set(on ? "#ffb23f" : "#3a2a10");
    if (sprite.current) sprite.current.visible = on;
  });
  return (
    <group position={[-1.6 + 0.0, 0.16, -0.9]}>
      <mesh>
        <boxGeometry args={[0.12, 0.05, 0.08]} />
        <meshBasicMaterial ref={mat} color="#3a2a10" toneMapped={false} />
      </mesh>
      <sprite ref={sprite} scale={0.9}>
        <spriteMaterial map={glowTexture()} color="#ffb23f" transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </sprite>
    </group>
  );
}

let bbTex: THREE.CanvasTexture | undefined;
/** Hole grid of a half-size breadboard: two terminal halves and the power rails. */
function breadboardTexture(): THREE.CanvasTexture {
  if (bbTex) return bbTex;
  const c = document.createElement("canvas");
  c.width = 900;
  c.height = 600;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = "rgba(0,0,0,0.55)";
  const hole = (x: number, y: number) => g.fillRect(x - 4, y - 4, 8, 8);
  for (let col = 0; col < 30; col++) {
    const x = 30 + col * 28.5;
    for (let r = 0; r < 5; r++) hole(x, 150 + r * 26);
    for (let r = 0; r < 5; r++) hole(x, 345 + r * 26);
    if (col % 6 !== 5) for (const y of [36, 62, 538, 564]) hole(x, y);
  }
  g.fillStyle = "rgba(0,0,0,0.12)";
  g.fillRect(0, 288, 900, 24); // centre channel
  g.fillStyle = "rgba(214, 64, 52, 0.7)";
  g.fillRect(20, 16, 860, 3);
  g.fillRect(20, 518, 860, 3);
  g.fillStyle = "rgba(52, 110, 214, 0.7)";
  g.fillRect(20, 80, 860, 3);
  g.fillRect(20, 582, 860, 3);
  bbTex = new THREE.CanvasTexture(c);
  bbTex.colorSpace = THREE.SRGBColorSpace;
  bbTex.anisotropy = 8;
  return bbTex;
}
