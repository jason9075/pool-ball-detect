/**
 * Simulates a coin-op pool table's ball-return rail: the ball rolls down
 * an inclined channel and settles against a gate, where a fixed inspection
 * camera (the kind real tables use to detect the 8-ball) frames it with a
 * bounding box. Unlike the main preview's analysis — which nulls out the
 * background for a clean alpha mask — this crop is the raw rectangle the
 * camera would actually capture: a tight box around a circle always leaves
 * the four corners showing whatever is behind the ball, which is exactly
 * the kind of background interference a real detector has to tolerate.
 *
 * The physics here are scripted easing, not a rigid-body simulation — good
 * enough to look and move like a real rolling ball without pulling in a
 * physics engine for one short animation.
 */

import * as THREE from 'three';
import { analyzeBallTexture, classifyBall, hsvToHex } from './colorAnalysis.js';
import { flipRowsVertically, buildHighlightMaskCanvas, buildDebugListHtml, wireDebugRowHover } from './pixelHighlight.js';

const BALL_RADIUS = 0.5;
const ROLL_DURATION_MS = 1500;
const START_POS = new THREE.Vector3(3.4, BALL_RADIUS + 1.05, 0.05);
const END_POS = new THREE.Vector3(0, BALL_RADIUS, 0);
const BBOX_PADDING = 1.04; // a little loose, not pixel-perfect, but still a tight detector box

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Render-target readback is linear; re-encode to sRGB before HSV analysis. */
function linearToSrgb8(channel8) {
  const c = channel8 / 255;
  const srgb = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(srgb * 255)));
}

/**
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {HTMLCanvasElement} opts.overlayCanvas
 * @param {HTMLElement} opts.resultElement
 * @param {HTMLElement} opts.statusElement
 * @param {THREE.Texture} opts.background
 * @param {THREE.Texture} opts.environment
 */
