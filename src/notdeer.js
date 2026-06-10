import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { jitterGeometry, lambert } from './world.js';
import * as tex from './textures.js';

const STATE_IDLE = 0;
const STATE_ENCOUNTER = 1;
const STATE_CHASE = 2;

// The Not-Deer is built on a real animated quadruped (the three.js Horse,
// morph-target run cycle) pushed into the uncanny valley: pitch-black hide,
// stretched too tall and too thin, twisted antlers, forward-facing glowing
// eyes, and an animation that stutters like bad taxidermy given motion.
export class NotDeer extends THREE.Group {
  constructor() {
    super();

    this.state = STATE_IDLE;
    this.encounterTimer = 0;
    this.twitchTimer = 0;
    this.velocity = new THREE.Vector3();
    this.onChaseStarted = null;

    this.mixer = null;
    this.inner = null;
    this.animRate = 0;
    this.jerkTimer = 0;

    // Procedural placeholder so something exists until the model loads.
    this.fallback = this.buildFallback();
    this.add(this.fallback);

    const base = import.meta.env?.BASE_URL ?? '/';
    new GLTFLoader().load(
      base + 'assets/Horse.glb',
      (gltf) => this.buildFromHorse(gltf),
      undefined,
      () => {} // fallback model simply stays if loading fails
    );
  }

  buildFallback() {
    const g = new THREE.Group();
    const skinMat = lambert({ color: 0x141114 });
    const torso = new THREE.Mesh(
      jitterGeometry(new THREE.CylinderGeometry(0.3, 0.4, 2.8, 6), 0.1),
      skinMat
    );
    torso.rotation.z = Math.PI / 2;
    torso.position.y = 1.8;
    g.add(torso);
    for (const x of [-1.0, 1.0]) {
      for (const z of [-0.4, 0.4]) {
        const leg = new THREE.Mesh(
          jitterGeometry(new THREE.CylinderGeometry(0.08, 0.05, 2.2, 4), 0.05),
          skinMat
        );
        leg.position.set(x, 1.1, z);
        g.add(leg);
      }
    }
    return g;
  }

