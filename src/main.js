import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RetroRenderer, RENDER_WIDTH, RENDER_HEIGHT } from './retro.js';
import { World } from './world.js';
import { Player } from './player.js';
import { GameAudio } from './audio.js';
import { NotDeer } from './notdeer.js';
import { Effigies } from './effigies.js';
import { Notes } from './notes.js';
import * as tex from './textures.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, RENDER_WIDTH / RENDER_HEIGHT, 0.1, 200);

const retro = new RetroRenderer();

// Post-Processing Pipeline (MSAA render targets so edges stay clean
// even though the composer bypasses the canvas's built-in antialiasing).
const composer = new EffectComposer(retro.renderer);
composer.renderTarget1.samples = 4;
composer.renderTarget2.samples = 4;
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(RENDER_WIDTH, RENDER_HEIGHT), 0.4, 0.5, 0.85);
composer.addPass(bloomPass);

// --- Version log shown on the menu screen ---
const CHANGELOG = [
  {
    v: '1.4.0',
    items: [
      'W River Road now divides the park from the sledding hill, matching the real Side Cut layout',
      'The limestone canal locks the park is named for stand near the road, with a marker',
      'A burning sun glow and sunset clouds in the western sky',
    ],
  },
  {
    v: '1.3.0',
    items: [
      'GRAPHICS: all-new 256px detail textures (grass blades, pebbled dirt, river stones, strata, bark, asphalt cracks) with smooth anisotropic filtering',
      'GRAPHICS: filmic ACES color, MSAA edges, sky reflections on water and the car, 4096px crisp sun shadows, denser tree geometry',
      'Not-Deer fixed: it was running sideways (wrong model axis) — now faces and follows you properly, including up the spiral ramp',
      'The Not-Deer has its burning red nose',
    ],
  },
  {
    v: '1.2.0',
    items: [
      'Returning to the menu mid-game now reads as a pause',
      'README/docs refreshed to match the finished loop',
    ],
  },
  {
    v: '1.1.0',
    items: [
      "Dan's backpack and what's left of him wait at the bottom of the pit, with the final journal page",
      'The crossing stones tip under your weight',
    ],
  },
  {
    v: '1.0.0',
    items: [
      'The full loop is here: cross at dusk, find the five effigies, open the tower, take what waits below, and outrun it home',
      'Opening lines set the scene; surviving earns you a proper ending',
      'Version number on the title screen',
    ],
  },
  {
    v: '0.9.0',
    items: [
      'Compass strip up top: cardinal directions, diamonds for unfound effigies, the tower once it opens',
      'Sharper performance on laptops (render scale capped)',
    ],
  },
  {
    v: '0.8.0',
    items: [
      'Crickets at dusk, an owl somewhere across the river — silent underground',
      'Your heartbeat surfaces when you are spent, and pounds through the chase',
      'The Not-Deer screeches as it closes in',
    ],
  },
  {
    v: '0.7.0',
    items: [
      'The park is furnished: picnic tables, benches along the trail, trash cans, a trailhead sign',
      'Three lampposts cast warm light over the Riverview Area as the sun goes down',
    ],
  },
  {
    v: '0.6.0',
    items: [
      'Four notes scattered along the route tell you who came here before you',
      'Before you ever reach the tower, something watches from the treeline. Approach and it is gone.',
    ],
  },
  {
    v: '0.5.0',
    items: [
      'Volume control on the menu (persists between visits)',
      'Sprint widens your field of view; exhaustion closes a vignette around the edges',
      'Proper IT FOUND YOU / YOU MADE IT BACK moments, with escape time and best-time tracking',
    ],
  },
  {
    v: '0.4.0',
    items: [
      'Ground mist drifts over the river and through the island woods',
      'Fireflies between the trees, brighter as night falls',
      'Stars and a moon appear when darkness comes',
      'Every tree has its own shade of green now',
    ],
  },
  {
    v: '0.3.0',
    items: [
      'New objective: five effigies wait at marked places — playground, sledding hill, the crossing, the forest path, the east shore',
      'The tower door is sealed by stone until all five are found',
      'Candlelight and faint beams mark each effigy; chimes and a distant stone-grind tell your progress',
      'Objective tracker (top-left) and message toasts',
    ],
  },
  {
    v: '0.2.0',
    items: [
      'Movement retuned: slower deliberate walk, sprint as a real choice, double-size stamina tank and a bigger bar',
      'Fixed falling through the ground while running',
      'River actually looks like water now, and flows',
      'Real music: dark ambient track, switches to a chase track when it finds you',
      'The Not-Deer rebuilt on a real animated quadruped — black, stretched, stuttering',
      'Lantern sways with your actual footsteps and lags your turns',
      'Night fog thickens properly; sunset sky fades out after dark',
      'Performance: shadow casting limited to the sun',
    ],
  },
  {
    v: '0.1.0',
    items: [
      'The park, the crossing, the island, the tower, the descent',
      'Lantern with fuel, crouch, glance-back, artifact encounter, chase, win/lose',
    ],
  },
];
document.getElementById('version').textContent = 'v' + CHANGELOG[0].v;
const logEl = document.getElementById('changelog');
if (logEl) {
  logEl.innerHTML =
    '<h4>UPDATE LOG</h4>' +
    CHANGELOG.map(
      (c) => `<div class="ver">v${c.v}</div><ul>${c.items.map((i) => `<li>${i}</li>`).join('')}</ul>`
    ).join('');
}

