import * as THREE from 'three';
import { lambert } from './world.js';
import * as tex from './textures.js';

// Five stick effigies hidden at landmarks around the park and island.
// Collecting all five unseals the tower door. Each one is a teepee of
// twisted sticks with a guttering candle so it can be spotted at dusk,
// plus a faint light pillar as a wayfinding aid.
const SPOTS = [
  { x: -18, z: -97, hint: 'by the playground' },
  { x: -185, z: -138, hint: 'on the sledding hill, across the road' },
  { x: -96, z: -4, hint: 'where the stones meet the island' },
  { x: 35, z: 46, hint: 'at the bend in the forest path' },
  { x: 128, z: 50, hint: 'near the east shore' },
];

export class Effigies {
  constructor(scene, world) {
    this.items = [];
    this.count = 0;
    this.total = SPOTS.length;

    const stickMat = lambert({ map: tex.barkTexture(2), color: 0x6b5742 });
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    for (const spot of SPOTS) {
      const g = new THREE.Group();
      const y = world.getGroundHeight(spot.x, spot.z);

      // Teepee of three crooked sticks bound at the top.
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.045, 1.3, 5), stickMat);
        stick.position.set(Math.cos(a) * 0.22, 0.6, Math.sin(a) * 0.22);
        stick.rotation.z = Math.cos(a) * 0.35;
        stick.rotation.x = -Math.sin(a) * 0.35;
        g.add(stick);
      }
      // A crooked crossbar — the antler line.
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.7, 5), stickMat);
      bar.rotation.z = Math.PI / 2 + 0.2;
      bar.position.y = 1.05;
      g.add(bar);

      // Candle: a tiny glowing nub and a warm flickering light.
      const candle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.045, 0.12, 8),
        new THREE.MeshBasicMaterial({ color: 0xffe2b0 })
      );
      candle.position.y = 0.1;
      g.add(candle);
      const light = new THREE.PointLight(0xffb050, 4, 8, 1.8);
      light.position.y = 0.35;
      g.add(light);

      // Faint vertical beam so the spot reads from a distance.
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.5, 14, 8, 1, true), beamMat);
      beam.position.y = 7;
      g.add(beam);

      g.position.set(spot.x, y, spot.z);
      this.items.push({ group: g, light, collected: false, hint: spot.hint });
    }

    for (const it of this.items) scene.add(it.group);
  }

  get allCollected() {
    return this.count >= this.total;
  }

  /** Returns the hint string when something was just picked up, else null. */
  update(dt, playerPos, audio) {
    const t = performance.now() * 0.004;
    let picked = null;
    for (const it of this.items) {
      if (it.collected) continue;
      it.light.intensity = 3.4 + Math.sin(t * 3 + it.group.position.x) * 0.8 + Math.random() * 0.6;
      const d = it.group.position.distanceTo(playerPos);
      if (d < 2.4) {
        it.collected = true;
        it.group.visible = false;
        this.count++;
        picked = it.hint;
        audio?.effigyPickup?.();
      }
    }
    return picked;
  }
}
