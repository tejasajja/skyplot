"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry, GeoJsonProperties } from "geojson";

const DATA_DIR = "/data/winddata";
const MANIFEST_URL = `${DATA_DIR}/wind_uv_manifest.json`;
const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json";

// ------------ CONFIGURABLE CONSTANTS ------------ //
const GLOBE_RADIUS = 200;
const PARTICLE_COUNT = 20000;
const PARTICLE_LIFE = 601;
const SPEED_FACTOR = 0.008;
const MAX_WIND_KMH = 150;
const TRAIL_FADE = 0.92;
const SIGNIFICANT_CAM_MOVE2 = 4;

// Temperature overlay settings
const TEMP_DATA_DIR = "/data/temperature";
const TEMP_MANIFEST_URL = `${TEMP_DATA_DIR}/temp_manifest.json`;
const TEMP_OVERLAY_ALPHA = 0.35;

// Air mode overlay settings
const OVERLAY_ALPHA = 0.4;
const AIR_MODE_ENABLED = true;

// Try 0.4–0.7 for different effects!
const GAMMA = 0.5;

/**
 * Nullschool Earth exact wind speed color mapping - uses extendedSinebowColor algorithm
 * Matches earth.nullschool.net wind visualization exactly
 */
const TAU = 2 * Math.PI;
const BOUNDARY = 0.45;

/**
 * Produces a color in a rainbow-like trefoil color space (sinebow)
 * This is the exact algorithm used by Nullschool Earth
 */
function sinebowColor(hue: number, alpha: number): [number, number, number, number] {
  // Map hue [0, 1] to radians [0, 5/6τ]. Don't allow a full rotation because that keeps hue == 0 and
  // hue == 1 from mapping to the same color.
  let rad = hue * TAU * 5/6;
  rad *= 0.75;  // increase frequency to 2/3 cycle per rad

  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const r = Math.floor(Math.max(0, -c) * 255);
  const g = Math.floor(Math.max(s, 0) * 255);
  const b = Math.floor(Math.max(c, 0, -s) * 255);
  return [r, g, b, alpha];
}

/**
 * Color interpolator between two colors
 */
function colorInterpolator(start: [number, number, number], end: [number, number, number]) {
  const r = start[0], g = start[1], b = start[2];
  const deltaR = end[0] - r, deltaG = end[1] - g, deltaB = end[2] - b;
  return function(i: number, a: number): [number, number, number, number] {
    return [
      Math.floor(r + i * deltaR), 
      Math.floor(g + i * deltaG), 
      Math.floor(b + i * deltaB), 
      a
    ];
  };
}

/**
 * Interpolates a sinebow color where 0 <= i <= BOUNDARY, then fades to white where BOUNDARY < i <= 1.
 * This is the exact extendedSinebowColor function from Nullschool Earth
 */
function extendedSinebowColor(i: number, alpha: number): [number, number, number, number] {
  const fadeToWhite = colorInterpolator(sinebowColor(1.0, 0).slice(0, 3) as [number, number, number], [255, 255, 255]);
  
  return i <= BOUNDARY ?
    sinebowColor(i / BOUNDARY, alpha) :
    fadeToWhite((i - BOUNDARY) / (1 - BOUNDARY), alpha);
}

/**
 * Wind speed color scale using Nullschool's exact algorithm
 * Wind speed bounds: [0, 100] m/s
 */
const windSpeedColorScale = (windSpeedMs: number, alpha: number = 1): [number, number, number, number] => {
  if (!Number.isFinite(windSpeedMs) || windSpeedMs < 0) {
    return [0, 0, 0, 0];
  }
  
  // Normalize wind speed to [0, 1] range with 100 m/s as maximum
  const normalized = Math.min(windSpeedMs, 100) / 100;
  
  // Use Nullschool's extendedSinebowColor function
  return extendedSinebowColor(normalized, Math.floor(alpha * 255));
};

/** Gamma-corrected color scale for perceptual smoothness. */
const colorForSpeed = (speedKmh: number): [number, number, number] => {
  const speedMs = speedKmh / 3.6; // Convert km/h to m/s
  const [r, g, b] = windSpeedColorScale(speedMs, 1);
  return [r, g, b];
};

const lonLatToVec3 = (lon: number, lat: number, r = GLOBE_RADIUS) => {
  // Standard mapping: X = r * cos(lat) * sin(lon)
  //                   Y = r * sin(lat)
  //                   Z = r * cos(lat) * cos(lon)
  const φ = THREE.MathUtils.degToRad(lat);
  const λ = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    r * Math.cos(φ) * Math.sin(λ),
    r * Math.sin(φ),
    r * Math.cos(φ) * Math.cos(λ)
  );
};

interface GridMeta {
  nx: number;
  ny: number;
  lo1: number;
  la1: number;
  dx: number;
  dy: number;
}

interface WindHeader {
  nx: number;
  ny: number;
  lo1: number;
  la1: number;
  dx: number;
  dy: number;
  surface1Type: number;
  surface1Value: number;
  // add more properties if you expect them!
}

interface WindObj {
  header: WindHeader;
  data: number[];
}