  buildFromHorse(gltf) {
    this.remove(this.fallback);
    this.fallback = null;

    const inner = new THREE.Group();
    const model = gltf.scene;

    // Pitch-black hide that still catches lamp light at the edges.
    model.traverse((o) => {
      if (o.isMesh) {
        o.material = new THREE.MeshStandardMaterial({ color: 0x0d0c0f, roughness: 0.8, metalness: 0.05 });
        o.castShadow = true;
        o.frustumCulled = false; // morph animation can outrun the static bounds
      }
    });

    // Normalize size from the model's own bounds. The body runs along the
    // native Z axis (raw bounds ~105 x 302 x 721).
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const s = 2.1 / size.y;
    // A touch too tall and narrow — deer-but-not, without mangling the
    // morph animation.
    model.scale.set(s * 0.92, s * 1.22, s);
    model.position.y = -box.min.y * s * 1.22;

    // Which end is the head? The head/neck own the tallest vertices, so the
    // average z-sign of the top quarter of the mesh points at the face.
    let headSign = 1;
    model.traverse((o) => {
      if (o.isMesh && o.geometry?.attributes?.position) {
        const p = o.geometry.attributes.position;
        const yCut = box.min.y + size.y * 0.75;
        let zSum = 0;
        let n = 0;
        for (let i = 0; i < p.count; i += 7) {
          if (p.getY(i) > yCut) {
            zSum += p.getZ(i);
            n++;
          }
        }
        if (n > 0) headSign = Math.sign(zSum / n) || 1;
      }
    });
    // Movement steers with rotation.y = atan2(dx, dz): forward must be +z.
    model.rotation.y = headSign > 0 ? 0 : Math.PI;
    inner.add(model);

    // Head rig: glowing eyes, RED NOSE, and twisted antlers seated at the
    // face end of the body.
    const headY = size.y * s * 1.22 * 0.86;
    const headZ = size.z * s * 0.44;
    const headRig = new THREE.Group();
    headRig.position.set(0, headY, headZ);
    const eyeGeo = new THREE.SphereGeometry(0.06, 8, 8);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xff2211, emissive: 0xff1100, emissiveIntensity: 4 });
    for (const ex of [-0.11, 0.11]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(ex, 0, 0.18);
      headRig.add(eye);
    }
    // The nose: a bright red coal at the tip of the snout.
    const nose = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xff1a00, emissive: 0xff1500, emissiveIntensity: 6 })
    );
    nose.position.set(0, -0.14, 0.38);
    headRig.add(nose);
    const glow = new THREE.PointLight(0xff2200, 5, 6, 1.8);
    glow.position.set(0, -0.1, 0.35);
    headRig.add(glow);

    const antlerMat = lambert({ map: tex.barkTexture(2), color: 0x2a2120 });
    const addBranch = (parent, x, y, z, rx, rz, scale) => {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * scale, 0.07 * scale, 1.1 * scale, 5), antlerMat);
      b.position.set(x, y, z);
      b.rotation.x = rx;
      b.rotation.z = rz;
      parent.add(b);
      return b;
    };
    const left = addBranch(headRig, -0.22, 0.5, -0.05, 0.25, -0.5, 1.1);
    addBranch(left, 0, 0.4, 0.15, 0.55, 0.25, 0.65);
    addBranch(left, 0, 0.7, -0.1, -0.35, -0.25, 0.45);
    const right = addBranch(headRig, 0.22, 0.55, -0.05, -0.3, 0.55, 1.2);
    addBranch(right, 0, 0.5, -0.15, -0.6, -0.15, 0.7);
    addBranch(right, 0, 0.25, 0.1, 0.45, 0.3, 0.5);

    inner.add(headRig);
    this.headRig = headRig;

    this.inner = inner;
    this.add(inner);

    this.mixer = new THREE.AnimationMixer(model);
    if (gltf.animations.length) {
      this.runAction = this.mixer.clipAction(gltf.animations[0]);
      this.runAction.play();
    }
    console.log(
      'HORSE LOADED anims:',
      gltf.animations.map((a) => `${a.name}(${a.duration.toFixed(2)}s)`).join(','),
      'size:', size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2)
    );
  }

  update(dt, player, world, audio) {
    const pPos = player.yawObject.position;
    const dist = this.position.distanceTo(pPos);

    // Whole-body twitching: small instantaneous offsets, never smooth.
    this.twitchTimer += dt;
    if (this.twitchTimer > 0.07) {
      this.twitchTimer = 0;
      const intense = this.state === STATE_CHASE ? 2.2 : 1.0;
      const n = () => (Math.random() - 0.5) * 0.05 * intense;
      if (this.inner) {
        this.inner.position.set(n(), Math.abs(n()) * 0.5, n());
        this.inner.rotation.y = n() * 2;
        if (this.headRig) {
          this.headRig.rotation.y = n() * 6;
          this.headRig.rotation.z = n() * 4;
        }
      }
    }

    // The run cycle stutters: it sprints, hitches, freezes for a beat, and
    // lurches again — speed and animation locked together.
    if (this.mixer && this.state === STATE_CHASE) {
      this.jerkTimer -= dt;
      if (this.jerkTimer <= 0) {
        this.animRate = Math.random() < 0.1 ? 0 : 0.5 + Math.random() * 1.9;
        this.jerkTimer = this.animRate === 0 ? 0.12 + Math.random() * 0.1 : 0.2 + Math.random() * 0.5;
      }
      this.mixer.update(dt * this.animRate);
    } else if (this.mixer && this.state === STATE_ENCOUNTER) {
      this.mixer.update(dt * 0.15); // slow, wrong, waking up
    } else if (this.mixer) {
      this.mixer.update(dt * 0.05); // never frozen — it breathes
    }

    if (this.state === STATE_IDLE) {
      if (Math.random() < dt * 0.2 && dist < 60) {
        audio.creatureNoise(1 - Math.min(dist / 60, 1));
      }
      // It is always already facing you.
      const targetAngle = Math.atan2(pPos.x - this.position.x, pPos.z - this.position.z);
      this.rotation.y += (targetAngle - this.rotation.y) * dt * 2;
      this.position.y = world.getGroundHeight(this.position.x, this.position.z);
    } else if (this.state === STATE_ENCOUNTER) {
      this.encounterTimer += dt;
      // Rearing up onto its hind legs, stretching taller than it should.
      const f = Math.min(1, this.encounterTimer / 1.6);
      if (this.inner) {
        this.inner.rotation.x = -f * 0.85;
        this.inner.scale.y = 1 + f * 0.2;
      }
      this.position.y = world.getGroundHeight(this.position.x, this.position.z);

      const targetAngle = Math.atan2(pPos.x - this.position.x, pPos.z - this.position.z);
      this.rotation.y = targetAngle;

      if (this.encounterTimer > 1.8) {
        this.state = STATE_CHASE;
        if (this.inner) {
          this.inner.rotation.x = 0;
          this.inner.scale.y = 1;
        }
        audio.setMusicMode('chase');
        if (this.onChaseStarted) this.onChaseStarted();
      }
    } else if (this.state === STATE_CHASE) {
      // Lurching pursuit: ground speed tied to the stuttering animation,
      // movement blocked by walls/ledges so it follows the ramp and the
      // terrain instead of warping over them.
      const speed = 7.2 * (this.mixer ? 0.45 + this.animRate * 0.55 : 1);
      const dir = new THREE.Vector3(pPos.x - this.position.x, 0, pPos.z - this.position.z);
      if (dir.lengthSq() > 1.5 * 1.5) {
        const baseAng = Math.atan2(dir.x, dir.z);
        for (const off of [0, 0.55, -0.55, 1.1, -1.1]) {
          const a = baseAng + off;
          const nx = this.position.x + Math.sin(a) * speed * dt;
          const nz = this.position.z + Math.cos(a) * speed * dt;
          const ny = world.getGroundHeight(nx, nz);
          if (Math.abs(ny - this.position.y) < 1.6) {
            this.position.set(nx, ny, nz);
            this.rotation.y = a;
            break;
          }
        }
      }
      // Ragged screeches as it closes in.
      if (Math.random() < dt * 0.12 && dist < 45) audio.creatureCry();
    } else {
      this.position.y = world.getGroundHeight(this.position.x, this.position.z);
    }
  }

  reset(spawnPoint) {
    this.state = STATE_IDLE;
    this.encounterTimer = 0;
    this.twitchTimer = 0;
    this.animRate = 0;
    this.position.copy(spawnPoint);
    this.rotation.set(0, 0, 0);
    if (this.inner) {
      this.inner.rotation.set(0, 0, 0);
      this.inner.scale.set(1, 1, 1);
    }
  }

  triggerEncounter(audio) {
    if (this.state === STATE_IDLE) {
      this.state = STATE_ENCOUNTER;
      this.encounterTimer = 0;
      audio.creatureScream();
    }
  }
}
