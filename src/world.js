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
// is its address space), reached by teleport from the tower doorway. A
// conical spiral ramp — each turn at a smaller radius, so the height stays
// a single-valued function of (x, z) and the heightfield physics still work.
const DESC = {
  cx: 500,
  cz: 0,
  R0: 14, // ramp radius at the top
  a: 3.2 / (2 * Math.PI), // radial shrink per radian
  b: 6.5 / (2 * Math.PI), // drop per radian
  ledge: 1.0, // flat entry arc (radians) before the ramp starts down
  maxTheta: 6 * Math.PI, // three full turns
  rampHalf: 1.7,
  chamberY: -20.5,
  chamberR: 14.5,
};
const rampRadius = (t) => DESC.R0 - DESC.a * Math.max(0, t - DESC.ledge);
const rampY = (t) => -DESC.b * Math.max(0, t - DESC.ledge);

function lambert(opts) {
  return applyRetroMaterial(new THREE.MeshLambertMaterial(opts));
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

// Hand-modeled jank: displace vertices by a hash of their position, so
// shared/seam vertices move identically and meshes never crack.
function jitterGeometry(geo, amount) {
  const pos = geo.attributes.position;
  const h = (x, y, z, s) => {
    const v = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + s * 53.3) * 43758.5453;
    return v - Math.floor(v) - 0.5;
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    pos.setXYZ(
      i,
      x + h(x, y, z, 1) * amount,
      y + h(x, y, z, 2) * amount,
      z + h(x, y, z, 3) * amount
    );
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
    this.hillCenter = new THREE.Vector2(-175, -112); // Wagener Sledding Hill

    this.rolling = new ValueNoise(1137);
    this.detail = new ValueNoise(4422);
    this.shore = new ValueNoise(9810);
  }

  // ---------------------------------------------------------------------
  // Height field — single source of truth for terrain, props, and physics.
  // ---------------------------------------------------------------------
  heightAt(x, z) {
    if (x > 400) return this.descentHeight(x, z);

    // Rolling parkland base.
    let h =
      this.rolling.noise2(x * 0.022, z * 0.022) * 1.1 +
      this.detail.noise2(x * 0.085, z * 0.085) * 0.3;
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

    // Keep a walkable land corridor under the footpaths.
    if (this.protectPoints.length) {
      const d = World.distanceToPoints(this.protectPoints, x, z);
      const f = 1 - smoothstep(2.5, 8, d);
      if (f > 0) h = THREE.MathUtils.lerp(h, Math.max(h, 0.2), f);
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

    // The same compass angle occurs once per turn; pick the turn whose
    // ramp radius is closest to where we actually stand.
    let best = null;
    for (let k = 0; k <= 3; k++) {
      const t = th + k * Math.PI * 2;
      if (t > DESC.maxTheta + 0.3) continue;
      const d = r - rampRadius(t);
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { t, d };
    }

    if (best && Math.abs(best.d) <= DESC.rampHalf) return rampY(best.t); // on the ramp
    if (best && best.d > DESC.rampHalf) return rampY(best.t) + 4; // pit wall blocks
    if (r <= DESC.chamberR) return DESC.chamberY; // inner void: fall to the chamber
    return 4; // solid rock
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
    scene.background = horizon;
    scene.fog = new THREE.Fog(horizon, 25, 140);

    this.hemi = new THREE.HemisphereLight(0xffb070, 0x4a3b5c, 1.5);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffa050, 2.0);
    this.sun.position.set(-80, 30, -30); // low in the west
    scene.add(this.sun);
  }

  /** Swap between the sunset overworld and the lightless underground. */
  setUnderground(under) {
    this.hemi.intensity = under ? 0.16 : 1.5;
    this.sun.intensity = under ? 0 : 2.0;
    const color = under ? 0x030303 : 0xc46a47;
    this.scene.fog.color.set(color);
    this.scene.background.set(color);
    this.scene.fog.near = under ? 3 : 25;
    this.scene.fog.far = under ? 30 : 140;
  }

  buildTerrain(scene) {
    // One displaced, flat-shaded heightfield instead of flat planes.
    const geo = new THREE.PlaneGeometry(560, 330, 200, 120);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, 5);

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

    // De-index for true per-face normals: shader-side flatShading derives
    // normals from screen derivatives, which degenerate on glancing
    // triangles at 320x240 and flash black.
    const flatGeo = geo.toNonIndexed();
    flatGeo.computeVertexNormals();
    const fn = flatGeo.attributes.normal;
    for (let i = 0; i < fn.count; i += 3) {
      // Average the three corners so each face is uniformly lit.
      const nx = (fn.getX(i) + fn.getX(i + 1) + fn.getX(i + 2)) / 3;
      const ny = (fn.getY(i) + fn.getY(i + 1) + fn.getY(i + 2)) / 3;
      const nz = (fn.getZ(i) + fn.getZ(i + 1) + fn.getZ(i + 2)) / 3;
      for (let k = 0; k < 3; k++) fn.setXYZ(i + k, nx, ny, nz);
    }

    scene.add(
      new THREE.Mesh(
        flatGeo,
        lambert({ map: tex.grassTexture(70), vertexColors: true })
      )
    );

    // Water sheet over the carved riverbed.
    const waterMat = lambert({ map: tex.waterTexture(80), color: 0xffff00 });
    this.waterMaterials.push(waterMat);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(560, 220, 56, 22), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, WATER_Y, 45);
    scene.add(water);
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
  }

  buildCar(scene, x, z, rotY) {
    const car = new THREE.Group();
    const bodyMat = lambert({ color: 0xb0a487 }); // dusty beige sedan
    const glassMat = lambert({ color: 0x2e3a40 });
    const wheelMat = lambert({ color: 0x1d1d1f });

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
    const frameMat = lambert({ color: 0x4a6a8a }); // faded municipal blue
    const accentMat = lambert({ color: 0x9e4436 }); // sun-bleached red
    const slideMat = lambert({ color: 0xc9a832 });
    const darkMat = lambert({ color: 0x26262a }); // rubber seats, chains

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
      this.stones.push({ x, z, r });
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
    const dirtMat = lambert({ map: tex.dirtTexture(1) });
    this.buildRibbon(scene, this.parkPathLine, 1.8, dirtMat);
    this.buildRibbon(scene, this.islandPathLine, 2.0, dirtMat);
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
        const cone = new THREE.ConeGeometry(r, 3.2 - f, 6);
        jitterGeometry(cone, r * 0.22);
        cone.translate(
          lean * (1 + f) + (Math.random() - 0.5) * 0.5,
          height * 0.42 + c * 2.1,
          (Math.random() - 0.5) * 0.5
        );
        cone.translate(x, y, z);
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
        const blob = new THREE.IcosahedronGeometry(1.4 + Math.random() * 1.1, 0);
        blob.scale(1 + Math.random() * 0.6, 0.7 + Math.random() * 0.4, 1 + Math.random() * 0.6);
        jitterGeometry(blob, 0.3);
        blob.translate(
          x + (Math.random() - 0.5) * 2.4,
          y + height + (Math.random() - 0.5) * 1.4,
          z + (Math.random() - 0.5) * 2.4
        );
        oakGeos.push(blob);
      }
    };

    // Dense mixed forest on the island, kept clear of the footpath and tower.
    const island = bands.blue_grass_island;
    let placed = 0;
    let attempts = 0;
    while (placed < 230 && attempts < 4000) {
      attempts++;
      const x = THREE.MathUtils.lerp(island.x[0] + 3, island.x[1] - 3, Math.random());
      const z = THREE.MathUtils.lerp(island.z[0] + 3, island.z[1] - 3, Math.random());
      if (World.distanceToPoints(this.pathPoints, x, z) < 3.2) continue;
      if (this.towerPosition.distanceTo(new THREE.Vector3(x, 0, z)) < 14) continue;
      if (this.heightAt(x, z) < -0.4) continue;
      Math.random() < 0.65 ? addPine(x, z) : addOak(x, z);
      placed++;
    }

    // Sparse parkland trees on the north bank — mostly broad oaks.
    let bankPlaced = 0;
    let bankAttempts = 0;
    while (bankPlaced < 36 && bankAttempts < 1500) {
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
      new THREE.Mesh(mergeGeometries(pineGeos), lambert({ color: 0x2f4226, flatShading: true }))
    );
    scene.add(
      new THREE.Mesh(mergeGeometries(oakGeos), lambert({ color: 0x4a5c30, flatShading: true }))
    );
  }

  // Ground clutter: grass tufts, shoreline reeds, fallen logs, stumps.
  buildUndergrowth(scene) {
    const island = bands.blue_grass_island;

    // Grass tufts: crossed alpha-tested quads, scattered everywhere walkable.
    const tuftGeos = [];
    let placed = 0;
    let attempts = 0;
    while (placed < 420 && attempts < 3000) {
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

  // The underground: an inverted echo of the tower — stacked stone rings
  // narrowing as the spiral ramp descends into a black chamber.
  buildDescent(scene) {
    const stoneMat = lambert({ map: tex.stoneTexture(6), flatShading: true });
    const rampMat = lambert({ map: tex.stoneTexture(3), flatShading: true });
    const rockMat = lambert({ map: tex.riverRockTexture(10) });

    // The spiral ramp, draped onto the descent height function.
    const rampPts = [];
    for (let t = 0; t <= DESC.maxTheta; t += 0.25) {
      rampPts.push([
        DESC.cx + rampRadius(t) * Math.cos(t),
        DESC.cz + rampRadius(t) * Math.sin(t),
      ]);
    }
    this.buildRibbon(scene, rampPts, 1.55, rampMat);

    // Pit walls: rings shrinking with depth, mirroring the tower above.
    for (let y = 2.4; y > DESC.chamberY + 4.5; y -= 1.45) {
      const t = Math.max(0, -y / DESC.b + DESC.ledge);
      const radius = Math.max(rampRadius(t) + 2.1, DESC.chamberR * 0.42) + (Math.random() - 0.5) * 0.2;
      const ring = new THREE.Mesh(
        jitterGeometry(new THREE.CylinderGeometry(radius, radius, 1.7, 12, 1, true), 0.14),
        stoneMat
      );
      ring.position.set(DESC.cx, y - 0.7, DESC.cz);
      ring.rotation.y = Math.random() * Math.PI;
      scene.add(ring);
    }

    // The chamber: wide cylindrical room under the shaft.
    for (let y = DESC.chamberY + 0.8; y < DESC.chamberY + 6; y += 1.45) {
      const ring = new THREE.Mesh(
        jitterGeometry(new THREE.CylinderGeometry(DESC.chamberR + 0.6, DESC.chamberR + 0.6, 1.7, 14, 1, true), 0.16),
        stoneMat
      );
      ring.position.set(DESC.cx, y, DESC.cz);
      ring.rotation.y = Math.random() * Math.PI;
      scene.add(ring);
    }

    // Chamber floor — subdivided disk, like the beach.
    const floorGeo = new THREE.PlaneGeometry(34, 34, 9, 9);
    const fpos = floorGeo.attributes.position;
    for (let i = 0; i < fpos.count; i++) {
      const x = fpos.getX(i);
      const y = fpos.getY(i);
      const fr = Math.hypot(x, y);
      if (fr > DESC.chamberR + 1) {
        fpos.setX(i, (x / fr) * (DESC.chamberR + 1));
        fpos.setY(i, (y / fr) * (DESC.chamberR + 1));
      }
    }
    const floor = new THREE.Mesh(floorGeo, rockMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(DESC.cx, DESC.chamberY + 0.05, DESC.cz);
    scene.add(floor);

    // Chamber ceiling annulus (the shaft continues through the middle)
    // and a cap over the whole pit so no sky is visible from below.
    const ceiling = new THREE.Mesh(new THREE.RingGeometry(6.5, DESC.chamberR + 1, 14, 2), stoneMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(DESC.cx, DESC.chamberY + 5.2, DESC.cz);
    scene.add(ceiling);
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

    // Faint warm lights: top of the shaft, mid-shaft, and the chamber.
    for (const [y, intensity, distance] of [[1.5, 22, 20], [-9, 16, 18], [DESC.chamberY + 3, 38, 30]]) {
      const light = new THREE.PointLight(0x8a6644, intensity, distance, 1.6);
      light.position.set(DESC.cx, y, DESC.cz);
      scene.add(light);
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

  update(dt) {
    // Slow texture scroll sells the river current.
    for (const mat of this.waterMaterials) {
      if (mat.map) mat.map.offset.x += dt * 0.018;
    }
  }
}
