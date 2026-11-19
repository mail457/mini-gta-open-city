/**
 * Pure city layout + road graph (no Three.js). Lead-owned after Agent 1 failure.
 *
 * Right-hand traffic. Lane nodes are laid out at intersection entries, exits and
 * mid-block points; turn edges at intersections include rounded corner points so
 * traffic arcs through junctions instead of turning on the spot.
 */
import type { Rect, RoadGraph, RoadGraphEdge, RoadGraphNode, XZ } from '../contracts';
import { BLOCK, STREETS, X_OFFSET, Z_OFFSET, nsX, ewZ, streetHalfWidth } from './layout';

export const LANE_WIDTH = 3.4;

/** Offset of a lane centre from the road centreline on street index i. */
export function laneOffset(i: number): number {
  const half = streetHalfWidth(i);
  return Math.max(LANE_WIDTH, half - LANE_WIDTH / 2);
}

/** Half extent of a city block between streets (ix, iz) and (ix+1, iz+1). */
export function blockRect(ix: number, iz: number): { minX: number; maxX: number; minZ: number; maxZ: number; cx: number; cz: number } {
  const minX = nsX(ix) + streetHalfWidth(ix);
  const maxX = nsX(ix + 1) - streetHalfWidth(ix + 1);
  const minZ = ewZ(iz) + streetHalfWidth(iz);
  const maxZ = ewZ(iz + 1) - streetHalfWidth(iz + 1);
  return { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

export const isParkBlock = (ix: number, iz: number): boolean => ix === 2 && iz === 2;
export const isParkingBlock = (ix: number, iz: number): boolean => ix === 3 && iz === 1;

/* -------------------------------------------------------------------------- */
/* Road road-network primitives                                               */
/* -------------------------------------------------------------------------- */

/** A lane runs either along a vertical (N-S) street or a horizontal (E-W) street. */
type Axis = 'ns' | 'ew';

interface LaneKey {
  axis: Axis;
  street: number; // street index
  dir: -1 | 1; // travel direction (+1 = east on ew / south on ns)
}

const keyStr = (k: LaneKey): string => `${k.axis}${k.street}_${k.dir}`;
const laneX = (k: LaneKey): number => (k.axis === 'ns' ? nsX(k.street) + k.dir * laneOffset(k.street) : 0);
const laneZ = (k: LaneKey): number => (k.axis === 'ew' ? ewZ(k.street) + k.dir * laneOffset(k.street) : 0);
/** Convert a node coordinate along the lane into world XZ. */
const lanePoint = (k: LaneKey, t: number): XZ =>
  k.axis === 'ns' ? { x: laneX(k), z: t } : { x: t, z: laneZ(k) };

/** Intersection index along the perpendicular street for a block corner coordinate. */
function crossIndex(axis: Axis, t: number): number {
  // Opposite-street index reached when travelling along `axis` to coordinate t.
  const arr = axis === 'ns' ? ewZ : nsX;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < STREETS; i++) {
    const d = Math.abs(arr(i) - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const along = (axis: Axis, i: number): number => (axis === 'ns' ? ewZ(i) : nsX(i));

/* -------------------------------------------------------------------------- */
/* Graph builder (clean rewrite — deterministic, allocation-light)            */
/* -------------------------------------------------------------------------- */

interface LaneNode {
  id: number;
  key: LaneKey;
  /** Coordinate along the lane axis. */
  t: number;
  /** Junction index, or -1 for mid-block. */
  junction: number;
  x: number;
  z: number;
}

export function buildRoadGraph(): RoadGraph {
  const nodes: RoadGraphNode[] = [];
  const laneNodes: LaneNode[] = [];
  const junctions = new Map<string, LaneNode>();
  const mids = new Map<string, LaneNode>();

  const add = (key: LaneKey, t: number, junction: number): LaneNode => {
    const p = lanePoint(key, t);
    const n: LaneNode = { id: nodes.length, key, t, junction, x: p.x, z: p.z };
    nodes.push({ id: n.id, x: n.x, z: n.z });
    laneNodes.push(n);
    const k = `${keyStr(key)}_${t.toFixed(2)}`;
    if (junction >= 0) junctions.set(k, n);
    else mids.set(k, n);
    return n;
  };

  const lanes: LaneKey[] = [];
  for (let s = 0; s < STREETS; s++) {
    lanes.push(
      { axis: 'ns', street: s, dir: 1 },
      { axis: 'ns', street: s, dir: -1 },
      { axis: 'ew', street: s, dir: 1 },
      { axis: 'ew', street: s, dir: -1 },
    );
  }

  for (const key of lanes) {
    for (let i = 0; i < STREETS; i++) add(key, along(key.axis, i), i);
    for (let i = 0; i < STREETS - 1; i++) add(key, (along(key.axis, i) + along(key.axis, i + 1)) / 2, -1);
  }

  const edges = new Map<number, RoadGraphEdge[]>();
  const link = (from: LaneNode, to: LaneNode) => {
    const list = edges.get(from.id) ?? [];
    list.push({ from: from.id, to: to.id, length: Math.hypot(to.x - from.x, to.z - from.z) });
    edges.set(from.id, list);
  };
  const getJunction = (key: LaneKey, j: number): LaneNode | undefined =>
    junctions.get(`${keyStr(key)}_${along(key.axis, j).toFixed(2)}`);

  for (const key of lanes) {
    const seq = laneNodes.filter((n) => keyStr(n.key) === keyStr(key));
    seq.sort((a, b) => (key.dir > 0 ? a.t - b.t : b.t - a.t));
    for (let i = 0; i < seq.length - 1; i++) link(seq[i], seq[i + 1]);
  }

  /** Perpendicular lane reached by turning at a junction node. */
  const turnAs = (node: LaneNode, nowNs: boolean): LaneNode | undefined => {
    const perpAxis: Axis = nowNs ? 'ew' : 'ns';
    const perpStreet = crossIndex(perpAxis, node.t);
    const nextKey: LaneKey = { axis: perpAxis, street: perpStreet, dir: nowNs ? 1 : -1 };
    return getJunction(nextKey, node.key.street);
  };

  const xOfJunction = (node: LaneNode, opt: LaneNode): number => (node.key.axis === 'ns' ? node.x : opt.x);
  const zOfJunction = (node: LaneNode, opt: LaneNode): number => (node.key.axis === 'ns' ? opt.z : node.z);
  const cornerId = new Map<string, number>();
  for (const node of laneNodes) {
    if (node.junction < 0) continue;
    const jIdx = node.junction;
    const straightEdges = edges.get(node.id) ?? [];
    const straight = straightEdges[0];
    const opts: LaneNode[] = [];
    const left = turnAs(node, true);
    const right = turnAs(node, true);
    if (left) opts.push(left);
    if (right) opts.push(right);
    for (const opt of opts) {
      const ck = `${node.id}->${opt.id}`;
      let cid = cornerId.get(ck);
      if (cid === undefined) {
        const jx = node.key.axis === 'ns' ? node.x : opt.x;
        const jz = node.key.axis === 'ns' ? opt.z : node.z;
        // Exit point: where the incoming lane leaves the junction square.
        const exitX = node.x;
        const exitZ = node.z;
        // Entry point of the outgoing lane at the junction, then a midpoint that
        // keeps the corner inside the junction square (never cuts through kerbs).
        const prevInput = node.key.axis === 'ns' ? { x: node.x, z: zOfJunction(node, opt) } : { x: xOfJunction(node, opt), z: node.z };
        const entryX = opt.key.axis === 'ns' ? opt.x : prevInput.x;
        const entryZ = opt.key.axis === 'ns' ? prevInput.z : opt.z;
        const midX = (exitX + entryX) / 2;
        const midZ = (exitZ + entryZ) / 2;
        void jx;
        void jz;
        cid = nodes.length;
        nodes.push({ id: cid, x: midX, z: midZ });
      }
      cornerId.set(ck, cid);
      const len1 = Math.hypot(nodes[cid].x - node.x, nodes[cid].z - node.z);
      const len2 = Math.hypot(opt.x - nodes[cid].x, opt.z - nodes[cid].z);
      if (len1 > 0.6 && len2 > 0.6) {
        const list = (edges.get(node.id) ?? []).filter((e) => e.to !== opt.id);
        list.push({ from: node.id, to: cid, length: len1 });
        edges.set(node.id, list);
        const l2 = edges.get(cid) ?? [];
        if (!l2.some((e) => e.to === opt.id)) l2.push({ from: cid, to: opt.id, length: len2 });
        edges.set(cid, l2);
      } else {
        const list = edges.get(node.id) ?? [];
        if (!list.some((e) => e.to === opt.id)) list.push({ from: node.id, to: opt.id, length: Math.hypot(opt.x - node.x, opt.z - node.z) });
        edges.set(node.id, list);
      }
    }
    void straight;
  }

  for (const n of nodes) {
    if (!edges.has(n.id)) {
      const other = nodes.find((m) => m.id !== n.id)!;
      edges.set(n.id, [{ from: n.id, to: other.id, length: Math.hypot(other.x - n.x, other.z - n.z) }]);
    }
  }

  const nearestNode = (x: number, z: number): number => {
    let best = 0;
    let bestD = Infinity;
    for (const n of nodes) {
      const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  };

  const pathFrom = (node: number, stopDistance: number, rng: () => number): XZ[] => {
    const out: XZ[] = [];
    let cur = nodes[node];
    if (!cur) return out;
    out.push({ x: cur.x, z: cur.z });
    let travelled = 0;
    let guard = 0;
    const visits = new Map<number, number>();
    visits.set(cur.id, 1);
    while (travelled < stopDistance && guard++ < 240) {
      const outs = (edges.get(cur.id) ?? []).filter((e) => nodes[e.to]);
      if (!outs.length) break;
      // Straight continuation edges share the incoming heading direction.
      const inDir = travelDir(cur.id, outs);
      let pick: RoadGraphEdge | undefined;
      if (inDir && outs.length > 1) {
        const straightish = outs.find((e) => {
          const n = nodes[e.to];
          return (n.x - cur.x) * inDir.x + (n.z - cur.z) * inDir.z > 0.7 * e.length;
        });
        pick = straightish && rng() < 0.6 ? straightish : outs[Math.floor(rng() * outs.length) % outs.length];
      } else {
        pick = outs.length === 1 ? outs[0] : outs[Math.floor(rng() * outs.length) % outs.length];
      }
      const next = nodes[pick.to];
      travelled += pick.length;
      out.push({ x: next.x, z: next.z });
      cur = next;
      const v = (visits.get(cur.id) ?? 0) + 1;
      visits.set(cur.id, v);
      if (v > 2) break;
    }
    return out;
  };

  // Heading used by pathFrom: computed from the first edge the node was reached by.
  const headingIn = new WeakMap<RoadGraphNode, XZ>();
  const travelDir = (_id: number, outs: RoadGraphEdge[]): XZ | null => {
    if (!outs.length) return null;
    const e = outs[0];
    const a = nodes[e.from];
    const b = nodes[e.to];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
  };
  void headingIn;

  return { nodes, edges, nearestNode, laneWidth: LANE_WIDTH, pathFrom };
}

/* -------------------------------------------------------------------------- */
/* POIs                                                                       */
/* -------------------------------------------------------------------------- */

export interface PoiDef {
  name: string;
  pos: XZ;
  label: string;
}

/** Sidewalk point: midway along the first block's north edge, near the spawn. */
const SPAWN: XZ = { x: -104, z: -100 };
const MISSION_START: XZ = { x: -40, z: -100 };
const PARKING: XZ = { x: blockRect(3, 1).cx, z: blockRect(3, 1).cz };
const PARK: XZ = { x: blockRect(2, 2).cx, z: blockRect(2, 2).cz };
/** Drop-off: on the south-bound kerbside lane of the eastern arterial. */
const DROP: XZ = { x: nsX(4) + laneOffset(4), z: ewZ(4) - 20 };

export const CITY_POIS: PoiDef[] = [
  { name: 'spawn', pos: SPAWN, label: 'Spawn' },
  { name: 'missionStart', pos: MISSION_START, label: 'Courier' },
  { name: 'missionDrop', pos: DROP, label: 'Delivery point' },
  { name: 'park', pos: PARK, label: 'Central Park' },
  { name: 'parking', pos: PARKING, label: 'Parking lot' },
];

export function poiMap(): Record<string, XZ> {
  const out: Record<string, XZ> = {};
  for (const p of CITY_POIS) out[p.name] = { ...p.pos };
  return out;
}

/* -------------------------------------------------------------------------- */
/* Collision index                                                            */
/* -------------------------------------------------------------------------- */

const CELL = 16;

/** Uniform spatial hash over axis-aligned Rect colliders. */
export class CollisionGrid {
  private map = new Map<number, number[]>();
  readonly rects: Rect[];

  constructor(rects: Rect[]) {
    this.rects = rects;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const x0 = Math.floor((r.x - r.hx) / CELL);
      const x1 = Math.floor((r.x + r.hx) / CELL);
      const z0 = Math.floor((r.z - r.hz) / CELL);
      const z1 = Math.floor((r.z + r.hz) / CELL);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          const k = this.key(gx, gz);
          const arr = this.map.get(k);
          if (arr) arr.push(i);
          else this.map.set(k, [i]);
        }
      }
    }
  }

  private key(gx: number, gz: number): number {
    return (gx + 4096) * 8192 + (gz + 4096);
  }

  /** Candidate overlapping rect indices for a circle. */
  candidates(cx: number, cz: number, r: number, out: number[]): number[] {
    out.length = 0;
    const x0 = Math.floor((cx - r) / CELL);
    const x1 = Math.floor((cx + r) / CELL);
    const z0 = Math.floor((cz - r) / CELL);
    const z1 = Math.floor((cz + r) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const arr = this.map.get(this.key(gx, gz));
        if (!arr) continue;
        for (const i of arr) if (out.indexOf(i) < 0) out.push(i);
      }
    }
    return out;
  }
}

/** Push a circle out of one rect. Returns true if it was inside. */
export function pushOutOfRect(c: { x: number; z: number }, r: number, rect: Rect): boolean {
  const px = Math.max(rect.x - rect.hx, Math.min(c.x, rect.x + rect.hx));
  const pz = Math.max(rect.z - rect.hz, Math.min(c.z, rect.z + rect.hz));
  let dx = c.x - px;
  let dz = c.z - pz;
  const d2 = dx * dx + dz * dz;
  if (d2 > r * r) return false;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    const push = r - d + 0.001;
    c.x += (dx / d) * push;
    c.z += (dz / d) * push;
    return true;
  }
  // Centre inside the rect: escape along the shortest axis.
  const exL = c.x - (rect.x - rect.hx);
  const exR = rect.x + rect.hx - c.x;
  const ezT = c.z - (rect.z - rect.hz);
  const ezB = rect.z + rect.hz - c.z;
  const m = Math.min(exL, exR, ezT, ezB);
  if (m === exL) c.x = rect.x - rect.hx - r;
  else if (m === exR) c.x = rect.x + rect.hx + r;
  else if (m === ezT) c.z = rect.z - rect.hz - r;
  else c.z = rect.z + rect.hz + r;
  return true;
}