const world = new World();
world.build(scene);

// Texture sharpness at oblique angles + soft sky reflections on water,
// car paint, and wet stone.
tex.applyAnisotropy(retro.renderer.capabilities.getMaxAnisotropy());
{
  const pmrem = new THREE.PMREMGenerator(retro.renderer);
  const envScene = new THREE.Scene();
  envScene.add(world.skyMesh.clone());
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  if ('environmentIntensity' in scene) scene.environmentIntensity = 0.35;
}

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

// Cursed Artifact
const artifact = new THREE.Mesh(
  new THREE.DodecahedronGeometry(0.3),
  new THREE.MeshStandardMaterial({ color: 0x88ff88, emissive: 0x22ff22, emissiveIntensity: 1.5, wireframe: true })
);
const artifactLight = new THREE.PointLight(0x44ff44, 2.0, 10);
artifact.add(artifactLight);
artifact.position.copy(notDeerSpawn).add(new THREE.Vector3(-3, 1, 3));
scene.add(artifact);

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

// --- The effigy hunt: five marked places, then the tower opens ---
const effigies = new Effigies(scene, world);
const objectiveEl = document.getElementById('objective');
const messageEl = document.getElementById('message');
let messageTimer = null;
function showMessage(text, ms = 4200) {
  messageEl.textContent = text;
  messageEl.style.opacity = 1;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => (messageEl.style.opacity = 0), ms);
}
function setObjective() {
  objectiveEl.textContent = effigies.allCollected
    ? 'The tower is open.'
    : `Effigies: ${effigies.count}/${effigies.total} — follow the candlelight`;
}
setObjective();

// The tower doorway is sealed by a stone slab until the hunt is done.
const doorSlab = new THREE.Mesh(
  new THREE.BoxGeometry(0.5, 3.3, 2.4),
  new THREE.MeshStandardMaterial({ color: 0x6a655c, roughness: 0.9 })
);
let doorOpening = false;
let doorOpen = false;
let sealHintCooldown = 0;
doorSlab.position.set(world.doorPosition.x + 0.15, 1.55, world.doorPosition.z);
scene.add(doorSlab);

// Scattered notes telling the story of the last person who came here.
const notes = new Notes(scene, world);

