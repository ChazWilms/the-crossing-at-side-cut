import * as THREE from 'three';

// Procedural textures, PS2/PS3-era quality: 256px multi-layer canvases with
// smooth (linear, mipmapped, anisotropic) filtering instead of chunky
// nearest-neighbor pixels.

const registry = [];

/** Call once the renderer exists — sharpens ground textures at oblique angles. */
export function applyAnisotropy(max) {
  for (const t of registry) {
    t.anisotropy = max;
    t.needsUpdate = true;
  }
}

function makeTex(size, draw, repeat = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const t = new THREE.CanvasTexture(canvas);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  registry.push(t);
  return t;
}

// Large soft blotches — low-frequency variation that kills the "flat tile" look.
function blotches(ctx, size, colors, count, rMin, rMax, alpha) {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = rMin + Math.random() * (rMax - rMin);
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    const c = colors[Math.floor(Math.random() * colors.length)];
    g.addColorStop(0, `rgba(${c},${alpha})`);
    g.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function specks(ctx, size, colors, count, w = 2, h = 1) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
    ctx.fillRect(Math.random() * size, Math.random() * size, w * (0.5 + Math.random()), h * (0.5 + Math.random()));
  }
}

export function grassTexture(repeat) {
  return makeTex(256, (ctx, S) => {
    ctx.fillStyle = '#5a7242';
    ctx.fillRect(0, 0, S, S);
    blotches(ctx, S, ['52,74,38', '96,116,66', '70,92,48', '58,66,36'], 26, 26, 90, 0.28);
    specks(ctx, S, ['#4a5d33', '#6d8450', '#3f4f2a', '#7e955c', '#566b3c'], 5200, 2, 1);
    // Individual grass blades.
    for (let i = 0; i < 1500; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const len = 2.5 + Math.random() * 4;
      const lean = (Math.random() - 0.5) * 2.4;
      const shade = 86 + Math.floor(Math.random() * 56);
      ctx.strokeStyle = `rgba(${shade * 0.78},${shade},${shade * 0.5},0.55)`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + lean, y - len);
      ctx.stroke();
    }
  }, repeat);
}

export function forestFloorTexture(repeat) {
  return makeTex(256, (ctx, S) => {
    ctx.fillStyle = '#4c5430';
    ctx.fillRect(0, 0, S, S);
    blotches(ctx, S, ['58,52,30', '46,54,28', '74,66,40', '38,44,24'], 30, 20, 80, 0.3);
    specks(ctx, S, ['#3f4628', '#5d663e', '#665838', '#333a20', '#54603a'], 5200, 2, 1);
    // Fallen-leaf dapples.
    for (let i = 0; i < 240; i++) {
      const shade = 70 + Math.floor(Math.random() * 60);
      ctx.fillStyle = `rgba(${shade},${shade * 0.8},${shade * 0.45},0.5)`;
      ctx.beginPath();
      ctx.ellipse(Math.random() * S, Math.random() * S, 1.6 + Math.random() * 2, 1 + Math.random(), Math.random() * 3, 0, 7);
      ctx.fill();
    }
  }, repeat);
}

export function dirtTexture(repeat) {
  return makeTex(256, (ctx, S) => {
    ctx.fillStyle = '#97794f';
    ctx.fillRect(0, 0, S, S);
    blotches(ctx, S, ['122,94,56', '168,140,94', '106,82,48'], 24, 24, 90, 0.3);
    specks(ctx, S, ['#8a6c42', '#b09262', '#7a5e38', '#bfa172'], 4200, 2, 1);
    // Embedded pebbles with a lit top edge.
    for (let i = 0; i < 130; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const r = 1.2 + Math.random() * 2.6;
      const shade = 120 + Math.floor(Math.random() * 60);
      ctx.fillStyle = `rgb(${shade},${shade - 12},${shade - 30})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 7);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,240,210,0.25)';
      ctx.beginPath();
      ctx.arc(x - r * 0.25, y - r * 0.3, r * 0.5, 0, 7);
      ctx.fill();
    }
  }, repeat);
}

export function riverRockTexture(repeat) {
  return makeTex(256, (ctx, S) => {
    ctx.fillStyle = '#6e6a60';
    ctx.fillRect(0, 0, S, S);
    // Densely packed rounded stones, each shaded top-to-bottom.
    for (let i = 0; i < 560; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const r = 3 + Math.random() * 7;
      const base = 95 + Math.floor(Math.random() * 70);
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.15, x, y, r);
      g.addColorStop(0, `rgb(${base + 32},${base + 26},${base + 14})`);
      g.addColorStop(0.75, `rgb(${base},${base - 4},${base - 12})`);
      g.addColorStop(1, `rgb(${base - 38},${base - 40},${base - 44})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.7 + Math.random() * 0.3), Math.random() * 3, 0, 7);
      ctx.fill();
    }
  }, repeat);
}

export function stoneTexture(repeat) {
  return makeTex(256, (ctx, S) => {
    ctx.fillStyle = '#878276';
    ctx.fillRect(0, 0, S, S);
    let y = 0;
    while (y < S) {
      const h = 10 + Math.floor(Math.random() * 12);
      let x = -Math.floor(Math.random() * 30);
      while (x < S) {
        const w = 22 + Math.floor(Math.random() * 34);
        const base = 105 + Math.floor(Math.random() * 55);
        const g = ctx.createLinearGradient(x, y, x, y + h);
        g.addColorStop(0, `rgb(${base + 20},${base + 14},${base + 2})`);
        g.addColorStop(1, `rgb(${base - 22},${base - 26},${base - 32})`);
        ctx.fillStyle = g;
        ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
        x += w;
      }
      ctx.fillStyle = 'rgba(22,20,16,0.75)';
      ctx.fillRect(0, y, S, 2);
      y += h;
    }
    specks(ctx, S, ['rgba(40,38,32,0.4)', 'rgba(190,184,168,0.3)'], 1800, 2, 1);
  }, repeat);
}

