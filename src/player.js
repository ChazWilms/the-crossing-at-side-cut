import * as THREE from 'three';

const EYE_HEIGHT = 1.7;
const WALK_SPEED = 5.0;
const SPRINT_SPEED = 8.5;
const JUMP_VELOCITY = 7.5;
const GRAVITY = -22;
const MAX_STEP = 0.55; // taller ledges block movement instead of being climbed

const STAMINA_MAX = 100;
const STAMINA_DRAIN = 22; // per second while sprinting
const STAMINA_REGEN = 14; // per second after a short recovery delay
const REGEN_DELAY = 1.0;

export class Player {
  constructor(camera, getGroundHeight) {
    this.getGroundHeight = getGroundHeight;

    // yaw -> pitch -> camera, the classic FPS rig.
    this.pitchObject = new THREE.Object3D();
    this.pitchObject.add(camera);
    this.yawObject = new THREE.Object3D();
    this.yawObject.add(this.pitchObject);

    this.velocity = new THREE.Vector3();
    this.grounded = false;
    this.stamina = STAMINA_MAX;
    this.regenTimer = 0;
    this.keys = new Set();

    this.staminaFill = document.getElementById('stamina-fill');

    document.addEventListener('keydown', (e) => this.keys.add(e.code));
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement) {
        this.yawObject.rotation.y -= e.movementX * 0.0022;
        this.pitchObject.rotation.x = THREE.MathUtils.clamp(
          this.pitchObject.rotation.x - e.movementY * 0.0022,
          -Math.PI / 2 + 0.05,
          Math.PI / 2 - 0.05
        );
      }
    });
  }

  spawnAt(position) {
    this.yawObject.position.copy(position);
    this.yawObject.position.y = this.getGroundHeight(position.x, position.z) + EYE_HEIGHT;
  }

  update(dt) {
    // --- Input direction in local space ---
    const input = new THREE.Vector3(
      (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0),
      0,
      (this.keys.has('KeyS') ? 1 : 0) - (this.keys.has('KeyW') ? 1 : 0)
    );
    const moving = input.lengthSq() > 0;
    if (moving) input.normalize().applyQuaternion(this.yawObject.quaternion);

    // --- Sprint & stamina ---
    const wantsSprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const sprinting = wantsSprint && moving && this.stamina > 0;
    if (sprinting) {
      this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN * dt);
      this.regenTimer = 0;
    } else {
      this.regenTimer += dt;
      if (this.regenTimer > REGEN_DELAY) {
        this.stamina = Math.min(STAMINA_MAX, this.stamina + STAMINA_REGEN * dt);
      }
    }
    if (this.staminaFill) {
      this.staminaFill.style.transform = `scaleX(${this.stamina / STAMINA_MAX})`;
    }

    // --- Horizontal movement with simple step-based collision ---
    const speed = sprinting ? SPRINT_SPEED : WALK_SPEED;
    const pos = this.yawObject.position;
    const footY = pos.y - EYE_HEIGHT;
    const step = input.clone().multiplyScalar(speed * dt);
    const nextGround = this.getGroundHeight(pos.x + step.x, pos.z + step.z);
    if (nextGround - footY <= MAX_STEP) {
      pos.x += step.x;
      pos.z += step.z;
    }

    // --- Gravity, jumping, ground snap ---
    if (this.keys.has('Space') && this.grounded) {
      this.velocity.y = JUMP_VELOCITY;
      this.grounded = false;
    }
    this.velocity.y += GRAVITY * dt;
    pos.y += this.velocity.y * dt;

    const ground = this.getGroundHeight(pos.x, pos.z);
    if (pos.y - EYE_HEIGHT <= ground) {
      pos.y = ground + EYE_HEIGHT;
      this.velocity.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
  }
}
