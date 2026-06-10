import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyRetroMaterial } from './retro.js';
import * as tex from './textures.js';
import mapData from './data/map.json';

// The map JSON is authored in a 1000x600 top-down grid; the world uses
// half-scale meters with the grid centered at the origin (map y -> world z).
const S = 0.5;

// Zone bands from the map, converted once to world-space ranges.
const bands = {};
for (const zone of mapData.zones) {
  bands[zone.id] = {
    z: [zone.boundaries.y[0], zone.boundaries.y[1]].map((y) => (y - 300) * S),
    x: [zone.boundaries.x[0], zone.boundaries.x[1]].map((x) => (x - 500) * S),
  };
}

const WATER_Y = -0.9;
const STONE_TOP_Y = 0.35;

// --- The descent: an underground area far east of the playable map (x>400
// is its address space), reached by teleport from the tower doorway. One
// sweeping ramp hugs the wall of a wide shaft for most of a single turn —
// under a full revolution, so every (x, z) maps to exactly one height and
// the heightfield physics still work. The open center drops to the chamber
// floor, which the ramp also reaches, so falling in never strands you.
const DESC = {
  cx: 500,
  cz: 0,
  R0: 14, // ramp centerline radius
  ledge: 1.0, // flat entry arc (radians) before the ramp starts down
  maxTheta: 5.88, // just under a full turn; the gap is solid wall
  rampHalf: 1.7,
  chamberY: -16,
};
DESC.drop = -DESC.chamberY / (DESC.maxTheta - DESC.ledge); // meters per radian
const rampY = (t) =>
  Math.max(-DESC.drop * Math.max(0, t - DESC.ledge), DESC.chamberY);

export function lambert(opts) {
  // PBR HD materials without flat shading!
  const newOpts = { ...opts, flatShading: false };
  if (opts.map) {
    newOpts.bumpMap = opts.map;
    newOpts.bumpScale = 0.2;
  }
  return applyRetroMaterial(new THREE.MeshStandardMaterial(newOpts));
}

// --- Seeded value noise, shared by the terrain mesh and collision so the
// player walks on exactly the surface that is rendered. ---
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class ValueNoise {
  constructor(seed) {
    const rand = mulberry32(seed);
    const p = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  lattice(ix, iz) {
    return this.perm[(this.perm[ix & 255] + iz) & 255] / 255;
  }

  noise2(x, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const a = this.lattice(ix, iz);
    const b = this.lattice(ix + 1, iz);
    const c = this.lattice(ix, iz + 1);
    const d = this.lattice(ix + 1, iz + 1);
    return (a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz) * 2 - 1;
  }
}

const smoothstep = (e0, e1, x) => {
  const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// Organic displacement: hash-based so shared vertices move identically and
// seams never crack. Half strength + smooth normals = natural irregularity
// without the old low-poly facet look.
export function jitterGeometry(geo, amount) {
  const pos = geo.attributes.position;
  const h = (x, y, z, s) => {
    const v = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + s * 53.3) * 43758.5453;
    return v - Math.floor(v) - 0.5;
  };
  const amt = amount * 0.55;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    pos.setXYZ(i, x + h(x, y, z, 1) * amt, y + h(x, y, z, 2) * amt, z + h(x, y, z, 3) * amt);
  }
  geo.computeVertexNormals();
  return geo;
}

export class World {
  constructor() {
    this.stones = []; // walkable crossing stones: {x, z, r}
    this.boulders = []; // solid rocks: {x, z, r, top}
    this.pathPoints = []; // sampled island footpath
    this.parkPathPoints = []; // sampled north-bank path
    this.protectPoints = []; // all path samples; terrain stays land near these
    this.waterMaterials = [];
    this.spawn = new THREE.Vector3(14, 0, -101);
    this.towerPosition = new THREE.Vector3(152, 0, 58);
    // Wagener Sledding Hill — north of W River Road, like the real park.
    this.hillCenter = new THREE.Vector2(-185, -138);

    this.rolling = new ValueNoise(1137);
    this.detail = new ValueNoise(4422);
    this.shore = new ValueNoise(9810);
    this.torches = [];
  }

  // ---------------------------------------------------------------------
  // Height field — single source of truth for terrain, props, and physics.
  // ---------------------------------------------------------------------
  heightAt(x, z) {
    if (x > 400) return this.descentHeight(x, z);

    // Rolling parkland base.
    const detailNoise = this.detail.noise2(x * 0.085, z * 0.085) * 0.3;
    let h = this.rolling.noise2(x * 0.022, z * 0.022) * 1.1 + detailNoise;
    h = Math.max(h, -0.45);

    // Wagener Sledding Hill rises out of the north bank.
    const hdx = x - this.hillCenter.x;
    const hdz = z - this.hillCenter.y;
    h += 6.5 * Math.exp(-(hdx * hdx + hdz * hdz) / (2 * 19 * 19));

    // Carve the two river channels with noisy, wavering shorelines.
    const wobbleA = this.shore.noise2(x * 0.02, 11.3) * 5;
    const wobbleB = this.shore.noise2(x * 0.02, 47.7) * 5;
    const carve = (z0, z1) => {
      const pen = Math.min(z - (z0 + wobbleA), z1 + wobbleB - z);
      const s = smoothstep(0, 6, pen);
      if (s > 0) h = THREE.MathUtils.lerp(h, -1.75 + this.detail.noise2(x * 0.1, z * 0.1) * 0.25, s);
    };
    carve(bands.river_north_channel.z[0], bands.river_north_channel.z[1]);
    carve(bands.river_south_channel.z[0], bands.river_south_channel.z[1]);

    // The island mounds up gently between the channels.
    const island = bands.blue_grass_island;
    const ipen = Math.min(
      z - (bands.river_north_channel.z[1] + wobbleB),
      bands.river_south_channel.z[0] + wobbleA - z,
      x - island.x[0],
      island.x[1] - x
    );
    h += smoothstep(0, 20, ipen) * 0.7;

    // Shallows where the crossing stones sit — wadeable, not drownable.
    if (x > -114 && x < -86 && z > -56 && z < -4) h = Math.max(h, -1.2);

    // Keep a walkable land corridor under the footpaths, and flatten the surface geometry.
    if (this.protectPoints.length) {
      const d = World.distanceToPoints(this.protectPoints, x, z);
      const f = 1 - smoothstep(2.5, 8, d);
      if (f > 0) {
        // Flatten the micro-bumps (detail noise) on the path
        h -= detailNoise * f;
        h = THREE.MathUtils.lerp(h, Math.max(h, 0.2), f);
      }
    }

    // Flatten the built-up Riverview Area so the structures sit naturally.
    const pdx = Math.max(0, Math.max(-34 - x, x - 38));
    const pdz = Math.max(0, Math.max(-120 - z, z - -78));
    const parkF = 1 - smoothstep(0, 10, Math.hypot(pdx, pdz));
    h = THREE.MathUtils.lerp(h, 0, parkF);

    // Flatten the beach clearing around the tower.
    const td = Math.hypot(x - this.towerPosition.x, z - this.towerPosition.z);
    h = THREE.MathUtils.lerp(h, 0.15, 1 - smoothstep(16, 30, td));

    return h;
  }

  descentHeight(x, z) {
    const dx = x - DESC.cx;
    const dz = z - DESC.cz;
    const r = Math.hypot(dx, dz);
    let th = Math.atan2(dz, dx);
    if (th < 0) th += Math.PI * 2;

    if (Math.abs(r - DESC.R0) <= DESC.rampHalf) {
      // In the ramp's radial band: ramp if the turn reaches this angle,
      // otherwise the solid wall segment between ramp end and ledge.
      return th <= DESC.maxTheta ? rampY(th) : 4;
    }
    if (r < DESC.R0 - DESC.rampHalf) return DESC.chamberY; // the open center
    return 4; // solid rock beyond the shaft wall
  }

