// The project in its own designed case: the shells, caps and light pipes the Case view built (the
// same meshes, in the case colour or a finish), with the live screen in the display window, the
// button caps pressable where the case has them (they travel in along their opening), LEDs glowing
// at their light pipes and sound rings at the speaker grille. Any outline or body works: it only
// draws the meshes the case has and puts the live parts at the case's own openings.
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { ContactShadows } from "@react-three/drei";
import * as THREE from "three";
import { ReadoutsContext, useDeviceSource } from "../context.ts";
import { SCREEN_TYPES, type CaseFit, type CaseOpening } from "../classify.ts";
import { caseGeometry } from "../caseModel.ts";
import { createColorScreenTexture, createScreenTexture } from "../screenTexture.ts";
import { buttonLabel, Led, SHELLS, type ShellFinish } from "./Handheld.tsx";

/** "design" is the colour the case was designed in; the others are the handheld finishes. */
export type CaseFinish = "design" | ShellFinish;

/** Scene size of the case's tallest side (same as the generic handheld, so the camera fits both). */
const MAX_H = 7.0;
const MAX_W = 6.0;
const STAND_TOP = 0.34;
const TILT = -0.17;

const v3 = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);

/** Rotation that maps local x / y / z to the opening's u / v / outward normal (right-handed). */
function basis(o: CaseOpening): THREE.Quaternion {
  const n = v3(o.n).normalize();
  const v = v3(o.vAxis).normalize();
  const u = new THREE.Vector3().crossVectors(v, n).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
}

/** A point on the opening's outer surface, `out` mm further along its normal. */
function outer(o: CaseOpening, out = 0): THREE.Vector3 {
  return v3(o.at).addScaledVector(v3(o.n).normalize(), o.depth + out);
}

export function caseBounds(fit: CaseFit): THREE.Box3 {
  const box = new THREE.Box3();
  for (const g of caseGeometry(fit.model)) if (g.kind === "shell" || g.kind === "cap") box.union(g.geometry.boundingBox!);
  return box;
}

