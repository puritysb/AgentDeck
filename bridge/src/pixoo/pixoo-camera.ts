/**
 * Pixoo64 Camera System — zoom/pan coordinate transform + zone director.
 *
 * Virtual world is normalized 0~1 in both axes. Camera defines a viewport
 * with center (cx, cy) and zoom level. At zoom=1.0 the full world is visible;
 * at zoom=2.0 only the center quarter is visible but everything is 2× larger.
 *
 * Rendering pipeline:
 *   1. Environment → 64×64 world buffer (pixel coords 0~63)
 *   2. blitWithCamera() → 64×64 output buffer (crop + nearest-neighbor scale)
 *   3. Scaled creatures → output buffer (high-detail grid, camera-aware sizing)
 */

export const WORLD_SIZE = 96;
export const ACTIVE_SIZE = 64;
const PAD = (WORLD_SIZE - ACTIVE_SIZE) / (2 * ACTIVE_SIZE); // 0.25

// ===== Types =====

export interface Camera {
  cx: number;   // center X in normalized world (0~1)
  cy: number;   // center Y in normalized world (0~1)
  zoom: number; // 1.0 = full view, 2.0 = 2× magnification
  width?: number; // target resolution width (e.g., 32 or 64)
}

export const CAMERA_WIDE: Camera = { cx: 0.5, cy: 0.5, zoom: 1.0 };

// ===== Camera Zones =====

export interface CameraZone {
  name: string;
  cx: number;
  cy: number;
  zoom: number;
  duration: number; // seconds to hold before advancing
}

export const ZONES: Record<string, CameraZone> = {
  wide:       { name: 'wide',       cx: 0.5,  cy: 0.5,  zoom: 1.0, duration: 10 },
  'pan-left': { name: 'pan-left',   cx: 0.35, cy: 0.52, zoom: 1.15, duration: 8 },
  'pan-right':{ name: 'pan-right',  cx: 0.65, cy: 0.52, zoom: 1.15, duration: 8 },
  octopus:    { name: 'octopus',    cx: 0.38, cy: 0.45, zoom: 3.2, duration: 15 },
  crayfish:   { name: 'crayfish',   cx: 0.72, cy: 0.55, zoom: 3.2, duration: 15 },
  school:     { name: 'school',     cx: 0.5,  cy: 0.40, zoom: 1.6, duration: 10 },
  'full-tank':{ name: 'full-tank',  cx: 0.5,  cy: 0.5,  zoom: 1.0, duration: 8 },
};

// ===== Coordinate Transforms =====

/** World (0~1) → screen pixel (0~W-1). */
export function worldToScreen(wx: number, wy: number, cam: Camera): [number, number] {
  const w = cam.width ?? 64;
  return [
    (wx - cam.cx) * w * cam.zoom + w / 2,
    (wy - cam.cy) * w * cam.zoom + w / 2,
  ];
}

/** Screen pixel → world (0~1). */
export function screenToWorld(sx: number, sy: number, cam: Camera): [number, number] {
  const w = cam.width ?? 64;
  return [
    (sx - w / 2) / (w * cam.zoom) + cam.cx,
    (sy - w / 2) / (w * cam.zoom) + cam.cy,
  ];
}

/** Check if a world-space point is within the camera viewport. */
export function isVisible(wx: number, wy: number, cam: Camera, padding = 0.05): boolean {
  const halfView = 0.5 / cam.zoom + padding;
  return Math.abs(wx - cam.cx) <= halfView && Math.abs(wy - cam.cy) <= halfView;
}

/** Clamp camera so the viewport stays within world bounds. */
export function clampCamera(cam: Camera): Camera {
  const halfView = 0.5 / cam.zoom;
  const minVal = -PAD + halfView;
  const maxVal = 1 + PAD - halfView;

  const minX = Math.max(0, minVal);
  const maxX = Math.min(1, maxVal);
  const minY = Math.max(0, minVal);
  const maxY = Math.min(1, maxVal);

  return {
    cx: minX <= maxX ? Math.max(minX, Math.min(maxX, cam.cx)) : 0.5,
    cy: minY <= maxY ? Math.max(minY, Math.min(maxY, cam.cy)) : 0.5,
    zoom: cam.zoom,
    width: cam.width,
  };
}

/** Linearly interpolate between two cameras. */
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  const s = Math.max(0, Math.min(1, t));
  return {
    cx: a.cx + (b.cx - a.cx) * s,
    cy: a.cy + (b.cy - a.cy) * s,
    zoom: a.zoom + (b.zoom - a.zoom) * s,
    width: b.width ?? a.width,
  };
}

/** Smoothstep ease-in-out. */
export function easeInOut(t: number): number {
  const s = Math.max(0, Math.min(1, t));
  return s * s * (3 - 2 * s);
}

