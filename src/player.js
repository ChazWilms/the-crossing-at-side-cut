import * as THREE from 'three';

const EYE_HEIGHT = 1.7;
// Deliberate pace: the walk is for taking the world in, the sprint is a
// real commitment — mix them on the way to the island.
const WALK_SPEED = 5.0;
const SPRINT_SPEED = 9.5;
const JUMP_VELOCITY = 7.5;
const GRAVITY = -22;
const MAX_STEP = 1.1;

// A deep tank so sustained running is viable, with a slow burn.
const STAMINA_MAX = 200;
const STAMINA_DRAIN = 14; // per second while sprinting
const STAMINA_REGEN = 22; // per second after a short recovery delay
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
    
    // A small kerosene lantern: dark metal caps and handle around a warm
    // glowing glass chimney — not just a glowing box.
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.6, metalness: 0.7 });
    const glassMat = new THREE.MeshBasicMaterial({ color: 0xffc878 });
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.05, 10), metalMat);
    cap.position.y = 0.13;
    this.lampGroup.add(cap);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.06, 10), metalMat);
    base.position.y = -0.12;
    this.lampGroup.add(base);
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.2, 10), glassMat);
    this.lampGroup.add(glass);
    this.lampGlass = glass;
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 14, Math.PI), metalMat);
    handle.position.y = 0.17;
    this.lampGroup.add(handle);

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

    this.onStep = null;
    this.onLand = null;
    this.stepAccum = 0;
    this.shakeTimer = 0;

    this.staminaFill = document.getElementById('stamina-fill');

    document.addEventListener('keydown', (e) => this.keys.add(e.code));
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement && !this.disabled) {
        this.yawObject.rotation.y -= e.movementX * 0.0022;
        this.pitchObject.rotation.x = THREE.MathUtils.clamp(
          this.pitchObject.rotation.x - e.movementY * 0.0022,
          -Math.PI / 2 + 0.05,
          Math.PI / 2 - 0.05
        );
      }
    });
  }

  forceLookAt(targetPosition) {
    // Flatten target position to only turn yaw
    const dx = targetPosition.x - this.yawObject.position.x;
    const dz = targetPosition.z - this.yawObject.position.z;
    this.yawObject.rotation.y = Math.atan2(dx, dz);
    
    // Pitch up slightly to look at face
    const dy = (targetPosition.y + 1.2) - this.pitchObject.position.y;
    const dist = Math.sqrt(dx*dx + dz*dz);
    this.pitchObject.rotation.x = -Math.atan2(dy, dist);
  }

  spawnAt(position) {
    this.yawObject.position.copy(position);
    this.yawObject.position.y = this.getGroundHeight(position.x, position.z) + this.currentEyeHeight;
  }

  setChaseMode(active) {
    this.chaseActive = active;
    // Adrenaline, not rocket boots — the deer must stay scary.
    this.walkSpeed = active ? WALK_SPEED * 1.2 : WALK_SPEED;
    this.sprintSpeed = active ? SPRINT_SPEED * 1.2 : SPRINT_SPEED;
    this.eyeHeight = active ? EYE_HEIGHT + 0.2 : EYE_HEIGHT;
  }

  update(dt) {
    // --- Input direction in local space ---
    const input = new THREE.Vector3(
      (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0),
      0,
      (this.keys.has('KeyS') ? 1 : 0) - (this.keys.has('KeyW') ? 1 : 0)
    );
    if (this.disabled) input.set(0, 0, 0);

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
    
    // Camera shake effect
    if (this.shakeTimer > 0) {
      this.shakeTimer -= dt;
      const shakeAmt = this.shakeTimer * 0.3;
      this.pitchObject.rotation.z = Math.sin(performance.now() * 0.05) * shakeAmt;
      this.pitchObject.rotation.x += Math.cos(performance.now() * 0.06) * shakeAmt * 0.1;
    } else {
      this.pitchObject.rotation.z = 0;
    }

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

    // --- Lamp: a carried object, not a metronome. Its sway is synced to
    // actual footfalls (distance walked), it lags behind turns, and it
    // pitches when falling or jumping.
    if (moving && this.grounded) {
      this.walkPhase = (this.walkPhase ?? 0) + Math.hypot(step.x, step.z) * (Math.PI / (sprinting ? 1.3 : 1.0));
    }
    const wp = this.walkPhase ?? 0;
    const speedF = moving && this.grounded ? Math.min(1, speed / this.sprintSpeed) : 0;
    let yawDelta = this.yawObject.rotation.y - (this.prevYaw ?? this.yawObject.rotation.y);
    yawDelta = Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta));
    this.prevYaw = this.yawObject.rotation.y;
    const yawVel = dt > 0 ? yawDelta / dt : 0;

    const tRotZ = THREE.MathUtils.clamp(yawVel * 0.05, -0.45, 0.45) + Math.sin(wp * 0.5) * 0.07 * speedF;
    const tRotX = THREE.MathUtils.clamp(-this.velocity.y * 0.03, -0.3, 0.3) + Math.sin(wp) * 0.04 * speedF;
    const tPosY = this.lampBasePos.y - Math.abs(Math.sin(wp * 0.5)) * 0.05 * speedF;
    const tPosX = this.lampBasePos.x + Math.sin(wp * 0.5) * 0.03 * speedF;
    // Exponential smoothing gives the lag of a real swinging object.
    const k = 1 - Math.exp(-dt * 7);
    this.lampGroup.rotation.z += (tRotZ - this.lampGroup.rotation.z) * k;
    this.lampGroup.rotation.x += (tRotX - this.lampGroup.rotation.x) * k;
    this.lampGroup.position.y += (tPosY - this.lampGroup.position.y) * k;
    this.lampGroup.position.x += (tPosX - this.lampGroup.position.x) * k;

    // Subtle camera bob on the same footfall rhythm.
    this.pitchObject.position.y += ((Math.abs(Math.sin(wp * 0.5)) * -0.06 * speedF) - this.pitchObject.position.y) * k;

    // --- Gravity, jumping, and ground-follow ---
    if (this.keys.has('Space') && this.grounded && !this.disabled) {
      this.velocity.y = JUMP_VELOCITY;
      this.grounded = false;
    }

    const ground = this.getGroundHeight(pos.x, pos.z);
    if (this.grounded && this.velocity.y <= 0) {
      // Stick to the terrain while walking: applying gravity first made the
      // player dip below the surface and pop back up every few frames.
      const dropBelow = pos.y - this.currentEyeHeight - ground;
      if (dropBelow <= 1.1) {
        pos.y = ground + this.currentEyeHeight;
        this.velocity.y = 0;
      } else {
        this.grounded = false; // genuinely walked off an edge
      }
    }

    if (!this.grounded) {
      this.velocity.y += GRAVITY * dt;
      pos.y += this.velocity.y * dt;
      if (pos.y - this.currentEyeHeight <= ground) {
        pos.y = ground + this.currentEyeHeight;
        if (this.velocity.y < -5) this.onLand?.();
        this.velocity.y = 0;
        this.grounded = true;
      }
    }
  }
}
