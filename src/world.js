import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyRetroMaterial } from './retro.js';
import * as tex from './textures.js';
import mapData from './data/map.json';

// The map JSON is authored in a 1000x600 top-down grid; the world uses
// half-scale meters with the grid centered at the origin (map y -> world z).
const S = 0.5;
const mapToWorld = (mx, my) => new THREE.Vector2((mx - 500) * S, (my - 300) * S);

// Zone bands from the map, converted once to world-space z ranges.
const bands = {};
for (const zone of mapData.zones) {
  bands[zone.id] = {
    z: [zone.boundaries.y[0], zone.boundaries.y[1]].map((y) => (y - 300) * S),
    x: [zone.boundaries.x[0], zone.boundaries.x[1]].map((x) => (x - 500) * S),
  };
}

const BANK_Y = 0;
const RIVERBED_Y = -1.4;
const WATER_Y = -0.8;
const STONE_TOP_Y = 0.35;

function lambert(opts) {
  return applyRetroMaterial(new THREE.MeshLambertMaterial(opts));
}

export class World {
  constructor() {
    this.stones = []; // walkable crossing stones: {x, z, r}
    this.pathPoints = []; // sampled island footpath, for tree avoidance + AI later
    this.waterMaterials = [];
    this.spawn = new THREE.Vector3(-55, 0, -70);
    this.towerPosition = new THREE.Vector3(152, 0, 58);
  }

  build(scene) {
    this.buildAtmosphere(scene);
    this.buildTerrain(scene);
    this.buildCrossing(scene);
    this.buildPath(scene);
    this.buildForest(scene);
    this.buildBeachAndTower(scene);
  }

  buildAtmosphere(scene) {
    // Deep sunset: orange light bleeding through purple haze, short draw
    // distance so the world dissolves before its edges show.
    const horizon = new THREE.Color(0xb35c47);
    scene.background = horizon;
    scene.fog = new THREE.Fog(horizon, 10, 70);

    scene.add(new THREE.HemisphereLight(0xcc7a4d, 0x3a2d4d, 0.9));

    const sun = new THREE.DirectionalLight(0xff7733, 1.4);
    sun.position.set(-80, 18, -30); // low in the west
    scene.add(sun);
  }

  buildTerrain(scene) {
    const grassMat = lambert({ map: tex.grassTexture(60) });
    const floorMat = lambert({ map: tex.forestFloorTexture(50) });
    const waterMat = lambert({ map: tex.waterTexture(80) });
    this.waterMaterials.push(waterMat);

    // North bank parkland.
    const northBank = new THREE.Mesh(new THREE.PlaneGeometry(520, 110), grassMat);
    northBank.rotation.x = -Math.PI / 2;
    northBank.position.set(0, BANK_Y, -105);
    scene.add(northBank);

    // South bank strip, mostly swallowed by fog across the river.
    const southBank = new THREE.Mesh(new THREE.PlaneGeometry(520, 30), grassMat);
    southBank.rotation.x = -Math.PI / 2;
    southBank.position.set(0, BANK_Y, 152);
    scene.add(southBank);

    // The island: dense forest floor between the two channels.
    const islandBand = bands.blue_grass_island;
    const island = new THREE.Mesh(
      new THREE.PlaneGeometry(islandBand.x[1] - islandBand.x[0], islandBand.z[1] - islandBand.z[0]),
      floorMat
    );
    island.rotation.x = -Math.PI / 2;
    island.position.set(
      (islandBand.x[0] + islandBand.x[1]) / 2,
      BANK_Y + 0.05,
      (islandBand.z[0] + islandBand.z[1]) / 2
    );
    scene.add(island);

    // One broad water sheet under everything between the banks; the island
    // plane sits on top of it.
    const water = new THREE.Mesh(new THREE.PlaneGeometry(520, 200), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, WATER_Y, 45);
    scene.add(water);
  }

