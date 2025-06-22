"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry, GeoJsonProperties } from "geojson";

const DATA_DIR = "/data/winddata";
const MANIFEST_URL = `${DATA_DIR}/wind_uv_manifest_20250622_00z.json`;
const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json";

// ------------ CONFIGURABLE CONSTANTS ------------ //
const GLOBE_RADIUS = 200;
const PARTICLE_COUNT = 20000;
const PARTICLE_LIFE = 601;
const SPEED_FACTOR = 0.008;
const MAX_WIND_KMH = 150;
const TRAIL_FADE = 0.92;
const SIGNIFICANT_CAM_MOVE2 = 4;

// Try 0.4–0.7 for different effects!
const GAMMA = 0.5;

/**
 * Nullschool-style wind colour ramp.
 */
const WIND_COLOR_SCALE: [number, number, number][] = [
  [36, 104, 180], [60, 157, 194], [128, 205, 193], [151, 218, 168], [198, 231, 181],
  [238, 247, 217], [255, 238, 159], [252, 217, 125], [255, 182, 100], [252, 150, 75],
  [250, 112, 52], [245, 84, 32], [237, 45, 28], [220, 24, 32], [180, 0, 35],
];

/** Gamma-corrected color scale for perceptual smoothness. */
const colorForSpeed = (speedKmh: number): [number, number, number] => {
  const norm = Math.pow(Math.min(1, speedKmh / MAX_WIND_KMH), GAMMA);
  const idx = Math.floor(norm * (WIND_COLOR_SCALE.length - 1));
  return WIND_COLOR_SCALE[idx];
};

