/**
 * Shared "which pixels made up this stat" visualization: a color swatch
 * next to each ratio in a debug list, and a hover handler that highlights
 * the matching pixels on top of whichever image the stat was measured
 * from. Used by both the main preview panel (the whole visible face) and
 * the camera-simulation panel (a bbox crop) — same category codes, same
 * highlight colors, same swatch-building logic either way.
 */

import { hsvToHex } from './colorAnalysis.js';

/** category codes matching analyzeBallTexture's / analyzeBallTextureCv's categoryMap */
export const CATEGORY = { BLACK: 1, WHITE: 2, CHROMATIC: 3 };

export const HIGHLIGHT_COLOR = {
  [CATEGORY.BLACK]: [255, 77, 77],
  [CATEGORY.WHITE]: [77, 210, 255],
  [CATEGORY.CHROMATIC]: [163, 255, 77],
};

/** WebGL readback rows run bottom-to-top; canvas drawing wants top-to-bottom. */
export function flipRowsVertically(typedArray, width, height, channels) {
  const rowSize = width * channels;
  const flipped = new typedArray.constructor(typedArray.length);
  for (let y = 0; y < height; y++) {
    const srcStart = y * rowSize;
    const dstStart = (height - 1 - y) * rowSize;
    flipped.set(typedArray.subarray(srcStart, srcStart + rowSize), dstStart);
  }
  return flipped;
}

/**
 * Builds a same-size RGBA mask canvas highlighting only pixels of one category.
 * @param {{width: number, height: number, categoryMap: Uint8Array}} crop
 * @param {number} category
 */
export function buildHighlightMaskCanvas(crop, category) {
  const { width, height, categoryMap } = crop;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskCtx = maskCanvas.getContext('2d');
  const imgData = maskCtx.createImageData(width, height);
  const [r, g, b] = HIGHLIGHT_COLOR[category];
  for (let i = 0; i < categoryMap.length; i++) {
    if (categoryMap[i] === category) {
      imgData.data[i * 4] = r;
      imgData.data[i * 4 + 1] = g;
      imgData.data[i * 4 + 2] = b;
      imgData.data[i * 4 + 3] = 190;
    }
  }
  maskCtx.putImageData(imgData, 0, 0);
  return maskCanvas;
}

const SWATCH_FOR_KEY_BASE = { whiteRatio: '#f5f1e6', blackRatio: '#141414' };
const CATEGORY_FOR_KEY = { whiteRatio: CATEGORY.WHITE, blackRatio: CATEGORY.BLACK, chromaticRatio: CATEGORY.CHROMATIC };

/**
 * Builds the <li> rows for a classification's debug stats. whiteRatio,
 * blackRatio, and chromaticRatio get a color swatch and a data-category
 * attribute (for hover-highlight wiring); hue/sat/val stay plain text.
 * Each row carries data-key so updateDebugListValues() can find it again
 * without rebuilding the DOM (rebuilding on every update would detach the
 * row out from under a hovering mouse before a hover can ever register —
 * this matters wherever analysis re-runs continuously, not just once).
 * @param {Record<string, number>} debug
 * @returns {string} HTML
 */
export function buildDebugListHtml(debug) {
  if (!debug) return '';
  const dominantColor = debug.hue !== undefined ? hsvToHex(debug.hue, debug.sat, debug.val) : '#888';
  const swatchForKey = { ...SWATCH_FOR_KEY_BASE, chromaticRatio: dominantColor };

  return Object.entries(debug)
    .map(([key, value]) => {
      const text = typeof value === 'number' ? value.toFixed(2) : value;
      if (!(key in swatchForKey)) return `<li data-key="${key}"><span class="debug-value">${key}: ${text}</span></li>`;
      return `<li class="debug-row" data-key="${key}" data-category="${CATEGORY_FOR_KEY[key]}">
        <span class="debug-swatch" style="background:${swatchForKey[key]}"></span><span class="debug-value">${key}: ${text}</span>
      </li>`;
    })
    .join('');
}

/**
 * @param {HTMLElement} container
 * @param {Record<string, number> | undefined} debug
 * @returns {boolean} true if container already has one [data-key] li per debug key, in the same order
 */
export function debugListMatches(container, debug) {
  const keys = Object.keys(debug || {});
  const existing = Array.from(container.querySelectorAll('[data-key]')).map((el) => el.dataset.key);
  return keys.length > 0 && keys.length === existing.length && keys.every((k, i) => k === existing[i]);
}

/**
 * Updates an already-built debug list's values/swatch colors in place,
 * without touching the DOM nodes themselves (preserves hover state).
 * @param {HTMLElement} container
 * @param {Record<string, number>} debug
 */
export function updateDebugListValues(container, debug) {
  const dominantColor = debug.hue !== undefined ? hsvToHex(debug.hue, debug.sat, debug.val) : '#888';
  const swatchForKey = { ...SWATCH_FOR_KEY_BASE, chromaticRatio: dominantColor };

  for (const [key, value] of Object.entries(debug)) {
    const li = container.querySelector(`[data-key="${key}"]`);
    if (!li) continue;
    const text = typeof value === 'number' ? value.toFixed(2) : value;
    const valueEl = li.querySelector('.debug-value');
    if (valueEl) valueEl.textContent = `${key}: ${text}`;
    const swatchEl = li.querySelector('.debug-swatch');
    if (swatchEl && key in swatchForKey) swatchEl.style.background = swatchForKey[key];
  }
}

/**
 * Wires hover/unhover on a result container's .debug-row elements to draw
 * highlighted pixels on an overlay canvas over the given crop. Call this
 * only when the rows are (re)built — updateDebugListValues() doesn't
 * disturb existing listeners, so it doesn't need rewiring.
 * @param {HTMLElement} container - holds the freshly-rendered .debug-row elements
 * @param {(category: number|null) => void} onHighlightChange - category or null to clear
 */
export function wireDebugRowHover(container, onHighlightChange) {
  container.querySelectorAll('.debug-row').forEach((row) => {
    const category = Number(row.dataset.category);
    row.addEventListener('mouseenter', () => onHighlightChange(category));
    row.addEventListener('mouseleave', () => onHighlightChange(null));
  });
}
