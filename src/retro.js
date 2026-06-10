import * as THREE from 'three';

// Internal render resolution — the whole game renders to this small target,
// then gets upscaled with nearest-neighbor filtering. 2x the PSX-native
// 320x240: still chunky, but twice the clarity.
export const RENDER_WIDTH = 640;
export const RENDER_HEIGHT = 480;

// Vertex positions snap to the render-resolution grid — a hint of PSX
// polygon jitter without the distracting wobble of a coarser grid.
const SNAP = new THREE.Vector2(RENDER_WIDTH, RENDER_HEIGHT);

/**
 * Patches a built-in Three.js material with the two PSX-era quirks:
 *  - vertex snapping (low-precision transform wobble)
 *  - affine texture mapping (textures warp because there's no perspective
 *    correction; we emulate it by un-correcting the UVs ourselves)
 */
export function applyRetroMaterial(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSnap = { value: SNAP };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        'uniform vec2 uSnap;\nvarying float vAffineW;\n#include <common>'
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        // Snap only in front of the camera (negative w mirrors vertices
        // behind the near plane), and fade the snap out as w approaches
        // zero — a hard cutoff folds triangles whose vertices straddle it.
        if (gl_Position.w > 0.0) {
          vec3 ndc = gl_Position.xyz / gl_Position.w;
          vec2 snapped = floor(ndc.xy * uSnap) / uSnap;
          float snapFade = clamp((gl_Position.w - 0.3) / 0.7, 0.0, 1.0);
          ndc.xy = mix(ndc.xy, snapped, snapFade);
          gl_Position.xyz = ndc * gl_Position.w;
        }
        vAffineW = max(gl_Position.w, 0.001);
        #ifdef USE_MAP
          vMapUv *= vAffineW;
        #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        'varying float vAffineW;\n#include <common>'
      )
      .replace(
        'vec4 sampledDiffuseColor = texture2D( map, vMapUv );',
        'vec4 sampledDiffuseColor = texture2D( map, vMapUv / vAffineW );'
      );
  };
  return material;
}

/**
 * Wraps a WebGLRenderer so the scene draws into a low-res target that is
 * blitted to the screen as one big pixelated quad.
 */
export class RetroRenderer {
  constructor(canvasParent = document.body) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    canvasParent.appendChild(this.renderer.domElement);

    this.target = new THREE.WebGLRenderTarget(RENDER_WIDTH, RENDER_HEIGHT, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });

    this.blitScene = new THREE.Scene();
    this.blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.blitScene.add(
      new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({ map: this.target.texture })
      )
    );

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  render(scene, camera) {
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.blitScene, this.blitCamera);
  }
}