export function initTableSimulation({
  canvas,
  overlayCanvas,
  resultElement,
  statusElement,
  background,
  environment,
}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = background;
  scene.environment = environment;

  // Positioned close to the gate and steeply above it — looking down the
  // long axis of the rail (a shallow, grazing angle) makes the floor's
  // near edge visually swallow the ball, so this stays short and steep.
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
  camera.position.set(0.75, 1.5, 1.5);
  camera.lookAt(END_POS.x, END_POS.y, END_POS.z);

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(2, 3, 2);
  scene.add(key);

  // ---- rail geometry ----
  // Split into two pieces instead of one long rotated box: a rough "approach
  // ramp" for visual context while the ball is rolling (never seen up close,
  // so it doesn't need to precisely track the ball's height along a tilted,
  // rotated box), and a flat, unrotated "landing platform" whose top is set
  // to exactly ball-radius below the resting spot — this is what the fixed
  // camera actually frames, so it needs to be exact, not approximated.
  const railDir = new THREE.Vector3().subVectors(END_POS, START_POS).normalize();
  const railQuaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), railDir);
  const railMat = new THREE.MeshStandardMaterial({ color: 0x2b1d12, roughness: 0.85 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1a120b, roughness: 0.9 });

  const rampLength = START_POS.distanceTo(END_POS);
  const rampMid = new THREE.Vector3().lerpVectors(START_POS, END_POS, 0.5);
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(rampLength, 0.12, BALL_RADIUS * 2.6), railMat);
  ramp.position.set(rampMid.x, rampMid.y - BALL_RADIUS - 0.06, rampMid.z);
  ramp.quaternion.copy(railQuaternion);
  scene.add(ramp);

  const platformTopY = END_POS.y - BALL_RADIUS;
  const platformLength = 1.6;
  const platform = new THREE.Mesh(new THREE.BoxGeometry(platformLength, 0.12, BALL_RADIUS * 2.6), railMat);
  platform.position.set(END_POS.x + platformLength * 0.3, platformTopY - 0.06, END_POS.z);
  scene.add(platform);

  for (const side of [1, -1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(platformLength, 0.3, 0.08), wallMat);
    wall.position.set(platform.position.x, platformTopY + 0.15, END_POS.z + side * BALL_RADIUS * 1.3);
    scene.add(wall);
  }

  const gate = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.4, BALL_RADIUS * 2.6), wallMat);
  gate.position.set(END_POS.x - BALL_RADIUS - 0.08, platformTopY + 0.2, END_POS.z);
  scene.add(gate);

  // ---- ball ----
  const sphereGeometry = new THREE.SphereGeometry(BALL_RADIUS, 48, 48);
  const sphereMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  sphereMaterial.envMapIntensity = 1;
  const ball = new THREE.Mesh(sphereGeometry, sphereMaterial);
  ball.visible = false;
  scene.add(ball);

  const rollAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), railDir).normalize();
  const totalDistance = START_POS.distanceTo(END_POS);

  const overlayCtx = overlayCanvas.getContext('2d');
  const analysisTarget = new THREE.WebGLRenderTarget(1, 1);

  let rolling = false;
  let animStart = 0;
  let lastDistanceAlong = 0;
  /** @type {ReturnType<typeof computeScreenBBoxAt> | null} */
  let fixedBBoxRect = null;
  /** @type {{width: number, height: number, categoryMap: Uint8Array} | null} */
  let lastCrop = null;
  let hoveredCategory = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    renderer.setSize(rect.width, rect.height, false);
    overlayCanvas.width = rect.width * (window.devicePixelRatio || 1);
    overlayCanvas.height = rect.height * (window.devicePixelRatio || 1);
    overlayCtx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    // .project() needs camera.matrixWorldInverse, which is only refreshed
    // during a render pass — resize() runs before the first one, so without
    // this the projection below uses a stale (identity-ish) matrix.
    camera.updateMatrixWorld(true);
    // The ball always settles at the same world position (END_POS), so the
    // camera's framing of it is always the same too — computed once here
    // rather than re-derived from the ball's live position after every
    // roll, which drifted slightly with each settle-bounce's exact phase.
    fixedBBoxRect = computeScreenBBoxAt(END_POS, rect);
  }
  window.addEventListener('resize', resize);
  resize();

  function clearOverlay() {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  /** Projects a world bounding sphere to a screen-pixel bbox (top-left origin). */
  function computeScreenBBoxAt(worldPos, rect) {
    const centerNDC = worldPos.clone().project(camera);
    const rightWorld = worldPos
      .clone()
      .add(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(BALL_RADIUS));
    const upWorld = worldPos
      .clone()
      .add(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(BALL_RADIUS));
    const rightNDC = rightWorld.project(camera);
    const upNDC = upWorld.project(camera);

    const toPxX = (ndcX) => (ndcX * 0.5 + 0.5) * rect.width;
    const toPxY = (ndcY) => (1 - (ndcY * 0.5 + 0.5)) * rect.height;

    const centerPx = { x: toPxX(centerNDC.x), y: toPxY(centerNDC.y) };
    const radiusPx =
      Math.max(Math.abs(toPxX(rightNDC.x) - centerPx.x), Math.abs(toPxY(upNDC.y) - centerPx.y)) * BBOX_PADDING;

    return {
      x: Math.round(centerPx.x - radiusPx),
      y: Math.round(centerPx.y - radiusPx),
      width: Math.round(radiusPx * 2),
      height: Math.round(radiusPx * 2),
      canvasWidth: Math.round(rect.width),
      canvasHeight: Math.round(rect.height),
    };
  }

  function drawBBoxOverlay(rect) {
    clearOverlay();
    overlayCtx.strokeStyle = '#5eb3ff';
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    overlayCtx.font = 'bold 12px system-ui, sans-serif';
    overlayCtx.fillStyle = '#5eb3ff';
    overlayCtx.fillText('bbox', rect.x + 4, rect.y - 6 < 10 ? rect.y + 14 : rect.y - 6);
  }

  function redrawOverlay() {
    if (!fixedBBoxRect) return;
    drawBBoxOverlay(fixedBBoxRect);
    if (hoveredCategory !== null && lastCrop) {
      const maskCanvas = buildHighlightMaskCanvas(lastCrop, hoveredCategory);
      overlayCtx.drawImage(maskCanvas, fixedBBoxRect.x, fixedBBoxRect.y, fixedBBoxRect.width, fixedBBoxRect.height);
    }
  }

  /** @param {ReturnType<typeof classifyBall>} result */
  function renderSimResult(result) {
    if (!result.ok) {
      resultElement.innerHTML = `<p class="error-text">${result.reason}</p>`;
      return;
    }
    const swatchColor = result.debug?.hue !== undefined
      ? hsvToHex(result.debug.hue, result.debug.sat, result.debug.val)
      : result.colorKey === 'black'
        ? '#111'
        : '#f5f5f5';
    const numberText = result.number === null ? '—' : `#${result.number}`;

    resultElement.innerHTML = `
      <div class="result-grid">
        <div class="swatch" style="background:${swatchColor}"></div>
        <div class="result-main">
          <div class="number">${numberText}</div>
          <div class="label">${result.colorLabel}・${result.typeLabel}</div>
        </div>
        <ul class="debug-list">${buildDebugListHtml(result.debug)}</ul>
      </div>
    `;

    wireDebugRowHover(resultElement, (category) => {
      hoveredCategory = category;
      redrawOverlay();
    });
  }

  function analyzeBBoxCrop(rect) {
    const w = Math.max(4, Math.min(rect.width, rect.canvasWidth));
    const h = Math.max(4, Math.min(rect.height, rect.canvasHeight));
    const x = Math.max(0, Math.min(rect.x, rect.canvasWidth - w));
    const yTop = Math.max(0, Math.min(rect.y, rect.canvasHeight - h));
    const pixelRatio = renderer.getPixelRatio();
    const fullW = Math.round(rect.canvasWidth * pixelRatio);
    const fullH = Math.round(rect.canvasHeight * pixelRatio);

    analysisTarget.setSize(fullW, fullH);
    renderer.setRenderTarget(analysisTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    // readRenderTargetPixels uses a bottom-left origin; our bbox is top-left.
    const cropW = Math.round(w * pixelRatio);
    const cropH = Math.round(h * pixelRatio);
    const cropX = Math.round(x * pixelRatio);
    const cropYGl = fullH - Math.round(yTop * pixelRatio) - cropH;

    const buffer = new Uint8Array(cropW * cropH * 4);
    renderer.readRenderTargetPixels(analysisTarget, cropX, cropYGl, cropW, cropH, buffer);

    for (let i = 0; i < buffer.length; i += 4) {
      buffer[i] = linearToSrgb8(buffer[i]);
      buffer[i + 1] = linearToSrgb8(buffer[i + 1]);
      buffer[i + 2] = linearToSrgb8(buffer[i + 2]);
      // every pixel in a raw bbox crop is "in frame" — background corners
      // included — so nothing here should read as an alpha-excluded pixel.
      buffer[i + 3] = 255;
    }

    const analysis = analyzeBallTexture({ data: buffer, width: cropW, height: cropH }, { trackCategories: true });
    // A raw bbox crop carries a higher baseline black level than the main
    // preview's clean circular mask — HDRI corners and the gate/rail edge
    // both count as "in frame" here. The main panel's threshold would flag
    // that baseline interference as a visible stripe cap on every ball.
    renderSimResult(classifyBall(analysis, { stripeBlackThreshold: 0.22 }));

    // categoryMap was built against GL's bottom-up row order; flip it to
    // match the top-down order the highlight mask is drawn in.
    lastCrop = analysis?.categoryMap
      ? { width: cropW, height: cropH, categoryMap: flipRowsVertically(analysis.categoryMap, cropW, cropH, 1) }
      : null;
    hoveredCategory = null;
  }

  function onSettled() {
    statusElement.textContent = '球已停在閥門，正在用 bbox 裁切分析…';
    drawBBoxOverlay(fixedBBoxRect);
    analyzeBBoxCrop(fixedBBoxRect);
  }

  /**
   * @param {HTMLCanvasElement} textureCanvas
   * @param {import('./ballTexture.js').BallDef} ballDef
   */
  function rollBall(textureCanvas, ballDef) {
    const oldTexture = sphereMaterial.map;
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    sphereMaterial.map = texture;
    sphereMaterial.needsUpdate = true;
    if (oldTexture) {
      try {
        oldTexture.dispose();
      } catch {
        /* stale context, nothing to clean up */
      }
    }

    ball.position.copy(START_POS);
    // A random starting orientation (not just a fixed roll distance) means
    // which face ends up toward the camera varies between rolls — matches
    // how a real ball never starts a roll in the exact same orientation.
    ball.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
    ball.visible = true;
    clearOverlay();
    lastCrop = null;
    hoveredCategory = null;

    const numberText = ballDef.number === null ? '母球' : `#${ballDef.number}`;
    statusElement.textContent = `${numberText}（${ballDef.colorLabel}・${ballDef.typeLabel}）正在滾動…`;
    resultElement.innerHTML = '<p class="placeholder">球停止後，這裡會顯示 bbox 裁切的分析結果。</p>';

    lastDistanceAlong = 0;
    animStart = performance.now();
    rolling = true;
  }

  function animate() {
    requestAnimationFrame(animate);

    if (rolling) {
      const elapsed = performance.now() - animStart;
      const t = Math.min(1, elapsed / ROLL_DURATION_MS);
      const eased = easeOutCubic(t);
      const pos = new THREE.Vector3().lerpVectors(START_POS, END_POS, eased);

      if (t > 0.82) {
        const settleT = (t - 0.82) / 0.18;
        pos.y += Math.max(0, Math.sin(settleT * Math.PI * 3) * (1 - settleT) * 0.045);
      }

      const distanceAlong = eased * totalDistance;
      ball.rotateOnWorldAxis(rollAxis, (distanceAlong - lastDistanceAlong) / BALL_RADIUS);
      lastDistanceAlong = distanceAlong;
      ball.position.copy(pos);

      if (t >= 1) {
        rolling = false;
        onSettled();
      }
    }

    renderer.render(scene, camera);
  }
  animate();

  return { rollBall };
}
