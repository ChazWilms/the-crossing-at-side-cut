import * as THREE from 'three';

// Export these for compatibility, though they aren't used for internal rendering anymore
export const RENDER_WIDTH = window.innerWidth;
export const RENDER_HEIGHT = window.innerHeight;

/**
 * We no longer apply retro material quirks! 
 * This simply returns the material unchanged for high-definition rendering.
 */
export function applyRetroMaterial(material) {
  return material;
}

/**
 * A standard, high-definition WebGLRenderer with shadows enabled.
 */
export class RetroRenderer {
  constructor(canvasParent = document.body) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // Cap the pixel ratio — full retina with bloom + shadows is brutal on laptops.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    
    // Enable High-Quality Shadows
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Filmic response curve — the single biggest step away from the flat
    // "WebGL demo" look toward console-era color.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    canvasParent.appendChild(this.renderer.domElement);

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  render(scene, camera) {
    this.renderer.render(scene, camera);
  }
}

