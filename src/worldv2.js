import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { World, lambert, jitterGeometry, smoothstep } from './world.js';
import * as tex from './textures.js';
import layout from './data/layout.json';

// ---------------------------------------------------------------------------
// The v2 world: geography traced from the official Side Cut trail map.
// River along the south flowing ENE, Blue Grass Island southwest, the
// Riverview hub at the origin, the Wood Duck slough east, canal locks
// northwest. Ground uses real PBR materials (color/normal/roughness).
// ---------------------------------------------------------------------------

// Terrain grid (mirrored by meshHeightAt).
const TERRAIN = { w: 700, h: 420, segs: 260, segz: 156, cx: 0, cz: -20 };
const WATER_Y = -0.85;

const texLoader = new THREE.TextureLoader();
function pbrMaterial(id, repeat, extra = {}) {
  const base = import.meta.env?.BASE_URL ?? '/';
  const load = (suffix, srgb) => {
    const t = texLoader.load(`${base}assets/tex/${id}_${suffix}.jpg`);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return new THREE.MeshStandardMaterial({
    map: load('Color', true),
    normalMap: load('NormalGL'),
    roughnessMap: load('Roughness'),
    ...extra,
  });
}

// Piecewise-linear z of the riverbank for a given x.
const BANK = layout.river.bank;
function bankZ(x) {
  if (x <= BANK[0][0]) return BANK[0][1];
  for (let i = 1; i < BANK.length; i++) {
    if (x <= BANK[i][0]) {
      const t = (x - BANK[i - 1][0]) / (BANK[i][0] - BANK[i - 1][0]);
      return THREE.MathUtils.lerp(BANK[i - 1][1], BANK[i][1], t);
    }
  }
  return BANK[BANK.length - 1][1];
}

const ISLAND = layout.blueGrassIsland;
const SLOUGH = layout.woodDuckSlough;

export class WorldV2 extends World {
  constructor() {
    super();
    this.spawn = new THREE.Vector3(18, 0, -12);
    // The tower stands at the heart of the island.
    this.towerPosition = new THREE.Vector3(-252, 0, 148);
    this.hubRect = { x0: -70, x1: 70, z0: -50, z1: 58 };
  }

  // ----- height field ------------------------------------------------------
  heightAt(x, z) {
    if (x > 400) return this.descentHeight(x, z);

    let h =
      this.rolling.noise2(x * 0.02, z * 0.02) * 0.9 +
      this.rolling.noise2(x * 0.009 + 31, z * 0.009) * 1.4 +
      this.detail.noise2(x * 0.08, z * 0.08) * 0.25;
    h = Math.max(h, -0.4);

    // The Maumee: everything south of the bank line slopes into the river.
    const shoreWobble = this.shore.noise2(x * 0.02, 7.7) * 5;
    const intoRiver = z - (bankZ(x) + shoreWobble);
    const riverS = smoothstep(-2, 12, intoRiver);
    const bed = -2.1 + this.detail.noise2(x * 0.09, z * 0.09) * 0.3;
    h = THREE.MathUtils.lerp(h, bed, riverS);

    // Blue Grass Island rises back out of the water.
    {
      const e =
        ((x - ISLAND.center[0]) / ISLAND.radii[0]) ** 2 +
        ((z - ISLAND.center[1]) / ISLAND.radii[1]) ** 2 +
        this.shore.noise2(x * 0.03, z * 0.03) * 0.09;
      const s = smoothstep(1.08, 0.82, e);
      const islandH = 0.35 + smoothstep(0.82, 0.25, e) * 1.0 + this.detail.noise2(x * 0.07, z * 0.07) * 0.2;
      h = THREE.MathUtils.lerp(h, islandH, s);
    }

    // Wood Duck slough: a marshy backwater in the eastern woods.
    {
      const e =
        ((x - SLOUGH.center[0]) / SLOUGH.radii[0]) ** 2 +
        ((z - SLOUGH.center[1]) / SLOUGH.radii[1]) ** 2 +
        this.shore.noise2(x * 0.05 + 9, z * 0.05) * 0.12;
      const s = smoothstep(1.0, 0.66, e);
      h = THREE.MathUtils.lerp(h, -1.1, s);
    }

    const flags = this.corridorFlags(x, z);

    // The old canal: a shallow overgrown ditch past the locks.
    if (flags & 4) {
      const d = World.distanceToPoints(this.canalPoints, x, z);
      h -= (1 - smoothstep(2.5, 7, d)) * 1.05;
    }

    // Crossing shallows by the island spur.
    if (x > -185 && x < -145 && z > 100 && z < 122) h = Math.max(h, -1.1);

    // Walkable corridors under every trail.
    if (flags & 1) {
      const d = World.distanceToPoints(this.protectPoints, x, z);
      const f = 1 - smoothstep(2.2, 7, d);
      if (f > 0) h = THREE.MathUtils.lerp(h, Math.max(h, 0.18), f);
    }
    // Roads get a gentler version of the same.
    if (flags & 2) {
      const d = World.distanceToPoints(this.roadPoints, x, z);
      const f = 1 - smoothstep(3.5, 9, d);
      if (f > 0) h = THREE.MathUtils.lerp(h, Math.max(h, 0.12), f);
    }

    // The Riverview hub sits on maintained, level ground.
    const r = this.hubRect;
    const dx = Math.max(0, Math.max(r.x0 - x, x - r.x1));
    const dz = Math.max(0, Math.max(r.z0 - z, z - r.z1));
    h = THREE.MathUtils.lerp(h, 0, 1 - smoothstep(0, 14, Math.hypot(dx, dz)));

    // Level clearing around the tower.
    const td = Math.hypot(x - this.towerPosition.x, z - this.towerPosition.z);
    h = THREE.MathUtils.lerp(h, 0.5, 1 - smoothstep(10, 22, td));

    return h;
  }

  meshHeightAt(x, z) {
    const x0 = TERRAIN.cx - TERRAIN.w / 2;
    const z0 = TERRAIN.cz - TERRAIN.h / 2;
    const cw = TERRAIN.w / TERRAIN.segs;
    const ch = TERRAIN.h / TERRAIN.segz;
    const gx = (x - x0) / cw;
    const gz = (z - z0) / ch;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const X = x0 + ix * cw;
    const Z = z0 + iz * ch;
    const h00 = this.heightAt(X, Z);
    const h10 = this.heightAt(X + cw, Z);
    const h01 = this.heightAt(X, Z + ch);
    const h11 = this.heightAt(X + cw, Z + ch);
    return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
  }

  // ----- build -------------------------------------------------------------
  build(scene) {
    this.computePathLines();
    this.buildAtmosphere(scene);
    this.buildTerrain(scene);
    this.buildWater(scene);
    this.buildHub(scene);
    this.buildRoads(scene);
    this.buildTrails(scene);
    this.buildCrossing(scene);
    this.buildLocksAndCanal(scene);
    this.buildForest(scene);
    this.buildBeachAndTower(scene);
    this.buildBollards(scene);
    this.buildDescent(scene);
    this.buildMist(scene);
    this.buildFireflies(scene);
    this.buildNightSky(scene);
  }

  computePathLines() {
    const sample = (pts) => {
      const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)));
      const n = Math.max(40, Math.round(curve.getLength() * 0.8));
      const out = [];
      for (let i = 0; i <= n; i++) out.push(curve.getPoint(i / n));
      return out;
    };
    this.trailLines = {
      riverview: layout.trails.riverviewTrail,
      woodDuck: layout.trails.woodDuckTrail,
      canal: layout.trails.canalLocksTrail,
      spur: layout.trails.islandSpur,
      island: [[-167, 116], [-192, 130], [-222, 142], [-252, 148]],
    };
    this.trailSamples = {};
    for (const [k, line] of Object.entries(this.trailLines)) this.trailSamples[k] = sample(line);

    // Names the parent class expects.
    this.parkPathPoints = [...this.trailSamples.riverview, ...this.trailSamples.spur];
    this.pathPoints = this.trailSamples.island;
    this.protectPoints = Object.values(this.trailSamples).flat();
    this.roadPoints = sample([...layout.roads.wayneSt.slice(1), ...layout.roads.parkDrive.slice(1)]);
    this.canalPoints = sample(layout.trails.canalLocksTrail).map((p) => p.clone().setZ(p.z - 6));

    // Coarse corridor grid: heightAt is called ~200k times during the
    // build, and brute-force distance checks against ~900 samples per call
    // hang the load. Cells within reach of a trail/road/canal get flagged;
    // exact distances only run inside flagged cells.
    const cs = 6;
    const gw = Math.ceil(TERRAIN.w / cs) + 2;
    const gh = Math.ceil(TERRAIN.h / cs) + 2;
    const gx0 = TERRAIN.cx - TERRAIN.w / 2;
    const gz0 = TERRAIN.cz - TERRAIN.h / 2;
    const grid = new Uint8Array(gw * gh);
    const stamp = (points, bit, reach) => {
      const r = Math.ceil(reach / cs);
      for (const p of points) {
        const cxi = Math.floor((p.x - gx0) / cs);
        const czi = Math.floor((p.z - gz0) / cs);
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const xi = cxi + dx;
            const zi = czi + dz;
            if (xi >= 0 && xi < gw && zi >= 0 && zi < gh) grid[zi * gw + xi] |= bit;
          }
        }
      }
    };
    stamp(this.protectPoints, 1, 9);
    stamp(this.roadPoints, 2, 11);
    stamp(this.canalPoints, 4, 9);
    this.corridor = { grid, gw, gh, gx0, gz0, cs };
  }

  corridorFlags(x, z) {
    const c = this.corridor;
    if (!c) return 0;
    const xi = Math.floor((x - c.gx0) / c.cs);
    const zi = Math.floor((z - c.gz0) / c.cs);
    if (xi < 0 || xi >= c.gw || zi < 0 || zi >= c.gh) return 0;
    return c.grid[zi * c.gw + xi];
  }

  buildTerrain(scene) {
    const geo = new THREE.PlaneGeometry(TERRAIN.w, TERRAIN.h, TERRAIN.segs, TERRAIN.segz);
    geo.rotateX(-Math.PI / 2);
    geo.translate(TERRAIN.cx, 0, TERRAIN.cz);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.heightAt(x, z);
      pos.setY(i, h);

      c.setRGB(1, 1, 1);
      // Mud below the waterline.
      if (h < -0.6) c.lerp(new THREE.Color(0.5, 0.44, 0.36), Math.min(1, (-0.6 - h) / 1.2));
      // Forest floor: eastern woods + island interior darker and browner.
      const ew =
        ((x - layout.zones.easternWoods.center[0]) / layout.zones.easternWoods.radii[0]) ** 2 +
        ((z - layout.zones.easternWoods.center[1]) / layout.zones.easternWoods.radii[1]) ** 2;
      const isl =
        ((x - ISLAND.center[0]) / ISLAND.radii[0]) ** 2 + ((z - ISLAND.center[1]) / ISLAND.radii[1]) ** 2;
      const woodsF = Math.max(1 - ew, 1 - isl);
      if (woodsF > 0 && h > -0.4) c.lerp(new THREE.Color(0.62, 0.6, 0.45), Math.min(0.55, woodsF));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = pbrMaterial('Grass001', 90, { vertexColors: true });
    const terrain = new THREE.Mesh(geo, mat);
    terrain.receiveShadow = true;
    terrain.castShadow = true;
    scene.add(terrain);
  }

  buildWater(scene) {
    const mkWater = (w, h, x, z, repeat) => {
      const mat = lambert({
        map: tex.waterTexture(repeat),
        color: 0x96b4c2,
        transparent: true,
        opacity: 0.88,
        roughness: 0.2,
        metalness: 0.08,
      });
      this.waterMaterials.push({ mat, sx: 0.05, sy: 0.004 });
      const geo = new THREE.PlaneGeometry(w, h, 90, 22);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, WATER_Y, z);
      scene.add(mesh);
      return mesh;
    };
    // The Maumee along the whole south edge.
    this.waterMesh = mkWater(TERRAIN.w, 190, 0, 165, 70);
    this.waterBase = this.waterMesh.geometry.attributes.position.array.slice();
    this.waveTime = 0;
    // The slough: still, darker.
    const slough = lambert({ map: tex.waterTexture(20), color: 0x5a6b58, transparent: true, opacity: 0.92, roughness: 0.4 });
    this.waterMaterials.push({ mat: slough, sx: 0.006, sy: 0.002 });
    const sgeo = new THREE.PlaneGeometry(SLOUGH.radii[0] * 2.3, SLOUGH.radii[1] * 2.6);
    sgeo.rotateX(-Math.PI / 2);
    const smesh = new THREE.Mesh(sgeo, slough);
    smesh.position.set(SLOUGH.center[0], -0.55, SLOUGH.center[1]);
    scene.add(smesh);
  }

  // The Riverview hub: parking, pavilion, shelter, playground, furnishings.
  buildHub(scene) {
    const lot = layout.riverviewArea.parking;
    const lotMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(lot.size[0], lot.size[1], 12, 4),
      lambert({ map: tex.parkingLotTexture() })
    );
    lotMesh.rotation.x = -Math.PI / 2;
    lotMesh.position.set(lot.center[0], 0.08, lot.center[1]);
    scene.add(lotMesh);

    this.buildCar(scene, lot.center[0] - 12, lot.center[1] - 2.5, 0.04);
    this.buildCar(scene, lot.center[0] + 8, lot.center[1] - 2.5, -0.05, 0x5a6a78);

    // Rotary Pavilion (bigger shelter) and the Riverview Shelter.
    this.buildShelter(scene, layout.riverviewArea.rotaryPavilion[0], layout.riverviewArea.rotaryPavilion[1]);
    this.buildShelter(scene, layout.riverviewArea.riverviewShelter[0], layout.riverviewArea.riverviewShelter[1]);
    this.buildPlayground(scene, layout.riverviewArea.playground[0], layout.riverviewArea.playground[1]);

    this.buildPicnicTable(scene, -40, -3, 0.4);
    this.buildPicnicTable(scene, -6, 32, 1.3);
    this.buildBench(scene, 6, 48, Math.PI);
    this.buildBench(scene, 60, 60, 2.6);
    this.buildTrashCan(scene, 2, -12);
    this.buildTrashCan(scene, -36, -2);
    this.buildLamppost(scene, 0, -14);
    this.buildLamppost(scene, 16, 36);
    this.buildLamppost(scene, -40, -14);
    this.buildSign(scene, -2, 42);
  }

  buildRoads(scene) {
    // The ribbon's v coordinate already tiles along the length.
    const road = pbrMaterial('Asphalt010', 1);
    this.buildRibbon(scene, [...layout.roads.wayneSt, ...layout.roads.parkDrive.slice(1)], 3.4, road);
  }

  buildTrails(scene) {
    const dirt = pbrMaterial('Ground037', 1);
    for (const key of ['riverview', 'woodDuck', 'canal', 'spur', 'island']) {
      this.buildRibbon(scene, this.trailLines[key], 1.6, dirt);
    }
  }

  buildCrossing(scene) {
    const stoneMat = pbrMaterial('Rock035', 2);
    const [cx0, cz0] = layout.blueGrassIsland.crossing;
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const x = cx0 + Math.sin(i * 2.0) * 1.6;
      const z = THREE.MathUtils.lerp(cz0 - 7, cz0 + 6, t);
      const r = 1.25 + Math.random() * 0.45;
      const stone = new THREE.Mesh(jitterGeometry(new THREE.CylinderGeometry(r, r * 1.2, 2.0, 9), 0.2), stoneMat);
      stone.position.set(x, 0.32 - 1.0, z);
      stone.rotation.y = Math.random() * Math.PI;
      scene.add(stone);
      this.stones.push({ x, z, r, mesh: stone });
    }
  }

  buildLocksAndCanal(scene) {
    const stone = pbrMaterial('Rock035', 3, { side: THREE.DoubleSide });
    for (const lock of layout.canalLocks) {
      const [lx, lz] = lock.pos;
      for (const side of [-1, 1]) {
        const wall = new THREE.Mesh(jitterGeometry(new THREE.BoxGeometry(16, 2.6, 1.3, 6, 2, 1), 0.12), stone);
        wall.position.set(lx, this.heightAt(lx, lz) + 0.7, lz + side * 3.1);
        wall.rotation.y = 0.12;
        scene.add(wall);
      }
    }
    this.buildSign(scene, layout.canalLocks[0].pos[0] + 6, layout.canalLocks[0].pos[1] + 5);
  }

  buildForest(scene) {
    // Placement by real zones (eastern woods, island, riverbank fringe,
    // open field), species mixing shared with scatterTrees below.
    const spots = [];
    const add = (x, z) => spots.push([x, z]);
    const ew = layout.zones.easternWoods;
    let placed = 0;
    let tries = 0;
    while (placed < 420 && tries < 12000) {
      tries++;
      const x = ew.center[0] + (Math.random() * 2 - 1) * ew.radii[0];
      const z = ew.center[1] + (Math.random() * 2 - 1) * ew.radii[1];
      const e = ((x - ew.center[0]) / ew.radii[0]) ** 2 + ((z - ew.center[1]) / ew.radii[1]) ** 2;
      if (e > 1) continue;
      if (this.heightAt(x, z) < -0.3) continue;
      if (World.distanceToPoints(this.protectPoints, x, z) < 2.6) continue;
      add(x, z);
      placed++;
    }
    // Island woods.
    placed = 0;
    tries = 0;
    while (placed < 220 && tries < 8000) {
      tries++;
      const x = ISLAND.center[0] + (Math.random() * 2 - 1) * ISLAND.radii[0];
      const z = ISLAND.center[1] + (Math.random() * 2 - 1) * ISLAND.radii[1];
      if (this.heightAt(x, z) < 0.1) continue;
      if (World.distanceToPoints(this.protectPoints, x, z) < 2.6) continue;
      if (this.towerPosition.distanceTo(new THREE.Vector3(x, 0, z)) < 13) continue;
      add(x, z);
      placed++;
    }
    // Riverbank fringe + scattered field oaks.
    for (let i = 0; i < 90; i++) {
      const x = THREE.MathUtils.lerp(-320, 300, Math.random());
      const z = bankZ(x) - 6 - Math.random() * 16;
      if (World.distanceToPoints(this.protectPoints, x, z) < 3) continue;
      add(x, z);
    }
    for (let i = 0; i < 60; i++) {
      const x = THREE.MathUtils.lerp(-300, 280, Math.random());
      const z = THREE.MathUtils.lerp(-160, 40, Math.random());
      const r = this.hubRect;
      if (x > r.x0 - 6 && x < r.x1 + 6 && z > r.z0 - 6 && z < r.z1 + 6) continue;
      if (World.distanceToPoints(this.roadPoints, x, z) < 7) continue;
      if (World.distanceToPoints(this.protectPoints, x, z) < 3) continue;
      if (this.heightAt(x, z) < -0.3) continue;
      add(x, z);
    }
    this.scatterTrees(scene, spots);
  }

  // Species mixing shared with v1 visuals (trunks, pines, oaks, sycamores).
  scatterTrees(scene, spots) {
    const saveBands = { i: 0 };
    const trunkGeos = [];
    const paleTrunkGeos = [];
    const pineGeos = [];
    const oakGeos = [];
    const tintGeo = (geo, base) => {
      const c = base.clone().offsetHSL((Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.1);
      const n = geo.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    };
    const pineGreen = new THREE.Color(0x2f4226);
    const oakGreen = new THREE.Color(0x4a5c30);
    const sycGreen = new THREE.Color(0x6a7838);

    for (const [x, z] of spots) {
      const y = this.heightAt(x, z);
      const roll = Math.random();
      if (roll < 0.45) {
        const height = 6.5 + Math.random() * 5;
        const lean = (Math.random() - 0.5) * 0.5;
        const trunk = new THREE.CylinderGeometry(0.2, 0.4, height, 7);
        jitterGeometry(trunk, 0.1);
        trunk.translate(x + lean, y + height / 2 - 0.3, z);
        trunkGeos.push(trunk);
        const tiers = 4 + Math.floor(Math.random() * 2);
        for (let c2 = 0; c2 < tiers; c2++) {
          const f = c2 / tiers;
          const r = (2.6 - f * 1.7) * (0.85 + Math.random() * 0.4);
          const cone = new THREE.ConeGeometry(r, 3.2 - f, 9);
          jitterGeometry(cone, r * 0.2);
          cone.translate(x + lean * (1 + f), y + height * 0.42 + c2 * 2.0, z);
          tintGeo(cone, pineGreen);
          pineGeos.push(cone);
        }
      } else if (roll < 0.78) {
        const height = 3.5 + Math.random() * 2.5;
        const trunk = new THREE.CylinderGeometry(0.24, 0.48, height, 7);
        jitterGeometry(trunk, 0.12);
        trunk.translate(x, y + height / 2 - 0.3, z);
        trunkGeos.push(trunk);
        const blobs = 3 + Math.floor(Math.random() * 3);
        for (let b = 0; b < blobs; b++) {
          const blob = new THREE.IcosahedronGeometry(1.4 + Math.random() * 1.1, 1);
          blob.scale(1 + Math.random() * 0.6, 0.7 + Math.random() * 0.4, 1 + Math.random() * 0.6);
          jitterGeometry(blob, 0.3);
          blob.translate(x + (Math.random() - 0.5) * 2.4, y + height + (Math.random() - 0.5) * 1.4, z + (Math.random() - 0.5) * 2.4);
          tintGeo(blob, oakGreen);
          oakGeos.push(blob);
        }
      } else {
        const height = 8 + Math.random() * 4.5;
        const lean = (Math.random() - 0.5) * 0.8;
        const trunk = new THREE.CylinderGeometry(0.2, 0.38, height, 7);
        jitterGeometry(trunk, 0.12);
        trunk.translate(x + lean, y + height / 2 - 0.3, z);
        paleTrunkGeos.push(trunk);
        const blobs = 3 + Math.floor(Math.random() * 2);
        for (let b = 0; b < blobs; b++) {
          const blob = new THREE.IcosahedronGeometry(1.7 + Math.random() * 1.3, 1);
          blob.scale(1.2 + Math.random() * 0.5, 0.6 + Math.random() * 0.3, 1.2 + Math.random() * 0.5);
          jitterGeometry(blob, 0.35);
          blob.translate(x + lean * 2 + (Math.random() - 0.5) * 3.4, y + height - 1 + (Math.random() - 0.5) * 2.2, z + (Math.random() - 0.5) * 3.4);
          tintGeo(blob, sycGreen);
          oakGeos.push(blob);
        }
      }
    }
    if (trunkGeos.length) {
      const m = new THREE.Mesh(mergeGeometries(trunkGeos), pbrMaterial('Bark012', 1));
      m.castShadow = true;
      scene.add(m);
    }
    if (paleTrunkGeos.length) {
      scene.add(new THREE.Mesh(mergeGeometries(paleTrunkGeos), lambert({ map: tex.sycamoreBarkTexture(1) })));
    }
    if (pineGeos.length) {
      scene.add(new THREE.Mesh(mergeGeometries(pineGeos), lambert({ map: tex.foliageTexture(2), color: 0xffffff, vertexColors: true })));
    }
    if (oakGeos.length) {
      scene.add(new THREE.Mesh(mergeGeometries(oakGeos), lambert({ map: tex.foliageTexture(3), color: 0xffffff, vertexColors: true })));
    }
    void saveBands;
  }

  buildMist(scene) {
    this.mist = [];
    const mat = new THREE.MeshBasicMaterial({ map: tex.mistTexture(), transparent: true, opacity: 0.16, depthWrite: false });
    for (let i = 0; i < 24; i++) {
      const overRiver = i % 2 === 0;
      const x = THREE.MathUtils.lerp(-300, 280, Math.random());
      const z = overRiver
        ? bankZ(x) + 14 + Math.random() * 50
        : layout.zones.easternWoods.center[1] + (Math.random() - 0.5) * 90;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(16 + Math.random() * 10, 4.5), mat);
      m.position.set(x, Math.max(this.heightAt(x, z), WATER_Y) + 1.1, z);
      scene.add(m);
      this.mist.push({ m, speed: 0.25 + Math.random() * 0.4, phase: Math.random() * 10 });
    }
  }

  buildFireflies(scene) {
    const N = 130;
    const pos = new Float32Array(N * 3);
    this.fireflyBase = new Float32Array(N * 3);
    this.fireflyPhase = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const inWoods = Math.random() < 0.6;
      const cx = inWoods ? layout.zones.easternWoods.center[0] : ISLAND.center[0];
      const cz = inWoods ? layout.zones.easternWoods.center[1] : ISLAND.center[1];
      const rx = inWoods ? layout.zones.easternWoods.radii[0] : ISLAND.radii[0];
      const rz = inWoods ? layout.zones.easternWoods.radii[1] : ISLAND.radii[1];
      const x = cx + (Math.random() * 2 - 1) * rx;
      const z = cz + (Math.random() * 2 - 1) * rz;
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

  // ----- queries ------------------------------------------------------------
  surfaceAt(x, z) {
    if (x > 400) return 'wetstone';
    for (const s of this.stones) {
      const dx = x - s.x;
      const dz = z - s.z;
      if (dx * dx + dz * dz < s.r * s.r) return 'wetstone';
    }
    if (this.heightAt(x, z) < -0.5) return 'water';
    const lot = layout.riverviewArea.parking;
    if (Math.abs(x - lot.center[0]) < lot.size[0] / 2 && Math.abs(z - lot.center[1]) < lot.size[1] / 2) return 'asphalt';
    if (this.roadPoints && World.distanceToPoints(this.roadPoints, x, z) < 3.4) return 'asphalt';
    if (this.protectPoints && World.distanceToPoints(this.protectPoints, x, z) < 1.8) return 'dirt';
    return 'grass';
  }

  riverProximity(x, z) {
    if (x > 400) return 0;
    const d = Math.max(0, bankZ(x) - z);
    return THREE.MathUtils.clamp(1 - d / 50, 0, 1);
  }

  windLevel(x, z) {
    if (x > 400) return 0;
    const ew = layout.zones.easternWoods;
    const inWoods =
      ((x - ew.center[0]) / ew.radii[0]) ** 2 + ((z - ew.center[1]) / ew.radii[1]) ** 2 < 1 ||
      ((x - ISLAND.center[0]) / ISLAND.radii[0]) ** 2 + ((z - ISLAND.center[1]) / ISLAND.radii[1]) ** 2 < 1;
    return inWoods ? 1 : 0.5;
  }
}
