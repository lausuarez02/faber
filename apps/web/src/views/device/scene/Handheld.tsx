// A handheld / pet device: rounded pebble shell, the live display behind glass, physical buttons
// that travel when pressed (wired to the simulation's press / release), LEDs that glow, a speaker
// grille that sends out sound rings while the buzzer sounds, a keychain loop and a desk stand.
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { RoundedBox, ContactShadows } from "@react-three/drei";
import * as THREE from "three";
import { useDeviceSource, ReadoutsContext } from "../context.ts";
import { SCREEN_TYPES, type DeviceLayout } from "../classify.ts";
import { createColorScreenTexture, createScreenTexture } from "../screenTexture.ts";
import { glowTexture, ledColor } from "./Studio.tsx";
import { useContext } from "react";

export type ShellFinish = "ceramic" | "graphite" | "signal";

export const SHELLS: Record<ShellFinish, { color: string; roughness: number; button: string; ink: string; label: string }> = {
  ceramic: { color: "#e7e5df", roughness: 0.5, button: "#34343a", ink: "#57575c", label: "Ceramic" },
  graphite: { color: "#2a2a2c", roughness: 0.42, button: "#d9d7d1", ink: "#9a9a9e", label: "Graphite" },
  signal: { color: "#ff5a1f", roughness: 0.48, button: "#1b1b1d", ink: "#3a1405", label: "Signal" },
};

/** "btnFeed" → "FEED", "button_a" → "A", anything else upper-cased. */
export function buttonLabel(id: string): string {
  const s = id.replace(/^(btn|button|key|sw)[-_]?/i, "") || id;
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase().slice(0, 10);
}

/** Text printed on the shell under a button (pad-printed look), with its key number. */
function PrintedLabel({ text, index, color }: { text: string; index: number; color: string }) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 96;
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = color;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "600 46px 'Geist Variable', ui-sans-serif, system-ui, sans-serif";
    // letter-spaced caps
    const label = text.split("").join(String.fromCharCode(8202));
    g.fillText(label, 256, 40);
    g.font = "500 26px 'Geist Mono Variable', ui-monospace, monospace";
    g.globalAlpha = 0.6;
    g.fillText(String(index + 1), 256, 82);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [text, index, color]);
  return (
    <mesh position={[0, -0.78, 0.006]}>
      <planeGeometry args={[1.4, 0.2625]} />
      <meshStandardMaterial map={tex} transparent roughness={0.6} depthWrite={false} />
    </mesh>
  );
}

const W = 5.4;
const H = 7.6;
const D = 1.3;
const FRONT = D / 2;