export default function GlobeWindMap() {
  const [levels, setLevels] = useState<
    { label: string; U: Float32Array; V: Float32Array; S: Float32Array }[]
  >([]);
  // Temperature levels (parallel to wind levels)
  const [tempLevels, setTempLevels] = useState<
    { label: string; T: Float32Array }[]
  >([]);
  const [lvlIdx, setLvlIdx] = useState(0);
  const [airModeEnabled, setAirModeEnabled] = useState(AIR_MODE_ENABLED);
  const [renderTrigger, setRenderTrigger] = useState(0);
  const gridMeta = useRef<GridMeta | null>(null);
  const tempGridMeta = useRef<GridMeta | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  // ---- LOAD DATA ---- //
  useEffect(() => {
    // 1. Fetch manifest listing all per-level files
    fetch(MANIFEST_URL)
      .then(r => r.json())
      .then(async (files: string[]) => {
        const next: typeof levels = [];

        for (const fname of files) {
          // 2. Fetch each file in DATA_DIR
          const uv: WindObj[] = await fetch(`${DATA_DIR}/${fname}`).then(r => r.json());

          const vObj = uv[0];
          const uObj = uv[1];
          if (!vObj || !uObj) continue;

          // 3. Setup gridMeta from first loaded file
          if (!gridMeta.current) {
            const { nx, ny, lo1, la1, dx, dy } = vObj.header;
            gridMeta.current = { nx, ny, lo1, la1, dx, dy };
          }

          const to32 = (d: number[]) => new Float32Array(d.map(x => x ?? NaN));
          const { surface1Type, surface1Value } = vObj.header;
          const label = surface1Type === 103 ? `${surface1Value} m` : `${surface1Value} hPa`;

          const U = to32(uObj.data);
          const V = to32(vObj.data);

          // Compute wind speed overlay
          const S = new Float32Array(U.length);
          for (let j = 0; j < U.length; j++) {
            const u = U[j], v = V[j];
            S[j] = (Number.isFinite(u) && Number.isFinite(v)) ? Math.sqrt(u * u + v * v) : NaN;
          }

          next.push({ label, V, U, S });
        }

        setLevels(next);
      });

    // Load temperature manifest and data
    fetch(TEMP_MANIFEST_URL)
      .then(r => r.json())
      .then(async (files: string[]) => {
        const next: { label: string; T: Float32Array }[] = [];
        console.log('Loading temperature files:', files);
        for (const fname of files) {
          try {
            const tObj = await fetch(`${TEMP_DATA_DIR}/${fname}`).then(r => r.json());
            if (!tObj || !tObj.header || !tObj.data) continue;
            
            console.log(`Temperature file ${fname}:`, {
              header: tObj.header,
              dataLength: tObj.data?.length,
              sampleData: tObj.data?.slice(0, 10)
            });
            
            // Setup tempGridMeta from first loaded temperature file
            if (!tempGridMeta.current) {
              const { nx, ny, lo1, la1, dx, dy } = tObj.header;
              tempGridMeta.current = { nx, ny, lo1, la1, dx, dy };
              console.log('Temperature grid metadata:', tempGridMeta.current);
              console.log('Grid longitude range:', lo1, 'to', lo1 + nx * dx);
              console.log('Grid latitude range:', la1, 'to', la1 - ny * dy);
            }
            
            const { surface1Type, surface1Value } = tObj.header;
            const label = surface1Type === 103 ? `${surface1Value} m` : `${surface1Value} hPa`;
            const T = new Float32Array(tObj.data.map((x: number) => x ?? NaN));
            next.push({ label, T });
          } catch (error) {
            console.warn(`Failed to load temperature file ${fname}:`, error);
            continue;
          }
        }
        console.log('Loaded temperature levels:', next.map(l => l.label));
        setTempLevels(next);
      })
      .catch(error => {
        console.warn('Failed to load temperature manifest:', error);
      });
  }, []);

  /**
   * Enhanced Nullschool temperature color scale with better contrast for all temperatures
   * Optimized for better visibility of temperature differences, especially at higher temps
   * Temperature range: -80°C to +50°C with enhanced gradients
   */
  function tempColorScale(tempValue: number, alpha: number = 1): [number, number, number, number] {
    // Handle invalid values
    if (!Number.isFinite(tempValue)) {
      return [0, 0, 0, 0]; // Transparent for invalid data
    }
    
    // Convert Kelvin to Celsius if needed
    const tempC = tempValue > 100 ? tempValue - 273.15 : tempValue;
    
    // Nullschool temperature range: -80°C to +50°C
    const minTemp = -80;
    const maxTemp = 50;
    const clampedTemp = Math.max(minTemp, Math.min(maxTemp, tempC));
    
    // Normalize to [0, 1]
    const t = (clampedTemp - minTemp) / (maxTemp - minTemp);
    
    let r: number, g: number, b: number;
    
    // Enhanced color mapping with better contrast and visibility
    if (t < 0.10) { // -80°C to -67°C: Deep Purple (Very Cold)
      const scale = t / 0.10;
      r = Math.round(80 + scale * 30);   // Deep purple to purple
      g = Math.round(20 + scale * 40);
      b = Math.round(120 + scale * 60);
    } else if (t < 0.25) { // -67°C to -47.5°C: Purple to Blue (Cold)
      const scale = (t - 0.10) / 0.15;
      r = Math.round(110 * (1 - scale) + 50 * scale);
      g = Math.round(60 * (1 - scale) + 120 * scale);
      b = Math.round(180 * (1 - scale) + 220 * scale);
    } else if (t < 0.40) { // -47.5°C to -28°C: Blue to Light Blue (Cool)
      const scale = (t - 0.25) / 0.15;
      r = Math.round(50 * (1 - scale) + 80 * scale);
      g = Math.round(120 * (1 - scale) + 180 * scale);
      b = Math.round(220 * (1 - scale) + 240 * scale);
    } else if (t < 0.50) { // -28°C to -15°C: Light Blue to Cyan (Cool-Mild)
      const scale = (t - 0.40) / 0.10;
      r = Math.round(80 * (1 - scale) + 100 * scale);
      g = Math.round(180 * (1 - scale) + 220 * scale);
      b = Math.round(240 * (1 - scale) + 240 * scale);
    } else if (t < 0.60) { // -15°C to -2°C: Cyan to Light Green (Around Freezing)
      const scale = (t - 0.50) / 0.10;
      r = Math.round(100 * (1 - scale) + 160 * scale);
      g = Math.round(220 * (1 - scale) + 240 * scale);
      b = Math.round(240 * (1 - scale) + 180 * scale);
    } else if (t < 0.70) { // -2°C to +11°C: Light Green to Yellow-Green (Mild)
      const scale = (t - 0.60) / 0.10;
      r = Math.round(160 * (1 - scale) + 220 * scale);
      g = Math.round(240 * (1 - scale) + 250 * scale);
      b = Math.round(180 * (1 - scale) + 120 * scale);
    } else if (t < 0.78) { // +11°C to +21°C: Yellow-Green to Yellow (Warm)
      const scale = (t - 0.70) / 0.08;
      r = Math.round(220 * (1 - scale) + 255 * scale);
      g = Math.round(250 * (1 - scale) + 240 * scale);
      b = Math.round(120 * (1 - scale) + 60 * scale);
    } else if (t < 0.86) { // +21°C to +31°C: Yellow to Orange (Hot)
      const scale = (t - 0.78) / 0.08;
      r = Math.round(255);  // Keep red at max
      g = Math.round(240 * (1 - scale) + 160 * scale);
      b = Math.round(60 * (1 - scale) + 20 * scale);
    } else if (t < 0.93) { // +31°C to +41°C: Orange to Red-Orange (Very Hot)
      const scale = (t - 0.86) / 0.07;
      r = Math.round(255 * (1 - scale) + 250 * scale);
      g = Math.round(160 * (1 - scale) + 80 * scale);
      b = Math.round(20 * (1 - scale) + 15 * scale);
    } else if (t < 0.97) { // +41°C to +47°C: Red-Orange to Deep Red (Extremely Hot)
      const scale = (t - 0.93) / 0.04;
      r = Math.round(250 * (1 - scale) + 220 * scale);
      g = Math.round(80 * (1 - scale) + 30 * scale);
      b = Math.round(15 * (1 - scale) + 10 * scale);
    } else { // +47°C to +50°C: Deep Red to Dark Red (Extreme Heat)
      const scale = (t - 0.97) / 0.03;
      r = Math.round(220 * (1 - scale) + 180 * scale);
      g = Math.round(30 * (1 - scale) + 10 * scale);
      b = Math.round(10 * (1 - scale) + 5 * scale);
    }
    
    return [r, g, b, Math.floor(alpha * 255)];
  }

  // ---- RENDERING ---- //
  useEffect(() => {
    if (!wrap.current || !levels.length || !gridMeta.current) return;

    const { nx, ny, lo1, la1, dx, dy } = gridMeta.current;
    const { U, V, S } = levels[lvlIdx];

    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 1);
    renderer.domElement.style.cssText = "position:absolute;inset:0";
    wrap.current.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
    camera.position.set(0, 0, 450);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05; // Reduced for more responsive controls
    controls.minDistance = 250;
    controls.maxDistance = 800;
    controls.zoomSpeed = 1.2; // Slightly faster zoom
    controls.rotateSpeed = 1.0;

    // Simplified movement detection using controls events only
    let controlsChangeTimeout: NodeJS.Timeout;

    // --------------- WIND TRAILS CANVAS --------------- //
    const windCanvas = document.createElement("canvas");
    windCanvas.style.cssText = "position:absolute;inset:0;pointer-events:none";
    wrap.current.appendChild(windCanvas);

    const ctx = windCanvas.getContext("2d")!;
    ctx.lineWidth = 1.0; // Slightly thinner for cleaner look
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // Adjust shadow based on overlay mode for better contrast
    if (overlayMode === 'temperature') {
      ctx.shadowBlur = 8;
      ctx.shadowColor = "rgba(0,0,0,0.8)";
    } else {
      ctx.shadowBlur = 6;
      ctx.shadowColor = "rgba(255,255,255,0.6)";
    }

    // --------------- WIND SPEED OVERLAY CANVAS --------------- //
    const overlayCanvas = document.createElement("canvas");
    overlayCanvas.style.cssText = "position:absolute;inset:0;pointer-events:none";
    wrap.current.appendChild(overlayCanvas);

    const overlayCtx = overlayCanvas.getContext("2d")!;

    // Movement tracking variables  
    let isMoving = false;
    let moveTimeout: NodeJS.Timeout;

    // --------------- RESIZE HANDLER --------------- //
    const resize = () => {
      const { offsetWidth: w, offsetHeight: h } = wrap.current!;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      windCanvas.width = w;
      windCanvas.height = h;
      overlayCanvas.width = w;
      overlayCanvas.height = h;
      ctx.clearRect(0, 0, w, h);
      overlayCtx.clearRect(0, 0, w, h);
      
      // Re-render overlay after resize
      if ((airModeEnabled || overlayMode === 'temperature') && !isMoving) {
        setTimeout(() => renderAirModeOverlay(), 100);
      }
    };
    resize();
    window.addEventListener("resize", resize);

    // --------------- GLOBE GEOMETRY - OPTIMIZED TO PREVENT ARTIFACTS --------------- //
    const globeMaterial = new THREE.MeshBasicMaterial({ 
      color: 0x000000,
      transparent: false,
      opacity: 1.0
    });
    const globeGeometry = new THREE.SphereGeometry(GLOBE_RADIUS, 64, 64);
    const globeMesh = new THREE.Mesh(globeGeometry, globeMaterial);
    scene.add(globeMesh);

    // --------------- COUNTRY OUTLINES - WITH SMART FILTERING --------------- //
    (async () => {
      const topo = await (await fetch(WORLD_URL)).json();
      const geos = (feature(
        topo,
        topo.objects.countries
      ) as unknown as FeatureCollection<Geometry, GeoJsonProperties>).features;

      const pos: number[] = [];

      const pushSeg = (a: number[], b: number[]) => {
        // Skip segments that cross the antimeridian (180°/-180° boundary)
        if (Math.abs(a[0] - b[0]) > 180) return;
        
        // Skip very long segments that could be problematic
        const distance = Math.sqrt(Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2));
        if (distance > 30) return; // More conservative filtering
        
        // Skip near-vertical segments that could create the black line artifact
        const lonDiff = Math.abs(a[0] - b[0]);
        const latDiff = Math.abs(a[1] - b[1]);
        
        // This is the key fix: skip segments that are nearly vertical and long
        if (lonDiff < 0.5 && latDiff > 15) return; // Skip long vertical-like segments
        
        // Skip segments very close to problematic meridians (more focused filtering)
        const tolerance = 0.1; // Much smaller tolerance
        if (Math.abs(Math.abs(a[0]) - 180) < tolerance && Math.abs(Math.abs(b[0]) - 180) < tolerance) return;
        if (Math.abs(a[0]) < tolerance && Math.abs(b[0]) < tolerance) return;
        
        // Allow most other segments for proper country outlines
        const v1 = lonLatToVec3(a[0], a[1], GLOBE_RADIUS + 1.1);
        const v2 = lonLatToVec3(b[0], b[1], GLOBE_RADIUS + 1.1);
        pos.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
      };

      const ring = (coords: number[][]) => {
        if (coords.length < 2) return;
        const closed = [...coords];
        const [fLon, fLat] = coords[0];
        const [lLon, lLat] = coords[coords.length - 1];
        if (fLon !== lLon || fLat !== lLat) closed.push([fLon, fLat]);
        for (let i = 0; i < closed.length - 1; i++) pushSeg(closed[i], closed[i + 1]);
      };

      // Draw country borders with smart filtering
      geos.forEach((g: Feature<Geometry, GeoJsonProperties>) => {
        const { geometry } = g;
        if (geometry.type === "Polygon") {
          geometry.coordinates.forEach(ring);
        } else if (geometry.type === "MultiPolygon") {
          geometry.coordinates.forEach(polygon => polygon.forEach(ring));
        }
      });

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));

      scene.add(new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.6, transparent: true })
      ));
    })();

    // --------------- LAT/LON GRID (REFERENCE) --------------- //
    // Re-enabled grid lines with careful filtering to avoid artifacts
    const gridLines: number[] = [];
    
    // Latitude lines (horizontal)
    for (let lat = -80; lat <= 80; lat += 20) {
      for (let lon = -180; lon < 180; lon += 2) {
        const v1 = lonLatToVec3(lon, lat, GLOBE_RADIUS + 0.8);
        const v2 = lonLatToVec3(lon + 2, lat, GLOBE_RADIUS + 0.8);
        gridLines.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
      }
    }
    
    // Longitude lines (vertical) - with careful filtering to avoid black line artifacts
    for (let lon = -180; lon <= 180; lon += 30) {
      // Skip problematic meridians that can cause artifacts
      if (Math.abs(lon) === 180 || lon === 0) continue;
      
      for (let lat = -80; lat < 80; lat += 2) {
        const v1 = lonLatToVec3(lon, lat, GLOBE_RADIUS + 0.8);
        const v2 = lonLatToVec3(lon, lat + 2, GLOBE_RADIUS + 0.8);
        gridLines.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
      }
    }
    
    if (gridLines.length > 0) {
      const gridGeo = new THREE.BufferGeometry();
      gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(gridLines, 3));
      scene.add(new THREE.LineSegments(
        gridGeo,
        new THREE.LineBasicMaterial({ color: 0x444444, opacity: 0.3, transparent: true })
      ));
    }

    // --------------- PARTICLES --------------- //
    const particles = Array.from({ length: PARTICLE_COUNT }, () => ({
      lon: Math.random() * 360 - 180,
      lat: Math.random() * 180 - 90,
      age: Math.random() * PARTICLE_LIFE
    }));

    const prevXY = new Float32Array(PARTICLE_COUNT * 2).fill(NaN);
    const clearPrev = (i: number) => (prevXY[2 * i] = prevXY[2 * i + 1] = NaN);

    const recycle = (i: number) => {
      particles[i] = {
        lon: Math.random() * 360 - 180,
        lat: Math.random() * 180 - 90,
        age: 0
      };
      clearPrev(i);
    };

    const idx = (j: number, i: number) => j * nx + ((i + nx) % nx);

    // FIXED: Improved longitude normalization to prevent wraparound artifacts
    const normalizeLon = (lon: number) => {
      // Ensure longitude is properly wrapped to [-180, 180] range
      let normalized = ((lon + 180) % 360) - 180;
      if (normalized < -180) normalized += 360;
      if (normalized > 180) normalized -= 360;
      return normalized;
    };

    const windAt = (lon: number, lat: number) => {
      // Shift longitude by +180 for correct alignment
      lon = normalizeLon(lon);
      const i = ((lon - lo1 + 360) % 360) / dx;
      const j = (la1 - lat) / dy;
      const i0 = Math.floor(i), j0 = Math.floor(j);
      const fi = i - i0, fj = j - j0;

      const interp = (A: Float32Array) => {
        const g00 = A[idx(j0, i0)],
          g10 = A[idx(j0, i0 + 1)],
          g01 = A[idx(j0 + 1, i0)],
          g11 = A[idx(j0 + 1, i0 + 1)];
        return g00 * (1 - fi) * (1 - fj) +
          g10 * fi * (1 - fj) +
          g01 * (1 - fi) * fj +
          g11 * fi * fj;
      };

      return { u: interp(U), v: interp(V) };
    };

    // STREAMLINES colored by local wind speed!
    const trailColor = (u: number, v: number) => {
      // Make wind particles more visible when temperature overlay is active
      if (overlayMode === 'temperature') {
        return "rgba(255,255,255,0.9)"; // Brighter white for better visibility over temperature
      }
      return "rgba(255,255,255,0.7)"; // Standard nullschool style
    };

    const worldToScreen = (v: THREE.Vector3): [number, number] | null => {
      const vec = v.clone().project(camera);
      if (vec.z > 1) return null;
      const s = renderer.getSize(new THREE.Vector2());
      return [(vec.x * 0.5 + 0.5) * s.x, (-vec.y * 0.5 + 0.5) * s.y];
    };

    const lastCamPos = camera.position.clone();
    const lastCamTarget = controls.target.clone();
    
    const cameraMoved = () => {
      return camera.position.distanceToSquared(lastCamPos) > SIGNIFICANT_CAM_MOVE2 || 
             controls.target.distanceToSquared(lastCamTarget) > SIGNIFICANT_CAM_MOVE2;
    };
    
    const handleCamMove = () => {
      // Clear particles canvas
      ctx.clearRect(0, 0, windCanvas.width, windCanvas.height);
      prevXY.fill(NaN);
      lastCamPos.copy(camera.position);
      lastCamTarget.copy(controls.target);
      
      // Mark as moving and clear overlay
      isMoving = true;
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      
      clearTimeout(moveTimeout);
      
      // Set timeout to render overlay after movement stops
      moveTimeout = setTimeout(() => {
        isMoving = false;
        if (airModeEnabled || overlayMode === 'temperature') {
          renderAirModeOverlay();
        }
      }, 150); // Longer delay to ensure movement has completely stopped
    };

    // Use controls change event for movement detection
    controls.addEventListener('change', () => {
      clearTimeout(controlsChangeTimeout);
      controlsChangeTimeout = setTimeout(() => {
        if (cameraMoved()) {
          handleCamMove();
        }
      }, 5); // Very short debounce
    });

    // --------------- AIR MODE OVERLAY RENDERING --------------- //
    const renderAirModeOverlay = () => {
      if ((!airModeEnabled && overlayMode !== 'temperature') || isMoving) return;
      requestAnimationFrame(() => {
        if ((!airModeEnabled && overlayMode !== 'temperature') || isMoving) return;
        const { width, height } = overlayCanvas;
        const ctx = overlayCtx;
        ctx.clearRect(0, 0, width, height);
        const camDir = camera.position.clone().normalize();
        const baseStep = overlayMode === 'temperature' ? 
          Math.max(1, Math.floor(Math.min(width, height) / 800)) : // Higher resolution for temperature
          Math.max(1, Math.floor(Math.min(width, height) / 600));   // Improved resolution for wind
        const step = baseStep;
        const imageData = ctx.createImageData(width, height);
        const data = imageData.data;
        for (let x = 0; x < width; x += step) {
          for (let y = 0; y < height; y += step) {
            // Convert screen coordinates to normalized device coordinates
            const ndcX = (x / width) * 2 - 1;
            const ndcY = -(y / height) * 2 + 1;
            
            // Create ray from camera through screen point
            const screenPoint = new THREE.Vector3(ndcX, ndcY, 0.5);
            screenPoint.unproject(camera);
            
            const rayDirection = screenPoint.sub(camera.position).normalize();
            
            // Intersect with sphere
            const oc = camera.position.clone();
            const a = rayDirection.dot(rayDirection);
            const b = 2.0 * oc.dot(rayDirection);
            const c = oc.dot(oc) - GLOBE_RADIUS * GLOBE_RADIUS;
            const discriminant = b * b - 4 * a * c;
            
            if (discriminant >= 0) {
              const t = (-b - Math.sqrt(discriminant)) / (2 * a);
              if (t > 0) {
                const intersectionPoint = camera.position.clone().add(rayDirection.multiplyScalar(t));
                
                // Check if point is on visible side
                const normal = intersectionPoint.clone().normalize();
                if (normal.dot(camDir) > 0.1) {
                  
                  // Convert 3D intersection point to lon/lat with better precision
                  const lon = Math.atan2(intersectionPoint.x, intersectionPoint.z) * 180 / Math.PI;
                  const lat = Math.asin(Math.max(-1, Math.min(1, intersectionPoint.y / GLOBE_RADIUS))) * 180 / Math.PI;
                  if (overlayMode === 'wind') {
                    const { u, v } = windAt(lon, lat);
                    if (Number.isFinite(u) && Number.isFinite(v)) {
                      const speedMs = Math.sqrt(u * u + v * v);
                      const [r, g, b, a] = windSpeedColorScale(speedMs, OVERLAY_ALPHA);
                      
                      // Anti-aliasing by sampling multiple points within the pixel area
                      const subSamples = step > 1 ? 2 : 1; // Use subsampling for larger steps
                      const sampleStep = step / subSamples;
                      
                      for (let dx = 0; dx < step && x + dx < width; dx++) {
                        for (let dy = 0; dy < step && y + dy < height; dy++) {
                          let avgR = r, avgG = g, avgB = b, avgA = a;
                          
                          // For larger step sizes, do subsampling for smoother edges
                          if (subSamples > 1) {
                            let totalR = 0, totalG = 0, totalB = 0, totalA = 0;
                            let sampleCount = 0;
                            
                            for (let sx = 0; sx < subSamples; sx++) {
                              for (let sy = 0; sy < subSamples; sy++) {
                                const subX = x + dx + sx * sampleStep;
                                const subY = y + dy + sy * sampleStep;
                                
                                if (subX < width && subY < height) {
                                  const subNdcX = (subX / width) * 2 - 1;
                                  const subNdcY = -(subY / height) * 2 + 1;
                                  const subPoint = new THREE.Vector3(subNdcX, subNdcY, 0.5);
                                  subPoint.unproject(camera);
                                  const subRayDir = subPoint.sub(camera.position).normalize();
                                  
                                  const subOc = camera.position.clone();
                                  const subA = subRayDir.dot(subRayDir);
                                  const subB = 2.0 * subOc.dot(subRayDir);
                                  const subC = subOc.dot(subOc) - GLOBE_RADIUS * GLOBE_RADIUS;
                                  const subDisc = subB * subB - 4 * subA * subC;
                                  
                                  if (subDisc >= 0) {
                                    const subT = (-subB - Math.sqrt(subDisc)) / (2 * subA);
                                    if (subT > 0) {
                                      const subIntersection = camera.position.clone().add(subRayDir.multiplyScalar(subT));
                                      const subNormal = subIntersection.clone().normalize();
                                      
                                      if (subNormal.dot(camDir) > 0.1) {
                                        const subLon = Math.atan2(subIntersection.x, subIntersection.z) * 180 / Math.PI;
                                        const subLat = Math.asin(Math.max(-1, Math.min(1, subIntersection.y / GLOBE_RADIUS))) * 180 / Math.PI;
                                        const { u: subU, v: subV } = windAt(subLon, subLat);
                                        
                                        if (Number.isFinite(subU) && Number.isFinite(subV)) {
                                          const subSpeed = Math.sqrt(subU * subU + subV * subV);
                                          const [subR, subG, subB, subAlpha] = windSpeedColorScale(subSpeed, OVERLAY_ALPHA);
                                          totalR += subR;
                                          totalG += subG;
                                          totalB += subB;
                                          totalA += subAlpha;
                                          sampleCount++;
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                            
                            if (sampleCount > 0) {
                              avgR = Math.round(totalR / sampleCount);
                              avgG = Math.round(totalG / sampleCount);
                              avgB = Math.round(totalB / sampleCount);
                              avgA = Math.round(totalA / sampleCount);
                            }
                          }
                          
                          const px = x + dx;
                          const py = y + dy;
                          const idx = (py * width + px) * 4;
                          data[idx] = avgR;
                          data[idx + 1] = avgG;
                          data[idx + 2] = avgB;
                          data[idx + 3] = avgA;
                        }
                      }
                    }
                  } else if (overlayMode === 'temperature' && tempLevels[lvlIdx] && tempGridMeta.current) {
                    // Temperature overlay - use temperature grid metadata
                    const tempLevel = tempLevels[lvlIdx];
                    const { nx: tempNx, ny: tempNy, lo1: tempLo1, la1: tempLa1, dx: tempDx, dy: tempDy } = tempGridMeta.current;
                    
                    // FIXED: Simplified and consistent longitude handling
                    // Convert longitude to 0-360 range consistently
                    let normLon = ((lon + 360) % 360);
                    
                    // Convert grid longitude origin to 0-360 range for consistency
                    let gridLo1 = tempLo1;
                    if (gridLo1 < 0) {
                      gridLo1 = ((gridLo1 + 360) % 360);
                    }
                    
                    // Calculate grid coordinates with proper handling
                    let gridLon = normLon;
                    
                    // Handle wraparound for longitude - ensure we're in the right range
                    if (gridLon < gridLo1) {
                      gridLon += 360;
                    }
                    if (gridLon >= gridLo1 + 360) {
                      gridLon -= 360;
                    }
                    
                    // Calculate grid indices
                    const i = (gridLon - gridLo1) / tempDx;
                    const j = (tempLa1 - lat) / tempDy;
                    const i0 = Math.floor(i), j0 = Math.floor(j);
                    const fi = i - i0, fj = j - j0;
                    
                    // Improved bounds checking
                    if (j0 >= 0 && j0 < tempNy - 1 && i0 >= 0) {
                      // FIXED: Simplified index calculation with proper longitude wraparound
                      const idxT = (jj: number, ii: number) => {
                        // Handle longitude wraparound properly
                        const wrappedII = ((ii % tempNx) + tempNx) % tempNx;
                        return jj * tempNx + wrappedII;
                      };
                      
                      const T = tempLevel.T;
                      
                      // FIXED: Safer grid point access
                      const safeGet = (jj: number, ii: number) => {
                        if (jj < 0 || jj >= tempNy) return NaN;
                        const idx = idxT(jj, ii);
                        return (idx >= 0 && idx < T.length) ? T[idx] : NaN;
                      };                      
                      // Get interpolation grid points
                      const g00 = safeGet(j0, i0);
                      const g10 = safeGet(j0, i0 + 1);
                      const g01 = safeGet(j0 + 1, i0);
                      const g11 = safeGet(j0 + 1, i0 + 1);

                      // Check if we have valid data points for interpolation
                      if (Number.isFinite(g00) && Number.isFinite(g10) && Number.isFinite(g01) && Number.isFinite(g11)) {
                        // Bilinear interpolation
                        const tempValue = g00 * (1 - fi) * (1 - fj) +
                          g10 * fi * (1 - fj) +
                          g01 * (1 - fi) * fj +
                          g11 * fi * fj;
                        
                        if (Number.isFinite(tempValue)) {
                          // SIMPLIFIED artifact filtering - only skip extreme outliers
                          let shouldSkip = false;
                          
                          // Check for extreme temperature values that are likely data errors
                          if (tempValue < -100 || tempValue > 100) {
                            shouldSkip = true;
                          }
                          
                          // Check for extreme local variations only near grid boundaries
                          if (!shouldSkip && (i0 === 0 || i0 === tempNx - 1)) {
                            const neighbors = [g00, g10, g01, g11].filter(Number.isFinite);
                            if (neighbors.length >= 3) {
                              const mean = neighbors.reduce((a, b) => a + b) / neighbors.length;
                              const maxDiff = Math.max(...neighbors.map(n => Math.abs(n - mean)));
                              // Only skip if there's an extreme difference (>50K) at boundaries
                              if (maxDiff > 50) {
                                shouldSkip = true;
                              }
                            }
                          }
                          
                          let finalTemp = tempValue;
                          
                          // If we detected artifacts, try to interpolate from nearby valid values
                          if (shouldSkip) {
                            const validNeighbors = [];
                            for (let di = -2; di <= 2; di++) {
                              for (let dj = -2; dj <= 2; dj++) {
                                if (di === 0 && dj === 0) continue;
                                const ni = i0 + di;
                                const nj = j0 + dj;
                                if (ni >= 0 && ni < tempNx && nj >= 0 && nj < tempNy) {
                                  const neighborVal = safeGet(nj, ni);
                                  if (Number.isFinite(neighborVal) && neighborVal > -100 && neighborVal < 100) {
                                    const distance = Math.sqrt(di * di + dj * dj);
                                    validNeighbors.push({ val: neighborVal, dist: distance });
                                  }
                                }
                              }
                            }
                            
                            if (validNeighbors.length > 0) {
                              // Simple distance-weighted average
                              let weightedSum = 0;
                              let totalWeight = 0;
                              for (const neighbor of validNeighbors) {
                                const weight = 1 / (neighbor.dist + 0.1);
                                weightedSum += neighbor.val * weight;
                                totalWeight += weight;
                              }
                              if (totalWeight > 0) {
                                finalTemp = weightedSum / totalWeight;
                              }
                            }
                          }
                          
                          // Convert temperature and get color
                          const [r, g, b, a] = tempColorScale(finalTemp, TEMP_OVERLAY_ALPHA);
                          
                          // Reduce opacity for interpolated values
                          const baseAlpha = shouldSkip ? 0.5 : 0.8;
                          const finalAlpha = Math.floor(a * baseAlpha);
                          
                          // Apply color to pixels
                          for (let dx = 0; dx < step && x + dx < width; dx++) {
                            for (let dy = 0; dy < step && y + dy < height; dy++) {
                              const px = x + dx;
                              const py = y + dy;
                              const idx = (py * width + px) * 4;
                              data[idx] = r;
                              data[idx + 1] = g;
                              data[idx + 2] = b;
                              data[idx + 3] = finalAlpha;
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        ctx.putImageData(imageData, 0, 0);
      });
    };

    const updateParticles = () => {
      ctx.save();
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = `rgba(0,0,0,${TRAIL_FADE})`;
      ctx.fillRect(0, 0, windCanvas.width, windCanvas.height);
      ctx.restore();
      ctx.globalCompositeOperation = "lighter";

      const camDir = camera.position.clone().normalize();
      const sMin = Math.min(windCanvas.width, windCanvas.height) * 0.4;

      particles.forEach((p, i) => {
        const { u, v } = windAt(p.lon, p.lat);
        if (!Number.isFinite(u) || !Number.isFinite(v)) return recycle(i);

        const sx0 = prevXY[2 * i], sy0 = prevXY[2 * i + 1];

        // Save previous world position for visibility check
        const prevLon = p.lon;
        const prevLat = p.lat;

        // Update longitude with consistent normalization (+180 instead of +540)
        p.lon = ((p.lon + (u * SPEED_FACTOR) / Math.cos(THREE.MathUtils.degToRad(p.lat)) + 180) % 360) - 180;
        p.lat += v * SPEED_FACTOR;

        if (p.lat > 90 || p.lat < -90) {
          p.lat = THREE.MathUtils.clamp(p.lat, -89.999, 89.999);
          p.lon = ((p.lon + 180) % 360) - 180;
          clearPrev(i);
        }

        if (++p.age > PARTICLE_LIFE) return recycle(i);

        const worldPos = lonLatToVec3(p.lon, p.lat, GLOBE_RADIUS + 0.5);
        const prevWorldPos = lonLatToVec3(prevLon, prevLat, GLOBE_RADIUS + 0.5);
        const visibleNow = worldPos.clone().normalize().dot(camDir) > 0;
        const visiblePrev = prevWorldPos.clone().normalize().dot(camDir) > 0;
        if (!visibleNow || !visiblePrev) {
          clearPrev(i);
          return;
        }

        const scr = worldToScreen(worldPos);
        if (!scr) return clearPrev(i);

        const [sx1, sy1] = scr;
        prevXY[2 * i] = sx1;
        prevXY[2 * i + 1] = sy1;

        if (!isNaN(sx0) && Math.hypot(sx1 - sx0, sy1 - sy0) <= sMin) {
          ctx.strokeStyle = trailColor(u, v);
          ctx.globalAlpha = Math.min(1.0, 0.1 + (PARTICLE_LIFE - p.age) / PARTICLE_LIFE * 0.9); // Fade with age
          ctx.beginPath();
          ctx.moveTo(sx0, sy0);
          ctx.lineTo(sx1, sy1);
          ctx.stroke();
          ctx.globalAlpha = 1.0; // Reset alpha
        }
      });
    };

    // --------------- ANIMATION LOOP --------------- //
    let raf = 0;
    
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      updateParticles();
      renderer.render(scene, camera);
    };
    loop();

    // Initial overlay render with delay to ensure everything is initialized
    if (airModeEnabled || overlayMode === 'temperature') {
      setTimeout(() => {
        if (!isMoving) {
          renderAirModeOverlay();
        }
      }, 500);
    }

    // --------------- CLEAN-UP --------------- //
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(moveTimeout);
      clearTimeout(controlsChangeTimeout);
      window.removeEventListener("resize", resize);
      controls.dispose();
      renderer.dispose();
      wrap.current?.removeChild(renderer.domElement);
      wrap.current?.removeChild(windCanvas);
      wrap.current?.removeChild(overlayCanvas);
    };
  }, [levels, lvlIdx, renderTrigger]);

  // ---- UI: air mode toggle ---- //
  const toggleAirMode = () => {
    setAirModeEnabled(!airModeEnabled);
    // Trigger a re-render of the air mode overlay
    setRenderTrigger(prev => prev + 1);
  };

  // ---- UI: overlay mode selector ---- //
  const [dashOpen, setDashOpen] = useState(false);
  const [overlayMode, setOverlayMode] = useState<'wind' | 'temperature' | 'none'>('wind');
  const [legendHover, setLegendHover] = useState<number | null>(null);
  const [altitudeHover, setAltitudeHover] = useState<number | null>(null);

  // Effect to handle overlay mode changes
  useEffect(() => {
    // Use a more reliable way to find the overlay canvas
    const canvases = wrap.current?.querySelectorAll('canvas');
    if (canvases && canvases.length >= 2) {
      const overlayCanvas = canvases[2]; // Third canvas is the overlay
      const ctx = overlayCanvas.getContext('2d');
      
      if (!airModeEnabled && overlayMode !== 'temperature') {
        // Clear overlay when disabled
        ctx?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      } else {
        // Render overlay when enabled
        setTimeout(() => {
          const renderEvent = new CustomEvent('renderAirMode');
          wrap.current?.dispatchEvent(renderEvent);
        }, 100);
      }
    }
  }, [airModeEnabled, overlayMode]);

  // Accessibility: focus management
  const dashRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (dashOpen) dashRef.current?.focus();
  }, [dashOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 't' || e.key === 'T') {
        setDashOpen(d => !d);
      }
      if (dashOpen && (e.key === 'Escape' || e.key === 'x')) {
        setDashOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dashOpen]);

  // Hide overlay if overlayMode is 'none'
  useEffect(() => {
    // Enable air mode for both wind and temperature overlays
    setAirModeEnabled(overlayMode === 'wind' || overlayMode === 'temperature');
    setRenderTrigger(prev => prev + 1);
  }, [overlayMode]);

  // Keyboard navigation for altitude slider
  useEffect(() => {
    if (!dashOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Allow keyboard navigation even when the range input isn't focused
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        setLvlIdx(i => Math.max(0, i - 1));
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        setLvlIdx(i => Math.min(levels.length - 1, i + 1));
      }
      if (e.key === 'Home') {
        e.preventDefault();
        setLvlIdx(0);
      }
      if (e.key === 'End') {
        e.preventDefault();
        setLvlIdx(levels.length - 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dashOpen, levels.length]);

  const onAltitudeChange = (e: React.ChangeEvent<HTMLSelectElement>) => setLvlIdx(Number(e.target.value));
  const altitudeLabel = levels[lvlIdx]?.label || '';

  return (
    <>
      {/* Dashboard toggle button */}
      <button
        onClick={() => setDashOpen(!dashOpen)}
        className="fixed bottom-6 right-6 z-20 w-12 h-12 bg-white/10 backdrop-blur-lg rounded-full border border-white/20 text-white text-xl shadow-lg hover:bg-white/20 transition-all duration-200"
        style={{ cursor: 'pointer' }}
        aria-label="Toggle dashboard"
      >
        ⚙️
      </button>

      {dashOpen && (
        <div
          ref={dashRef}
          tabIndex={0}
          aria-label="Wind globe dashboard"
          role="dialog"
          className="fixed bottom-6 left-6 z-30 bg-white/10 backdrop-blur-lg rounded-2xl px-7 py-5 text-white text-sm min-w-[340px] max-w-[420px] shadow-2xl border border-white/20 animate-fadein"
          style={{ boxShadow: '0 8px 32px 0 rgba(0,0,0,0.25)', outline: 'none', transition: 'box-shadow 0.2s', width: 380 }}
        >
          <button
            aria-label="Close dashboard"
            className="absolute top-2 right-3 text-xl text-white/70 hover:text-white/100 focus:outline-none"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}
            onClick={() => setDashOpen(false)}
          >×</button>
          <div className="font-bold mb-1 text-base tracking-wide">Dashboard</div>
          {/* Overlay selector as pill toggle */}
          <div className="mb-2 flex items-center gap-2">
            <span className="mr-1 font-medium">Overlay</span>
            <div className="flex gap-1" role="radiogroup" aria-label="Overlay selector">
              {["wind", "temperature", "none"].map(mode => (
                <button
                  key={mode}
                  role="radio"
                  aria-checked={overlayMode === mode}
                  tabIndex={0}
                  className={`px-3 py-1 rounded-full font-semibold text-xs transition-all duration-150 border border-white/20 focus:outline-none ${overlayMode === mode ? 'bg-cyan-400/90 text-black shadow-md scale-105' : 'bg-white/10 text-white/80 hover:bg-cyan-300/30'}`}
                  style={{ minWidth: 56, letterSpacing: '0.5px' }}
                  onClick={() => setOverlayMode(mode as 'wind' | 'temperature' | 'none')}
                >
                  {mode === 'wind' ? 'Wind' : mode === 'temperature' ? 'Temp' : 'None'}
                </button>
              ))}
            </div>
          </div>
          {/* Temperature/Wind speed legend with ticks */}
          <div className="mb-1 mt-2 font-medium">Scale</div>
          <div className="flex flex-col items-center w-full mb-2 relative group">
            {overlayMode === 'wind' ? (
              <svg
                width="220" height="22" style={{ display: 'block', cursor: 'pointer' }}
                onMouseMove={e => {
                  const rect = (e.target as SVGElement).getBoundingClientRect();
                  const x = e.clientX - rect.left;
                  const value = Math.round((x / 220) * 100);
                  setLegendHover(value);
                }}
                onMouseLeave={() => setLegendHover(null)}
              >
                <defs>
                  <linearGradient id="windbar" x1="0%" y1="0%" x2="100%" y2="0%">
                    {Array.from({ length: 100 }, (_, i) => {
                      const [r, g, b] = windSpeedColorScale(i, 1);
                      return (
                        <stop
                          key={i}
                          offset={`${i}%`}
                          stopColor={`rgb(${r},${g},${b})`}
                        />
                      );
                    })}
                  </linearGradient>
                </defs>
                <rect x="0" y="4" width="220" height="14" fill="url(#windbar)" rx="7" />
                {/* Tick marks */}
                {Array.from({ length: 6 }, (_, i) => (
                  <g key={i}>
                    <rect x={i * 44 - 0.5} y="2" width="1" height="18" fill="#fff" fillOpacity="0.5" />
                    <text x={i * 44} y="20" textAnchor="middle" fontSize="10" fill="#e0e0e0">{i * 10}</text>
                  </g>
                ))}
                {/* Last tick for 50+ */}
                <g>
                  <rect x={220 - 0.5} y="2" width="1" height="18" fill="#fff" fillOpacity="0.5" />
                  <text x={220} y="20" textAnchor="end" fontSize="10" fill="#e0e0e0">50+</text>
                </g>
                {legendHover !== null && (
                  <g>
                    <rect x={legendHover * 2.2 - 1} y="4" width="2" height="14" fill="#fff" fillOpacity="0.7" />
                  </g>
                )}
              </svg>
            ) : overlayMode === 'temperature' ? (
              <svg
                width="220" height="22" style={{ display: 'block', cursor: 'pointer' }}
                onMouseMove={e => {
                  const rect = (e.target as SVGElement).getBoundingClientRect();
                  const x = e.clientX - rect.left;
                  const value = Math.round(-80 + (x / 220) * 130); // -80°C to 50°C
                  setLegendHover(value);
                }}
                onMouseLeave={() => setLegendHover(null)}
              >
                <defs>
                  <linearGradient id="tempbar" x1="0%" y1="0%" x2="100%" y2="0%">
                    {Array.from({ length: 100 }, (_, i) => {
                      const tempC = -80 + (i / 99) * 130; // -80°C to 50°C
                      const [r, g, b] = tempColorScale(tempC, 1);
                      return (
                        <stop
                          key={i}
                          offset={`${i}%`}
                          stopColor={`rgb(${r},${g},${b})`}
                        />
                      );
                    })}
                  </linearGradient>
                </defs>
                <rect x="0" y="4" width="220" height="14" fill="url(#tempbar)" rx="7" />
                {/* Tick marks for temperature */}
                {Array.from({ length: 7 }, (_, i) => {
                  const tempValue = -60 + i * 20; // -60, -40, -20, 0, 20, 40, 60
                  const x = ((tempValue + 80) / 130) * 220;
                  return (
                    <g key={i}>
                      <rect x={x - 0.5} y="2" width="1" height="18" fill="#fff" fillOpacity="0.5" />
                      <text x={x} y="20" textAnchor="middle" fontSize="10" fill="#e0e0e0">{tempValue}°</text>
                    </g>
                  );
                })}
                {legendHover !== null && (
                  <g>
                    <rect x={((legendHover + 80) / 130) * 220 - 1} y="4" width="2" height="14" fill="#fff" fillOpacity="0.7" />
                  </g>
                )}
              </svg>
            ) : (
              <div className="text-gray-400 text-center py-2">No overlay selected</div>
            )}
            {legendHover !== null && overlayMode === 'wind' && (
              <div
                className="absolute left-0 top-[-32px] text-xs bg-black/90 px-2 py-1 rounded pointer-events-none border border-gray-700 shadow"
                style={{ left: `${legendHover * 2.2 - 18}px`, minWidth: '48px', textAlign: 'center', zIndex: 10 }}
              >
                <div className="mb-[-4px]">{legendHover} m/s</div>
                <svg width="16" height="8" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: '100%' }}>
                  <polygon points="8,0 16,8 0,8" fill="#222" fillOpacity="0.9" />
                </svg>
              </div>
            )}
            {legendHover !== null && overlayMode === 'temperature' && (
              <div
                className="absolute left-0 top-[-32px] text-xs bg-black/90 px-2 py-1 rounded pointer-events-none border border-gray-700 shadow"
                style={{ left: `${((legendHover + 80) / 130) * 220 - 18}px`, minWidth: '48px', textAlign: 'center', zIndex: 10 }}
              >
                <div className="mb-[-4px]">{legendHover}°C</div>
                <svg width="16" height="8" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: '100%' }}>
                  <polygon points="8,0 16,8 0,8" fill="#222" fillOpacity="0.9" />
                </svg>
              </div>
            )}
          </div>
          {/* Altitude selector: smooth slider with visual indicators */}
          <div className="mb-1 mt-3 flex flex-col items-center w-full">
            <div className="flex items-center gap-3 mb-3 w-full">
              <span className="font-medium text-base">Altitude</span>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-cyan-400/20 rounded-lg border border-cyan-400/30">
                <div className="w-2 h-2 bg-cyan-400 rounded-full"></div>
                <span className="text-cyan-100 font-mono text-sm">{levels[lvlIdx]?.label || '10 m'}</span>
              </div>
            </div>
            
            <div className="relative w-full max-w-[320px] mx-auto">
              {/* Custom slider track */}
              <div className="relative h-8 mb-2">
                <div className="absolute top-3 left-0 right-0 h-2 bg-white/10 rounded-full"></div>
                
                {/* Level indicators */}
                {levels.map((level, i) => {
                  const position = (i / (levels.length - 1)) * 100;
                  const isActive = i === lvlIdx;
                  const t = i / Math.max(1, levels.length - 1);
                  const hue = 220 - 140 * t;
                  const indicatorColor = isActive ? '#22d3ee' : `hsl(${hue}, 60%, 70%)`;
                  
                  return (
                    <div
                      key={i}
                      className="absolute top-1 w-6 h-6 rounded-full border-2 border-white/20 cursor-pointer transition-all duration-200 hover:scale-110"
                      style={{ 
                        left: `calc(${position}% - 12px)`,
                        backgroundColor: indicatorColor,
                        boxShadow: isActive ? '0 0 12px rgba(34, 211, 238, 0.6)' : 'none',
                        transform: isActive ? 'scale(1.15)' : 'scale(1)'
                      }}
                      onClick={() => setLvlIdx(i)}
                      onMouseEnter={() => setAltitudeHover(i)}
                      onMouseLeave={() => setAltitudeHover(null)}
                    >
                      {isActive && (
                        <div className="absolute inset-0 rounded-full bg-white/30 animate-pulse"></div>
                      )}
                    </div>
                  );
                })}
                
                {/* Slider input (invisible but functional) */}
                <input
                  type="range"
                  min="0"
                  max={levels.length - 1}
                  value={lvlIdx}
                  onChange={(e) => setLvlIdx(Number(e.target.value))}
                  className="absolute top-0 left-0 w-full h-8 opacity-0 cursor-pointer"
                  style={{ zIndex: 10 }}
                />
              </div>
              
              {/* Level labels below slider */}
              <div className="flex justify-between text-xs text-white/60 mt-2 px-3">
                <span>Surface</span>
                <span>High Alt</span>
              </div>
              
              {/* Hover tooltip */}
              {altitudeHover !== null && altitudeHover !== lvlIdx && (
                <div
                  className="absolute top-[-40px] text-xs bg-black/90 px-2 py-1 rounded pointer-events-none border border-gray-600 shadow-lg z-20"
                  style={{ 
                    left: `calc(${(altitudeHover / (levels.length - 1)) * 100}% - 30px)`,
                    minWidth: '60px', 
                    textAlign: 'center',
                    transform: 'translateX(0)'
                  }}
                >
                  <div className="text-white">{levels[altitudeHover]?.label}</div>
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2">
                    <div className="w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-600"></div>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="text-xs text-gray-300 mt-2">
            Press <b>Arrow Keys</b> to change altitude • <b>Ctrl+K</b> or <b>×</b> to close
          </div>
        </div>
      )}

      <div ref={wrap} className="fixed inset-0 bg-black" />
      <style jsx global>{`
        .animate-fadein { animation: fadein 0.3s cubic-bezier(.4,0,.2,1); }
        @keyframes fadein { from { opacity: 0; transform: translateY(30px) scale(0.98); } to { opacity: 1; transform: none; } }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        
        /* Custom slider styling */
        input[type="range"]::-webkit-slider-thumb {
          appearance: none;
          width: 0;
          height: 0;
          background: transparent;
        }
        
        input[type="range"]::-moz-range-thumb {
          width: 0;
          height: 0;
          background: transparent;
          border: none;
        }
        
        input[type="range"]:focus {
          outline: none;
        }
      `}</style>
    </>
  );
}
