// The robot in its world: the arena from fabwright.json (floor, walls, obstacles), a modeled 2WD rover
// whose wheels spin at the simulated speed, its HC-SR04 "eyes" with a sonar cone as long as the
// measured distance, an OLED face when the project has one, and the trail it drove.
//
// World coordinates are top-down cm with y DOWN and heading clockwise (world.ts); here 1 unit =
// 10 cm, X = x, Z = y (so +Z is "down" on the top view), and yaw = -heading.
import { useContext, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { PhysicsBinding, WorldSnapshot } from "@fabwright/physics";
import { ReadoutsContext, useDeviceSource } from "../context.ts";
import type { DeviceLayout } from "../classify.ts";
import { screenTypeOf } from "../classify.ts";
import { createScreenTexture } from "../screenTexture.ts";
import { glowTexture } from "./Studio.tsx";
import { Board } from "./Board.tsx";

export const CM = 0.1;

export interface ArenaFrame {
  cx: number;
  cy: number;
}

/** Map a top-view point (cm) into the scene. */
export function toScene(p: { x: number; y: number }, f: ArenaFrame): [number, number] {
  return [(p.x - f.cx) * CM, (p.y - f.cy) * CM];
}

export function Arena({ binding }: { binding: PhysicsBinding }) {
  const w = binding.world;
  const f: ArenaFrame = { cx: w.arena.width / 2, cy: w.arena.height / 2 };
  const wallH = 1.0;
  const t = w.arena.wallThickness * CM;
  const AW = w.arena.width * CM;
  const AH = w.arena.height * CM;
  const floorTex = useMemo(() => gridTexture(w.arena.width, w.arena.height), [w.arena.width, w.arena.height]);
  return (
    <group>
      {/* surrounding desk */}
      <mesh rotation-x={-Math.PI / 2} position-y={-0.02} receiveShadow>
        <planeGeometry args={[AW + 40, AH + 40]} />
        <meshStandardMaterial color="#0c0c0c" roughness={1} />
      </mesh>
      {/* arena floor: light grey mat with a 10 cm grid, like a test track */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[AW, AH]} />
        <meshStandardMaterial map={floorTex} roughness={0.78} metalness={0.05} />
      </mesh>
      {w.arena.enclosed ? (
        <>
          <Wall x={0} z={-AH / 2 - t / 2} w={AW + 2 * t} d={t} h={wallH} />
          <Wall x={0} z={AH / 2 + t / 2} w={AW + 2 * t} d={t} h={wallH} />
          <Wall x={-AW / 2 - t / 2} z={0} w={t} d={AH} h={wallH} />
          <Wall x={AW / 2 + t / 2} z={0} w={t} d={AH} h={wallH} />
        </>
      ) : null}
      {w.walls.map((wl, i) => {
        const [x1, z1] = toScene({ x: wl.x1, y: wl.y1 }, f);
        const [x2, z2] = toScene({ x: wl.x2, y: wl.y2 }, f);
        const len = Math.hypot(x2 - x1, z2 - z1);
        return <Wall key={`w${i}`} x={(x1 + x2) / 2} z={(z1 + z2) / 2} w={len} d={wl.thickness * CM} h={wallH} yaw={-Math.atan2(z2 - z1, x2 - x1)} />;
      })}
      {w.obstacles.map((o, i) => {
        const [x, z] = toScene(o, f);
        if (o.shape === "circle")
          return (
            <mesh key={`o${i}`} position={[x, 0.75, z]} castShadow receiveShadow>
              <cylinderGeometry args={[o.r * CM, o.r * CM, 1.5, 48]} />
              <meshStandardMaterial color="#d4d1ca" roughness={0.5} />
            </mesh>
          );
        const h = Math.min(1.2, Math.max(0.6, Math.min(o.w, o.h) * CM * 0.35));
        return (
          <group key={`o${i}`} position={[x, h / 2, z]} rotation-y={-((o.angle ?? 0) * Math.PI) / 180}>
            <RoundedBox args={[o.w * CM, h, o.h * CM]} radius={0.06} smoothness={3} castShadow receiveShadow>
              <meshStandardMaterial color={i % 2 ? "#4a4a4d" : "#b9a98b"} roughness={0.75} />
            </RoundedBox>
          </group>
        );
      })}
    </group>
  );
}

function Wall({ x, z, w, d, h, yaw = 0 }: { x: number; z: number; w: number; d: number; h: number; yaw?: number }) {
  return (
    <mesh position={[x, h / 2, z]} rotation-y={yaw} castShadow receiveShadow>
      <boxGeometry args={[w, h, Math.max(d, 0.05)]} />
      <meshStandardMaterial color="#3a3a3c" roughness={0.6} />
    </mesh>
  );
}

function gridTexture(wcm: number, hcm: number): THREE.CanvasTexture {
  const px = 4; // px per cm
  const c = document.createElement("canvas");
  c.width = Math.min(2048, Math.round(wcm * px));
  c.height = Math.min(2048, Math.round(hcm * px));
  const sx = c.width / wcm;
  const sy = c.height / hcm;
  const g = c.getContext("2d")!;
  g.fillStyle = "#262626";
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = "rgba(255,255,255,0.05)";
  g.lineWidth = 1;
  for (let x = 0; x <= wcm; x += 10) {
    g.beginPath();
    g.moveTo(x * sx, 0);
    g.lineTo(x * sx, c.height);
    g.stroke();
  }
  for (let y = 0; y <= hcm; y += 10) {
    g.beginPath();
    g.moveTo(0, y * sy);
    g.lineTo(c.width, y * sy);
    g.stroke();
  }
  g.strokeStyle = "rgba(255,255,255,0.11)";
  g.lineWidth = 2;
  for (let x = 0; x <= wcm; x += 50) {
    g.beginPath();
    g.moveTo(x * sx, 0);
    g.lineTo(x * sx, c.height);
    g.stroke();
  }
  for (let y = 0; y <= hcm; y += 50) {
    g.beginPath();
    g.moveTo(0, y * sy);
    g.lineTo(c.width, y * sy);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export interface RoverHandle {
  /** Latest pose in scene units (for the follow camera). */
  pos: THREE.Vector3;
  yaw: number;
}

/** The rover, its sonar cone and trail. Writes its pose into `handle` every frame. */
export function RoverRobot({ binding, layout, handle }: { binding: PhysicsBinding; layout: DeviceLayout; handle: React.MutableRefObject<RoverHandle> }) {
  const source = useDeviceSource();
  const readouts = useContext(ReadoutsContext);
  const w = binding.world;
  const f: ArenaFrame = { cx: w.arena.width / 2, cy: w.arena.height / 2 };
  const body = useRef<THREE.Group>(null);
  const wheelL = useRef<THREE.Group>(null);
  const wheelR = useRef<THREE.Group>(null);
  const cone = useRef<THREE.Mesh>(null);
  const hit = useRef<THREE.Sprite>(null);
  const lastT = useRef<number | undefined>(undefined);
  const snap0 = useMemo(() => binding.snapshot(), [binding]);
  const r0 = snap0.robot;
  const L = (r0?.length ?? 20) * CM;
  const Wd = (r0?.width ?? 15) * CM;
  const track = (r0?.trackWidth ?? 13.5) * CM;
  const axle = (r0?.axleOffset ?? -5) * CM;
  const wheelR0 = 3.25 * CM;
  const sensorOffset = 0.95 * (L / 2);
  const trailLine = useMemo(() => {
    const mat = new LineMaterial({ color: 0x2fb57c, linewidth: 2.5, worldUnits: false });
    mat.depthTest = true;
    const l = new Line2(new LineGeometry(), mat);
    l.frustumCulled = false;
    l.visible = false;
    return l;
  }, []);
  const trailCount = useRef(-1);
  const { size } = useThree();
  const robot = w.robot;
  // Apex at the sensor, unit length along +X, half angle 15° (the modelled cone).
  const coneGeom = useMemo(() => new THREE.ConeGeometry(Math.tan((15 * Math.PI) / 180), 1, 48, 1, true).rotateZ(Math.PI / 2).translate(0.5, 0, 0), []);
  const screenType = layout.screen ? screenTypeOf(layout.screen.type) : undefined;
  const screen = layout.screen && screenType && (screenType.kind === "oled" || screenType.kind === "lcd") ? layout.screen : undefined;

  useFrame(() => {
    const snap: WorldSnapshot = binding.snapshot();
    const r = snap.robot;
    if (!r || !body.current) return;
    const [x, z] = toScene(r.pose, f);
    const yaw = (-r.pose.heading * Math.PI) / 180;
    body.current.position.set(x, 0, z);
    body.current.rotation.y = yaw;
    handle.current.pos.set(x, 0, z);
    handle.current.yaw = yaw;
    // Wheels: integrate the surface speed (cm/s) over virtual time.
    const t = snap.tMs;
    const dt = lastT.current === undefined ? 0 : Math.max(0, Math.min(0.2, (t - lastT.current) / 1000));
    lastT.current = t;
    const ws = r.wheelSpeeds;
    if (wheelL.current) wheelL.current.rotation.z -= (ws.left / 3.25) * dt;
    if (wheelR.current) wheelR.current.rotation.z -= (ws.right / 3.25) * dt;
    // Sonar cone: length = measured distance (or 400 cm out when nothing echoes).
    const s = r.sonar;
    if (cone.current) {
      const d = s ? (s.distanceCm > 0 ? s.distanceCm : 400) : 0;
      const len = Math.max(0.05, Math.min(d, 400) * CM);
      cone.current.visible = !!s;
      cone.current.scale.set(len, Math.min(len, 1.1), len); // flattened: a beam, not a cone into the floor
      const m = cone.current.material as THREE.MeshBasicMaterial;
      m.opacity = s && s.distanceCm > 0 && s.distanceCm < 25 ? 0.16 : 0.07;
      m.color.set(s && s.distanceCm > 0 && s.distanceCm < 25 ? "#ffb23f" : "#9fe9c6");
      if (hit.current) {
        hit.current.visible = !!s && s.distanceCm > 0;
        hit.current.position.set(sensorOffset + len, 0.42, 0);
      }
    }
    // Trail (rebuilt only when a point was added, every 100 ms of virtual time)
    const tr = snap.trail;
    (trailLine.material as LineMaterial).resolution.set(size.width, size.height);
    if (tr.length !== trailCount.current) {
      trailCount.current = tr.length;
      if (tr.length >= 2) {
        const pts: number[] = [];
        for (const p of tr) {
          const [tx, tz] = toScene(p, f);
          pts.push(tx, 0.015, tz);
        }
        pts.push(x, 0.015, z);
        trailLine.geometry.dispose();
        trailLine.geometry = new LineGeometry().setPositions(pts);
        trailLine.visible = true;
      } else trailLine.visible = false;
    }
    // HUD
    const ro = readouts.current;
    if (s) ro.distance = s.distanceCm > 0 ? `${s.distanceCm.toFixed(1)} cm` : "> 400 cm";
    ro.speed = `${Math.abs(r.speed).toFixed(1)} cm/s`;
    ro.wheels = `${ws.left.toFixed(0)} / ${ws.right.toFixed(0)} cm/s`;
    ro.collisions = String(snap.stats.collisions);
    ro.travelled = `${(snap.stats.travelledCm / 100).toFixed(2)} m`;
    if (Number.isFinite(snap.stats.minClearanceCm)) ro["closest"] = `${snap.stats.minClearanceCm.toFixed(1)} cm`;
    if (robot) {
      const drv = source.project().parts.find((p) => p.type === "l298n");
      if (drv) {
        const st = source.partState(drv.id);
        if (st) ro["motor duty"] = `${Math.round(Number(st.aDuty ?? 0) * 100)}% / ${Math.round(Number(st.bDuty ?? 0) * 100)}%`;
      }
    }
  });

  return (
    <>
      <primitive object={trailLine} />
      <group ref={body}>
        {/* lower acrylic plate */}
        <RoundedBox args={[L, 0.05, Wd]} radius={0.02} smoothness={2} position={[0, wheelR0 * 0.9, 0]} castShadow receiveShadow>
          <meshPhysicalMaterial color="#18181a" roughness={0.3} clearcoat={1} clearcoatRoughness={0.2} />
        </RoundedBox>
        {/* upper deck on standoffs */}
        <RoundedBox args={[L * 0.86, 0.04, Wd * 0.9]} radius={0.02} smoothness={2} position={[-L * 0.02, wheelR0 * 0.9 + 0.32, 0]} castShadow>
          <meshPhysicalMaterial color="#18181a" roughness={0.3} clearcoat={1} clearcoatRoughness={0.2} />
        </RoundedBox>
        {[-1, 1].flatMap((sx) =>
          [-1, 1].map((sz) => (
            <mesh key={`${sx}${sz}`} position={[sx * L * 0.36, wheelR0 * 0.9 + 0.16, sz * Wd * 0.38]} castShadow>
              <cylinderGeometry args={[0.025, 0.025, 0.32, 8]} />
              <meshStandardMaterial color="#c8a24a" metalness={1} roughness={0.3} />
            </mesh>
          )),
        )}
        {/* motors (yellow TT gearboxes) */}
        {[-1, 1].map((sz) => (
          <mesh key={sz} position={[axle, wheelR0 * 0.9 - 0.12, sz * (track / 2 - 0.36)]} castShadow>
            <boxGeometry args={[0.7, 0.22, 0.2]} />
            <meshStandardMaterial color="#e8c13a" roughness={0.6} />
          </mesh>
        ))}
        {/* wheels */}
        <group position={[axle, wheelR0, track / 2]}>
          <group ref={wheelL}>
            <Wheel r={wheelR0} />
          </group>
        </group>
        <group position={[axle, wheelR0, -track / 2]}>
          <group ref={wheelR}>
            <Wheel r={wheelR0} />
          </group>
        </group>
        {/* caster */}
        <mesh position={[L * 0.36, 0.09, 0]} castShadow>
          <sphereGeometry args={[0.09, 20, 14]} />
          <meshStandardMaterial color="#d0d3d8" metalness={1} roughness={0.15} />
        </mesh>
        {/* battery pack on the lower plate */}
        <RoundedBox args={[0.75, 0.2, 0.42]} radius={0.04} smoothness={2} position={[-L * 0.22, wheelR0 * 0.9 + 0.13, 0]} castShadow>
          <meshStandardMaterial color="#141414" roughness={0.5} />
        </RoundedBox>
        {/* Uno on the upper deck */}
        <Board position={[-L * 0.12, wheelR0 * 0.9 + 0.36, 0]} />
        {/* L298N with heatsink */}
        <group position={[L * 0.2, wheelR0 * 0.9 + 0.36, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.43, 0.02, 0.43]} />
            <meshStandardMaterial color="#b3261e" roughness={0.6} />
          </mesh>
          {[-2, -1, 0, 1, 2].map((i) => (
            <mesh key={i} position={[0, 0.13, i * 0.05]} castShadow>
              <boxGeometry args={[0.24, 0.24, 0.012]} />
              <meshStandardMaterial color="#111" metalness={0.6} roughness={0.4} />
            </mesh>
          ))}
        </group>
        {/* HC-SR04 eyes, facing +X */}
        <group position={[sensorOffset, 0.42, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.03, 0.2, 0.45]} />
            <meshStandardMaterial color="#1f4f8f" roughness={0.6} />
          </mesh>
          {[-1, 1].map((s) => (
            <group key={s} position={[0.06, 0, s * 0.13]} rotation-z={-Math.PI / 2}>
              <mesh castShadow>
                <cylinderGeometry args={[0.08, 0.08, 0.12, 32]} />
                <meshStandardMaterial color="#d8dadf" metalness={0.9} roughness={0.25} />
              </mesh>
              <mesh position={[0, 0.062, 0]}>
                <circleGeometry args={[0.065, 32]} />
                <meshStandardMaterial color="#222" roughness={0.9} side={THREE.DoubleSide} />
              </mesh>
            </group>
          ))}
          {/* sonar cone: unit length along +X, scaled to the distance */}
          <mesh ref={cone} position={[0.06, 0, 0]} geometry={coneGeom}>
            <meshBasicMaterial color="#9fe9c6" transparent opacity={0.1} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
          </mesh>
        </group>
        <sprite ref={hit} scale={0.5}>
          <spriteMaterial map={glowTexture()} color="#9fe9c6" transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
        </sprite>
        {screen ? <RoverFace partId={screen.id} screen={screenType!.screen} position={[L * 0.38, wheelR0 * 0.9 + 0.55, 0]} /> : null}
      </group>
    </>
  );
}

function Wheel({ r }: { r: number }) {
  return (
    <group rotation-x={Math.PI / 2}>
      <mesh castShadow>
        <cylinderGeometry args={[r, r, 0.26, 40]} />
        <meshStandardMaterial color="#141414" roughness={0.9} />
      </mesh>
      <mesh>
        <cylinderGeometry args={[r * 0.62, r * 0.62, 0.27, 32]} />
        <meshStandardMaterial color="#e8c13a" roughness={0.5} />
      </mesh>
      {/* spokes make the spin visible */}
      {[0, 1, 2].map((i) => (
        <mesh key={i} rotation-y={(i * Math.PI) / 3}>
          <boxGeometry args={[r * 1.15, 0.28, 0.035]} />
          <meshStandardMaterial color="#141414" roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

function RoverFace({ partId, screen, position }: { partId: string; screen: string; position: [number, number, number] }) {
  const source = useDeviceSource();
  const tex = useMemo(() => createScreenTexture(screen), [screen]);
  useFrame(() => void tex.update(source.partState(partId)));
  return (
    <group position={position} rotation-y={Math.PI / 2}>
      <mesh>
        <boxGeometry args={[0.38, 0.24, 0.03]} />
        <meshStandardMaterial color="#0a0a0a" roughness={0.3} />
      </mesh>
      <mesh position={[0, 0, 0.017]}>
        <planeGeometry args={[0.32, 0.16]} />
        <meshBasicMaterial map={tex.texture} toneMapped={false} />
      </mesh>
    </group>
  );
}

export type RoverCamera = "track" | "chase" | "arena";

/**
 * Camera modes for the rover:
 *   track: orbit controls whose target rides along with the robot (drag to orbit, scroll to zoom)
 *   chase: third-person camera behind the robot
 *   arena: the whole arena from above at an angle (static target)
 */
export function CameraRig({ handle, mode, arena }: { handle: React.MutableRefObject<RoverHandle>; mode: RoverCamera; arena: { width: number; height: number } }) {
  const { camera, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3; update(): void } | null };
  const last = useRef<THREE.Vector3 | null>(null);
  const look = useRef(new THREE.Vector3());
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const placed = useRef<string>("");
  useFrame((_, dt) => {
    const { pos, yaw } = handle.current;
    if (mode === "chase") {
      const back = camera.aspect < 0.8 ? 9 : 6.2;
      tmp.set(pos.x - Math.cos(yaw) * back, back * 0.55, pos.z + Math.sin(yaw) * back);
      // Snap on the first frame (and when the robot was not placed yet), ease after.
      const k = placed.current === "chase" && pos.lengthSq() > 0 ? 1 - Math.exp(-dt * 4) : 1;
      camera.position.lerp(tmp, k);
      look.current.lerp(tmp.set(pos.x + Math.cos(yaw) * 3, 0.2, pos.z - Math.sin(yaw) * 3), k);
      camera.lookAt(look.current);
      if (pos.lengthSq() > 0) placed.current = "chase";
      last.current = null;
      return;
    }
    if (!controls) return;
    if (mode === "arena") {
      if (placed.current !== "arena") {
        const m = Math.max(arena.width, arena.height * 1.4) / 10;
        camera.position.set(m * 0.08, m * 1.0, m * 1.05);
        controls.target.set(0, 0, 0.8);
        controls.update();
        placed.current = "arena";
      }
      last.current = null;
      return;
    }
    // track
    if (placed.current !== "track") {
      const k = camera.aspect < 0.8 ? 1.9 : 1;
      camera.position.set(pos.x - 4.2 * k, 3.9 * k, pos.z + 5.6 * k);
      controls.target.copy(pos);
      controls.update();
      placed.current = "track";
      last.current = pos.clone();
      return;
    }
    if (last.current) {
      tmp.copy(pos).sub(last.current);
      camera.position.add(tmp);
      controls.target.add(tmp);
      last.current.copy(pos);
    } else last.current = pos.clone();
  });
  return null;
}