// --- Compass strip: cardinals, uncollected effigies, and (once open) the tower ---
const compassEl = document.getElementById('compass');
const compassMarks = [];
function addMark(label, cls) {
  const el = document.createElement('div');
  el.className = 'mk' + (cls ? ' ' + cls : '');
  el.textContent = label;
  compassEl.appendChild(el);
  return el;
}
for (const [label, ang] of [['N', Math.PI], ['E', Math.PI / 2], ['S', 0], ['W', -Math.PI / 2]]) {
  compassMarks.push({ el: addMark(label, ''), fixedAngle: ang });
}
const effigyMarks = effigies.items.map((it) => ({
  el: addMark('◆', 'eff'),
  target: it.group.position,
  item: it,
}));
const towerMark = { el: addMark('▲', 'tower') };

function updateCompass(p, yaw) {
  const camAngle = yaw + Math.PI; // camera looks along -z of the yaw frame
  const place = (el, angTo) => {
    let d = angTo - camAngle;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) < 0.75) {
      el.style.display = 'block';
      el.style.left = `${50 + (d / 0.75) * 50}%`;
    } else {
      el.style.display = 'none';
    }
  };
  compassEl.style.display = underground ? 'none' : 'block';
  if (underground) return;
  for (const m of compassMarks) place(m.el, m.fixedAngle);
  for (const m of effigyMarks) {
    if (m.item.collected) {
      m.el.style.display = 'none';
      continue;
    }
    place(m.el, Math.atan2(m.target.x - p.x, m.target.z - p.z));
  }
  if (effigies.allCollected && !chaseActive) {
    place(towerMark.el, Math.atan2(world.doorPosition.x - p.x, world.doorPosition.z - p.z));
  } else {
    towerMark.el.style.display = 'none';
  }
}

// --- The watcher: before you ever reach the tower, the deer is sometimes
// just... there, in the treeline, facing you. Get close and it's gone.
const watcher = new NotDeer();
watcher.visible = false;
scene.add(watcher);
let chaseHappened = false;
let glimpseTimer = 25;
let glimpseActive = 0;
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

let chaseStartTime = 0;
notDeer.onChaseStarted = () => {
  chaseActive = true;
  chaseHappened = true;
  watcher.visible = false;
  chaseStartTime = performance.now();
  player.setChaseMode(true);
};

// --- QoL UI: vignette, big-moment text, volume control ---
const vignetteEl = document.getElementById('vignette');
const bigtextEl = document.getElementById('bigtext');
function showBigText(text, color, ms = 4500) {
  bigtextEl.textContent = text;
  bigtextEl.style.color = color;
  bigtextEl.style.opacity = 1;
  setTimeout(() => (bigtextEl.style.opacity = 0), ms);
}
const volVal = document.getElementById('vol-val');
function syncVolLabel() {
  volVal.textContent = `${Math.round(audio.volumeScale * 100)}%`;
}
syncVolLabel();
for (const [id, delta] of [['vol-down', -0.1], ['vol-up', 0.1]]) {
  document.getElementById(id).addEventListener('click', (e) => {
    e.stopPropagation(); // don't trigger the click-to-start overlay
    audio.setMasterVolume(Math.round((audio.volumeScale + delta) * 10) / 10);
    syncVolLabel();
  });
}

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
  // &deertest force-triggers the encounter and logs the creature's state.
  if (params.has('deertest')) {
    setTimeout(() => notDeer.triggerEncounter(audio), 2500);
    setInterval(() => {
      console.log(
        'DEERTEST state', notDeer.state,
        'pos', notDeer.position.x.toFixed(1), notDeer.position.y.toFixed(1), notDeer.position.z.toFixed(1),
        'mixer', !!notDeer.mixer, 'rate', notDeer.animRate?.toFixed(2),
        'playerdist', notDeer.position.distanceTo(player.yawObject.position).toFixed(1)
      );
    }, 1000);
  }
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
let introShown = false;
document.addEventListener('pointerlockchange', () => {
  overlay.classList.toggle('hidden', !!document.pointerLockElement);
  // Coming back to the menu mid-game reads as a pause, not a fresh start.
  if (!document.pointerLockElement && introShown) {
    overlay.querySelector('p').innerHTML = 'Paused &mdash; click to resume';
  }
  if (document.pointerLockElement && !introShown) {
    introShown = true;
    setTimeout(() => showMessage('Blue Grass Island. October. The sun is going down.', 5500), 1200);
    setTimeout(() => showMessage('Find the five effigies. They mark the way to the tower.', 6500), 8200);
  }
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
    audio.setMusicMode(chaseActive ? 'chase' : toUnderground ? 'underground' : 'overworld');
    // If it's hunting you, it follows you out of the tower.
    if (chaseActive && !toUnderground) {
      notDeer.position.set(world.doorPosition.x + 5, 0, world.doorPosition.z + 4);
    }
  }, 420);
}

