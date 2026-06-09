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
    this.parkPathPoints = []; // sampled north-bank path, parking lot -> crossing
    this.waterMaterials = [];
    // Spawn in the Riverview Area parking lot.
    this.spawn = new THREE.Vector3(14, 0, -101);
    this.towerPosition = new THREE.Vector3(152, 0, 58);
  }

  build(scene) {
    this.buildAtmosphere(scene);
    this.buildTerrain(scene);
    this.buildParkArea(scene);
    this.buildCrossing(scene);
    this.buildPaths(scene);
    this.buildBoulders(scene);
    this.buildForest(scene);
    this.buildBeachAndTower(scene);
  }

  buildAtmosphere(scene) {
    // Deep sunset: orange light bleeding through purple haze, short draw
    // distance so the world dissolves before its edges show.
    const horizon = new THREE.Color(0xc46a47);
    scene.background = horizon;
    scene.fog = new THREE.Fog(horizon, 25, 140);

    scene.add(new THREE.HemisphereLight(0xffb070, 0x4a3b5c, 1.5));

    const sun = new THREE.DirectionalLight(0xffa050, 2.0);
    sun.position.set(-80, 30, -30); // low in the west
    scene.add(sun);
  }

  buildTerrain(scene) {
    const grassMat = lambert({ map: tex.grassTexture(60) });
    const floorMat = lambert({ map: tex.forestFloorTexture(50) });
    const waterMat = lambert({ map: tex.waterTexture(80) });
    this.waterMaterials.push(waterMat);

    // Large surfaces are subdivided so the affine texture warp stays local —
    // PSX hardware had the same problem and games tessellated for the same reason.
    const northBank = new THREE.Mesh(new THREE.PlaneGeometry(520, 110, 52, 11), grassMat);
    northBank.rotation.x = -Math.PI / 2;
    northBank.position.set(0, BANK_Y, -105);
    scene.add(northBank);

    // South bank strip, mostly swallowed by fog across the river.
    const southBank = new THREE.Mesh(new THREE.PlaneGeometry(520, 30, 52, 3), grassMat);
    southBank.rotation.x = -Math.PI / 2;
    southBank.position.set(0, BANK_Y, 152);
    scene.add(southBank);

    // The island: dense forest floor between the two channels.
    const islandBand = bands.blue_grass_island;
    const island = new THREE.Mesh(
      new THREE.PlaneGeometry(
        islandBand.x[1] - islandBand.x[0],
        islandBand.z[1] - islandBand.z[0],
        38, 11
      ),
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
    const water = new THREE.Mesh(new THREE.PlaneGeometry(520, 200, 52, 20), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, WATER_Y, 45);
    scene.add(water);
  }

  // The Riverview Area from the map: parking lot, one lone car, the picnic
  // shelter, and the playground. This is where the player starts.
  buildParkArea(scene) {
    // Parking lot with painted stalls along its north edge.
    const lot = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 12, 10, 4),
      lambert({ map: tex.parkingLotTexture() })
    );
    lot.rotation.x = -Math.PI / 2;
    lot.position.set(15, 0.1, -106);
    scene.add(lot);

    // Driveway running north into the fog, implying the road out.
    const driveway = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 40, 2, 13),
      lambert({ map: tex.asphaltTexture(10) })
    );
    driveway.rotation.x = -Math.PI / 2;
    driveway.position.set(15, 0.09, -132);
    scene.add(driveway);

    this.buildCar(scene, 8, -109.3, 0.06);
    this.buildShelter(scene, 6, -88);
    this.buildPlayground(scene, -16, -94);
  }

  buildCar(scene, x, z, rotY) {
    const car = new THREE.Group();
    const bodyMat = lambert({ color: 0xb0a487 }); // dusty beige sedan
    const glassMat = lambert({ color: 0x2e3a40 });
    const wheelMat = lambert({ color: 0x1d1d1f });

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.0, 4.4), bodyMat);
    body.position.y = 0.8;
    car.add(body);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.75, 2.2), glassMat);
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
    const slab = new THREE.Mesh(new THREE.PlaneGeometry(9, 7), lambert({ map: tex.concreteTexture(4) }));
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

    const roof = new THREE.Mesh(new THREE.ConeGeometry(6.4, 2.2, 4), lambert({ color: 0x5e4632 }));
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
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.1, 1.3, 4), accentMat);
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

  // Builds a flat dirt ribbon along a 2D polyline; returns the sampled points
  // so callers can use them for tree avoidance and, later, chase AI.
  buildRibbon(scene, points2d, halfWidth, material) {
    const curve = new THREE.CatmullRomCurve3(
      points2d.map(([x, z]) => new THREE.Vector3(x, 0, z))
    );
    const samples = Math.max(60, Math.round(curve.getLength() * 1.2));
    const sampled = [];
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const p = curve.getPoint(t);
      sampled.push(p);
      const tangent = curve.getTangent(t);
      const nx = -tangent.z;
      const nz = tangent.x;
      positions.push(p.x + nx * halfWidth, 0.12, p.z + nz * halfWidth);
      positions.push(p.x - nx * halfWidth, 0.12, p.z - nz * halfWidth);
      const v = (t * curve.getLength()) / 4;
      uvs.push(0, v, 1, v);
      if (i < samples) {
        const a = i * 2;
        // Wound counterclockwise seen from above so the faces point up.
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, material));
    return sampled;
  }

  buildPaths(scene) {
    const dirtMat = lambert({ map: tex.dirtTexture(1) });

    // Park side: from the parking lot, past the playground, to the crossing.
    this.parkPathPoints = this.buildRibbon(
      scene,
      [[2, -101], [-20, -92], [-48, -78], [-75, -62], [-92, -52], [-99, -47]],
      1.8,
      dirtMat
    );

    // Island side: from the crossing landing, winding east to the beach and tower.
    this.pathPoints = this.buildRibbon(
      scene,
      [
        [-100, -8], [-78, 8], [-42, 26], [-5, 16], [35, 42],
        [78, 24], [112, 48], [140, 56], [152, 58],
      ],
      2.0,
      dirtMat
    );
  }

  // Low-poly rocks: wayfinding markers along both paths plus natural scatter.
  // They are solid — getGroundHeight treats them as plateaus, so small ones
  // can be stepped onto and large ones physically block the player.
  buildBoulders(scene) {
    this.boulders = []; // {x, z, r, top}
    const geos = [];

    const addBoulder = (x, z, r, baseY) => {
      const geo = new THREE.IcosahedronGeometry(r, 0);
      geo.scale(1, 0.65, 1);
      geo.rotateY(Math.random() * Math.PI * 2);
      geo.translate(x, baseY + r * 0.4, z);
      geos.push(geo);
      this.boulders.push({ x, z, r, top: baseY + r * 0.62 });
    };

    // Markers along the path edges, alternating sides every ~12 meters.
    const lineTrail = (points, halfWidth, baseY) => {
      const stride = 14;
      for (let i = stride; i < points.length - stride; i += stride) {
        const side = (i / stride) % 2 === 0 ? 1 : -1;
        const tangent = points[i + 1].clone().sub(points[i - 1]).normalize();
        const off = halfWidth + 0.9 + Math.random() * 0.5;
        addBoulder(
          points[i].x - tangent.z * off * side,
          points[i].z + tangent.x * off * side,
          0.45 + Math.random() * 0.35,
          baseY
        );
      }
    };
    lineTrail(this.parkPathPoints, 1.8, 0);
    lineTrail(this.pathPoints, 2.0, 0.05);

    // Natural scatter on the north bank, clear of the built-up park area.
    let placed = 0;
    while (placed < 18) {
      const x = THREE.MathUtils.lerp(-240, 240, Math.random());
      const z = THREE.MathUtils.lerp(-145, -58, Math.random());
      if (x > -32 && x < 36 && z > -118 && z < -80) continue;
      if (World.distanceToPoints(this.parkPathPoints, x, z) < 4) continue;
      addBoulder(x, z, 0.6 + Math.random() * 1.1, 0);
      placed++;
    }

    // Scatter through the island forest and along its shorelines.
    const island = bands.blue_grass_island;
    placed = 0;
    while (placed < 34) {
      const x = THREE.MathUtils.lerp(island.x[0] + 2, island.x[1] - 2, Math.random());
      const z = THREE.MathUtils.lerp(island.z[0] + 2, island.z[1] - 2, Math.random());
      if (this.distanceToPath(x, z) < 4) continue;
      if (this.towerPosition.distanceTo(new THREE.Vector3(x, 0, z)) < 10) continue;
      addBoulder(x, z, 0.5 + Math.random() * 1.3, 0.05);
      placed++;
    }

    scene.add(new THREE.Mesh(mergeGeometries(geos), lambert({ map: tex.riverRockTexture(2) })));
  }

  static distanceToPoints(points, x, z) {
    let min = Infinity;
    for (const p of points) {
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < min) min = d;
    }
    return Math.sqrt(min);
  }

  distanceToPath(x, z) {
    return World.distanceToPoints(this.pathPoints, x, z);
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

    // Sparse parkland trees on the north bank, clear of the Riverview Area,
    // the driveway, and the path down to the crossing.
    let bankPlaced = 0;
    let bankAttempts = 0;
    while (bankPlaced < 32 && bankAttempts < 1500) {
      bankAttempts++;
      const x = THREE.MathUtils.lerp(-250, 250, Math.random());
      const z = THREE.MathUtils.lerp(-145, -58, Math.random());
      if (x > -32 && x < 36 && z > -118 && z < -80) continue; // lot/shelter/playground
      if (x > 9 && x < 21 && z < -110) continue; // driveway
      if (World.distanceToPoints(this.parkPathPoints, x, z) < 3.5) continue;
      addTree(x, z);
      bankPlaced++;
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
