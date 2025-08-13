// stereo-img.js (updated version with fixes for VR entry and rendering issues)

import { parseVR, parseStereo, parseAnaglyph, parseDepth, parseTexture } from './parsers.js';
import { VRButton } from './VRButton.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as THREE from 'three';

class StereoImg extends HTMLElement {
  static get observedAttributes() {
    return ['type', 'angle', 'debug', 'projection', 'wiggle', 'src', 'src-right'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 100%;
        }
        canvas {
          width: 100%;
          height: 100%;
        }
      </style>
      <canvas></canvas>
    `;

    this.canvas = this.shadowRoot.querySelector('canvas');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.xr.enabled = true; // Enable XR for VR support
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.25;

    this.leftEye = null;
    this.rightEye = null;
    this.wiggleInterval = null;
    this.isWiggling = false;

    this.animate = this.animate.bind(this);
  }

  connectedCallback() {
    this.resize();
    window.addEventListener('resize', this.resize.bind(this));
    this.parse(); // Initial parse on connection
  }

  disconnectedCallback() {
    window.removeEventListener('resize', this.resize.bind(this));
    if (this.wiggleInterval) clearInterval(this.wiggleInterval);
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      this.parse();
    }
  }

  resize() {
    const width = this.clientWidth;
    const height = this.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  async parse() {
    const type = this.getAttribute('type') || 'auto';
    const src = this.getAttribute('src');
    const srcRight = this.getAttribute('src-right');
    const angle = parseFloat(this.getAttribute('angle')) || 180;
    const debug = this.hasAttribute('debug');
    const projection = this.getAttribute('projection') || 'equirectangular';
    const wiggle = this.hasAttribute('wiggle');

    if (!src) return;

    let leftTexture, rightTexture;

    try {
      if (type === 'auto' || type === 'vr') {
        const { left, right } = await parseVR(src);
        leftTexture = left;
        rightTexture = right;
      } else if (type === 'left-right' || type === 'top-bottom') {
        const { left, right } = await parseStereo(src, type);
        leftTexture = left;
        rightTexture = right;
      } else if (type === 'anaglyph') {
        const { left, right } = await parseAnaglyph(src);
        leftTexture = left;
        rightTexture = right;
      } else if (type === 'depth') {
        const { left, right } = await parseDepth(src, srcRight);
        leftTexture = left;
        rightTexture = right;
      } else {
        leftTexture = await parseTexture(src);
        rightTexture = leftTexture; // Mono fallback
      }

      // Resize textures if necessary to fit GPU limits
      const maxSize = this.renderer.capabilities.maxTextureSize;
      [leftTexture, rightTexture].forEach(tex => {
        if (tex.image.width > maxSize || tex.image.height > maxSize) {
          const aspect = tex.image.width / tex.image.height;
          tex.image.width = Math.min(tex.image.width, maxSize);
          tex.image.height = tex.image.width / aspect;
        }
      });

      this.createEye(leftTexture, rightTexture, angle, projection, debug);

      if (wiggle) {
        this.toggleWiggle(true);
      } else {
        this.toggleWiggle(false);
      }

      this.animate();
    } catch (error) {
      console.error('Error parsing image:', error);
    }
  }

  createEye(leftTexture, rightTexture, angle, projection, debug) {
    // Clear previous eyes
    if (this.leftEye) this.scene.remove(this.leftEye);
    if (this.rightEye) this.scene.remove(this.rightEye);

    const radius = 1;
    const geometry = (angle >= 360) ? new THREE.SphereGeometry(radius, 60, 40) : new THREE.PlaneGeometry(2, 2);

    // Left eye
    const leftMaterial = new THREE.MeshBasicMaterial({ map: leftTexture, side: THREE.DoubleSide });
    this.leftEye = new THREE.Mesh(geometry, leftMaterial);
    this.leftEye.scale.x = -1; // Flip for inside-out sphere
    this.scene.add(this.leftEye);

    // Right eye
    const rightMaterial = new THREE.MeshBasicMaterial({ map: rightTexture, side: THREE.DoubleSide });
    this.rightEye = new THREE.Mesh(geometry, rightMaterial);
    this.rightEye.scale.x = -1;
    this.rightEye.visible = false; // Initially show left for mono
    this.scene.add(this.rightEye);

    // Adjust UVs for fisheye or other projections
    if (projection === 'fisheye') {
      const uvAttribute = geometry.attributes.uv;
      for (let i = 0; i < uvAttribute.count; i++) {
        const u = uvAttribute.getX(i);
        const v = uvAttribute.getY(i);
        // Re-set the UVs of the sphere for fisheye correction
        const theta = u * Math.PI * (angle / 180);
        const phi = (v - 0.5) * Math.PI;
        uvAttribute.setXY(i, (theta / Math.PI) * 0.5 + 0.5, (phi / Math.PI) + 0.5);
      }
      uvAttribute.needsUpdate = true;
    }

    this.camera.position.set(0, 0, 0);

    if (debug) {
      console.log('Eyes created:', { left: leftTexture, right: rightTexture });
    }
  }

  toggleWiggle(enable) {
    if (this.wiggleInterval) clearInterval(this.wiggleInterval);
    this.isWiggling = enable;
    if (enable) {
      this.wiggleInterval = setInterval(() => {
        this.leftEye.visible = !this.leftEye.visible;
        this.rightEye.visible = !this.rightEye.visible;
      }, 500);
    } else {
      this.leftEye.visible = true;
      this.rightEye.visible = false;
    }
  }

  animate() {
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }
}

customElements.define('stereo-img', StereoImg);

export { StereoImg };
