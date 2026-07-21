import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { analyzeBallTexture, classifyBall, hsvToHex } from './colorAnalysis.js';
import { createBallTexture, getBallDef } from './ballTexture.js';
import { initTableSimulation } from './tableSimulation.js';
import { initOpenCv, isOpenCvReady, analyzeBallTextureCv } from './openCvAnalysis.js';
import {
  flipRowsVertically,
  buildHighlightMaskCanvas,
  buildDebugListHtml,
  debugListMatches,
  updateDebugListValues,
  wireDebugRowHover,
} from './pixelHighlight.js';
import hdrUrl from '../assets/cowboy_town_saloon_1k.hdr?url';

// OpenCV.js is a ~10MB WASM download — start fetching it immediately so
// it's ready well before the user finishes picking a ball, but fall back
// to the hand-rolled analyzer for the few frames before it resolves.
initOpenCv();

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

  // This runs on a continuous ~130ms loop — rebuilding the debug list's DOM
  // every tick would detach a row out from under the mouse before a hover
  // could ever register. When the same set of stats is already rendered,
  // update values/colors in place instead of touching the DOM structure.
  if (debugListMatches(resultContent, result.debug)) {
    resultContent.querySelector('.swatch').style.background = swatchColor;
    const numberEl = resultContent.querySelector('.number');
    numberEl.textContent = numberText;
    numberEl.className = `number ${isCorrect ? 'match' : 'mismatch'}`;
    resultContent.querySelector('.label').textContent = `${result.colorLabel}・${result.typeLabel}`;
    if (result.debug) updateDebugListValues(resultContent, result.debug);
    return;
  }

  resultContent.innerHTML = `
    <div class="result-grid">
      <div class="swatch" style="background:${swatchColor}"></div>
      <div class="result-main">
        <div class="number ${isCorrect ? 'match' : 'mismatch'}">${numberText}</div>
        <div class="label">${result.colorLabel}・${result.typeLabel}</div>
      </div>
      <ul class="debug-list">${buildDebugListHtml(result.debug)}</ul>
    </div>
  `;

  wireDebugRowHover(resultContent, (category) => {
    hoveredBallCategory = category;
    redrawBallOverlay();
  });
}

// ---- three.js rotatable ball preview ----

