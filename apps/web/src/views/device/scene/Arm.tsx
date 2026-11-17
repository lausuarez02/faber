// The servo arm on a table: pedestal, a servo at every joint, links that follow the simulated
// servo angles (forward kinematics from @faber/physics), a gripper, and the target cups that
// light up when the gripper reaches them. Side-view cm (y up) → scene units at ARM_SCALE.
import { useContext, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { RoundedBox, ContactShadows } from "@react-three/drei";
import * as THREE from "three";
import type { PhysicsBinding } from "@faber/physics";
import { ReadoutsContext } from "../context.ts";
import { Board } from "./Board.tsx";

export const ARM_SCALE = 0.25;
const S = ARM_SCALE;

export function ArmScene({ binding }: { binding: PhysicsBinding }) {
  const readouts = useContext(ReadoutsContext);
  const spec = binding.world.arm!;
  const links = useRef<(THREE.Group | null)[]>([]);
  const joints = useRef<(THREE.Group | null)[]>([]);
  const grip = useRef<THREE.Group>(null);
  const cups = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  useFrame(() => {
    const a = binding.snapshot().arm;
    if (!a) return;
    const { pose, servoAngles } = a;
    pose.points.forEach((p, i) => {
      const j = joints.current[i];
      if (j) j.position.set(p.x * S, p.y * S, 0);
      const l = links.current[i];
      if (l && i < pose.linkAngles.length) {
        l.position.set(p.x * S, p.y * S, 0);
        l.rotation.z = (pose.linkAngles[i]! * Math.PI) / 180;
      }
    });
    if (grip.current) {
      grip.current.position.set(pose.end.x * S, pose.end.y * S, 0);
      grip.current.rotation.z = ((pose.linkAngles[pose.linkAngles.length - 1] ?? 0) * Math.PI) / 180;
    }
    spec.targets.forEach((t, i) => {
      const m = cups.current[i];
      if (!m) return;
      const on = pose.reached.includes(t.id);
      m.emissive.set(on ? "#3ddc97" : "#000000");
      m.emissiveIntensity = on ? 0.9 : 0;
    });
    const ro = readouts.current;
    spec.joints.forEach((j, i) => (ro[j.servo] = `${(servoAngles[i] ?? 0).toFixed(0)}°`));
    ro.gripper = `${pose.end.x.toFixed(1)}, ${pose.end.y.toFixed(1)} cm`;
    ro.reached = pose.reached.length ? pose.reached.join(", ") : "none";
  });
  const tableW = 16;
  return (
    <group position={[-2.5, 0, 0]}>
      {/* table top */}
      <RoundedBox args={[tableW, 0.3, 6]} radius={0.08} smoothness={3} position={[2.5, -0.15, 0]} receiveShadow castShadow>
        <meshStandardMaterial color="#1a1a1a" roughness={0.75} />
      </RoundedBox>
      {/* pedestal */}
      <mesh position={[spec.base.x * S, (spec.base.y * S) / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.55, 0.7, spec.base.y * S, 48]} />
        <meshStandardMaterial color="#1f1f21" roughness={0.45} metalness={0.3} />
      </mesh>
      <Board position={[spec.base.x * S - 2.6, 0.02, 1.2]} scale={2.4} />
      {/* links */}
      {spec.links.map((len, i) => (
        <group key={`l${i}`} ref={(g) => void (links.current[i] = g)}>
          <RoundedBox args={[len * S, 0.32, 0.22]} radius={0.1} smoothness={3} position={[(len * S) / 2, 0, 0.26]} castShadow>
            <meshStandardMaterial color="#c9ccd1" metalness={0.85} roughness={0.32} />
          </RoundedBox>
        </group>
      ))}
      {/* servos at the joints (the link rides on the horn, in front of the servo) */}
      {spec.joints.map((j, i) => (
        <group key={`j${i}`} ref={(g) => void (joints.current[i] = g)}>
          <RoundedBox args={[0.58, 0.58, 0.32]} radius={0.05} smoothness={2} position={[0, -0.06, 0]} castShadow>
            <meshStandardMaterial color="#2a5bd7" roughness={0.45} />
          </RoundedBox>
          <mesh position={[0, 0, 0.2]} rotation-x={Math.PI / 2} castShadow>
            <cylinderGeometry args={[0.13, 0.13, 0.1, 24]} />
            <meshStandardMaterial color="#f2f2f2" roughness={0.4} />
          </mesh>
        </group>
      ))}
      {/* gripper */}
      <group ref={grip}>
        {[-1, 1].map((s) => (
          <mesh key={s} position={[0.25, s * 0.12, 0.26]} castShadow>
            <boxGeometry args={[0.5, 0.06, 0.2]} />
            <meshStandardMaterial color="#1c1c1e" roughness={0.4} metalness={0.3} />
          </mesh>
        ))}
      </group>
      {/* targets */}
      {spec.targets.map((t, i) => (
        <group key={t.id} position={[t.x * S, 0, 0.26]}>
          <mesh position={[0, Math.max(0.2, t.y * S) / 2, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[t.r * S * 1.1, t.r * S * 0.9, Math.max(0.2, t.y * S), 40, 1, true]} />
            <meshStandardMaterial ref={(m) => void (cups.current[i] = m)} color="#c9b48f" roughness={0.6} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
      <ContactShadows position={[2.5, 0.005, 0]} opacity={0.6} scale={18} blur={2.4} far={6} resolution={512} />
    </group>
  );
}
