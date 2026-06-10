import * as THREE from 'three';
import { jitterGeometry, lambert } from './world.js';
import * as tex from './textures.js';

const STATE_IDLE = 0;
const STATE_ENCOUNTER = 1;
const STATE_CHASE = 2;

export class NotDeer extends THREE.Group {
  constructor() {
    super();

    this.state = STATE_IDLE;
    this.encounterTimer = 0;
    this.twitchTimer = 0;
    this.velocity = new THREE.Vector3();
    this.onChaseStarted = null;

    // Lanky, uncanny body
    const mat = lambert({ color: 0x241d18, flatShading: true });
    // Use bark for a twisted texture
    const skinMat = lambert({ map: tex.barkTexture(1), flatShading: true });

    // Torso
    this.torso = new THREE.Mesh(
      jitterGeometry(new THREE.CylinderGeometry(0.3, 0.4, 2.8, 6), 0.1),
      skinMat
    );
    this.torso.rotation.z = Math.PI / 2;
    this.torso.position.y = 1.8;
    this.add(this.torso);

    // Neck
    this.neck = new THREE.Mesh(
      jitterGeometry(new THREE.CylinderGeometry(0.15, 0.25, 1.8, 5), 0.1),
      skinMat
    );
    this.neck.position.set(1.2, 2.5, 0);
    this.neck.rotation.z = -Math.PI / 6;
    this.add(this.neck);

    // Head (twisted skull-like)
    this.head = new THREE.Mesh(
      jitterGeometry(new THREE.BoxGeometry(0.4, 0.5, 0.8), 0.15),
      lambert({ color: 0x8f8c85, flatShading: true }) // Bone colored
    );
    this.head.position.set(1.8, 3.2, 0);
    
    // Glowing Red Eyes
    const eyeGeo = new THREE.SphereGeometry(0.06, 8, 8);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xff0000, emissive: 0xff0000, emissiveIntensity: 3.0 });
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(0.18, 0.1, 0.2);
    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.18, 0.1, -0.2);
    this.head.add(leftEye);
    this.head.add(rightEye);
    
    // Face Glow
    const faceLight = new THREE.PointLight(0xff0000, 2.0, 4);
    faceLight.position.set(0.3, 0, 0);
    this.head.add(faceLight);

    // Twisted Antlers
    const antlerMat = lambert({ map: tex.barkTexture(2), color: 0x332222 });
    const addAntlerBranch = (parent, x, y, z, rx, rz, scale) => {
      const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.04 * scale, 0.08 * scale, 1.2 * scale, 5), antlerMat);
      branch.position.set(x, y, z);
      branch.rotation.x = rx;
      branch.rotation.z = rz;
      parent.add(branch);
      return branch;
    };
    
    // Left Antler System
    const leftBase = addAntlerBranch(this.head, -0.1, 0.5, 0.25, 0.2, -0.4, 1.0);
    addAntlerBranch(leftBase, 0, 0.4, 0.2, 0.5, 0.2, 0.6);
    addAntlerBranch(leftBase, 0, 0.7, -0.1, -0.3, -0.2, 0.4);
    
    // Right Antler System (Asymmetric)
    const rightBase = addAntlerBranch(this.head, -0.1, 0.6, -0.25, -0.3, -0.5, 1.1);
    addAntlerBranch(rightBase, 0, 0.5, -0.2, -0.6, 0.1, 0.7);
    addAntlerBranch(rightBase, 0, 0.2, 0.1, 0.4, -0.3, 0.5);

    this.add(this.head);

    // Legs
    this.legs = [];
    for (const x of [-1.0, 1.0]) {
      for (const z of [-0.4, 0.4]) {
        const leg = new THREE.Mesh(
          jitterGeometry(new THREE.CylinderGeometry(0.08, 0.05, 2.2, 4), 0.05),
          mat
        );
        leg.position.set(x, 1.1, z);
        this.add(leg);
        this.legs.push({ mesh: leg, baseX: x, baseZ: z });
      }
    }

    this.basePositions = {
      neck: this.neck.position.clone(),
      head: this.head.position.clone(),
      torsoRot: this.torso.rotation.clone(),
    };
  }

  update(dt, player, world, audio) {
    const pPos = player.yawObject.position;
    const dist = this.position.distanceTo(pPos);

    // Procedural twitching
    this.twitchTimer += dt;
    if (this.twitchTimer > 0.05) {
      this.twitchTimer = 0;
      const noise = () => (Math.random() - 0.5) * 0.1;
      const intense = this.state === STATE_CHASE ? 2.5 : 1.0;
      
      this.neck.position.x = this.basePositions.neck.x + noise() * intense;
      this.neck.position.y = this.basePositions.neck.y + noise() * intense;
      
      this.head.position.x = this.basePositions.head.x + noise() * intense;
      this.head.position.y = this.basePositions.head.y + noise() * intense;
      this.head.rotation.y = noise() * intense * 3;
      this.head.rotation.z = noise() * intense * 3;
    }

    if (this.state === STATE_IDLE) {
      // Occasional clicking
      if (Math.random() < dt * 0.2 && dist < 60) {
        audio.creatureNoise(1 - Math.min(dist / 60, 1));
      }

      // Look at player loosely
      const targetAngle = Math.atan2(pPos.x - this.position.x, pPos.z - this.position.z);
      this.rotation.y += (targetAngle - this.rotation.y) * dt * 2;
    } else if (this.state === STATE_ENCOUNTER) {
      this.encounterTimer += dt;
      // Stand up and scream phase
      this.torso.rotation.z = THREE.MathUtils.lerp(this.basePositions.torsoRot.z, Math.PI * 0.8, this.encounterTimer / 1.5);
      this.position.y = world.getGroundHeight(this.position.x, this.position.z) + this.encounterTimer * 0.5;

      const targetAngle = Math.atan2(pPos.x - this.position.x, pPos.z - this.position.z);
      this.rotation.y = targetAngle;

      if (this.encounterTimer > 1.8) {
        this.state = STATE_CHASE;
        audio.setMusicMode('chase');
        if (this.onChaseStarted) this.onChaseStarted();
      }
    } else if (this.state === STATE_CHASE) {
      // Run toward player
      const speed = 7.2; // Slightly slower than sprint, faster than walk
      const dir = new THREE.Vector3(pPos.x - this.position.x, 0, pPos.z - this.position.z);
      if (dir.lengthSq() > 1.5 * 1.5) { // Stop slightly before touching
        dir.normalize();
        this.position.x += dir.x * speed * dt;
        this.position.z += dir.z * speed * dt;
        this.rotation.y = Math.atan2(dir.x, dir.z);
      } else {
        // Player caught! (For now, just stop or attack logic)
        // Can optionally trigger a jump scare or game over here
      }

      // Animate legs while running
      const runTime = performance.now() * 0.01;
      this.legs.forEach((legData, i) => {
        const offset = i % 2 === 0 ? 0 : Math.PI;
        legData.mesh.rotation.x = Math.sin(runTime + offset) * 0.8;
      });

      this.position.y = world.getGroundHeight(this.position.x, this.position.z);
    } else {
      this.position.y = world.getGroundHeight(this.position.x, this.position.z);
    }
  }

  reset(spawnPoint) {
    this.state = STATE_IDLE;
    this.encounterTimer = 0;
    this.twitchTimer = 0;
    this.position.copy(spawnPoint);
    this.rotation.set(0, 0, 0);
    this.torso.rotation.copy(this.basePositions.torsoRot);
  }

  triggerEncounter(audio) {
    if (this.state === STATE_IDLE) {
      this.state = STATE_ENCOUNTER;
      this.encounterTimer = 0;
      audio.creatureScream();
    }
  }
}