const ballCanvas = document.getElementById('ball-canvas');
const ballOverlayCanvas = document.getElementById('ball-overlay-canvas');
const ballOverlayCtx = ballOverlayCanvas.getContext('2d');
const renderer = new THREE.WebGLRenderer({
  canvas: ballCanvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

/** @type {{width: number, height: number, categoryMap: Uint8Array} | null} */
let lastBallCrop = null;
let hoveredBallCategory = null;

function redrawBallOverlay() {
  ballOverlayCtx.clearRect(0, 0, ballOverlayCanvas.width, ballOverlayCanvas.height);
  if (hoveredBallCategory === null || !lastBallCrop) return;
  const maskCanvas = buildHighlightMaskCanvas(lastBallCrop, hoveredBallCategory);
  // The analysis frame is a square render of the whole visible ball, same
  // aspect as the (CSS-enforced square) display canvas, so it can just be
  // stretched to fill — no bbox positioning needed like the sim panel.
  const rect = ballCanvas.getBoundingClientRect();
  ballOverlayCtx.drawImage(maskCanvas, 0, 0, rect.width, rect.height);
}

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0.9, 2.7);

// Rotation is done by spinning the ball mesh itself (see the drag handlers
// below), not by orbiting the camera — with a skybox in the background,
// orbiting the camera would make the room appear to swing around the
// ball, which looks wrong. OrbitControls is kept only for scroll-to-zoom.
const controls = new OrbitControls(camera, ballCanvas);
controls.enableDamping = true;
controls.enableRotate = false;
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
// Higher than a real glossy ball would be — gives a small but measurable
// improvement in how much of a dark, saturated color (brown, green) reads
// as its true hue rather than washed-out gray. That gray band turned out
// to come mostly from ambient light's flat contribution dominating near
// the grazing-angle/silhouette edge, not from specular sheen — lowering
// ambient to fix it pushes those same regions below the "lit enough to
// classify" cutoff instead, which is worse, so this is a partial mitigation.
const sphereMaterial = new THREE.MeshStandardMaterial({ roughness: 0.85 });
// Full strength is fine for the visible display — runAnalysis() strips
// scene.environment out for its own offscreen render, so this never
// touches the HSV thresholds the classifier is calibrated against.
sphereMaterial.envMapIntensity = 1;
const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
scene.add(sphere);

// ---- drag-to-spin the ball (camera and background stay put) ----

const SPIN_SPEED = 0.006; // radians of ball rotation per pixel of drag
const SPIN_DAMPING = 0.92; // per-frame velocity decay once the drag ends

let isSpinning = false;
let lastPointerPos = { x: 0, y: 0 };
let spinVelocity = { x: 0, y: 0 };

ballCanvas.addEventListener('pointerdown', (event) => {
  isSpinning = true;
  lastPointerPos = { x: event.clientX, y: event.clientY };
  spinVelocity = { x: 0, y: 0 };
  ballCanvas.setPointerCapture(event.pointerId);
});

ballCanvas.addEventListener('pointermove', (event) => {
  if (!isSpinning) return;
  const dx = event.clientX - lastPointerPos.x;
  const dy = event.clientY - lastPointerPos.y;
  lastPointerPos = { x: event.clientX, y: event.clientY };

  spinVelocity = { x: dy * SPIN_SPEED, y: dx * SPIN_SPEED };
  sphere.rotation.x += spinVelocity.x;
  sphere.rotation.y += spinVelocity.y;
});

const stopSpinning = () => {
  isSpinning = false;
};
ballCanvas.addEventListener('pointerup', stopSpinning);
ballCanvas.addEventListener('pointercancel', stopSpinning);

/** @type {Map<number|'cue', HTMLCanvasElement>} */
const textureCache = new Map();
/** @type {import('./ballTexture.js').BallDef | null} */
let currentTruth = null;
let currentBallKey = null;

// Skybox + image-based "dome light" — the crisp equirect texture is used
// for the visible background, while a PMREM-filtered version drives
// environment lighting/reflections on the material.
/** @type {ReturnType<typeof initTableSimulation> | null} */
let simulation = null;
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();
new RGBELoader().load(hdrUrl, (hdrTexture) => {
  hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = hdrTexture;
  const envMap = pmremGenerator.fromEquirectangular(hdrTexture).texture;
  scene.environment = envMap;
  pmremGenerator.dispose();

  simulation = initTableSimulation({
    canvas: document.getElementById('sim-canvas'),
    overlayCanvas: document.getElementById('sim-overlay-canvas'),
    resultElement: document.getElementById('sim-result-content'),
    statusElement: document.getElementById('sim-status'),
    background: hdrTexture,
    environment: envMap,
  });
  if (currentBallKey !== null) {
    simulation.rollBall(textureCache.get(currentBallKey), currentTruth);
  }
});

document.getElementById('sim-replay-button').addEventListener('click', () => {
  if (simulation && currentBallKey !== null) {
    simulation.rollBall(textureCache.get(currentBallKey), currentTruth);
  }
});

// Spins the HDRI dome (skybox + the lighting/reflections it drives) around
// the vertical axis only, independent of the ball's own drag-to-spin — lets
// you see how the ball looks lit from a different direction without
// changing which face is pointed at the camera.
document.getElementById('dome-light-slider').addEventListener('input', (event) => {
  const radians = (Number(event.target.value) * Math.PI) / 180;
  scene.environmentRotation.y = radians;
  scene.backgroundRotation.y = radians;
  runAnalysis();
});

/** @param {number|'cue'} ballKey */
function loadBall(ballKey) {
  currentBallKey = ballKey;
  sphere.rotation.set(0, 0, 0);
  spinVelocity = { x: 0, y: 0 };
  hoveredBallCategory = null;
  redrawBallOverlay();
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
  if (simulation) simulation.rollBall(textureCanvas, currentTruth);
}

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

  const dpr = window.devicePixelRatio || 1;
  ballOverlayCanvas.width = rect.width * dpr;
  ballOverlayCanvas.height = rect.height * dpr;
  ballOverlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  // Analysis must see the ball's calibrated lighting only — the skybox
  // would leak into the alpha-masked background, and the HDRI env light
  // washes out the black/white thresholds the classifier is tuned around.
  // Both are swapped out for this offscreen pass only, then restored so
  // the interactive display keeps full dome lighting + skybox.
  const displayBackground = scene.background;
  const displayEnvironment = scene.environment;
  scene.background = null;
  scene.environment = null;
  renderer.setRenderTarget(analysisTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  scene.environment = displayEnvironment;
  scene.background = displayBackground;
  renderer.readRenderTargetPixels(analysisTarget, 0, 0, analysisSize, analysisSize, analysisBuffer);

  for (let i = 0; i < analysisBuffer.length; i += 4) {
    analysisBuffer[i] = linearToSrgb8(analysisBuffer[i]);
    analysisBuffer[i + 1] = linearToSrgb8(analysisBuffer[i + 1]);
    analysisBuffer[i + 2] = linearToSrgb8(analysisBuffer[i + 2]);
  }

  const frame = { data: analysisBuffer, width: analysisSize, height: analysisSize };
  const opts = { trackCategories: true };
  const analysis = isOpenCvReady() ? analyzeBallTextureCv(frame, opts) : analyzeBallTexture(frame, opts);
  const result = classifyBall(analysis);
  renderResult(result, currentTruth);

  lastBallCrop = analysis?.categoryMap
    ? { width: analysisSize, height: analysisSize, categoryMap: flipRowsVertically(analysis.categoryMap, analysisSize, analysisSize, 1) }
    : null;
  // Note: hover state is intentionally NOT reset here — this runs on a
  // continuous ~130ms loop, and clearing it every tick would make the
  // highlight flicker away almost as soon as the user hovers a stat. If
  // they're currently hovering, redraw with the freshly analyzed pixels
  // (keeps the highlight in sync as the ball rotates); loadBall() resets
  // the hover state when the ball itself changes.
  if (hoveredBallCategory !== null) redrawBallOverlay();
}

const ANALYSIS_INTERVAL_MS = 130;
let lastAnalysisTime = 0;

function animate(time) {
  requestAnimationFrame(animate);
  controls.update();

  if (!isSpinning && (Math.abs(spinVelocity.x) > 0.0001 || Math.abs(spinVelocity.y) > 0.0001)) {
    sphere.rotation.x += spinVelocity.x;
    sphere.rotation.y += spinVelocity.y;
    spinVelocity.x *= SPIN_DAMPING;
    spinVelocity.y *= SPIN_DAMPING;
  }

  renderer.render(scene, camera);

  if (currentTruth && time - lastAnalysisTime > ANALYSIS_INTERVAL_MS) {
    lastAnalysisTime = time;
    runAnalysis();
  }
}
animate(0);

loadBall(1);