export function CaseDevice({ fit, finish, onPressKey }: { fit: CaseFit; finish: CaseFinish; onPressKey?: (fn: (i: number, down: boolean) => void) => void }) {
  const geos = useMemo(() => caseGeometry(fit.model), [fit.model]);
  const box = useMemo(() => caseBounds(fit), [fit]);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const k = Math.min(MAX_H / Math.max(size.y, 1), MAX_W / Math.max(size.x, 1));
  const shellColor = finish === "design" ? fit.model.color ?? geos.find((g) => g.kind === "shell")?.color ?? SHELLS.ceramic.color : SHELLS[finish].color;
  const roughness = finish === "design" ? 0.5 : SHELLS[finish].roughness;
  const capColor = (own: string) => (finish === "design" ? own : SHELLS[finish].button);

  const pressFns = useRef<((down: boolean) => void)[]>([]);
  useEffect(() => {
    onPressKey?.((i, down) => pressFns.current[i]?.(down));
  }, [onPressKey]);
  // keys press every button, even one the case has no opening for
  const source = useDeviceSource();
  fit.buttons.forEach((b, i) => {
    if (!b.opening) pressFns.current[i] = (down) => (down ? source.press(b.id) : source.release(b.id));
  });

  const capBodies = new Set(fit.buttons.map((b) => b.cap).filter(Boolean));
  const shellMat = useMemo(() => new THREE.MeshPhysicalMaterial({ color: shellColor, roughness, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.4 }), [shellColor, roughness]);
  useEffect(() => () => shellMat.dispose(), [shellMat]);

  return (
    <group>
      <group position={[0, STAND_TOP + 0.08, 0.25]} rotation-x={TILT}>
        <group scale={k}>
          <group position={[-center.x, -box.min.y, -center.z]} data-testid="case-device">
            {geos.map((g) => {
              if (capBodies.has(g.body)) return null; // drawn by its button, so it travels
              if (g.kind === "shell") return <mesh key={g.body} geometry={g.geometry} material={shellMat} castShadow receiveShadow name={`case-${g.body}`} />;
              const pipe = g.body.startsWith("light-pipe-");
              return (
                <mesh key={g.body} geometry={g.geometry} name={`case-${g.body}`}>
                  {pipe ? <meshPhysicalMaterial color={g.color} roughness={0.15} transmission={0.4} transparent opacity={0.85} /> : <meshStandardMaterial color={g.kind === "cap" ? capColor(g.color) : g.color} roughness={0.55} metalness={g.kind === "part" ? 0.1 : 0} />}
                </mesh>
              );
            })}
            {fit.screen?.window ? <WindowScreen partId={fit.screen.id} type={fit.screen.type} o={fit.screen.window} /> : null}
            {fit.buttons.map((b, i) =>
              b.opening ? (
                <CaseButton
                  key={b.id}
                  index={i}
                  partId={b.id}
                  o={b.opening}
                  cap={b.cap ? geos.find((g) => g.body === b.cap) : undefined}
                  color={capColor(b.cap ? geos.find((g) => g.body === b.cap)?.color ?? "#34343a" : "#34343a")}
                  registerPress={(fn) => void (pressFns.current[i] = fn)}
                />
              ) : null,
            )}
            {fit.leds.map((l) => (
              <LedAt key={l.id} id={l.id} color={l.color} o={l.opening} />
            ))}
            {fit.grilles.map((o) => (
              <GrilleRings key={`${o.part}-${o.feature}`} o={o} />
            ))}
            {fit.lenses.map((o) => (
              <CameraLens key={`${o.part}-${o.feature}`} o={o} />
            ))}
          </group>
        </group>
      </group>
      {/* Stand: a puck the case rests on */}
      <mesh position={[0, 0.17, 0.25]} castShadow receiveShadow>
        <cylinderGeometry args={[Math.max(1.8, size.x * k * 0.4), Math.max(1.9, size.x * k * 0.4 + 0.12), 0.34, 96]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.6} metalness={0.2} />
      </mesh>
      <ContactShadows position={[0, 0.005, 0]} opacity={0.7} scale={16} blur={2.6} far={9} resolution={512} frames={Infinity} />
    </group>
  );
}

/** The live display in the case's window: in the inner wall's plane, the active area's size. */
function WindowScreen({ partId, type, o }: { partId: string; type: string; o: CaseOpening }) {
  const source = useDeviceSource();
  const readouts = useContext(ReadoutsContext);
  const st = SCREEN_TYPES[type];
  const color = st?.kind === "tft";
  const mono = useMemo(() => (!color && st ? createScreenTexture(st.screen) : undefined), [color, st]);
  const rgb = useMemo(() => (color ? createColorScreenTexture() : undefined), [color]);
  useEffect(() => () => (mono?.dispose(), rgb?.dispose()), [mono, rgb]);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(() => {
    const s = source.partState(partId);
    if (mono) {
      mono.update(s);
      if (mat.current) mat.current.color.setScalar(0.35 + 0.65 * mono.level);
      if (s && typeof s.lit === "number") readouts.current["screen lit"] = `${s.lit} px`;
    } else if (rgb) {
      rgb.update(source.framebuffer?.(partId), s);
      if (mat.current) mat.current.color.setScalar(0.2 + 0.8 * rgb.level);
    }
  });
  const w = o.screen?.u ?? o.u;
  const h = o.screen?.v ?? o.v;
  const round = (o.screen?.shape ?? o.shape) === "round";
  const q = useMemo(() => basis(o), [o]);
  // in the inner wall's plane (the module's glass is at or behind it), facing out
  const at = useMemo(() => v3(o.at).addScaledVector(v3(o.n).normalize(), 0.05), [o]);
  const tex = mono?.texture ?? rgb?.texture;
  return (
    <group position={at} quaternion={q} name={`screen-${partId}`}>
      <mesh>
        {round ? <circleGeometry args={[w / 2, 64]} /> : <planeGeometry args={[w, h]} />}
        <meshBasicMaterial ref={mat} map={tex ?? null} toneMapped={false} />
      </mesh>
    </group>
  );
}

