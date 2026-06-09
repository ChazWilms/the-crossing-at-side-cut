import * as THREE from 'three';
import { RetroRenderer, RENDER_WIDTH, RENDER_HEIGHT } from './retro.js';
import { World } from './world.js';
import { Player } from './player.js';
import { GameAudio } from './audio.js';

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
player.onStep = (sprinting) => {
  const p = player.yawObject.position;
  audio.footstep(world.surfaceAt(p.x, p.z), sprinting);
};
player.onLand = () => {
  const p = player.yawObject.position;
  audio.land(world.surfaceAt(p.x, p.z));
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
    player.spawnAt(new THREE.Vector3(
      parseFloat(params.get('x') ?? world.spawn.x), 0,
      parseFloat(params.get('z') ?? world.spawn.z)
    ));
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

// --- Main loop ---
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (document.pointerLockElement || debug) {
    player.update(dt);
  }
  world.update(dt);
  const p = player.yawObject.position;
  audio.setAmbience(world.windLevel(p.x, p.z), world.riverProximity(p.x, p.z));
  retro.render(scene, camera);
}
animate();