// ===== Blit: world buffer → output with camera transform =====

/**
 * Crop + nearest-neighbor scale from a 96×96 world buffer into a w×w output.
 */
export function blitWithCamera(world: Uint8Array, output: Uint8Array, cam: Camera): void {
  const w = cam.width ?? 64;

  for (let sy = 0; sy < w; sy++) {
    for (let sx = 0; sx < w; sx++) {
      // Convert screen coordinate to normalized active region coordinate
      const nx = (sx - w / 2) / (w * cam.zoom) + cam.cx;
      const ny = (sy - w / 2) / (w * cam.zoom) + cam.cy;

      // Convert normalized active region coordinate to world buffer index (centered)
      const wx = Math.floor((WORLD_SIZE - ACTIVE_SIZE) / 2 + nx * ACTIVE_SIZE);
      const wy = Math.floor((WORLD_SIZE - ACTIVE_SIZE) / 2 + ny * ACTIVE_SIZE);

      const dstIdx = (sy * w + sx) * 3;

      // Clamp coordinates to world boundaries (0..95) to prevent out-of-bounds access
      const clampWx = Math.max(0, Math.min(WORLD_SIZE - 1, wx));
      const clampWy = Math.max(0, Math.min(WORLD_SIZE - 1, wy));

      const srcIdx = (clampWy * WORLD_SIZE + clampWx) * 3;
      output[dstIdx] = world[srcIdx];
      output[dstIdx + 1] = world[srcIdx + 1];
      output[dstIdx + 2] = world[srcIdx + 2];
    }
  }
}

// ===== Camera Director — 3-mode state machine =====

/** Active creature descriptor for camera targeting. */
export interface ActiveCreature {
  x: number;
  y: number;
  /** Lower = higher priority. AWAITING=0, PROCESSING=1, ROUTING=2. */
  priority: number;
}

type DirectorMode = 'idle-cycle' | 'tracking' | 'cycling-active';

interface DirectorState {
  mode: DirectorMode;
  camera: Camera;

  // idle-cycle state
  idleCycle: CameraZone[];
  idleIndex: number;
  currentZone: CameraZone;
  targetZone: CameraZone;
  zoneTimer: number;
  transitionT: number;
  transitioning: boolean;

  // cycling-active state
  activeIndex: number;
  activeDwell: number;
}

const TRANSITION_SEC = 8; // ease-in-out zone transition (8s for smooth camera at ~1fps)
const ACTIVE_DWELL_SEC = 6; // seconds per creature in cycling-active mode

let ds: DirectorState | null = null;

// Idle cycle: wide overview → left pan (octopus area) → wide → right pan (crayfish area)
const IDLE_CYCLE: CameraZone[] = [
  ZONES.wide, ZONES['pan-left'], ZONES.wide, ZONES['pan-right'],
];

/**
 * Advance the camera director by `dt` seconds and return the current camera.
 *
 * 3-mode state machine:
 *   idle-cycle:     No active creatures → wide(12s) → school(10s) → full-tank(8s)
 *   tracking:       Single active creature → zoom 2.0 tracking
 *   cycling-active: 2+ active creatures → priority-sorted, 6s per creature
 *
 * @param dt               seconds since last call (~1.2s at Pixoo push rate)
 * @param activeCreatures  creatures with state != idle (octopus PROCESSING/AWAITING, crayfish ROUTING)
 * @param crayfishRouting  whether crayfish is actively routing (for legacy compat)
 * @param crayfishPos      crayfish world position (if visible)
 * @param schoolPos        dynamic tetra school center for idle tracking
 */