function checkTransitions(p) {
  if (teleportCooldown > 0) return;
  if (!underground && p.distanceTo(world.doorPosition) < 1.4) {
    if (!doorOpen) {
      if (sealHintCooldown <= 0) {
        sealHintCooldown = 4;
        showMessage(`The door is sealed. ${effigies.count}/${effigies.total} effigies.`);
      }
      return;
    }
    // Into the dark: arrive on the ledge, facing along it toward the ramp.
    teleport(world.descentEntry, Math.PI - 0.55, true);
  } else if (underground && p.distanceTo(world.descentExit) < 1.6) {
    // Back out through the tunnel mouth to the beach.
    const out = world.doorPosition.clone();
    out.x += 2.5;
    teleport(out, -Math.PI / 2, false);
  }
}

// Enable shadows on meshes; only the sun casts them. Every point light
// casting shadows means six render passes each — it tanked the framerate.
scene.traverse((child) => {
  if (child.isMesh) {
    child.castShadow = true;
    child.receiveShadow = true;
  }
  if (child.isLight && child.isDirectionalLight) {
    child.castShadow = true;
    child.shadow.bias = -0.001;
  } else if (child.isLight) {
    child.castShadow = false;
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

  // Artifact logic
  if (artifact.parent) {
    artifact.rotation.y += dt;
    artifact.rotation.z += dt * 0.5;
    artifact.position.y = notDeerSpawn.y + 1 + Math.sin(clock.elapsedTime * 2) * 0.2;
    if (artifact.position.distanceTo(player.yawObject.position) < 2.5) {
      scene.remove(artifact);
      notDeer.triggerEncounter(audio);
    }
  }

  // Win condition: reach the car
  const pPos = player.yawObject.position;
  if (chaseActive && pPos.x < 30 && pPos.z < -100) {
    chaseActive = false;
    nightFactor = 0;
    player.setChaseMode(false);
    notDeer.reset(notDeerSpawn);
    world.setNightness(nightFactor, underground);
    audio.setMusicMode('overworld');

    const secs = ((performance.now() - chaseStartTime) / 1000).toFixed(1);
    const best = parseFloat(localStorage.getItem('sidecut-best') ?? 'Infinity');
    if (parseFloat(secs) < best) localStorage.setItem('sidecut-best', secs);
    showBigText('YOU MADE IT BACK', '#e8d8ae', 5000);
    showMessage(
      `Escaped in ${secs}s${parseFloat(secs) < best ? ' — a new best.' : ` (best ${Math.min(best, parseFloat(secs)).toFixed(1)}s)`}`,
      6000
    );
    setTimeout(() => showMessage('It does not cross the open ground. For now.', 7000), 7000);

    // Quick win flash
    fade.style.backgroundColor = 'white';
    fade.style.opacity = 1;
    setTimeout(() => {
      fade.style.backgroundColor = 'black';
      fade.style.opacity = 0;
    }, 2000);
  }

  // Game over logic (Jumpscare)
  if (chaseActive && notDeer.position.distanceTo(pPos) < 1.6 && teleportCooldown <= 0) {
    teleportCooldown = 3;
    player.disabled = true;
    player.forceLookAt(notDeer.position);
    player.shakeTimer = 1.0;
    audio.creatureScream();
    
    setTimeout(() => {
      fade.style.opacity = 1;
      audio.gameOver();
      showBigText('IT FOUND YOU', '#a51f1f', 2600);
    }, 800);
    
    setTimeout(() => {
      chaseActive = false;
      nightFactor = 0;
      player.setChaseMode(false);
      player.disabled = false;
      notDeer.reset(notDeerSpawn);
      
      // Reset artifact
      if (!artifact.parent) scene.add(artifact);
      
      player.spawnAt(world.spawn);
      player.yawObject.rotation.y = Math.PI / 2;
      player.pitchObject.rotation.x = 0;
      player.velocity.set(0, 0, 0);
      world.setNightness(nightFactor, underground);
      fade.style.opacity = 0;
    }, 3000);
  }

  // Effigy hunt progress.
  sealHintCooldown = Math.max(0, sealHintCooldown - dt);
  const picked = effigies.update(dt, player.yawObject.position, audio);
  if (picked) {
    setObjective();
    if (effigies.allCollected) {
      showMessage('The last effigy. Far away, stone grinds against stone.', 6000);
      doorOpening = true;
      audio.rumbleOpen();
    } else {
      showMessage(`An effigy, ${picked}. ${effigies.count}/${effigies.total}.`);
    }
  }
  if (doorOpening) {
    doorSlab.position.y -= dt * 0.7;
    if (doorSlab.position.y < -2.1) {
      doorOpening = false;
      doorOpen = true;
      scene.remove(doorSlab);
    }
  }

  // Sprint FOV kick + exhaustion/chase vignette.
  const targetFov = player.sprinting ? 83 : 75;
  if (Math.abs(camera.fov - targetFov) > 0.05) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 4);
    camera.updateProjectionMatrix();
  }
  const exhaustion = 1 - player.stamina / player.staminaMax;
  vignetteEl.style.opacity = Math.min(0.85, exhaustion * 0.55 + (chaseActive ? 0.3 : 0));
  audio.setHeartbeat(Math.max(0, exhaustion - 0.45) * 1.1 + (chaseActive ? 0.45 : 0));

  notDeer.update(dt, player, world, audio);
  const p = player.yawObject.position;
  world.update(dt, p);

  // Lore notes.
  const noteText = notes.update(p);
  if (noteText) {
    showMessage(noteText, 9000);
    audio.burst({ dur: 0.12, type: 'highpass', freq: 2600, gain: 0.1 });
  }

  // Treeline glimpses before the first encounter.
  if (!chaseHappened && !underground) {
    if (glimpseActive > 0) {
      glimpseActive -= dt;
      watcher.update(dt, player, world, audio);
      if (glimpseActive <= 0 || watcher.position.distanceTo(p) < 16) {
        watcher.visible = false;
        glimpseActive = 0;
        glimpseTimer = 45 + Math.random() * 50;
        audio.creatureNoise(0.5);
      }
    } else {
      glimpseTimer -= dt;
      if (glimpseTimer <= 0) {
        glimpseTimer = 12; // retry soon if no valid spot found
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = 26 + Math.random() * 10;
          const gx = p.x + Math.cos(a) * d;
          const gz = p.z + Math.sin(a) * d;
          if (gx > 380) continue;
          const gy = world.heightAt(gx, gz);
          if (gy < -0.3) continue;
          watcher.position.set(gx, gy, gz);
          watcher.visible = true;
          glimpseActive = 4 + Math.random() * 3;
          break;
        }
      }
    }
  }
  const ground = new THREE.Vector3(p.x, 0, p.z);
  checkTransitions(ground);
  audio.setAmbience(world.windLevel(p.x, p.z), world.riverProximity(p.x, p.z));
  updateCompass(p, player.yawObject.rotation.y);
  composer.render();
}
animate();
