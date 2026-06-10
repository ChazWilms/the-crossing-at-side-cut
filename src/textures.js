import * as THREE from 'three';

// All textures are generated at runtime onto tiny canvases — 64x64 with
// nearest filtering reads as authentically low-budget PSX.
const SIZE = 1024;

function makeCanvasTexture(draw, repeat = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  draw(canvas.getContext('2d'));
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.LinearFilter; // chunky up close
  // Mipmapped minification: without it every textured surface shimmers
  // and crawls as the camera moves, which reads as "shifting pixels".
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Speckled noise over a base color — covers grass, dirt, stone, sand.
function noiseTexture(base, specks, density, repeat) {
  return makeCanvasTexture((ctx) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, SIZE, SIZE);
    for (let i = 0; i < SIZE * SIZE * density; i++) {
      ctx.fillStyle = specks[Math.floor(Math.random() * specks.length)];
      ctx.fillRect(
        Math.floor(Math.random() * SIZE),
        Math.floor(Math.random() * SIZE),
        1 + Math.floor(Math.random() * 2),
        1
      );
    }
  }, repeat);
}

export function grassTexture(repeat) {
  return noiseTexture('#5a7040', ['#4a5d33', '#6d8450', '#3f4f2a', '#7e955c'], 0.5, repeat);
}

export function dirtTexture(repeat) {
  return noiseTexture('#9c7e53', ['#8a6c42', '#b09262', '#7a5e38', '#bfa172'], 0.5, repeat);
}

export function forestFloorTexture(repeat) {
  return noiseTexture('#4d5532', ['#3f4628', '#5d663e', '#665838', '#333a20'], 0.6, repeat);
}

export function riverRockTexture(repeat) {
  return makeCanvasTexture((ctx) => {
    ctx.fillStyle = '#76726a';
    ctx.fillRect(0, 0, SIZE, SIZE);
    // Round overlapping pebbles.
    for (let i = 0; i < 90 * 16 * 16; i++) {
      const shade = 95 + Math.floor(Math.random() * 70);
      ctx.fillStyle = `rgb(${shade}, ${shade - 4}, ${shade - 10})`;
      ctx.beginPath();
      ctx.arc(
        Math.random() * SIZE,
        Math.random() * SIZE,
        (2 + Math.random() * 4) * 16,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }, repeat);
}

export function stoneTexture(repeat) {
  return makeCanvasTexture((ctx) => {
    ctx.fillStyle = '#878276';
    ctx.fillRect(0, 0, SIZE, SIZE);
    // Horizontal strata — reads as stacked flat stones on the tower.
    for (let y = 0; y < SIZE; y += (4 + Math.floor(Math.random() * 3)) * 16) {
      const shade = 105 + Math.floor(Math.random() * 60);
      ctx.fillStyle = `rgb(${shade}, ${shade - 5}, ${shade - 12})`;
      ctx.fillRect(0, y, SIZE, (3 + Math.floor(Math.random() * 2)) * 16);
      ctx.fillStyle = 'rgba(20, 18, 14, 0.6)';
      ctx.fillRect(0, y - 16, SIZE, 16);
      // Vertical joints between stones.
      for (let x = Math.floor(Math.random() * 8) * 16; x < SIZE; x += (6 + Math.floor(Math.random() * 8)) * 16) {
        ctx.fillRect(x, y, 16, 4 * 16);
      }
    }
  }, repeat);
}

export function barkTexture(repeat) {
  return makeCanvasTexture((ctx) => {
    ctx.fillStyle = '#4d3f2f';
    ctx.fillRect(0, 0, SIZE, SIZE);
    for (let x = 0; x < SIZE; x += (2 + Math.floor(Math.random() * 3)) * 16) {
      const shade = 50 + Math.floor(Math.random() * 35);
      ctx.fillStyle = `rgb(${shade + 15}, ${shade}, ${Math.floor(shade * 0.7)})`;
      ctx.fillRect(x, 0, (1 + Math.floor(Math.random() * 2)) * 16, SIZE);
    }
  }, repeat);
}

export function waterTexture(repeat) {
  return noiseTexture('#39505c', ['#304450', '#44606e', '#283a44', '#50707e'], 0.35, repeat);
}

export function asphaltTexture(repeat) {
  return noiseTexture('#45464a', ['#3b3c40', '#515257', '#36373a', '#5c5d63'], 0.5, repeat);
}

// One-shot texture for the whole lot: asphalt with painted parking stalls
// along the top edge.
export function parkingLotTexture() {
  return makeCanvasTexture((ctx) => {
    ctx.fillStyle = '#45464a';
    ctx.fillRect(0, 0, SIZE, SIZE);
    for (let i = 0; i < SIZE * SIZE * 0.5; i++) {
      ctx.fillStyle = ['#3b3c40', '#515257', '#36373a', '#5c5d63'][Math.floor(Math.random() * 4)];
      ctx.fillRect(Math.floor(Math.random() * SIZE), Math.floor(Math.random() * SIZE), 2, 1);
    }
    ctx.fillStyle = '#cfcabb';
    for (let x = 2; x < SIZE; x += 13) {
      ctx.fillRect(x, 0, 1, 26);
    }
  });
}

export function concreteTexture(repeat) {
  return noiseTexture('#9a9588', ['#8d8a7e', '#a8a294', '#827d70', '#b3ac9c'], 0.4, repeat);
}

// Soft radial mist puff for drifting fog cards — smooth-filtered, unlike
// the pixel textures.
export function mistTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(235, 230, 220, 0.5)');
  grad.addColorStop(0.55, 'rgba(225, 220, 210, 0.22)');
  grad.addColorStop(1, 'rgba(220, 215, 205, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Transparent grass blades for cross-quad tufts (used with alphaTest).
export function grassBladeTexture() {
  return makeCanvasTexture((ctx) => {
    ctx.clearRect(0, 0, SIZE, SIZE);
    const greens = ['#5a7040', '#4a5d33', '#6d8450', '#74683c'];
    for (let i = 0; i < 14; i++) {
      const x = 4 + Math.random() * (SIZE - 8);
      const top = 10 + Math.random() * 26;
      ctx.strokeStyle = greens[Math.floor(Math.random() * greens.length)];
      ctx.lineWidth = 2 + Math.random() * 2;
      ctx.beginPath();
      ctx.moveTo(x, SIZE);
      ctx.quadraticCurveTo(x + (Math.random() - 0.5) * 6, (SIZE + top) / 2, x + (Math.random() - 0.5) * 12, top);
      ctx.stroke();
    }
  });
}
