import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { analyzeBallTexture, classifyBall, hsvToHex } from './colorAnalysis.js';
import { createBallTexture, getBallDef } from './ballTexture.js';

const IMAGE_URL = '/pool_balls.jpg';

// Grid layout of the reference photo, used only to map a click position to
// a ball identity — pixel colors from the photo itself are never analyzed.
const GRID = [
  [1, 2, 3, 4],
  [8, 7, 6, 5],
  [9, 10, 11, 12],
  ['cue', 15, 14, 13],
];
const GRID_SPACING = 104;
const GRID_BASE = 67;

const sourceCanvas = document.getElementById('source-canvas');
const overlayCanvas = document.getElementById('overlay-canvas');
const resultContent = document.getElementById('result-content');
const selectionCaption = document.getElementById('selection-caption');

const sourceCtx = sourceCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');

/** @type {HTMLImageElement} */
let sourceImage;

loadImage(IMAGE_URL).then((img) => {
  sourceImage = img;
  sourceCanvas.width = img.naturalWidth;
  sourceCanvas.height = img.naturalHeight;
  overlayCanvas.width = img.naturalWidth;
  overlayCanvas.height = img.naturalHeight;
  sourceCtx.drawImage(img, 0, 0);
});

/**
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** @param {PointerEvent} event */
function toCanvasCoords(event) {
  const rect = sourceCanvas.getBoundingClientRect();
  const scaleX = sourceCanvas.width / rect.width;
  const scaleY = sourceCanvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

/**
 * @param {{x: number, y: number}} point
 * @returns {{ballKey: number|'cue', col: number, row: number} | null}
 */
function pickBallAt(point) {
  const col = Math.round((point.x - GRID_BASE) / GRID_SPACING);
  const row = Math.round((point.y - GRID_BASE) / GRID_SPACING);
  if (row < 0 || row > 3 || col < 0 || col > 3) return null;

  const cellCenter = { x: GRID_BASE + col * GRID_SPACING, y: GRID_BASE + row * GRID_SPACING };
  const distance = Math.hypot(point.x - cellCenter.x, point.y - cellCenter.y);
  if (distance > GRID_SPACING * 0.6) return null;

  return { ballKey: GRID[row][col], col, row };
}

sourceCanvas.addEventListener('click', (event) => {
  if (!sourceImage) return;
  const picked = pickBallAt(toCanvasCoords(event));
  if (!picked) return;

  drawPickHighlight(picked.col, picked.row);
  loadBall(picked.ballKey);
});

/**
 * @param {number} col
 * @param {number} row
 */
function drawPickHighlight(col, row) {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayCtx.beginPath();
  overlayCtx.arc(GRID_BASE + col * GRID_SPACING, GRID_BASE + row * GRID_SPACING, 50, 0, Math.PI * 2);
  overlayCtx.strokeStyle = '#5eb3ff';
  overlayCtx.lineWidth = Math.max(2, overlayCanvas.width * 0.006);
  overlayCtx.stroke();
}

/**
 * @param {import('./colorAnalysis.js').BallClassification} result
 * @param {import('./ballTexture.js').BallDef} truth
 */
function renderResult(result, truth) {
  if (!result.ok) {
    resultContent.innerHTML = `<p class="error-text">${result.reason}</p>`;
    return;
  }

  const swatchColor = result.debug?.hue !== undefined
    ? hsvToHex(result.debug.hue, result.debug.sat, result.debug.val)
    : result.colorKey === 'black'
      ? '#111'
      : '#f5f5f5';

  const numberText = result.number === null ? '—' : `#${result.number}`;
  const isCorrect = result.number === truth.number;
  const debugLines = result.debug
    ? Object.entries(result.debug)
        .map(([key, value]) => `<li>${key}: ${typeof value === 'number' ? value.toFixed(2) : value}</li>`)
        .join('')
    : '';

  resultContent.innerHTML = `
    <div class="result-grid">
      <div class="swatch" style="background:${swatchColor}"></div>
      <div class="result-main">
        <div class="number ${isCorrect ? 'match' : 'mismatch'}">${numberText}</div>
        <div class="label">${result.colorLabel}・${result.typeLabel}</div>
      </div>
      <ul class="debug-list">${debugLines}</ul>
    </div>
  `;
}

// ---- three.js rotatable ball preview ----

const ballCanvas = document.getElementById('ball-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas: ballCanvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0.9, 2.7);

const controls = new OrbitControls(camera, ballCanvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 1.5;
controls.maxDistance = 6;

// Fairly even lighting from two sides — this app's classifier relies on
// reading the currently-visible face's true colors, so heavy one-sided
// shading (like a real product photo) would hide information rather than
// just look dramatic.
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
keyLight.position.set(2, 2, 3);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
fillLight.position.set(-2, -1, -3);
scene.add(fillLight);

const sphereGeometry = new THREE.SphereGeometry(1, 64, 64);
const sphereMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6 });
const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
scene.add(sphere);

/** @type {Map<number|'cue', HTMLCanvasElement>} */
const textureCache = new Map();
/** @type {import('./ballTexture.js').BallDef | null} */
let currentTruth = null;

/** @param {number|'cue'} ballKey */
function loadBall(ballKey) {
  currentBallKey = ballKey;
  let textureCanvas = textureCache.get(ballKey);
  if (!textureCanvas) {
    textureCanvas = createBallTexture(ballKey);
    textureCache.set(ballKey, textureCanvas);
  }

  const oldTexture = sphereMaterial.map;
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  sphereMaterial.map = texture;
  sphereMaterial.needsUpdate = true;
  // disposing a texture that belongs to a since-lost-and-restored GL
  // context throws; harmless to skip since that context is already gone
  if (oldTexture) {
    try {
      oldTexture.dispose();
    } catch {
      /* stale context, nothing to clean up */
    }
  }

  currentTruth = getBallDef(ballKey);
  const numberText = currentTruth.number === null ? '母球' : `#${currentTruth.number}`;
  selectionCaption.textContent = `你選擇的是：${numberText}（${currentTruth.colorLabel}・${currentTruth.typeLabel}）`;

  runAnalysis();
}

let currentBallKey = null;
ballCanvas.addEventListener('webglcontextrestored', () => {
  // GPU-side texture uploads from before the loss are gone; reload the
  // current ball fresh so the restored context has correct texture data.
  if (currentBallKey !== null) loadBall(currentBallKey);
});

function resizeRenderer() {
  const rect = ballCanvas.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', resizeRenderer);
resizeRenderer();

// ---- live "current face" color analysis ----

// Rendered separately from the display canvas, at a fixed low resolution —
// reading pixels back from the main canvas via drawImage()/getImageData()
// is unreliable with a premultiplied-alpha WebGL context under software
// rendering, so analysis renders into its own WebGLRenderTarget instead.
const analysisSize = 200;
const analysisTarget = new THREE.WebGLRenderTarget(analysisSize, analysisSize);
const analysisBuffer = new Uint8Array(analysisSize * analysisSize * 4);

/**
 * Render targets store linear color (three.js only sRGB-encodes the final
 * screen framebuffer), so a raw readback looks darker/blacker than what's
 * actually on screen. Encode back to sRGB before running HSV analysis.
 * @param {number} channel8 0-255
 */
function linearToSrgb8(channel8) {
  const c = channel8 / 255;
  const srgb = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(srgb * 255)));
}

function runAnalysis() {
  if (!currentTruth) return;
  renderer.setRenderTarget(analysisTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.readRenderTargetPixels(analysisTarget, 0, 0, analysisSize, analysisSize, analysisBuffer);

  for (let i = 0; i < analysisBuffer.length; i += 4) {
    analysisBuffer[i] = linearToSrgb8(analysisBuffer[i]);
    analysisBuffer[i + 1] = linearToSrgb8(analysisBuffer[i + 1]);
    analysisBuffer[i + 2] = linearToSrgb8(analysisBuffer[i + 2]);
  }

  const analysis = analyzeBallTexture({ data: analysisBuffer, width: analysisSize, height: analysisSize });
  const result = classifyBall(analysis);
  renderResult(result, currentTruth);
}

const ANALYSIS_INTERVAL_MS = 130;
let lastAnalysisTime = 0;

function animate(time) {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);

  if (currentTruth && time - lastAnalysisTime > ANALYSIS_INTERVAL_MS) {
    lastAnalysisTime = time;
    runAnalysis();
  }
}
animate(0);

loadBall(1);
