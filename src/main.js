import * as THREE from 'three';
import { RetroRenderer, RENDER_WIDTH, RENDER_HEIGHT } from './retro.js';
import { World } from './world.js';
import { Player } from './player.js';
import { GameAudio } from './audio.js';
import { NotDeer } from './notdeer.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, RENDER_WIDTH / RENDER_HEIGHT, 0.1, 200);

const retro = new RetroRenderer();
const world = new World();
world.build(scene);

const player = new Player(camera, (x, z) => world.getGroundHeight(x, z));
player.spawnAt(world.spawn);
// Face west, toward the crossing.
player.yawObject.rotation.y = Math.PI / 2;
scene.add(player.yawObject);

const audio = new GameAudio();

const notDeer = new NotDeer();
const notDeerSpawn = new THREE.Vector3(495, -16, 5);
notDeer.position.copy(notDeerSpawn);
scene.add(notDeer);

// Fuel Cans
const fuelCans = [];
const canGeo = new THREE.BoxGeometry(0.3, 0.4, 0.2);
const canMat = new THREE.MeshBasicMaterial({ color: 0xaa2222 }); // Red jerrycans

const spawnFuelCan = (x, z, yOffset = 0.2) => {
  const mesh = new THREE.Mesh(canGeo, canMat);
  mesh.position.set(x, world.getGroundHeight(x, z) + yOffset, z);
  scene.add(mesh);
  fuelCans.push(mesh);
};

// Spawn a few cans around the map
spawnFuelCan(80, 15);     // Forest
spawnFuelCan(120, -5);    // Path
spawnFuelCan(485, 12, -15); // Tower basement ledge
player.onStep = (sprinting) => {
  const p = player.yawObject.position;
  audio.footstep(world.surfaceAt(p.x, p.z), sprinting);
};
player.onLand = () => {
  const p = player.yawObject.position;
  audio.land(world.surfaceAt(p.x, p.z));
};

// --- Area transition state (used by debug teleports below) ---
const fade = document.getElementById('fade');
let underground = false;
let teleportCooldown = 0;
let nightFactor = 0;
let chaseActive = false;

notDeer.onChaseStarted = () => {
  chaseActive = true;
  player.setChaseMode(true);
};

// --- Pointer lock flow ---
// ?debug skips the lock so the scene can be inspected/screenshotted headlessly;
// optional x/z/ry params teleport the camera for spot-checking the world.
const params = new URLSearchParams(location.search);
const debug = params.has('debug');
const overlay = document.getElementById('overlay');
if (debug) {
  overlay.classList.add('hidden');
  if (params.has('x') || params.has('z')) {
    const dx = parseFloat(params.get('x') ?? world.spawn.x);
    player.spawnAt(new THREE.Vector3(dx, 0, parseFloat(params.get('z') ?? world.spawn.z)));
    underground = dx > 400;
    world.setNightness(nightFactor, underground);
  }
  if (params.has('ry')) player.yawObject.rotation.y = parseFloat(params.get('ry'));
  if (params.has('rx')) player.pitchObject.rotation.x = parseFloat(params.get('rx'));
  // &audiotest exercises every footstep variant (needs relaxed autoplay).
  if (params.has('audiotest')) {
    audio.start();
    const surfaces = ['grass', 'dirt', 'asphalt', 'wetstone', 'riverrock', 'water'];
    surfaces.forEach((s, i) => setTimeout(() => audio.footstep(s, i % 2 === 0), 200 + i * 300));
    setTimeout(() => audio.land('riverrock'), 2100);
    setTimeout(() => console.log('AUDIOTEST done, ctx state:', audio.ctx?.state), 2500);
  }
}
overlay.addEventListener('click', () => {
  audio.start(); // must happen inside a user gesture
  retro.renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  overlay.classList.toggle('hidden', !!document.pointerLockElement);
});

// F toggles fullscreen; entering it can drop pointer lock, so re-grab it.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyF') return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    const wasLocked = !!document.pointerLockElement;
    document.body.requestFullscreen().then(() => {
      if (wasLocked) retro.renderer.domElement.requestPointerLock();
    }).catch(() => {});
  }
});

// --- Area transitions: tower doorway <-> the descent ---
function teleport(position, facing, toUnderground) {
  teleportCooldown = 2;
  fade.style.opacity = 1;
  setTimeout(() => {
    underground = toUnderground;
    world.setNightness(nightFactor, toUnderground);
    player.spawnAt(position);
    player.yawObject.rotation.y = facing;
    player.pitchObject.rotation.x = 0;
    player.velocity.set(0, 0, 0);
    fade.style.opacity = 0;
  }, 420);
}

function checkTransitions(p) {
  if (teleportCooldown > 0) return;
  if (!underground && p.distanceTo(world.doorPosition) < 1.4) {
    // Into the dark: arrive on the ledge, facing along it toward the ramp.
    teleport(world.descentEntry, Math.PI - 0.55, true);
  } else if (underground && p.distanceTo(world.descentExit) < 1.6) {
    // Back out through the tunnel mouth to the beach.
    const out = world.doorPosition.clone();
    out.x += 2.5;
    teleport(out, -Math.PI / 2, false);
  }
}

// Enable shadows globally for all built objects
scene.traverse((child) => {
  if (child.isMesh) {
    child.castShadow = true;
    child.receiveShadow = true;
  }
  if (child.isLight && child.type !== 'HemisphereLight') {
    child.castShadow = true;
    child.shadow.mapSize.width = 1024;
    child.shadow.mapSize.height = 1024;
    child.shadow.bias = -0.001;
  }
});

// --- Main loop ---
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  teleportCooldown = Math.max(0, teleportCooldown - dt);
  if (document.pointerLockElement || debug) {
    player.update(dt);
  }

  // Fuel collection logic
  for (let i = fuelCans.length - 1; i >= 0; i--) {
    const can = fuelCans[i];
    // Rotate slightly for visibility
    can.rotation.y += dt;
    if (can.position.distanceTo(player.yawObject.position) < 2.0) {
      player.fuel = 100;
      scene.remove(can);
      fuelCans.splice(i, 1);
      // Play a simple pickup sound
      audio.burst({ dur: 0.1, freq: 800, gain: 0.2 });
    }
  }

  // Handle the chase transition
  if (chaseActive) {
    nightFactor = Math.min(1.0, nightFactor + dt * 0.3);
  }
  world.setNightness(nightFactor, underground);

  // Game over logic
  if (chaseActive && notDeer.position.distanceTo(player.yawObject.position) < 1.5 && teleportCooldown <= 0) {
    teleportCooldown = 2;
    fade.style.opacity = 1;
    audio.gameOver();
    setTimeout(() => {
      chaseActive = false;
      nightFactor = 0;
      player.setChaseMode(false);
      notDeer.reset(notDeerSpawn);
      player.spawnAt(world.spawn);
      player.yawObject.rotation.y = Math.PI / 2;
      player.pitchObject.rotation.x = 0;
      player.velocity.set(0, 0, 0);
      world.setNightness(nightFactor, underground);
      fade.style.opacity = 0;
    }, 1200);
  }

  notDeer.update(dt, player, world, audio);
  world.update(dt);
  const p = player.yawObject.position;
  const ground = new THREE.Vector3(p.x, 0, p.z);
  checkTransitions(ground);
  audio.setAmbience(world.windLevel(p.x, p.z), world.riverProximity(p.x, p.z));
  retro.render(scene, camera);
}
animate();
