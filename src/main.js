import * as THREE from 'three';
import { RetroRenderer, RENDER_WIDTH, RENDER_HEIGHT } from './retro.js';
import { World } from './world.js';
import { Player } from './player.js';

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
}
overlay.addEventListener('click', () => {
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
  retro.render(scene, camera);
}
animate();
