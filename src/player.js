import * as THREE from 'three';

const EYE_HEIGHT = 1.7;
const WALK_SPEED = 10.0;
const SPRINT_SPEED = 17.0;
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

    this.walkSpeed = WALK_SPEED;
    this.sprintSpeed = SPRINT_SPEED;
    this.eyeHeight = EYE_HEIGHT;
    this.currentEyeHeight = EYE_HEIGHT;
    this.chaseActive = false;
    this.fuel = 100;
    this.tripTimer = 0;
    this.crouching = false;

    // Hand-held lamp
    this.lampGroup = new THREE.Group();
    // Positioned bottom right of view
    this.lampBasePos = new THREE.Vector3(0.5, -0.6, -0.8);
    this.lampGroup.position.copy(this.lampBasePos);
    
    // Simple box for the lamp
    const lampMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.3, 0.15),
      new THREE.MeshBasicMaterial({ color: 0xffd080 })
    );
    this.lampGroup.add(lampMesh);

    // Light casting around the player
    this.lampLight = new THREE.PointLight(0xffb060, 2.0, 15);
    this.lampLight.position.set(0, 0.2, 0);
    this.lampGroup.add(this.lampLight);

    this.pitchObject.add(this.lampGroup);

    this.velocity = new THREE.Vector3();
    this.grounded = false;
    this.stamina = STAMINA_MAX;
    this.regenTimer = 0;
    this.keys = new Set();

    // Audio hooks, wired up by main: onStep(sprinting), onLand().
    this.onStep = null;
    this.onLand = null;
    this.stepAccum = 0;

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
    this.yawObject.position.y = this.getGroundHeight(position.x, position.z) + this.currentEyeHeight;
  }

  setChaseMode(active) {
    this.chaseActive = active;
    this.walkSpeed = active ? WALK_SPEED * 2.0 : WALK_SPEED;
    this.sprintSpeed = active ? SPRINT_SPEED * 2.0 : SPRINT_SPEED;
    this.eyeHeight = active ? EYE_HEIGHT + 0.3 : EYE_HEIGHT;
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

    // --- New Mechanics: Crouching, Glancing, Fuel, Tripping ---
    this.crouching = this.keys.has('KeyC') || this.keys.has('ControlLeft');
    this.pitchObject.rotation.y = this.keys.has('KeyQ') ? Math.PI : 0;
    
    this.fuel = Math.max(0, this.fuel - dt * 1.5);
    this.lampLight.intensity = (this.fuel > 0 ? 2.0 : 0) * (this.fuel < 20 ? 0.3 + 0.7 * Math.random() : 1.0);

    // --- Sprint & stamina ---
    const wantsSprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const sprinting = wantsSprint && moving && this.stamina > 0 && !this.crouching;

    if (sprinting) {
      this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN * dt);
      this.regenTimer = 0;
      // Tripping mechanic
      if (this.stamina <= 0 && this.tripTimer <= 0) {
        this.tripTimer = 2.0;
      }
    } else {
      if (this.tripTimer > 0) {
        this.tripTimer -= dt;
      } else {
        this.regenTimer += dt;
        if (this.regenTimer > REGEN_DELAY) {
          this.stamina = Math.min(STAMINA_MAX, this.stamina + STAMINA_REGEN * dt);
        }
      }
    }
    if (this.staminaFill) {
      this.staminaFill.style.transform = `scaleX(${this.stamina / STAMINA_MAX})`;
    }

    // Dynamic Eye Height
    const targetHeight = this.tripTimer > 0 ? 0.5 : (this.crouching ? 1.0 : this.eyeHeight);
    this.currentEyeHeight = THREE.MathUtils.lerp(this.currentEyeHeight, targetHeight, dt * 8.0);

    // --- Horizontal movement with simple step-based collision ---
    let speed = sprinting ? this.sprintSpeed : this.walkSpeed;
    if (this.crouching) speed *= 0.5;
    if (this.tripTimer > 0) speed = 0;

    const pos = this.yawObject.position;
    const footY = pos.y - this.currentEyeHeight;
    const step = input.clone().multiplyScalar(speed * dt);
    const nextGround = this.getGroundHeight(pos.x + step.x, pos.z + step.z);
    if (nextGround - footY <= MAX_STEP) {
      pos.x += step.x;
      pos.z += step.z;
      // Footsteps fire on distance traveled, so cadence tracks speed.
      if (this.grounded && moving) {
        this.stepAccum += Math.hypot(step.x, step.z);
        if (this.stepAccum >= (sprinting ? 2.6 : 2.0)) {
          this.stepAccum = 0;
          if (!this.crouching) this.onStep?.(sprinting);
        }
      }
    }

    // Wobble the lamp based on movement
    const wobbleSpeed = sprinting ? 12 : 8;
    const wobbleAmount = moving && this.grounded ? (sprinting ? 0.08 : 0.04) : 0.01;
    const t = performance.now() * 0.001 * wobbleSpeed;
    this.lampGroup.position.y = this.lampBasePos.y + Math.sin(t) * wobbleAmount;
    this.lampGroup.position.x = this.lampBasePos.x + Math.cos(t * 0.5) * wobbleAmount;
    this.lampGroup.rotation.z = Math.sin(t * 0.5) * wobbleAmount * 2;
    this.lampGroup.rotation.x = Math.cos(t) * wobbleAmount;

    // --- Gravity, jumping, ground snap ---
    if (this.keys.has('Space') && this.grounded) {
      this.velocity.y = JUMP_VELOCITY;
      this.grounded = false;
    }
    this.velocity.y += GRAVITY * dt;
    pos.y += this.velocity.y * dt;

    const ground = this.getGroundHeight(pos.x, pos.z);
    if (pos.y - this.currentEyeHeight <= ground) {
      pos.y = ground + this.currentEyeHeight;
      if (!this.grounded && this.velocity.y < -5) this.onLand?.();
      this.velocity.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
  }
}
