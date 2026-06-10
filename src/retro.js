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
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    
    // Enable High-Quality Shadows
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    canvasParent.appendChild(this.renderer.domElement);

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  render(scene, camera) {
    this.renderer.render(scene, camera);
  }
}