export function updateDirector(
  dt: number,
  activeCreatures: ActiveCreature[],
  crayfishRouting: boolean,
  crayfishPos: { x: number; y: number } | null,
  schoolPos: { x: number; y: number },
): Camera {
  if (!ds) {
    ds = {
      mode: 'idle-cycle',
      camera: { ...CAMERA_WIDE },
      idleCycle: IDLE_CYCLE,
      idleIndex: 0,
      currentZone: ZONES.wide,
      targetZone: ZONES.wide,
      zoneTimer: 0,
      transitionT: 0,
      transitioning: false,
      activeIndex: 0,
      activeDwell: 0,
    };
  }

  // Sort active creatures by priority (lower = more important)
  const sorted = [...activeCreatures].sort((a, b) => a.priority - b.priority);

  // --- Determine mode ---
  const prevMode = ds.mode;
  if (sorted.length === 0) {
    ds.mode = 'idle-cycle';
  } else if (sorted.length === 1) {
    ds.mode = 'tracking';
  } else {
    ds.mode = 'cycling-active';
  }

  // Reset on mode transition
  if (prevMode !== ds.mode) {
    if (ds.mode === 'idle-cycle') {
      ds.idleIndex = 0;
      ds.currentZone = ZONES.wide;
      ds.targetZone = ZONES.wide;
      ds.zoneTimer = 0;
      ds.transitionT = 0;
      ds.transitioning = false;
    } else if (ds.mode === 'cycling-active') {
      ds.activeIndex = 0;
      ds.activeDwell = 0;
    }
  }

  // --- Priority interrupt: AWAITING (priority 0) jumps to front ---
  if (ds.mode === 'cycling-active' && sorted.length > 0 && sorted[0].priority === 0) {
    // If current target isn't the highest-priority creature, snap to it
    if (ds.activeIndex !== 0) {
      ds.activeIndex = 0;
      ds.activeDwell = 0;
    }
  }

  // --- Execute mode ---
  switch (ds.mode) {
    case 'idle-cycle': {
      const cycle = IDLE_CYCLE;

      if (ds.transitioning) {
        ds.transitionT += dt / TRANSITION_SEC;
        if (ds.transitionT >= 1) {
          ds.transitionT = 1;
          ds.transitioning = false;
          ds.currentZone = ds.targetZone;
          ds.zoneTimer = 0;
        }
        const t = easeInOut(ds.transitionT);
        const fromCam = resolveIdleZoneCamera(ds.currentZone, schoolPos);
        const toCam = resolveIdleZoneCamera(ds.targetZone, schoolPos);
        ds.camera = lerpCamera(fromCam, toCam, t);
      } else {
        ds.zoneTimer += dt;
        const zoneCam = resolveIdleZoneCamera(ds.currentZone, schoolPos);
        ds.camera = lerpCamera(ds.camera, zoneCam, Math.min(1, dt * 2));

        if (ds.zoneTimer >= ds.currentZone.duration) {
          ds.idleIndex = (ds.idleIndex + 1) % cycle.length;
          ds.targetZone = cycle[ds.idleIndex];
          ds.transitioning = true;
          ds.transitionT = 0;
        }
      }
      break;
    }

    case 'tracking': {
      const c = sorted[0];
      const yOff = c.priority === 0 ? -0.05 : 0; // AWAITING: shift up for "?" bubble
      const target: Camera = { cx: c.x, cy: c.y + yOff, zoom: 3.2 };
      ds.camera = lerpCamera(ds.camera, target, Math.min(1, dt * 0.8));
      break;
    }

    case 'cycling-active': {
      ds.activeDwell += dt;
      if (ds.activeDwell >= ACTIVE_DWELL_SEC) {
        ds.activeIndex = (ds.activeIndex + 1) % sorted.length;
        ds.activeDwell = 0;
      }
      const c = sorted[ds.activeIndex % sorted.length];
      const yOff = c.priority === 0 ? -0.05 : 0;
      const target: Camera = { cx: c.x, cy: c.y + yOff, zoom: 3.2 };
      ds.camera = lerpCamera(ds.camera, target, Math.min(1, dt * 0.8));
      break;
    }
  }

  return clampCamera(ds.camera);
}

function resolveIdleZoneCamera(
  zone: CameraZone,
  schoolPos?: { x: number; y: number },
): Camera {
  if (zone.name === 'school' && schoolPos) {
    return { cx: schoolPos.x, cy: schoolPos.y, zoom: zone.zoom };
  }
  return { cx: zone.cx, cy: zone.cy, zoom: zone.zoom };
}

/** Jump to a specific zone immediately (for preview). */
export function setZone(zoneName: string): void {
  const zone = ZONES[zoneName];
  if (!zone) return;
  ds = {
    mode: 'idle-cycle',
    camera: { cx: zone.cx, cy: zone.cy, zoom: zone.zoom },
    idleCycle: IDLE_CYCLE,
    idleIndex: IDLE_CYCLE.findIndex(z => z.name === zoneName) ?? 0,
    currentZone: zone,
    targetZone: zone,
    zoneTimer: 0,
    transitionT: 0,
    transitioning: false,
    activeIndex: 0,
    activeDwell: 0,
  };
}

/** Override camera directly (for preview --zoom). */
export function setOverride(cam: Camera): void {
  ds = {
    mode: 'idle-cycle',
    camera: { ...cam },
    idleCycle: IDLE_CYCLE,
    idleIndex: 0,
    currentZone: ZONES.wide,
    targetZone: ZONES.wide,
    zoneTimer: 0,
    transitionT: 0,
    transitioning: false,
    activeIndex: 0,
    activeDwell: 0,
  };
}

/** Reset director state (e.g. on reconnect). */
export function resetDirector(): void {
  ds = null;
}

/** Get the name of the current camera zone (for change detection). */
export function getCurrentZoneName(): string {
  if (!ds) return 'wide';
  return ds.transitioning
    ? `${ds.currentZone.name}→${ds.targetZone.name}`
    : ds.currentZone.name;
}
