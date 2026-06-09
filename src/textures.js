import * as THREE from 'three';

// All textures are generated at runtime onto tiny canvases — 64x64 with
// nearest filtering reads as authentically low-budget PSX.
const SIZE = 64;

function makeCanvasTexture(draw, repeat = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  draw(canvas.getContext('2d'));
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
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
  return noiseTexture('#4a5d33', ['#3c4d28', '#5a7040', '#2f3d1f', '#677d49'], 0.5, repeat);
}

export function dirtTexture(repeat) {
  return noiseTexture('#6b5436', ['#5a462c', '#7d6440', '#4d3c25', '#857049'], 0.5, repeat);
}

export function forestFloorTexture(repeat) {
  return noiseTexture('#3d4429', ['#2f361f', '#4d5533', '#56492e', '#262c18'], 0.6, repeat);
}

export function riverRockTexture(repeat) {
  return makeCanvasTexture((ctx) => {
    ctx.fillStyle = '#5d5a52';
    ctx.fillRect(0, 0, SIZE, SIZE);
    // Round overlapping pebbles.
    for (let i = 0; i < 90; i++) {
      const shade = 70 + Math.floor(Math.random() * 60);
      ctx.fillStyle = `rgb(${shade}, ${shade - 4}, ${shade - 10})`;
      ctx.beginPath();
      ctx.arc(
        Math.random() * SIZE,
        Math.random() * SIZE,
        2 + Math.random() * 4,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }, repeat);
}

export function stoneTexture(repeat) {
  return makeCanvasTexture((ctx) => {
    ctx.fillStyle = '#6e6a60';
    ctx.fillRect(0, 0, SIZE, SIZE);
    // Horizontal strata — reads as stacked flat stones on the tower.
    for (let y = 0; y < SIZE; y += 4 + Math.floor(Math.random() * 3)) {
      const shade = 80 + Math.floor(Math.random() * 50);
      ctx.fillStyle = `rgb(${shade}, ${shade - 5}, ${shade - 12})`;
      ctx.fillRect(0, y, SIZE, 3 + Math.floor(Math.random() * 2));
      ctx.fillStyle = 'rgba(20, 18, 14, 0.6)';
      ctx.fillRect(0, y - 1, SIZE, 1);
      // Vertical joints between stones.
      for (let x = Math.floor(Math.random() * 8); x < SIZE; x += 6 + Math.floor(Math.random() * 8)) {
        ctx.fillRect(x, y, 1, 4);
      }
    }
  }, repeat);
}

export function barkTexture(repeat) {
  return makeCanvasTexture((ctx) => {
    ctx.fillStyle = '#4d3f2f';
    ctx.fillRect(0, 0, SIZE, SIZE);
    for (let x = 0; x < SIZE; x += 2 + Math.floor(Math.random() * 3)) {
      const shade = 50 + Math.floor(Math.random() * 35);
      ctx.fillStyle = `rgb(${shade + 15}, ${shade}, ${Math.floor(shade * 0.7)})`;
      ctx.fillRect(x, 0, 1 + Math.floor(Math.random() * 2), SIZE);
    }
  }, repeat);
}

export function waterTexture(repeat) {
  return noiseTexture('#2b3a42', ['#243239', '#33444d', '#1d2930', '#3b4f59'], 0.35, repeat);
}
