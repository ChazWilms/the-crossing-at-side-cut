import * as THREE from 'three';
import { lambert } from './world.js';

// Four pieces of paper that tell you what happened to the last people who
// followed the stones across. Walking up to one reads it.
const NOTES = [
  {
    x: 8.5,
    z: -86,
    text: 'MISSING — Daniel R., 19. Last seen near the Blue Grass Island crossing, Oct 12. If seen, DO NOT APPROACH.',
  },
  {
    x: -94,
    z: -45,
    text: "Journal, p.1 — The stones line up when the water is low. Dan swears there's a tower on the island. There is no tower on any map.",
  },
  {
    x: 4,
    z: 18,
    text: "Journal, p.2 — Something paced us in the treeline all afternoon. It stepped on the wrong beats. Deer don't do that.",
  },
  {
    x: 146,
    z: 52,
    text: 'Journal, p.3 — It is not a deer. The door under the tower was open when we got here. Dan went down. I am going down after him.',
  },
  {
    x: 497,
    z: -5,
    text: "Journal, p.4 — Found Dan's pack at the bottom. The thing in the dark walks like him now. If you read this: take the stones home and DO NOT look back.",
  },
];

export class Notes {
  constructor(scene, world) {
    this.items = [];
    const paperMat = new THREE.MeshBasicMaterial({ color: 0xd8d2c2, side: THREE.DoubleSide });
    const stakeMat = lambert({ color: 0x4a3a2a });

    for (const n of NOTES) {
      const g = new THREE.Group();
      const y = world.getGroundHeight(n.x, n.z);
      const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.0, 5), stakeMat);
      stake.position.y = 0.5;
      g.add(stake);
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.46), paperMat);
      paper.position.set(0, 0.95, 0.03);
      paper.rotation.y = Math.random() * Math.PI * 2;
      paper.rotation.z = (Math.random() - 0.5) * 0.15;
      g.add(paper);
      g.position.set(n.x, y, n.z);
      scene.add(g);
      this.items.push({ group: g, text: n.text, read: false });
    }
  }

  /** Returns note text when the player walks up to an unread note. */
  update(playerPos) {
    for (const it of this.items) {
      if (it.read) continue;
      if (it.group.position.distanceTo(playerPos) < 2.2) {
        it.read = true;
        return it.text;
      }
    }
    return null;
  }
}