  buildCrossing(scene) {
    // Large flat river stones spanning the north channel near Western Point.
    const stoneMat = lambert({ map: tex.riverRockTexture(2) });
    const startZ = bands.river_north_channel.z[0] + 1.5;
    const endZ = bands.river_north_channel.z[1] - 1.0;
    const count = 9;
    const crossingX = -100;

    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const x = crossingX + Math.sin(i * 2.1) * 2.2;
      const z = THREE.MathUtils.lerp(startZ, endZ, t);
      const r = 1.3 + Math.random() * 0.5;
      const stone = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.15, 1.7, 7), stoneMat);
      stone.position.set(x, STONE_TOP_Y - 0.85, z);
      stone.rotation.y = Math.random() * Math.PI;
      scene.add(stone);
      this.stones.push({ x, z, r });
    }
  }

  buildPath(scene) {
    // Narrow dirt footpath winding from the crossing landing to the east beach.
    const curve = new THREE.CatmullRomCurve3(
      [
        [-100, -8], [-78, 8], [-42, 26], [-5, 16], [35, 42],
        [78, 24], [112, 48], [140, 56], [152, 58],
      ].map(([x, z]) => new THREE.Vector3(x, 0, z))
    );

    const samples = 240;
    const positions = [];
    const uvs = [];
    const indices = [];
    const halfWidth = 1.6;

    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const p = curve.getPoint(t);
      this.pathPoints.push(p);
      const tangent = curve.getTangent(t);
      const nx = -tangent.z;
      const nz = tangent.x;
      positions.push(p.x + nx * halfWidth, 0.12, p.z + nz * halfWidth);
      positions.push(p.x - nx * halfWidth, 0.12, p.z - nz * halfWidth);
      uvs.push(0, t * 60, 1, t * 60);
      if (i < samples) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, lambert({ map: tex.dirtTexture(1) })));
  }

  distanceToPath(x, z) {
    let min = Infinity;
    for (const p of this.pathPoints) {
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < min) min = d;
    }
    return Math.sqrt(min);
  }

  buildForest(scene) {
    const trunkGeos = [];
    const canopyGeos = [];

    const addTree = (x, z) => {
      const height = 6 + Math.random() * 5;
      const trunk = new THREE.CylinderGeometry(0.22, 0.35, height, 5);
      trunk.translate(x, height / 2, z);
      trunkGeos.push(trunk);
      // Two stacked cones for a chunky low-poly canopy.
      for (let c = 0; c < 2; c++) {
        const r = 2.4 - c * 0.9 + Math.random() * 0.6;
        const cone = new THREE.ConeGeometry(r, 4 - c, 6);
        cone.translate(x, height * 0.55 + c * 2.4, z);
        canopyGeos.push(cone);
      }
    };

    // Dense forest on the island, kept clear of the footpath and the tower.
    const island = bands.blue_grass_island;
    let placed = 0;
    let attempts = 0;
    while (placed < 230 && attempts < 4000) {
      attempts++;
      const x = THREE.MathUtils.lerp(island.x[0] + 3, island.x[1] - 3, Math.random());
      const z = THREE.MathUtils.lerp(island.z[0] + 3, island.z[1] - 3, Math.random());
      if (this.distanceToPath(x, z) < 3.2) continue;
      if (this.towerPosition.distanceTo(new THREE.Vector3(x, 0, z)) < 14) continue;
      addTree(x, z);
      placed++;
    }

    // Sparse parkland trees on the north bank.
    for (let i = 0; i < 28; i++) {
      addTree(
        THREE.MathUtils.lerp(-250, 250, Math.random()),
        THREE.MathUtils.lerp(-145, -58, Math.random())
      );
    }

    scene.add(new THREE.Mesh(mergeGeometries(trunkGeos), lambert({ map: tex.barkTexture(1) })));
    scene.add(
      new THREE.Mesh(mergeGeometries(canopyGeos), lambert({ color: 0x2d3b22 }))
    );
  }

  buildBeachAndTower(scene) {
    // Round river-rock beach where the path meets the eastern shore.
    const beach = new THREE.Mesh(
      new THREE.CircleGeometry(20, 14),
      lambert({ map: tex.riverRockTexture(8) })
    );
    beach.rotation.x = -Math.PI / 2;
    beach.position.set(this.towerPosition.x + 6, 0.18, this.towerPosition.z + 2);
    scene.add(beach);

    // The tower: rings of stacked flat river stones, slightly irregular so
    // the silhouette reads as hand-piled rather than machined.
    const stoneMat = lambert({ map: tex.stoneTexture(6) });
    const rings = 15;
    const baseRadius = 4.2;
    for (let i = 0; i < rings; i++) {
      const radius = baseRadius * (1 - i * 0.012) + (Math.random() - 0.5) * 0.18;
      const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, 1.5, 10, 1, true),
        stoneMat
      );
      ring.position.set(
        this.towerPosition.x + (Math.random() - 0.5) * 0.15,
        0.6 + i * 1.22,
        this.towerPosition.z + (Math.random() - 0.5) * 0.15
      );
      ring.rotation.y = Math.random() * Math.PI;
      scene.add(ring);
    }

    // Dark doorway facing the beach — the way down comes in a later phase.
    const doorway = new THREE.Mesh(
      new THREE.PlaneGeometry(1.8, 3),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    doorway.position.set(this.towerPosition.x + baseRadius * 0.99, 1.5, this.towerPosition.z + 1.2);
    doorway.rotation.y = Math.PI / 2;
    scene.add(doorway);
  }

  /** Walkable ground height at (x, z) — the player controller's only physics query. */
  getGroundHeight(x, z) {
    for (const s of this.stones) {
      const dx = x - s.x;
      const dz = z - s.z;
      if (dx * dx + dz * dz < s.r * s.r) return STONE_TOP_Y;
    }
    const island = bands.blue_grass_island;
    if (z < bands.river_north_channel.z[0]) return BANK_Y;
    if (z < bands.river_north_channel.z[1]) return RIVERBED_Y;
    if (z < bands.river_south_channel.z[0]) {
      return x >= island.x[0] && x <= island.x[1] ? BANK_Y + 0.05 : RIVERBED_Y;
    }
    if (z < bands.river_south_channel.z[1]) return RIVERBED_Y;
    return BANK_Y;
  }

  update(dt) {
    // Slow texture scroll sells the river current.
    for (const mat of this.waterMaterials) {
      if (mat.map) mat.map.offset.x += dt * 0.018;
    }
  }
}