  build(scene) {
    this.computePathLines();
    this.buildAtmosphere(scene);
    this.buildTerrain(scene);
    this.buildParkArea(scene);
    this.buildCrossing(scene);
    this.buildPaths(scene);
    this.buildBoulders(scene);
    this.buildForest(scene);
    this.buildUndergrowth(scene);
    this.buildBeachAndTower(scene);
    this.buildDescent(scene);
    this.buildMist(scene);
    this.buildFireflies(scene);
    this.buildNightSky(scene);
  }

  // Drifting fog cards: soft billboards that slide slowly over the river
  // and the island floor.
  buildMist(scene) {
    this.mist = [];
    const mat = new THREE.MeshBasicMaterial({
      map: tex.mistTexture(),
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    });
    const spots = [];
    for (let i = 0; i < 26; i++) {
      // Half over the channels, half through the island woods.
      const overRiver = i % 2 === 0;
      const x = THREE.MathUtils.lerp(-220, 220, Math.random());
      const z = overRiver
        ? (Math.random() < 0.5 ? -30 : 120) + (Math.random() - 0.5) * 24
        : THREE.MathUtils.lerp(-5, 95, Math.random());
      spots.push([x, z]);
    }
    for (const [x, z] of spots) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(16 + Math.random() * 10, 4.5), mat);
      const y = Math.max(this.heightAt(x, z), WATER_Y) + 1.1;
      m.position.set(x, y, z);
      scene.add(m);
      this.mist.push({ m, speed: 0.25 + Math.random() * 0.4, phase: Math.random() * 10 });
    }
  }

  // Fireflies drifting between the trees at dusk.
  buildFireflies(scene) {
    const N = 130;
    const pos = new Float32Array(N * 3);
    this.fireflyBase = new Float32Array(N * 3);
    this.fireflyPhase = new Float32Array(N);
    const island = bands.blue_grass_island;
    for (let i = 0; i < N; i++) {
      const x = THREE.MathUtils.lerp(island.x[0], island.x[1], Math.random());
      const z = THREE.MathUtils.lerp(island.z[0] - 30, island.z[1], Math.random());
      const y = Math.max(this.heightAt(x, z), -0.4) + 0.7 + Math.random() * 1.8;
      pos.set([x, y, z], i * 3);
      this.fireflyBase.set([x, y, z], i * 3);
      this.fireflyPhase[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.fireflyMat = new THREE.PointsMaterial({
      color: 0xd8efa0,
      size: 0.14,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.fireflies = new THREE.Points(geo, this.fireflyMat);
    scene.add(this.fireflies);
  }

  // Stars and a moon, revealed as the night factor rises.
  buildNightSky(scene) {
    const N = 420;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      const elev = Math.random() * Math.PI * 0.46 + 0.06;
      const r = 720;
      pos.set(
        [r * Math.cos(elev) * Math.cos(a), r * Math.sin(elev), r * Math.cos(elev) * Math.sin(a)],
        i * 3
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xcdd8ee,
      size: 2.0,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      fog: false,
      depthWrite: false,
    });
    scene.add(new THREE.Points(geo, this.starMat));

    this.moonMat = new THREE.MeshBasicMaterial({ color: 0xdde6f2, transparent: true, opacity: 0, fog: false });
    const moon = new THREE.Mesh(new THREE.CircleGeometry(26, 24), this.moonMat);
    moon.position.set(320, 330, 260);
    moon.lookAt(0, 0, 0);
    scene.add(moon);
  }

  // Path centerlines are needed before the terrain builds (land protection),
  // so they are sampled first and the visible ribbons are draped later.
  computePathLines() {
    const sample = (points2d) => {
      const curve = new THREE.CatmullRomCurve3(
        points2d.map(([x, z]) => new THREE.Vector3(x, 0, z))
      );
      const n = Math.max(60, Math.round(curve.getLength() * 0.8));
      const out = [];
      for (let i = 0; i <= n; i++) out.push(curve.getPoint(i / n));
      return out;
    };

    this.parkPathLine = [[2, -101], [-20, -92], [-48, -78], [-75, -62], [-92, -52], [-99, -47]];
    this.islandPathLine = [
      [-100, -8], [-78, 8], [-42, 26], [-5, 16], [35, 42],
      [78, 24], [112, 48], [140, 56], [152, 58],
    ];
    this.parkPathPoints = sample(this.parkPathLine);
    this.pathPoints = sample(this.islandPathLine);
    this.protectPoints = [...this.parkPathPoints, ...this.pathPoints];
  }

  buildAtmosphere(scene) {
    this.scene = scene;
    const horizon = new THREE.Color(0xc46a47);
    const zenith = new THREE.Color(0x3a4b6c);
    scene.background = horizon;
    scene.fog = new THREE.FogExp2(horizon, 0.0105);

    // Create a sky dome with vertex colors to simulate a gradient sunset sky
    const skyGeo = new THREE.SphereGeometry(800, 32, 16);
    const pos = skyGeo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const ratio = Math.max(0, Math.min(1, y / 200));
      const c = horizon.clone().lerp(zenith, ratio);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    skyGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, transparent: true });
    this.skyMesh = new THREE.Mesh(skyGeo, skyMat);
    scene.add(this.skyMesh);

    // The sun itself: a hot additive glow low in the west.
    this.glowMat = new THREE.MeshBasicMaterial({
      map: tex.mistTexture(),
      color: 0xff9038,
      transparent: true,
      opacity: 0.9,
      fog: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sunGlow = new THREE.Mesh(new THREE.PlaneGeometry(340, 340), this.glowMat);
    sunGlow.position.set(-560, 160, -210);
    sunGlow.lookAt(0, 30, 0);
    scene.add(sunGlow);

    // A few long sunset clouds, lit from below.
    this.cloudMat = new THREE.MeshBasicMaterial({
      map: tex.mistTexture(),
      color: 0xe09a78,
      transparent: true,
      opacity: 0.32,
      fog: false,
      depthWrite: false,
    });
    for (let i = 0; i < 10; i++) {
      const w = 140 + Math.random() * 200;
      const cloud = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.32), this.cloudMat);
      const a = Math.random() * Math.PI * 2;
      const r = 260 + Math.random() * 320;
      cloud.position.set(Math.cos(a) * r, 140 + Math.random() * 110, Math.sin(a) * r);
      cloud.rotation.x = -Math.PI / 2;
      cloud.rotation.z = Math.random() * Math.PI;
      scene.add(cloud);
    }

    this.hemi = new THREE.HemisphereLight(0xffb070, 0x4a3b5c, 1.5);
    scene.add(this.hemi);

    // Cool rim light from the east — separates silhouettes from the dusk
    // the way console games faked bounce light.
    this.rim = new THREE.DirectionalLight(0x6a7eb8, 0.5);
    this.rim.position.set(70, 22, 40);
    scene.add(this.rim);

    this.sun = new THREE.DirectionalLight(0xffa050, 2.0);
    this.sun.position.set(-80, 30, -30); // low in the west
    
    // Enable HD shadows for the sun over the entire map
    // Tight frustum + big map = crisp console-era shadows over the
    // playable area instead of a blurry smear over a half-kilometer.
    this.sun.castShadow = true;
    this.sun.shadow.camera.left = -300;
    this.sun.shadow.camera.right = 300;
    this.sun.shadow.camera.top = 220;
    this.sun.shadow.camera.bottom = -220;
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 700;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.mapSize.width = 4096;
    this.sun.shadow.mapSize.height = 4096;

    scene.add(this.sun);
  }

  /** Swap between the sunset overworld and the lightless underground, blending in the night fog if active. */
  setNightness(nightFactor, under) {
    // Underground overrides nightFactor to fully black
    const factor = under ? 1.0 : nightFactor;
    
    // Light intensity
    this.hemi.intensity = THREE.MathUtils.lerp(1.5, 0.26, factor);
    this.sun.intensity = THREE.MathUtils.lerp(2.0, 0, factor);
    if (this.rim) this.rim.intensity = THREE.MathUtils.lerp(0.5, 0.12, factor);

    // Color transition
    const sunset = new THREE.Color(0xc46a47);
    const black = new THREE.Color(0x030303);
    const color = sunset.lerp(black, factor);

    this.scene.fog.color.copy(color);
    this.scene.background.copy(color);

    // FogExp2 has no near/far — the fog thickens via density in the dark.
    this.scene.fog.density = THREE.MathUtils.lerp(0.0105, 0.055, factor);
    // The sunset sky dome fades out as night (or the underground) takes over.
    if (this.skyMesh) this.skyMesh.material.opacity = 1 - factor;
    // Stars, moon, and fireflies belong to the surface night.
    if (this.starMat) this.starMat.opacity = under ? 0 : factor * 0.9;
    if (this.moonMat) this.moonMat.opacity = under ? 0 : factor * 0.95;
    if (this.fireflyMat) this.fireflyMat.opacity = under ? 0 : 0.45 + factor * 0.45;
    if (this.glowMat) this.glowMat.opacity = 0.9 * (1 - factor);
    if (this.cloudMat) this.cloudMat.opacity = 0.32 * (1 - factor * 0.85);
  }

  buildTerrain(scene) {
    // One displaced, flat-shaded heightfield instead of flat planes.
    // Expanded to 800x400 and translated to cover the tower at X=340
    const geo = new THREE.PlaneGeometry(800, 400, 300, 150);
    geo.rotateX(-Math.PI / 2);
    geo.translate(150, 0, -30);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const island = bands.blue_grass_island;
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.heightAt(x, z);
      pos.setY(i, h);

      // Zone tinting: mud below the waterline, darker forest floor on the
      // island, warm sand around the tower beach.
      c.setRGB(1, 1, 1);
      if (h < -0.7) {
        c.lerp(new THREE.Color(0.6, 0.55, 0.45), Math.min(1, (-0.7 - h) / 0.9));
      } else if (z > island.z[0] - 6 && z < island.z[1] + 6 && x > island.x[0] && x < island.x[1]) {
        c.lerp(new THREE.Color(0.74, 0.78, 0.62), 0.6);
      }
      const td = Math.hypot(x - this.towerPosition.x, z - this.towerPosition.z);
      if (td < 26) c.lerp(new THREE.Color(1.0, 0.93, 0.78), 1 - td / 26);

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Compute smooth vertex normals for high fidelity PBR shading
    geo.computeVertexNormals();

    const terrainMesh = new THREE.Mesh(
      geo,
      lambert({ map: tex.grassTexture(70), vertexColors: true })
    );
    terrainMesh.receiveShadow = true;
    terrainMesh.castShadow = true;
    scene.add(terrainMesh);

    // Water: two scrolling layers (deep body + bright surface ripple) plus
    // gentle vertex waves, flowing east like the real Maumee.
    const waterMat = lambert({
      map: tex.waterTexture(60),
      color: 0x96b4c2,
      transparent: true,
      opacity: 0.88,
      roughness: 0.25,
      metalness: 0.08,
    });
    this.waterMaterials.push({ mat: waterMat, sx: 0.05, sy: 0.004 });
    const waterGeo = new THREE.PlaneGeometry(800, 220, 100, 24);
    waterGeo.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.position.set(150, WATER_Y, 45);
    scene.add(water);
    this.waterMesh = water;
    this.waterBase = waterGeo.attributes.position.array.slice();
    this.waveTime = 0;

    const rippleMat = lambert({
      map: tex.waterTexture(110),
      color: 0xdfe9ee,
      transparent: true,
      opacity: 0.3,
      roughness: 0.15,
      metalness: 0.1,
    });
    this.waterMaterials.push({ mat: rippleMat, sx: 0.095, sy: -0.008 });
    const ripple = new THREE.Mesh(new THREE.PlaneGeometry(800, 220, 4, 2), rippleMat);
    ripple.rotation.x = -Math.PI / 2;
    ripple.position.set(150, WATER_Y + 0.08, 45);
    scene.add(ripple);
  }

  // The Riverview Area from the map: parking lot, one lone car, the picnic
  // shelter, and the playground. This is where the player starts.
  buildParkArea(scene) {
    const lot = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 12, 10, 4),
      lambert({ map: tex.parkingLotTexture() })
    );
    lot.rotation.x = -Math.PI / 2;
    lot.position.set(15, 0.1, -106);
    scene.add(lot);

    // Driveway running north into the fog, draped over the terrain.
    this.buildRibbon(
      scene,
      [[15, -112], [15, -132], [14, -152]],
      3,
      lambert({ map: tex.asphaltTexture(8) })
    );

    this.buildCar(scene, 8, -109.3, 0.06);
    this.buildShelter(scene, 6, -88);
    this.buildPlayground(scene, -16, -94);
    this.buildParkProps(scene);
    this.buildRoad(scene);
    this.buildCanalLocks(scene);
  }

  // W River Road: runs along the north side of the park, dividing the
  // Riverview Area from the sledding hill — straight from the map data.
  buildRoad(scene) {
    this.buildRibbon(
      scene,
      [[-250, -75], [-185, -98], [-125, -125], [40, -138], [250, -150]],
      3.5,
      lambert({ map: tex.roadTexture() })
    );
  }

  // The limestone canal locks Side Cut is named for — ruined parallel
  // walls of the old Miami & Erie side cut, with a historical marker.
  buildCanalLocks(scene) {
    const stone = lambert({ map: tex.stoneTexture(4), side: THREE.DoubleSide });
    const cx = 62;
    const cz = -122;
    const angle = -0.08; // roughly parallel to the road
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const len = 5 + Math.random() * 3;
        const h = 1.6 + Math.random() * 0.9;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(len, h, 1.1), stone);
        const along = -9 + i * 6 + Math.random();
        const x = cx + Math.cos(angle) * along - Math.sin(angle) * side * 2.6;
        const z = cz + Math.sin(angle) * along + Math.cos(angle) * side * 2.6;
        wall.position.set(x, this.heightAt(x, z) + h * 0.32, z);
        wall.rotation.y = -angle + (Math.random() - 0.5) * 0.06;
        scene.add(wall);
      }
    }
    this.buildSign(scene, cx - 6, cz + 5);
  }

  // Park furnishings: the small human things that make the place feel
  // recently abandoned rather than never inhabited.
  buildParkProps(scene) {
    this.buildPicnicTable(scene, 6, -88.5, 0.2);
    this.buildPicnicTable(scene, 13.5, -83.5, 1.2);
    this.buildBench(scene, -28, -89, 0.6);
    this.buildBench(scene, -70, -64.5, 2.3);
    this.buildTrashCan(scene, 1.8, -99.2);
    this.buildTrashCan(scene, 10.8, -91.8);
    this.buildLamppost(scene, 0.5, -103);
    this.buildLamppost(scene, -13, -89.5);
    this.buildLamppost(scene, 18.5, -99.5);
    this.buildSign(scene, 0.2, -99.6);
  }

  buildPicnicTable(scene, x, z, rotY) {
    const wood = lambert({ map: tex.barkTexture(1), color: 0x9a7e5c });
    const g = new THREE.Group();
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 0.9), wood);
    top.position.y = 0.76;
    g.add(top);
    for (const sz of [-0.62, 0.62]) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 0.28), wood);
      seat.position.set(0, 0.45, sz);
      g.add(seat);
    }
    for (const sx of [-0.85, 0.85]) {
      const legs = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.76, 1.5), wood);
      legs.position.set(sx, 0.38, 0);
      g.add(legs);
    }
    g.position.set(x, this.getGroundHeight(x, z) + 0.04, z);
    g.rotation.y = rotY;
    scene.add(g);
  }

  buildBench(scene, x, z, rotY) {
    const wood = lambert({ map: tex.barkTexture(1), color: 0x8a7050 });
    const iron = lambert({ color: 0x2c2c30 });
    const g = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 0.45), wood);
    seat.position.y = 0.45;
    g.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 0.07), wood);
    back.position.set(0, 0.78, -0.22);
    back.rotation.x = 0.12;
    g.add(back);
    for (const sx of [-0.7, 0.7]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.45, 0.4), iron);
      leg.position.set(sx, 0.22, 0);
      g.add(leg);
    }
    g.position.set(x, this.getGroundHeight(x, z) + 0.03, z);
    g.rotation.y = rotY;
    scene.add(g);
  }

  buildTrashCan(scene, x, z) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.3, 0.9, 10),
      lambert({ color: 0x32503a, roughness: 0.85 })
    );
    body.position.y = 0.45;
    g.add(body);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.08, 10), lambert({ color: 0x222426 }));
    rim.position.y = 0.92;
    g.add(rim);
    g.position.set(x, this.getGroundHeight(x, z) + 0.02, z);
    scene.add(g);
  }

  buildLamppost(scene, x, z) {
    const g = new THREE.Group();
    const iron = lambert({ color: 0x26262a, metalness: 0.6, roughness: 0.5 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 3.8, 8), iron);
    pole.position.y = 1.9;
    g.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.34), iron);
    head.position.y = 3.9;
    g.add(head);
    const pane = new THREE.Mesh(
      new THREE.BoxGeometry(0.26, 0.2, 0.26),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0 })
    );
    pane.position.y = 3.86;
    g.add(pane);
    const light = new THREE.PointLight(0xffc580, 12, 15, 1.7);
    light.position.y = 3.7;
    g.add(light);
    g.position.set(x, this.getGroundHeight(x, z), z);
    scene.add(g);
  }

  buildSign(scene, x, z) {
    const g = new THREE.Group();
    const wood = lambert({ map: tex.barkTexture(1), color: 0x7a5c3c });
    for (const sx of [-0.55, 0.55]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.6, 0.1), wood);
      post.position.set(sx, 0.8, 0);
      g.add(post);
    }
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.7, 0.06), wood);
    panel.position.y = 1.35;
    g.add(panel);
    const inset = new THREE.Mesh(
      new THREE.PlaneGeometry(1.34, 0.54),
      new THREE.MeshBasicMaterial({ color: 0xc9b48a })
    );
    inset.position.set(0, 1.35, 0.035);
    g.add(inset);
    // Faces the parking lot, marking the trailhead.
    g.rotation.y = Math.PI / 2 + 0.3;
    g.position.set(x, this.getGroundHeight(x, z), z);
    scene.add(g);
  }

  buildCar(scene, x, z, rotY) {
    const car = new THREE.Group();
    // Paint with a sheen, glass with a near-mirror finish — the env map
    // gives both real reflections.
    const bodyMat = lambert({ color: 0xb0a487, metalness: 0.55, roughness: 0.35 });
    const glassMat = lambert({ color: 0x2e3a40, metalness: 0.8, roughness: 0.12 });
    const wheelMat = lambert({ color: 0x1d1d1f, roughness: 0.9 });

    const body = new THREE.Mesh(jitterGeometry(new THREE.BoxGeometry(1.9, 1.0, 4.4, 2, 1, 3), 0.08), bodyMat);
    body.position.y = 0.8;
    car.add(body);

    const cabin = new THREE.Mesh(jitterGeometry(new THREE.BoxGeometry(1.7, 0.75, 2.2, 2, 1, 2), 0.06), glassMat);
    cabin.position.set(0, 1.65, 0.3);
    car.add(cabin);

    for (const sx of [-0.85, 0.85]) {
      for (const sz of [-1.45, 1.45]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.25, 8), wheelMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(sx, 0.38, sz);
        car.add(wheel);
      }
    }

    car.position.set(x, 0.02, z);
    car.rotation.y = rotY;
    scene.add(car);
  }

  buildShelter(scene, x, z) {
    const postMat = lambert({ color: 0x6b4f35 });
    const slab = new THREE.Mesh(new THREE.PlaneGeometry(9, 7, 4, 3), lambert({ map: tex.concreteTexture(4) }));
    slab.rotation.x = -Math.PI / 2;
    slab.position.set(x, 0.08, z);
    scene.add(slab);

    for (const px of [-3.8, 3.8]) {
      for (const pz of [-2.8, 0, 2.8]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.7, 0.22), postMat);
        post.position.set(x + px, 1.35, z + pz);
        scene.add(post);
      }
    }

    const roof = new THREE.Mesh(
      jitterGeometry(new THREE.ConeGeometry(6.4, 2.2, 4), 0.15),
      lambert({ color: 0x5e4632, flatShading: true })
    );
    roof.rotation.y = Math.PI / 4;
    roof.position.set(x, 3.7, z);
    scene.add(roof);
  }

  buildPlayground(scene, x, z) {
    // Painted metal and plastic — smoother than wood and stone.
    const frameMat = lambert({ color: 0x4a6a8a, metalness: 0.4, roughness: 0.45 });
    const accentMat = lambert({ color: 0x9e4436, roughness: 0.5 });
    const slideMat = lambert({ color: 0xc9a832, roughness: 0.35, metalness: 0.2 });
    const darkMat = lambert({ color: 0x26262a, roughness: 0.85 }); // rubber

    // Platform tower with a pyramid roof.
    for (const px of [-1.1, 1.1]) {
      for (const pz of [-1.1, 1.1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.6, 0.18), frameMat);
        post.position.set(x + px, 1.3, z + pz);
        scene.add(post);
      }
    }
    const platform = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.18, 2.8), accentMat);
    platform.position.set(x, 1.25, z);
    scene.add(platform);
    const roof = new THREE.Mesh(
      jitterGeometry(new THREE.ConeGeometry(2.1, 1.3, 4), 0.1),
      lambert({ color: 0x9e4436, flatShading: true })
    );
    roof.rotation.y = Math.PI / 4;
    roof.position.set(x, 3.2, z);
    scene.add(roof);

    // Slide running off the south side of the platform.
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 3.4), slideMat);
    slide.position.set(x, 0.68, z + 2.5);
    slide.rotation.x = 0.42;
    scene.add(slide);

    // Swing set: A-frame legs, top bar, two swings.
    const sx = x - 5.5;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.15, 0.15), frameMat);
    bar.position.set(sx, 2.3, z);
    scene.add(bar);
    for (const ex of [-1.7, 1.7]) {
      for (const tilt of [-0.35, 0.35]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.5, 0.12), frameMat);
        leg.rotation.x = tilt;
        leg.position.set(sx + ex, 1.15, z + Math.sin(tilt) * 1.1);
        scene.add(leg);
      }
    }
    for (const swx of [-0.7, 0.7]) {
      for (const chx of [-0.22, 0.22]) {
        const chain = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.3, 0.04), darkMat);
        chain.position.set(sx + swx + chx, 1.6, z);
        scene.add(chain);
      }
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.25), darkMat);
      seat.position.set(sx + swx, 0.92, z);
      scene.add(seat);
    }
  }

  buildCrossing(scene) {
    // Large flat river stones spanning the north channel near Western Point.
    const stoneMat = lambert({ map: tex.riverRockTexture(2), flatShading: true });
    const startZ = bands.river_north_channel.z[0] + 1.5;
    const endZ = bands.river_north_channel.z[1] - 1.0;
    const count = 9;
    const crossingX = -100;

    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const x = crossingX + Math.sin(i * 2.1) * 2.2;
      const z = THREE.MathUtils.lerp(startZ, endZ, t);
      const r = 1.3 + Math.random() * 0.5;
      const stone = new THREE.Mesh(
        jitterGeometry(new THREE.CylinderGeometry(r, r * 1.2, 2.0, 7), 0.16),
        stoneMat
      );
      stone.position.set(x, STONE_TOP_Y - 1.0, z);
      stone.rotation.y = Math.random() * Math.PI;
      scene.add(stone);
      this.stones.push({ x, z, r, mesh: stone });
    }
  }

  // Builds a dirt ribbon draped over the terrain along a 2D polyline.
  buildRibbon(scene, points2d, halfWidth, material) {
    const curve = new THREE.CatmullRomCurve3(
      points2d.map(([x, z]) => new THREE.Vector3(x, 0, z))
    );
    const samples = Math.max(60, Math.round(curve.getLength() * 1.2));
    const positions = [];
    const uvs = [];
    const indices = [];

    // 4 vertex columns across the width — a single quad would smear badly
    // under the affine texture mapping at close, glancing angles.
    const cols = 4;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const p = curve.getPoint(t);
      const tangent = curve.getTangent(t);
      const nx = -tangent.z;
      const nz = tangent.x;
      const v = (t * curve.getLength()) / 4;
      for (let c = 0; c < cols; c++) {
        const f = (c / (cols - 1)) * 2 - 1;
        const px = p.x + nx * halfWidth * f;
        const pz = p.z + nz * halfWidth * f;
        // 0.35 offset: the terrain mesh interpolates between vertices 2.8m
        // apart and can bow above the analytic height between them.
        positions.push(px, this.heightAt(px, pz) + 0.35, pz);
        uvs.push(c / (cols - 1), v);
      }
      if (i < samples) {
        for (let c = 0; c < cols - 1; c++) {
          const a = i * cols + c;
          const b = a + cols;
          // Wound counterclockwise seen from above so the faces point up.
          indices.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, material));
  }

  buildPaths(scene) {
    // Feathered edges blend the trail into the grass.
    const dirtMat = lambert({ map: tex.pathTexture(), transparent: true });
    dirtMat.map.wrapS = THREE.ClampToEdgeWrapping;
    this.buildRibbon(scene, this.parkPathLine, 2.1, dirtMat);
    this.buildRibbon(scene, this.islandPathLine, 2.3, dirtMat);
  }

  // Low-poly rocks: wayfinding markers along both paths plus natural scatter.
  // They are solid — getGroundHeight treats them as plateaus, so small ones
  // can be stepped onto and large ones physically block the player.
  buildBoulders(scene) {
    const geos = [];

    const addBoulder = (x, z, r) => {
      const baseY = this.heightAt(x, z);
      const geo = new THREE.IcosahedronGeometry(r, 0);
      geo.scale(1, 0.65, 1);
      jitterGeometry(geo, r * 0.25);
      geo.rotateY(Math.random() * Math.PI * 2);
      geo.translate(x, baseY + r * 0.4, z);
      geos.push(geo);
      this.boulders.push({ x, z, r, top: baseY + r * 0.62 });
    };

    // Markers along the path edges, alternating sides every ~12 meters.
    const lineTrail = (points, halfWidth) => {
      const stride = 10;
      for (let i = stride; i < points.length - stride; i += stride) {
        const side = (i / stride) % 2 === 0 ? 1 : -1;
        const tangent = points[i + 1].clone().sub(points[i - 1]).normalize();
        const off = halfWidth + 0.9 + Math.random() * 0.5;
        addBoulder(
          points[i].x - tangent.z * off * side,
          points[i].z + tangent.x * off * side,
          0.45 + Math.random() * 0.35
        );
      }
    };
    lineTrail(this.parkPathPoints, 1.8);
    lineTrail(this.pathPoints, 2.0);

    // Natural scatter on the north bank, clear of the built-up park area.
    let placed = 0;
    while (placed < 18) {
      const x = THREE.MathUtils.lerp(-240, 240, Math.random());
      const z = THREE.MathUtils.lerp(-145, -58, Math.random());
      if (x > -32 && x < 36 && z > -118 && z < -80) continue;
      if (World.distanceToPoints(this.parkPathPoints, x, z) < 4) continue;
      addBoulder(x, z, 0.6 + Math.random() * 1.1);
      placed++;
    }

    // Scatter through the island forest and along its shorelines.
    const island = bands.blue_grass_island;
    placed = 0;
    while (placed < 34) {
      const x = THREE.MathUtils.lerp(island.x[0] + 2, island.x[1] - 2, Math.random());
      const z = THREE.MathUtils.lerp(island.z[0] + 2, island.z[1] - 2, Math.random());
      if (World.distanceToPoints(this.pathPoints, x, z) < 4) continue;
      if (this.towerPosition.distanceTo(new THREE.Vector3(x, 0, z)) < 10) continue;
      if (this.heightAt(x, z) < -0.5) continue;
      addBoulder(x, z, 0.5 + Math.random() * 1.3);
      placed++;
    }

    scene.add(
      new THREE.Mesh(
        mergeGeometries(geos),
        lambert({ map: tex.riverRockTexture(2), flatShading: true })
      )
    );
  }

  static distanceToPoints(points, x, z) {
    let min = Infinity;
    for (const p of points) {
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < min) min = d;
    }
    return Math.sqrt(min);
  }

  buildForest(scene) {
    const trunkGeos = [];
    const pineGeos = [];
    const oakGeos = [];

    // Every tree gets its own shade of green baked into vertex colors so
    // the forest reads as individuals instead of a copy-pasted block.
    const tintGeo = (geo, base) => {
      const c = base
        .clone()
        .offsetHSL((Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.1);
      const n = geo.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    };
    const pineGreen = new THREE.Color(0x2f4226);
    const oakGreen = new THREE.Color(0x4a5c30);

    // Jittered conifer: leaning tapered trunk, 3-4 irregular cone tiers.
    const addPine = (x, z) => {
      const y = this.heightAt(x, z);
      const height = 6.5 + Math.random() * 5;
      const lean = (Math.random() - 0.5) * 0.5;
      const trunk = new THREE.CylinderGeometry(0.18 + Math.random() * 0.1, 0.4, height, 5);
      jitterGeometry(trunk, 0.1);
      trunk.translate(lean, height / 2 - 0.3, 0);
      trunk.translate(x, y, z);
      trunkGeos.push(trunk);

      const tiers = 3 + Math.floor(Math.random() * 2);
      for (let c = 0; c < tiers; c++) {
        const f = c / tiers;
        const r = (2.6 - f * 1.7) * (0.85 + Math.random() * 0.4);
        const cone = new THREE.ConeGeometry(r, 3.2 - f, 9);
        jitterGeometry(cone, r * 0.22);
        cone.translate(
          lean * (1 + f) + (Math.random() - 0.5) * 0.5,
          height * 0.42 + c * 2.1,
          (Math.random() - 0.5) * 0.5
        );
        cone.translate(x, y, z);
        tintGeo(cone, pineGreen);
        pineGeos.push(cone);
      }
    };

    // Blobby deciduous tree: short trunk, cluster of squashed icosahedrons.
    const addOak = (x, z) => {
      const y = this.heightAt(x, z);
      const height = 3.5 + Math.random() * 2.5;
      const trunk = new THREE.CylinderGeometry(0.22, 0.45, height, 5);
      jitterGeometry(trunk, 0.12);
      trunk.translate(x, y + height / 2 - 0.3, z);
      trunkGeos.push(trunk);

      const blobs = 2 + Math.floor(Math.random() * 3);
      for (let b = 0; b < blobs; b++) {
        const blob = new THREE.IcosahedronGeometry(1.4 + Math.random() * 1.1, 1);
        blob.scale(1 + Math.random() * 0.6, 0.7 + Math.random() * 0.4, 1 + Math.random() * 0.6);
        jitterGeometry(blob, 0.3);
        blob.translate(
          x + (Math.random() - 0.5) * 2.4,
          y + height + (Math.random() - 0.5) * 1.4,
          z + (Math.random() - 0.5) * 2.4
        );
        tintGeo(blob, oakGreen);
        oakGeos.push(blob);
      }
    };

    // Dense mixed forest on the island, kept clear of the footpath and tower.
    const island = bands.blue_grass_island;
    let placed = 0;
    let attempts = 0;
    while (placed < 580 && attempts < 15000) {
      attempts++;
      const x = THREE.MathUtils.lerp(island.x[0] + 3, island.x[1] - 3, Math.random());
      const z = THREE.MathUtils.lerp(island.z[0] + 3, island.z[1] - 3, Math.random());
      if (World.distanceToPoints(this.pathPoints, x, z) < 2.8) continue;
      if (this.towerPosition.distanceTo(new THREE.Vector3(x, 0, z)) < 12) continue;
      if (this.heightAt(x, z) < -0.4) continue;
      Math.random() < 0.65 ? addPine(x, z) : addOak(x, z);
      placed++;
    }

    // Sparse parkland trees on the north bank — mostly broad oaks.
    let bankPlaced = 0;
    let bankAttempts = 0;
    while (bankPlaced < 52 && bankAttempts < 2500) {
      bankAttempts++;
      const x = THREE.MathUtils.lerp(-250, 250, Math.random());
      const z = THREE.MathUtils.lerp(-145, -58, Math.random());
      if (x > -32 && x < 36 && z > -118 && z < -80) continue; // lot/shelter/playground
      if (x > 9 && x < 21 && z < -110) continue; // driveway
      if (World.distanceToPoints(this.parkPathPoints, x, z) < 3.5) continue;
      Math.random() < 0.6 ? addOak(x, z) : addPine(x, z);
      bankPlaced++;
    }

    scene.add(new THREE.Mesh(mergeGeometries(trunkGeos), lambert({ map: tex.barkTexture(1) })));
    scene.add(
      new THREE.Mesh(
        mergeGeometries(pineGeos),
        lambert({ map: tex.foliageTexture(2), color: 0xffffff, vertexColors: true })
      )
    );
    scene.add(
      new THREE.Mesh(
        mergeGeometries(oakGeos),
        lambert({ map: tex.foliageTexture(3), color: 0xffffff, vertexColors: true })
      )
    );
  }

  // Ground clutter: grass tufts, shoreline reeds, fallen logs, stumps.
  buildUndergrowth(scene) {
    const island = bands.blue_grass_island;

    // Grass tufts: crossed alpha-tested quads, scattered everywhere walkable.
    const tuftGeos = [];
    let placed = 0;
    let attempts = 0;
    while (placed < 760 && attempts < 5500) {
      attempts++;
      const x = THREE.MathUtils.lerp(-250, 250, Math.random());
      const z = THREE.MathUtils.lerp(-148, 105, Math.random());
      const h = this.heightAt(x, z);
      if (h < -0.4) continue; // not in the river
      if (World.distanceToPoints(this.protectPoints, x, z) < 2.2) continue;
      if (x > -32 && x < 36 && z > -118 && z < -80) continue;
      const s = 0.7 + Math.random() * 0.8;
      for (const rot of [0, Math.PI / 2]) {
        const quad = new THREE.PlaneGeometry(s, s * 0.6);
        quad.rotateY(rot + Math.random() * 0.6);
        quad.translate(x, h + s * 0.27, z);
        tuftGeos.push(quad);
      }
      placed++;
    }
    scene.add(
      new THREE.Mesh(
        mergeGeometries(tuftGeos),
        lambert({
          map: tex.grassBladeTexture(),
          alphaTest: 0.5,
          side: THREE.DoubleSide,
        })
      )
    );

    // Reeds where land meets water.
    const stemGeos = [];
    const tipGeos = [];
    placed = 0;
    attempts = 0;
    while (placed < 90 && attempts < 2500) {
      attempts++;
      const x = THREE.MathUtils.lerp(-250, 250, Math.random());
      const z = THREE.MathUtils.lerp(-60, 145, Math.random());
      const h = this.heightAt(x, z);
      if (h > -0.45 || h < -0.95) continue; // only the waterline band
      for (let r = 0; r < 3 + Math.floor(Math.random() * 3); r++) {
        const rx = x + (Math.random() - 0.5) * 1.6;
        const rz = z + (Math.random() - 0.5) * 1.6;
        const rh = 1.1 + Math.random() * 0.6;
        const stem = new THREE.CylinderGeometry(0.025, 0.05, rh, 3);
        stem.translate(rx, h + rh / 2, rz);
        stemGeos.push(stem);
        const tip = new THREE.CylinderGeometry(0.07, 0.07, 0.3, 3);
        tip.translate(rx, h + rh + 0.1, rz);
        tipGeos.push(tip);
      }
      placed++;
    }
    scene.add(new THREE.Mesh(mergeGeometries(stemGeos), lambert({ color: 0x5c6336 })));
    scene.add(new THREE.Mesh(mergeGeometries(tipGeos), lambert({ color: 0x4a3526 })));

    // Fallen logs and stumps in the island forest.
    const logMat = lambert({ map: tex.barkTexture(2), flatShading: true });
    for (let i = 0; i < 7; i++) {
      const x = THREE.MathUtils.lerp(island.x[0] + 10, island.x[1] - 10, Math.random());
      const z = THREE.MathUtils.lerp(island.z[0] + 6, island.z[1] - 6, Math.random());
      if (World.distanceToPoints(this.pathPoints, x, z) < 4) continue;
      if (this.heightAt(x, z) < -0.3) continue;
      const len = 4 + Math.random() * 3.5;
      const log = new THREE.Mesh(
        jitterGeometry(new THREE.CylinderGeometry(0.32, 0.4, len, 7), 0.1),
        logMat
      );
      log.rotation.z = Math.PI / 2;
      log.rotation.y = Math.random() * Math.PI;
      log.position.set(x, this.heightAt(x, z) + 0.28, z);
      scene.add(log);
    }
    for (let i = 0; i < 6; i++) {
      const p = this.pathPoints[Math.floor(Math.random() * this.pathPoints.length)];
      const x = p.x + (Math.random() - 0.5) * 8;
      const z = p.z + (Math.random() - 0.5) * 8;
      if (World.distanceToPoints(this.pathPoints, x, z) < 2.5) continue;
      const stump = new THREE.Mesh(
        jitterGeometry(new THREE.CylinderGeometry(0.35, 0.48, 0.7, 7), 0.08),
        logMat
      );
      stump.position.set(x, this.heightAt(x, z) + 0.3, z);
      scene.add(stump);
    }
  }

  buildBeachAndTower(scene) {
    // Round river-rock beach where the path meets the eastern shore.
    // Subdivided disk rather than a triangle fan, to keep affine warp local.
    const beachGeo = new THREE.PlaneGeometry(42, 42, 10, 10);
    const bpos = beachGeo.attributes.position;
    for (let i = 0; i < bpos.count; i++) {
      const x = bpos.getX(i);
      const y = bpos.getY(i);
      const r = Math.hypot(x, y);
      if (r > 20) {
        bpos.setX(i, (x / r) * 20);
        bpos.setY(i, (y / r) * 20);
      }
    }
    const beach = new THREE.Mesh(beachGeo, lambert({ map: tex.riverRockTexture(8) }));
    beach.rotation.x = -Math.PI / 2;
    beach.position.set(this.towerPosition.x + 6, 0.22, this.towerPosition.z + 2);
    scene.add(beach);

    // The tower: rings of stacked flat river stones, slightly irregular so
    // the silhouette reads as hand-piled rather than machined.
    const stoneMat = lambert({ map: tex.stoneTexture(6), flatShading: true });
    const rings = 15;
    const baseRadius = 4.2;
    for (let i = 0; i < rings; i++) {
      const radius = baseRadius * (1 - i * 0.012) + (Math.random() - 0.5) * 0.18;
      const ring = new THREE.Mesh(
        jitterGeometry(new THREE.CylinderGeometry(radius, radius, 1.5, 10, 1, true), 0.12),
        stoneMat
      );
      ring.position.set(
        this.towerPosition.x + (Math.random() - 0.5) * 0.15,
        0.75 + i * 1.22,
        this.towerPosition.z + (Math.random() - 0.5) * 0.15
      );
      ring.rotation.y = Math.random() * Math.PI;
      scene.add(ring);
    }

    // Dark doorway facing the beach — walking into it triggers the descent.
    const doorway = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 3),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    this.doorPosition = new THREE.Vector3(
      this.towerPosition.x + baseRadius * 0.99,
      0,
      this.towerPosition.z + 1.2
    );
    doorway.position.set(this.doorPosition.x, 1.65, this.doorPosition.z);
    doorway.rotation.y = Math.PI / 2;
    scene.add(doorway);

    // Rough stone frame around the opening.
    const frameMat = lambert({ map: tex.stoneTexture(2), flatShading: true });
    for (const dz of [-1.1, 1.1]) {
      const post = new THREE.Mesh(jitterGeometry(new THREE.BoxGeometry(0.5, 3.4, 0.45), 0.08), frameMat);
      post.position.set(this.doorPosition.x + 0.1, 1.7, this.doorPosition.z + dz);
      scene.add(post);
    }
    const lintel = new THREE.Mesh(jitterGeometry(new THREE.BoxGeometry(0.55, 0.5, 2.7), 0.08), frameMat);
    lintel.position.set(this.doorPosition.x + 0.1, 3.55, this.doorPosition.z);
    scene.add(lintel);
  }

  // The underground: an inverted echo of the tower — a wide stone shaft
  // with the ramp sweeping down its wall to an open black floor.
  buildDescent(scene) {
    // Walls are seen from inside, so they need DoubleSide.
    const wallMat = lambert({ map: tex.stoneTexture(6), flatShading: true, side: THREE.DoubleSide });
    const rampMat = lambert({ map: tex.stoneTexture(3), flatShading: true });
    const rockMat = lambert({ map: tex.riverRockTexture(10) });

    // The ramp, draped onto the descent height function.
    const rampPts = [];
    for (let t = 0; t <= DESC.maxTheta; t += 0.15) {
      rampPts.push([
        DESC.cx + DESC.R0 * Math.cos(t),
        DESC.cz + DESC.R0 * Math.sin(t),
      ]);
    }
    this.buildRibbon(scene, rampPts, 1.55, rampMat);

    // Shaft walls: stacked stone rings from above the ledge to the floor.
    const wallR = DESC.R0 + DESC.rampHalf + 0.4;
    for (let y = 2.4; y > DESC.chamberY - 1.2; y -= 1.45) {
      const radius = wallR + (Math.random() - 0.5) * 0.25;
      const ring = new THREE.Mesh(
        jitterGeometry(new THREE.CylinderGeometry(radius, radius, 1.7, 14, 1, true), 0.14),
        wallMat
      );
      ring.position.set(DESC.cx, y - 0.7, DESC.cz);
      ring.rotation.y = Math.random() * Math.PI;
      scene.add(ring);
    }

    // The floor — a subdivided disk spanning the whole shaft.
    const floorGeo = new THREE.PlaneGeometry(36, 36, 9, 9);
    const fpos = floorGeo.attributes.position;
    for (let i = 0; i < fpos.count; i++) {
      const x = fpos.getX(i);
      const y = fpos.getY(i);
      const fr = Math.hypot(x, y);
      if (fr > wallR + 0.5) {
        fpos.setX(i, (x / fr) * (wallR + 0.5));
        fpos.setY(i, (y / fr) * (wallR + 0.5));
      }
    }
    const floor = new THREE.Mesh(floorGeo, rockMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(DESC.cx, DESC.chamberY + 0.05, DESC.cz);
    scene.add(floor);

    // Cap over the shaft so no sky is visible from below.
    const cap = new THREE.Mesh(new THREE.CircleGeometry(19, 12), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    cap.rotation.x = Math.PI / 2;
    cap.position.set(DESC.cx, 3.1, DESC.cz);
    scene.add(cap);

    // The tunnel mouth on the entry ledge — the way back out.
    const mouth = new THREE.Mesh(new THREE.PlaneGeometry(2, 2.8), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    const exitT = 0.12;
    this.descentExit = new THREE.Vector3(
      DESC.cx + (DESC.R0 + 0.6) * Math.cos(exitT),
      0,
      DESC.cz + (DESC.R0 + 0.6) * Math.sin(exitT)
    );
    mouth.position.set(this.descentExit.x, 1.4, this.descentExit.z);
    mouth.rotation.y = Math.atan2(DESC.cx - this.descentExit.x, DESC.cz - this.descentExit.z);
    scene.add(mouth);

    // Player arrives here, facing along the ledge toward the ramp.
    const enterT = 0.55;
    this.descentEntry = new THREE.Vector3(
      DESC.cx + DESC.R0 * Math.cos(enterT),
      0,
      DESC.cz + DESC.R0 * Math.sin(enterT)
    );

    // Spooky torches along the walls
    const torchAngles = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
    for (const angle of torchAngles) {
      const x = DESC.cx + (wallR - 0.2) * Math.cos(angle);
      const z = DESC.cz + (wallR - 0.2) * Math.sin(angle);
      const y = DESC.chamberY + 2.5;

      const torchPole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.6, 5), lambert({ color: 0x3d2b1f }));
      torchPole.position.set(x, y - 0.3, z);
      scene.add(torchPole);

      const light = new THREE.PointLight(0xff4a10, 40, 28, 1.2);
      light.position.set(x, y + 0.1, z);
      light.baseIntensity = 40;
      scene.add(light);
      this.torches.push(light);
    }
    
    // One dim eerie center light
    const centerLight = new THREE.PointLight(0x401010, 30, 35, 1.5);
    centerLight.position.set(DESC.cx, DESC.chamberY + 8, DESC.cz);
    scene.add(centerLight);

    // What's left of Dan: a dropped backpack and scattered bones near the
    // chamber's edge.
    const packGroup = new THREE.Group();
    const canvasMat = lambert({ color: 0x3e4a36, roughness: 0.95 });
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.55, 0.22), canvasMat);
    pack.rotation.z = 1.35; // toppled over
    pack.position.y = 0.16;
    packGroup.add(pack);
    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.06), canvasMat);
    flap.position.set(0.25, 0.3, 0);
    flap.rotation.z = 0.8;
    packGroup.add(flap);
    packGroup.position.set(DESC.cx - 3.5, DESC.chamberY + 0.05, DESC.cz - 5);
    scene.add(packGroup);

    const boneMat = lambert({ color: 0xb8b0a0, roughness: 0.7 });
    for (let i = 0; i < 9; i++) {
      const bone = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.045, 0.25 + Math.random() * 0.3, 5),
        boneMat
      );
      const a = Math.random() * Math.PI * 2;
      const d = 1 + Math.random() * 3.5;
      bone.position.set(
        DESC.cx - 3.5 + Math.cos(a) * d,
        DESC.chamberY + 0.1,
        DESC.cz - 5 + Math.sin(a) * d
      );
      bone.rotation.set(Math.PI / 2, Math.random() * Math.PI, Math.random() * 0.4);
      scene.add(bone);
    }
  }

  /** Walkable ground height at (x, z) — the player controller's only physics query. */
  getGroundHeight(x, z) {
    // Tower wall: solid ring, passable only through the doorway sector.
    if (x < 400) {
      const tdx = x - this.towerPosition.x;
      const tdz = z - this.towerPosition.z;
      if (tdx * tdx + tdz * tdz < 4.6 * 4.6) {
        const doorAngle = Math.atan2(1.2, 4.2);
        let dAng = Math.atan2(tdz, tdx) - doorAngle;
        dAng = Math.atan2(Math.sin(dAng), Math.cos(dAng));
        if (Math.abs(dAng) > 0.45) return this.heightAt(x, z) + 4;
      }
    }

    for (const b of this.boulders) {
      const dx = x - b.x;
      const dz = z - b.z;
      const reach = b.r * 0.8;
      if (dx * dx + dz * dz < reach * reach) return b.top;
    }
    for (const s of this.stones) {
      const dx = x - s.x;
      const dz = z - s.z;
      if (dx * dx + dz * dz < s.r * s.r) return STONE_TOP_Y;
    }
    return this.heightAt(x, z);
  }

  /** What the player is standing on, for footstep audio. */
  surfaceAt(x, z) {
    if (x > 400) return 'wetstone'; // everything underground is cold stone
    for (const s of this.stones) {
      const dx = x - s.x;
      const dz = z - s.z;
      if (dx * dx + dz * dz < s.r * s.r) return 'wetstone';
    }
    for (const b of this.boulders) {
      const dx = x - b.x;
      const dz = z - b.z;
      const reach = b.r * 0.8;
      if (dx * dx + dz * dz < reach * reach) return 'wetstone';
    }
    if (this.heightAt(x, z) < -0.45) return 'water';
    if (x > 0 && x < 30 && z > -112 && z < -100) return 'asphalt'; // parking lot
    if (x > 12 && x < 18 && z < -112 && z > -152) return 'asphalt'; // driveway
    if (x > 1.5 && x < 10.5 && z > -91.5 && z < -84.5) return 'asphalt'; // shelter slab
    if (Math.hypot(x - (this.towerPosition.x + 6), z - (this.towerPosition.z + 2)) < 20) {
      return 'riverrock'; // tower beach
    }
    if (World.distanceToPoints(this.protectPoints, x, z) < 2) return 'dirt';
    return 'grass';
  }

  /** 0..1 — how close the river sounds from here. */
  riverProximity(x, z) {
    if (x > 400) return 0; // silent underground
    const bandDist = (z0, z1) => Math.max(0, Math.max(z0 - z, z - z1));
    let d = Math.min(
      bandDist(bands.river_north_channel.z[0], bands.river_north_channel.z[1]),
      bandDist(bands.river_south_channel.z[0], bands.river_south_channel.z[1])
    );
    // Standing in the water itself.
    if (this.heightAt(x, z) < -0.45) d = 0;
    return THREE.MathUtils.clamp(1 - d / 45, 0, 1);
  }

  /** 0..1 — wind is stronger among the island trees. */
  windLevel(x, z) {
    if (x > 400) return 0; // no wind below the earth
    const island = bands.blue_grass_island;
    return z > island.z[0] && z < island.z[1] && x > island.x[0] && x < island.x[1] ? 1 : 0.45;
  }

  update(dt, playerPos) {
    // Crossing stones tip slightly under the player's weight.
    if (playerPos) {
      for (const s of this.stones) {
        if (!s.mesh) continue;
        const dx = playerPos.x - s.x;
        const dz = playerPos.z - s.z;
        const on = dx * dx + dz * dz < s.r * s.r && Math.abs(playerPos.y - 2) < 2.5;
        const tx = on ? (dz / s.r) * 0.06 : 0;
        const tz = on ? (-dx / s.r) * 0.06 : 0;
        s.mesh.rotation.x += (tx - s.mesh.rotation.x) * Math.min(1, dt * 6);
        s.mesh.rotation.z += (tz - s.mesh.rotation.z) * Math.min(1, dt * 6);
      }
    }

    // Mist cards drift east and always face the player.
    if (this.mist) {
      this.mistTime = (this.mistTime ?? 0) + dt;
      for (const f of this.mist) {
        f.m.position.x += f.speed * dt;
        if (f.m.position.x > 240) f.m.position.x = -240;
        if (playerPos) f.m.lookAt(playerPos.x, f.m.position.y, playerPos.z);
      }
    }
    // Fireflies wander and bob.
    if (this.fireflies) {
      const t = performance.now() * 0.001;
      const pos = this.fireflies.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const p = this.fireflyPhase[i];
        pos.setY(i, this.fireflyBase[i * 3 + 1] + Math.sin(t * 1.1 + p) * 0.5);
        pos.setX(i, this.fireflyBase[i * 3] + Math.sin(t * 0.4 + p * 2) * 0.9);
      }
      pos.needsUpdate = true;
    }

    // Scrolling layers + slow rolling waves sell the river current.
    for (const w of this.waterMaterials) {
      if (w.mat.map) {
        w.mat.map.offset.x += w.sx * dt;
        w.mat.map.offset.y += w.sy * dt;
      }
    }
    if (this.waterMesh) {
      this.waveTime += dt;
      const pos = this.waterMesh.geometry.attributes.position;
      const base = this.waterBase;
      for (let i = 0; i < pos.count; i++) {
        const x = base[i * 3];
        const z = base[i * 3 + 2];
        pos.setY(i, Math.sin(x * 0.12 + this.waveTime * 1.4) * 0.055 + Math.sin(z * 0.3 + this.waveTime * 0.9) * 0.04);
      }
      pos.needsUpdate = true;
    }

    // Flicker torches
    const time = performance.now() * 0.01;
    for (let i = 0; i < this.torches.length; i++) {
      const light = this.torches[i];
      const flicker = Math.sin(time + i * 2.3) * Math.cos(time * 1.5 + i) * 15;
      light.intensity = light.baseIntensity + flicker + Math.random() * 5;
    }
  }
}