export function Handheld({ layout, finish, onPressKey }: { layout: DeviceLayout; finish: ShellFinish; onPressKey?: (fn: (i: number, down: boolean) => void) => void }) {
  const shell = SHELLS[finish];
  const group = useRef<THREE.Group>(null);
  const screenType = layout.screen ? SCREEN_TYPES[layout.screen.type] : undefined;
  const screenW = 3.9;
  const screenH = screenType ? screenW / screenType.aspect : 1.95;

  // Buttons: up to 3 in a row, more wrap to a second row.
  const buttons = layout.buttons.slice(0, 8);
  const perRow = Math.min(3, Math.max(1, buttons.length));
  const btnPos = buttons.map((b, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, buttons.length - row * perRow);
    const col = i % perRow;
    const spacing = 1.45;
    return { id: b.id, x: (col - (inRow - 1) / 2) * spacing, y: -1.15 - row * 1.35 };
  });
  const pressFns = useRef<((down: boolean) => void)[]>([]);
  useEffect(() => {
    onPressKey?.((i, down) => pressFns.current[i]?.(down));
  }, [onPressKey]);

  return (
    <group position={[0, 0, 0]}>
      <group ref={group} position={[0, H / 2 + 0.55, 0]} rotation-x={-0.17}>
        {/* Shell */}
        <RoundedBox args={[W, H, D]} radius={0.62} smoothness={8} castShadow receiveShadow>
          <meshPhysicalMaterial color={shell.color} roughness={shell.roughness} metalness={0} clearcoat={0.35} clearcoatRoughness={0.4} />
        </RoundedBox>
        {/* Seam line around the edge (two-part case) */}
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[W + 0.004, H - 1.3, 0.025]} />
          <meshStandardMaterial color="#000" transparent opacity={0.18} />
        </mesh>
        {/* Screen module */}
        {layout.screen && screenType?.kind === "tft" ? <ColorScreen partId={layout.screen.id} w={screenW} h={screenH} y={1.3} /> : null}
        {layout.screen && screenType && screenType.kind !== "tft" ? <Screen partId={layout.screen.id} screen={screenType.screen} w={screenW} h={screenH} y={1.45} /> : null}
        {/* Power LED + project LEDs, top left */}
        <PowerDot />
        {layout.leds.slice(0, 4).map((l, i) => (
          <Led key={l.id} partId={l.id} color={l.color} position={[-W / 2 + 1.35 + i * 0.5, H / 2 - 0.62, FRONT]} />
        ))}
        {/* Buttons */}
        {btnPos.map((b, i) => (
          <PushButton key={b.id} index={i} partId={b.id} x={b.x} y={b.y} cap={shell.button} labelInk={shell.ink} registerPress={(fn) => void (pressFns.current[i] = fn)} />
        ))}
        {/* Speaker grille + sound rings */}
        <Speaker buzzers={layout.buzzers.map((b) => b.id)} x={W / 2 - 1.15} y={-H / 2 + 0.95} />
        {/* Keychain loop */}
        <mesh position={[0, H / 2 + 0.25, 0]} rotation-y={Math.PI / 2} castShadow>
          <torusGeometry args={[0.42, 0.075, 16, 48]} />
          <meshStandardMaterial color="#b9bcc2" metalness={1} roughness={0.25} />
        </mesh>
      </group>
      {/* Stand: a puck with a slot */}
      <mesh position={[0, 0.17, 0.25]} castShadow receiveShadow>
        <cylinderGeometry args={[3.4, 3.55, 0.34, 96]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.6} metalness={0.2} />
      </mesh>
      <mesh position={[0, 0.345, 0.25]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[3.0, 3.4, 96]} />
        <meshStandardMaterial color="#262626" roughness={0.4} metalness={0.4} />
      </mesh>
      <ContactShadows position={[0, 0.005, 0]} opacity={0.7} scale={16} blur={2.6} far={9} resolution={512} frames={Infinity} />
    </group>
  );
}