function CaseButton({ index, partId, o, cap, color, registerPress }: { index: number; partId: string; o: CaseOpening; cap: { geometry: THREE.BufferGeometry } | undefined; color: string; registerPress: (fn: (down: boolean) => void) => void }) {
  const source = useDeviceSource();
  const group = useRef<THREE.Group>(null);
  const [hover, setHover] = useState(false);
  const held = useRef(false);
  const n = useMemo(() => v3(o.n).normalize(), [o]);
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
  // the cap travels in along its opening (exaggerated a little so the press reads at this scale)
  const travel = Math.max(0.8, (o.insert?.travel ?? 0.25) * 3);
  useFrame((_, dt) => {
    const st = source.partState(partId);
    const pressed = held.current || st?.pressed === true;
    const g = group.current;
    if (!g) return;
    const cur = -g.position.dot(n);
    const next = cur + ((pressed ? travel : 0) - cur) * Math.min(1, dt * 30);
    g.position.copy(n).multiplyScalar(-next);
  });
  const hitAt = useMemo(() => outer(o, (o.insert?.protrude ?? 0) / 2), [o]);
  // beside the cap, never over it: under it on the front / back, out past it on a side, above it on the top
  const labelAt = useMemo(() => {
    const p = o.insert?.protrude ?? 0;
    if (Math.abs(o.n[2]) > 0.5) return outer(o, p + 1).add(new THREE.Vector3(0, -(o.u / 2 + 4.5), 0));
    if (Math.abs(o.n[0]) > 0.5) return outer(o, p + 12);
    return outer(o, p + 4);
  }, [o]);
  const hitR = Math.max(4.5, o.u * 1.2);
  const handlers = {
    onPointerDown: (e: { stopPropagation(): void; pointerId: number; target: EventTarget | null }) => {
      e.stopPropagation();
      (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
      down(true);
    },
    onPointerUp: (e: { stopPropagation(): void }) => {
      e.stopPropagation();
      down(false);
    },
    onPointerLeave: () => {
      setHover(false);
      down(false);
    },
    onPointerEnter: () => setHover(true),
  };
  return (
    <group name={`button-${partId}`}>
      <group ref={group}>
        {cap ? (
          <mesh geometry={cap.geometry} castShadow>
            <meshPhysicalMaterial color={color} roughness={0.35} clearcoat={0.6} clearcoatRoughness={0.25} emissive={hover ? "#ffffff" : "#000000"} emissiveIntensity={hover ? 0.12 : 0} />
          </mesh>
        ) : (
          // a hole without a printed cap: the switch's own plunger, drawn as a short cylinder
          <mesh position={outer(o, -0.4)} quaternion={new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n)}>
            <cylinderGeometry args={[o.u * 0.42, o.u * 0.42, 1.2, 32]} />
            <meshStandardMaterial color={color} roughness={0.4} emissive={hover ? "#ffffff" : "#000000"} emissiveIntensity={hover ? 0.12 : 0} />
          </mesh>
        )}
      </group>
      {/* a generous invisible target round the cap: a 4 mm cap is small on screen */}
      <mesh position={hitAt} {...handlers}>
        <sphereGeometry args={[hitR, 16, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {/* key badge beside the cap (hidden by the case when it is on the far side) */}
      <KeyBadge index={index} text={buttonLabel(partId)} position={labelAt} />
    </group>
  );
}

/** "1 BTN" as a small sprite (always faces the camera; the case hides it from behind). */
function KeyBadge({ index, text, position }: { index: number; text: string; position: THREE.Vector3 }) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 128;
    const g = c.getContext("2d")!;
    g.scale(2, 2);
    g.font = "500 30px 'Geist Mono Variable', ui-monospace, monospace";
    const tw = Math.min(150, g.measureText(text).width);
    const w = 64 + tw + 22;
    const x0 = (256 - w) / 2;
    g.fillStyle = "rgba(10,10,10,0.78)";
    g.beginPath();
    g.roundRect(x0, 6, w, 52, 26);
    g.fill();
    g.fillStyle = "#2a2a2a";
    g.beginPath();
    g.roundRect(x0 + 8, 13, 38, 38, 9);
    g.fill();
    g.fillStyle = "#ffffff";
    g.textBaseline = "middle";
    g.textAlign = "center";
    g.fillText(String(index + 1), x0 + 27, 33);
    g.fillStyle = "#d6d6d6";
    g.textAlign = "left";
    g.fillText(text, x0 + 58, 33, 150);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [index, text]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <sprite position={position} scale={[18, 4.5, 1]} renderOrder={5}>
      <spriteMaterial map={tex} transparent depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

function LedAt({ id, color, o }: { id: string; color: string; o: CaseOpening }) {
  const q = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v3(o.n).normalize()), [o]);
  const at = useMemo(() => outer(o, 0.05), [o]);
  // Led draws a dome facing +y local; point it out of the case
  return (
    <group position={at} quaternion={q}>
      <Led partId={id} color={color} position={[0, 0, 0]} size={Math.max(0.9, o.u / 2)} />
    </group>
  );
}