export function barkTexture(repeat) {
  return makeTex(128, (ctx, S) => {
    ctx.fillStyle = '#4d3f2f';
    ctx.fillRect(0, 0, S, S);
    for (let x = 0; x < S; x += 2) {
      const shade = 48 + Math.floor(Math.random() * 42);
      const g = ctx.createLinearGradient(x, 0, x + 3, 0);
      g.addColorStop(0, `rgb(${shade + 18},${shade},${Math.floor(shade * 0.66)})`);
      g.addColorStop(1, `rgb(${shade - 8},${shade - 16},${Math.floor(shade * 0.5)})`);
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 2 + Math.random() * 2, S);
    }
    // Knots and fissures.
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = 'rgba(20,14,9,0.7)';
      ctx.beginPath();
      ctx.ellipse(Math.random() * S, Math.random() * S, 1.5 + Math.random() * 2, 4 + Math.random() * 9, 0, 0, 7);
      ctx.fill();
    }
  }, repeat);
}

export function waterTexture(repeat) {
  return makeTex(256, (ctx, S) => {
    ctx.fillStyle = '#41586a';
    ctx.fillRect(0, 0, S, S);
    blotches(ctx, S, ['52,76,92', '38,52,64', '70,96,110'], 22, 30, 100, 0.3);
    // Sinuous current lines.
    for (let i = 0; i < 60; i++) {
      const y0 = Math.random() * S;
      const light = Math.random() < 0.55;
      ctx.strokeStyle = light ? 'rgba(150,185,200,0.18)' : 'rgba(20,32,44,0.22)';
      ctx.lineWidth = 0.8 + Math.random() * 1.6;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      for (let x = 0; x <= S; x += 16) {
        ctx.lineTo(x, y0 + Math.sin(x * 0.05 + i) * 4);
      }
      ctx.stroke();
    }
  }, repeat);
}

export function asphaltTexture(repeat) {
  return makeTex(256, (ctx, S) => {
    ctx.fillStyle = '#46474b';
    ctx.fillRect(0, 0, S, S);
    blotches(ctx, S, ['56,57,62', '64,66,72', '50,50,54'], 20, 30, 90, 0.3);
    specks(ctx, S, ['#3b3c40', '#515257', '#36373a', '#5c5d63', '#65666c'], 6000, 1.5, 1.5);
    // Cracks.
    for (let i = 0; i < 7; i++) {
      ctx.strokeStyle = 'rgba(18,18,20,0.6)';
      ctx.lineWidth = 1;
      let x = Math.random() * S;
      let y = Math.random() * S;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let j = 0; j < 7; j++) {
        x += (Math.random() - 0.5) * 32;
        y += Math.random() * 22;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, repeat);
}

// One-shot texture for the whole lot: asphalt with painted parking stalls.
export function parkingLotTexture() {
  return makeTex(256, (ctx, S) => {
    ctx.fillStyle = '#46474b';
    ctx.fillRect(0, 0, S, S);
    specks(ctx, S, ['#3b3c40', '#515257', '#36373a', '#5c5d63'], 6000, 1.5, 1.5);
    ctx.fillStyle = 'rgba(210,202,186,0.85)';
    for (let x = 8; x < S; x += 52) {
      ctx.fillRect(x, 0, 4, 104);
    }
  });
}

export function concreteTexture(repeat) {
  return makeTex(256, (ctx, S) => {
    ctx.fillStyle = '#9a9588';
    ctx.fillRect(0, 0, S, S);
    blotches(ctx, S, ['141,138,126', '168,162,148', '130,125,112'], 18, 30, 90, 0.3);
    specks(ctx, S, ['#8d8a7e', '#a8a294', '#827d70', '#b3ac9c'], 3600, 2, 1);
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = 'rgba(60,56,48,0.5)';
      ctx.lineWidth = 0.8;
      let x = Math.random() * S;
      let y = 0;
      ctx.beginPath();
      ctx.moveTo(x, y);
      while (y < S) {
        x += (Math.random() - 0.5) * 20;
        y += 18 + Math.random() * 22;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, repeat);
}

// Soft radial mist puff for drifting fog cards.
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
  return makeTex(128, (ctx, S) => {
    ctx.clearRect(0, 0, S, S);
    for (let i = 0; i < 26; i++) {
      const x = 6 + Math.random() * (S - 12);
      const top = 14 + Math.random() * 52;
      const shade = 80 + Math.floor(Math.random() * 70);
      const g = ctx.createLinearGradient(x, S, x, top);
      g.addColorStop(0, `rgb(${shade * 0.55},${shade * 0.72},${shade * 0.36})`);
      g.addColorStop(1, `rgb(${shade * 0.8},${shade},${shade * 0.5})`);
      ctx.strokeStyle = g;
      ctx.lineWidth = 2.2 + Math.random() * 2.4;
      ctx.beginPath();
      ctx.moveTo(x, S);
      ctx.quadraticCurveTo(x + (Math.random() - 0.5) * 10, (S + top) / 2, x + (Math.random() - 0.5) * 22, top);
      ctx.stroke();
    }
  });
}