const lonLatToVec3 = (lon: number, lat: number, r = GLOBE_RADIUS) => {
  const φ = THREE.MathUtils.degToRad(lat);
  const λ = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    r * Math.cos(φ) * Math.cos(λ),
    r * Math.sin(φ),
    -r * Math.cos(φ) * Math.sin(λ)
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
  const [lvlIdx, setLvlIdx] = useState(0);
  const gridMeta = useRef<GridMeta | null>(null);
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
  }, []);

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
    controls.dampingFactor = 0.1;
    controls.minDistance = 250;
    controls.maxDistance = 800;

    // --------------- WIND TRAILS CANVAS --------------- //
    const windCanvas = document.createElement("canvas");
    windCanvas.style.cssText = "position:absolute;inset:0;pointer-events:none";
    wrap.current.appendChild(windCanvas);

    const ctx = windCanvas.getContext("2d")!;
    ctx.lineWidth = 1.2;
    ctx.shadowBlur = 6;
    ctx.shadowColor = "rgba(255,255,255,0.6)";

    // --------------- RESIZE HANDLER --------------- //
    const resize = () => {
      const { offsetWidth: w, offsetHeight: h } = wrap.current!;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      windCanvas.width = w;
      windCanvas.height = h;
      ctx.clearRect(0, 0, w, h);
    };
    resize();
    window.addEventListener("resize", resize);

    // --------------- GLOBE GEOMETRY --------------- //
    scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS, 64, 64),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    ));

    // --------------- COUNTRY OUTLINES --------------- //
    (async () => {
      const topo = await (await fetch(WORLD_URL)).json();
      const geos = (feature(
        topo,
        topo.objects.countries
      ) as unknown as FeatureCollection<Geometry, GeoJsonProperties>).features;

      const pos: number[] = [];

      const pushSeg = (a: number[], b: number[]) => {
        if (Math.abs(a[0] - b[0]) > 180) return;
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
        new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.8 })
      ));
    })();

    // --------------- WIND MAGNITUDE TEXTURE (colour overlay) --------------- //
    const texData = new Uint8Array(nx * ny * 4);
    for (let i = 0; i < S.length; i++) {
      const speedKmh = S[i] * 3.6; // m/s -> km/h
      const [r, g, b] = colorForSpeed(speedKmh);
      texData[4 * i] = r;
      texData[4 * i + 1] = g;
      texData[4 * i + 2] = b;
      texData[4 * i + 3] = 155; // Alpha! Not too opaque, not too faint.
    }

    const tex = new THREE.DataTexture(texData, nx, ny, THREE.RGBAFormat);
    tex.minFilter = tex.magFilter = THREE.LinearFilter; // << smooth!
    tex.needsUpdate = true;

    scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS + 0.6, 64, 64),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0.62, // 0.5–0.7 looks nice!
        depthTest: true
      })
    ));

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

    const windAt = (lon: number, lat: number) => {
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
      const [r, g, b] = colorForSpeed(Math.hypot(u, v) * 3.6);
      return `rgb(${r},${g},${b})`;
    };

    const worldToScreen = (v: THREE.Vector3): [number, number] | null => {
      const vec = v.clone().project(camera);
      if (vec.z > 1) return null;
      const s = renderer.getSize(new THREE.Vector2());
      return [(vec.x * 0.5 + 0.5) * s.x, (-vec.y * 0.5 + 0.5) * s.y];
    };

    const lastCamPos = camera.position.clone();
    const cameraMoved = () => camera.position.distanceToSquared(lastCamPos) > SIGNIFICANT_CAM_MOVE2;
    const handleCamMove = () => {
      ctx.clearRect(0, 0, windCanvas.width, windCanvas.height);
      prevXY.fill(NaN);
      lastCamPos.copy(camera.position);
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

        p.lon = ((p.lon + (u * SPEED_FACTOR) / Math.cos(THREE.MathUtils.degToRad(p.lat)) + 540) % 360) - 180;
        p.lat += v * SPEED_FACTOR;

        if (p.lat > 90 || p.lat < -90) {
          p.lat = THREE.MathUtils.clamp(p.lat, -89.999, 89.999);
          p.lon = ((p.lon + 180) % 360) - 180;
          clearPrev(i);
        }

        if (++p.age > PARTICLE_LIFE) return recycle(i);

        const worldPos = lonLatToVec3(p.lon, p.lat, GLOBE_RADIUS + 0.5);
        if (worldPos.clone().normalize().dot(camDir) < 0) {
          clearPrev(i);
          return;
        }

        const scr = worldToScreen(worldPos);
        if (!scr) return clearPrev(i);

        const [sx1, sy1] = scr;
        prevXY[2 * i] = sx1;
        prevXY[2 * i + 1] = sy1;

        if (!isNaN(sx0) && Math.hypot(sx1 - sx0, sy1 - sy0) <= sMin) {
          ctx.strokeStyle = trailColor(u, v); // Colored trails!
          ctx.beginPath();
          ctx.moveTo(sx0, sy0);
          ctx.lineTo(sx1, sy1);
          ctx.stroke();
        }
      });
    };

    // --------------- ANIMATION LOOP --------------- //
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      if (cameraMoved()) handleCamMove();
      updateParticles();
      renderer.render(scene, camera);
    };
    loop();

    // --------------- CLEAN-UP --------------- //
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      controls.dispose();
      renderer.dispose();
      wrap.current?.removeChild(renderer.domElement);
      wrap.current?.removeChild(windCanvas);
    };
  }, [levels, lvlIdx]);

  // ---- UI: level selector ---- //
  const onLevelChange = (e: React.ChangeEvent<HTMLSelectElement>) => setLvlIdx(Number(e.target.value));

  return (
    <>
      {levels.length > 1 && (
        <select
          value={lvlIdx}
          onChange={onLevelChange}
          className="absolute top-4 left-4 z-10 bg-neutral-900 text-white rounded p-2"
        >
          {levels.map((l: { label: string; U: Float32Array; V: Float32Array; S: Float32Array }, i: number) => (
            <option key={i} value={i}>{l.label}</option>
          ))}
        </select>
      )}
      <div ref={wrap} className="fixed inset-0 bg-black" />
    </>
  );
}