/** Sound rings out of the grille while its speaker (or any buzzer) sounds. */
function GrilleRings({ o }: { o: CaseOpening }) {
  const source = useDeviceSource();
  const readouts = useContext(ReadoutsContext);
  const rings = useRef<THREE.Mesh[]>([]);
  const phase = useRef(0);
  const q = useMemo(() => basis(o), [o]);
  const at = useMemo(() => outer(o, 0.2), [o]);
  const r = Math.max(o.u, o.v) / 2;
  useFrame((_, dt) => {
    const st = source.partState(o.part);
    const sounding = st?.sounding === true || st?.playing === true;
    readouts.current.speaker = sounding ? "sounding" : "quiet";
    if (sounding) phase.current += dt;
    rings.current.forEach((m, i) => {
      if (!m) return;
      const p = (phase.current * 1.6 + i / 3) % 1;
      m.visible = sounding;
      m.scale.setScalar(0.6 + p * 2.4);
      (m.material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.55;
    });
  });
  return (
    <group position={at} quaternion={q}>
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={(m) => void (rings.current[i] = m!)} visible={false}>
          <ringGeometry args={[r * 0.9, r, 64]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Round 13: a camera lens in its hole: dark glass in a metal ring at the inner wall (the hole is
 * wider than the lens so the wall stays out of the picture); a red ring glows while the camera takes
 * pictures (the part's camera_on).
 */
function CameraLens({ o }: { o: CaseOpening }) {
  const source = useDeviceSource();
  const ring = useRef<THREE.MeshBasicMaterial>(null);
  const q = useMemo(() => basis(o), [o]);
  const at = useMemo(() => v3(o.at).addScaledVector(v3(o.n).normalize(), 0.05), [o]);
  const r = Math.max(1.5, Math.min(o.u / 2 - 0.3, 4));
  useFrame(() => {
    const on = source.partState(o.part)?.camera_on === true;
    if (ring.current) ring.current.opacity = on ? 0.9 : 0;
  });
  return (
    <group position={at} quaternion={q} name={`lens-${o.part}`}>
      <mesh>
        <circleGeometry args={[r, 48]} />
        <meshPhysicalMaterial color="#05070a" roughness={0.05} metalness={0.2} clearcoat={1} clearcoatRoughness={0.05} />
      </mesh>
      <mesh position={[-r * 0.3, r * 0.3, 0.02]}>
        <circleGeometry args={[r * 0.25, 24]} />
        <meshBasicMaterial color="#5b6f95" transparent opacity={0.45} />
      </mesh>
      <mesh position={[0, 0, 0.01]}>
        <ringGeometry args={[r, r + 0.6, 48]} />
        <meshStandardMaterial color="#9aa3ad" roughness={0.3} metalness={0.8} />
      </mesh>
      <mesh position={[0, 0, 0.03]}>
        <ringGeometry args={[r + 0.6, r + 1.1, 48]} />
        <meshBasicMaterial ref={ring} color="#ff3b2f" transparent opacity={0} toneMapped={false} />
      </mesh>
    </group>
  );
}