function Screen({ partId, screen, w, h, y }: { partId: string; screen: string; w: number; h: number; y: number }) {
  const source = useDeviceSource();
  const readouts = useContext(ReadoutsContext);
  const tex = useMemo(() => createScreenTexture(screen), [screen]);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const halo = useRef<THREE.Mesh>(null);
  useEffect(() => () => tex.dispose(), [tex]);
  useFrame(() => {
    const st = source.partState(partId);
    tex.update(st);
    if (mat.current) {
      const k = 0.35 + 0.65 * tex.level;
      mat.current.color.setScalar(k);
    }
    if (halo.current) (halo.current.material as THREE.MeshBasicMaterial).opacity = 0.05 + 0.08 * tex.level;
    if (st && typeof st.lit === "number") readouts.current["screen lit"] = `${st.lit} px`;
  });
  const bezelW = w + 0.5;
  const bezelH = h + 0.62;
  return (
    <group position={[0, y, FRONT]}>
      {/* recessed black bezel */}
      <RoundedBox args={[bezelW, bezelH, 0.12]} radius={0.12} smoothness={4} position={[0, 0, 0.0]}>
        <meshPhysicalMaterial color="#070707" roughness={0.3} clearcoat={1} clearcoatRoughness={0.08} />
      </RoundedBox>
      {/* the panel: unlit, so pixels are exactly what the firmware drew */}
      <mesh position={[0, 0, 0.065]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial ref={mat} map={tex.texture} toneMapped={false} />
      </mesh>
      {/* faint light spill on the bezel */}
      <mesh ref={halo} position={[0, 0, 0.063]}>
        <planeGeometry args={[w + 0.3, h + 0.3]} />
        <meshBasicMaterial color="#cfe6ff" transparent opacity={0.08} toneMapped={false} />
      </mesh>
      {/* cover glass: catches the studio reflections */}
      <mesh position={[0, 0, 0.075]}>
        <planeGeometry args={[bezelW - 0.08, bezelH - 0.08]} />
        <meshPhysicalMaterial color="#ffffff" transparent opacity={0.06} roughness={0.04} metalness={0} clearcoat={1} clearcoatRoughness={0} envMapIntensity={2.4} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** A colour TFT behind glass: pixels from the panel's framebuffer, backlight as brightness. */
function ColorScreen({ partId, w, h, y }: { partId: string; w: number; h: number; y: number }) {
  const source = useDeviceSource();
  const readouts = useContext(ReadoutsContext);
  const tex = useMemo(() => createColorScreenTexture(), []);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useEffect(() => () => tex.dispose(), [tex]);
  useFrame(() => {
    const st = source.partState(partId);
    tex.update(source.framebuffer?.(partId), st);
    if (mat.current) mat.current.color.setScalar(0.2 + 0.8 * tex.level);
  });
  const bezelW = w + 0.42;
  const bezelH = h + 0.5;
  return (
    <group position={[0, y, FRONT]}>
      <RoundedBox args={[bezelW, bezelH, 0.12]} radius={0.12} smoothness={4}>
        <meshPhysicalMaterial color="#070707" roughness={0.3} clearcoat={1} clearcoatRoughness={0.08} />
      </RoundedBox>
      <mesh position={[0, 0, 0.065]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial ref={mat} map={tex.texture} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, 0.075]}>
        <planeGeometry args={[bezelW - 0.08, bezelH - 0.08]} />
        <meshPhysicalMaterial color="#ffffff" transparent opacity={0.06} roughness={0.04} clearcoat={1} clearcoatRoughness={0} envMapIntensity={2.4} depthWrite={false} />
      </mesh>
    </group>
  );
}

function PowerDot() {
  const source = useDeviceSource();
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(() => {
    if (!mat.current) return;
    const on = source.runState() === "running";
    mat.current.color.set(on ? "#3ddc97" : "#3a3a3a");
  });
  return (
    <mesh position={[-W / 2 + 0.75, H / 2 - 0.62, FRONT + 0.005]}>
      <circleGeometry args={[0.08, 24]} />
      <meshBasicMaterial ref={mat} color="#3a3a3a" toneMapped={false} />
    </mesh>
  );
}

export function Led({ partId, color, position, size = 0.16 }: { partId: string; color: string; position: [number, number, number]; size?: number }) {
  const source = useDeviceSource();
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const sprite = useRef<THREE.Sprite>(null);
  const tint = useMemo(() => new THREE.Color(ledColor(color)), [color]);
  useFrame(() => {
    const st = source.partState(partId);
    const b = Math.max(0, Math.min(1, Number(st?.brightness ?? 0)));
    const c = typeof st?.color === "string" ? ledColor(st.color) : undefined;
    if (c) tint.set(c);
    if (mat.current) {
      mat.current.emissive.copy(tint);
      mat.current.emissiveIntensity = 0.15 + b * 3.2;
      mat.current.color.copy(tint).multiplyScalar(0.35 + b * 0.4);
    }
    if (sprite.current) {
      sprite.current.visible = b > 0.03;
      (sprite.current.material as THREE.SpriteMaterial).opacity = b * 0.9;
      (sprite.current.material as THREE.SpriteMaterial).color.copy(tint);
    }
  });
  return (
    <group position={position}>
      <mesh castShadow>
        <sphereGeometry args={[size, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial ref={mat} color={tint} roughness={0.2} transparent opacity={0.92} toneMapped={false} />
      </mesh>
      <sprite ref={sprite} scale={size * 9} position={[0, size * 0.4, 0.05]}>
        <spriteMaterial map={glowTexture()} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </sprite>
    </group>
  );
}

function PushButton({ index, partId, x, y, cap, labelInk, registerPress }: { index: number; partId: string; x: number; y: number; cap: string; labelInk: string; registerPress: (fn: (down: boolean) => void) => void }) {
  const source = useDeviceSource();
  const capRef = useRef<THREE.Group>(null);
  const [hover, setHover] = useState(false);
  const held = useRef(false);
  const down = (v: boolean) => {
    if (held.current === v) return;
    held.current = v;
    if (v) source.press(partId);
    else source.release(partId);
  };
  useEffect(() => {
    registerPress(down);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useFrame((_, dt) => {
    const st = source.partState(partId);
    const pressed = held.current || st?.pressed === true;
    const target = pressed ? -0.13 : 0;
    if (capRef.current) capRef.current.position.z += (target - capRef.current.position.z) * Math.min(1, dt * 30);
  });
  return (
    <group position={[x, y, FRONT]}>
      {/* well */}
      <mesh position={[0, 0, 0.005]}>
        <circleGeometry args={[0.56, 48]} />
        <meshStandardMaterial color="#000" transparent opacity={0.35} />
      </mesh>
      <group ref={capRef}>
        <mesh
          position={[0, 0, 0.12]}
          rotation-x={Math.PI / 2}
          castShadow
          onPointerDown={(e) => {
            e.stopPropagation();
            (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
            down(true);
          }}
          onPointerUp={(e) => {
            e.stopPropagation();
            down(false);
          }}
          onPointerLeave={() => {
            setHover(false);
            down(false);
          }}
          onPointerEnter={() => setHover(true)}
        >
          <cylinderGeometry args={[0.46, 0.48, 0.3, 48]} />
          <meshPhysicalMaterial color={cap} roughness={0.35} clearcoat={0.6} clearcoatRoughness={0.25} emissive={hover ? "#ffffff" : "#000000"} emissiveIntensity={hover ? 0.04 : 0} />
        </mesh>
        <mesh position={[0, 0, 0.272]}>
          <circleGeometry args={[0.44, 48]} />
          <meshPhysicalMaterial color={cap} roughness={0.28} clearcoat={1} clearcoatRoughness={0.12} />
        </mesh>
      </group>
      <PrintedLabel text={buttonLabel(partId)} index={index} color={labelInk} />
    </group>
  );
}

function Speaker({ buzzers, x, y }: { buzzers: string[]; x: number; y: number }) {
  const source = useDeviceSource();
  const readouts = useContext(ReadoutsContext);
  const rings = useRef<THREE.Mesh[]>([]);
  const phase = useRef(0);
  const holes = useMemo(() => {
    const pts: [number, number][] = [];
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) if (r * r + c * c <= 5) pts.push([c * 0.17, r * 0.17]);
    return pts;
  }, []);
  useFrame((_, dt) => {
    let sounding = false;
    for (const b of buzzers) if (source.partState(b)?.sounding === true) sounding = true;
    if (buzzers.length) readouts.current.buzzer = sounding ? "beeping" : "quiet";
    if (sounding) phase.current += dt;
    rings.current.forEach((m, i) => {
      if (!m) return;
      const p = (phase.current * 1.6 + i / 3) % 1;
      m.visible = sounding;
      m.scale.setScalar(0.5 + p * 2.6);
      (m.material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.5;
    });
  });
  return (
    <group position={[x, y, FRONT + 0.004]}>
      {holes.map(([hx, hy], i) => (
        <mesh key={i} position={[hx, hy, 0]}>
          <circleGeometry args={[0.045, 12]} />
          <meshBasicMaterial color="#000" transparent opacity={0.75} />
        </mesh>
      ))}
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={(m) => void (rings.current[i] = m!)} position={[0, 0, 0.02]} visible={false}>
          <ringGeometry args={[0.36, 0.4, 64]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
