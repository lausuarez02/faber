// The designed case for the Device view: GET /api/device/case (the same meshes the Case view draws,
// from the server's mesh cache, plus where the window, buttons, light pipes and grille are). Loaded
// once per project state and kept: reopening the view shows the cached case at once and only
// swaps it when the server says the case changed. Geometry is decoded once per case hash.
import { useEffect, useState } from "react";
import * as THREE from "three";
import type { Project } from "@jumper/project-format";
import { decodeF32, decodeU32 } from "../../case/api.ts";
import { serverConnection } from "../../projects/api.ts";
import type { CaseModel } from "./classify.ts";

export type CaseLoad =
  | { status: "none" } // the project has no case yet
  | { status: "loading" }
  | { status: "ready"; model: CaseModel }
  | { status: "error"; error: string };

/** How a DeviceSource can hand over the case (tests, the standalone harness); default: the server. */
export type CaseLoader = () => Promise<CaseModel | null>;

export async function fetchDeviceCase(): Promise<CaseModel | null> {
  const conn = await serverConnection();
  if (!conn) return null; // no jumper serve (static build, harness): no case to show
  let r: Response;
  try {
    r = await fetch("/api/device/case", { headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error(`Could not reach the Jumper server. Why: ${(e as Error).message}. Fix: check that jumper serve is still running, then reopen the Device view.`);
  }
  const data = (await r.json().catch(() => undefined)) as { case?: CaseModel | null; error?: string } | undefined;
  if (!r.ok) throw new Error(data?.error ?? `GET /api/device/case failed with HTTP ${r.status}. Why: the server gave no reason. Fix: look at the jumper serve terminal.`);
  return data?.case ?? null;
}

/** What changes the case the server sends: the enclosure and the parts. */
export function caseKey(project: Project): string {
  return JSON.stringify([project.name, project.enclosure ?? null, project.parts.map((p) => [p.id, p.type, p.props ?? null])]);
}

const cache = new Map<string, CaseModel | null>();
const inflight = new Map<string, Promise<CaseModel | null>>();

function same(a: CaseModel | null | undefined, b: CaseModel | null): boolean {
  if (!a || !b) return a === b;
  return a.hash === b.hash && a.stale === b.stale && a.mesh.hash === b.mesh.hash && JSON.stringify(a.openings) === JSON.stringify(b.openings);
}

/**
 * The project's built case: cached per project state, revalidated once each time the view opens.
 * A project without an enclosure never asks the server.
 */
export function useDeviceCase(project: Project, loader: CaseLoader = fetchDeviceCase): CaseLoad {
  const key = project.enclosure ? caseKey(project) : "";
  const [state, setState] = useState<CaseLoad>(() => (!key ? { status: "none" } : cache.has(key) ? fromModel(cache.get(key)!) : { status: "loading" }));
  useEffect(() => {
    if (!key) {
      setState({ status: "none" });
      return;
    }
    let live = true;
    const had = cache.get(key);
    setState(cache.has(key) ? fromModel(had!) : { status: "loading" });
    let p = inflight.get(key);
    if (!p) {
      p = loader();
      inflight.set(key, p);
      void p.finally(() => inflight.delete(key)).catch(() => undefined);
    }
    p.then(
      (m) => {
        const keep = same(cache.get(key), m) ? cache.get(key)! : m;
        cache.set(key, keep);
        if (cache.size > 6) cache.delete(cache.keys().next().value!);
        if (live) setState((s) => (s.status === "ready" && keep && s.model === keep ? s : fromModel(keep)));
      },
      (e: Error) => {
        if (live && !cache.has(key)) setState({ status: "error", error: e.message });
      },
    );
    return () => {
      live = false;
    };
  }, [key, loader]);
  return state;
}

function fromModel(m: CaseModel | null): CaseLoad {
  return m ? { status: "ready", model: m } : { status: "none" };
}

export interface CaseGeometry {
  body: string;
  kind: CaseModel["mesh"]["bodies"][number]["kind"];
  color: string;
  geometry: THREE.BufferGeometry;
}

const geoCache = new Map<string, CaseGeometry[]>();

/** The case's bodies as three.js geometry, decoded once per mesh hash (kept for the last few cases). */
export function caseGeometry(model: CaseModel): CaseGeometry[] {
  const k = `${model.mesh.hash}|${model.mesh.bodies.length}|${model.mesh.bodies.map((b) => b.body).join(",")}`;
  const hit = geoCache.get(k);
  if (hit) return hit;
  const out = model.mesh.bodies.map((b) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(decodeF32(b.positions), 3));
    g.setIndex(new THREE.BufferAttribute(decodeU32(b.indices), 1));
    g.computeVertexNormals();
    g.computeBoundingBox();
    return { body: b.body, kind: b.kind, color: b.color, geometry: g };
  });
  geoCache.set(k, out);
  if (geoCache.size > 4) {
    const [oldKey, old] = geoCache.entries().next().value!;
    geoCache.delete(oldKey);
    for (const g of old) g.geometry.dispose();
  }
  return out;
}
