/**
 * Pure color-analysis utilities for classifying whichever face of a pool
 * ball mesh currently faces the camera. Operates only on rendered pixel
 * data — it never reads the printed digit — so a face with no visible
 * number label can still be identified by its color/pattern composition.
 */

/**
 * Color -> {solid, stripe} ball number mapping. Hues match the exact hex
 * values used in ballTexture.js's BASE_COLORS, so boundaries below are
 * real midpoints between known colors rather than textbook guesses.
 */
const COLOR_TABLE = {
  yellow: { solid: 1, stripe: 9, label: '黃色' },
  blue: { solid: 2, stripe: 10, label: '藍色' },
  red: { solid: 3, stripe: 11, label: '紅色' },
  pink: { solid: 4, stripe: 12, label: '粉紅色' },
  purple: { solid: 5, stripe: 13, label: '紫色' },
  green: { solid: 6, stripe: 14, label: '綠色' },
  brown: { solid: 7, stripe: 15, label: '棕色' },
};

const HUE_BINS = 36; // 10° per bin

/**
 * @param {number} r 0-1
 * @param {number} g 0-1
 * @param {number} b 0-1
 * @returns {{h: number, s: number, v: number}} h in [0,360), s/v in [0,1]
 */
function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return { h, s, v };
}

/**
 * @typedef {object} BallAnalysis
 * @property {number} validCount
 * @property {number} whiteRatio
 * @property {number} blackRatio
 * @property {number} chromaticRatio
 * @property {{hue: number, sat: number, val: number} | null} dominant
 * @property {Uint8Array | null} categoryMap - per-pixel 0=excluded/1=black/2=white/3=chromatic, only when requested
 */

/**
 * Scans a cropped ball ImageData (alpha=0 outside the selection circle)
 * and summarizes its color composition.
 * @param {ImageData} imageData
 * @param {object} [options]
 * @param {boolean} [options.trackCategories] - populate the returned categoryMap
 * @returns {BallAnalysis | null}
 */
export function analyzeBallTexture(imageData, { trackCategories = false } = {}) {
  const { data, width, height } = imageData;
  const pixelCount = width * height;
  // Per-pixel category codes, only populated when requested: 0 = excluded
  // (background/specular/too-dim-to-classify), 1 = black, 2 = white,
  // 3 = chromatic. Lets a caller visualize which pixels fed which stat.
  const categoryMap = trackCategories ? new Uint8Array(pixelCount) : null;

  // A single fixed-angle photo of a glossy sphere is lit from one side, so
  // roughly half the ball falls into deep shadow regardless of its true
  // paint color. blackRatio (used for the 8-ball check) is measured across
  // the whole selection, but white-vs-color composition is only measured
  // among "lit" pixels — otherwise the shadowed half dilutes every ratio
  // toward the same middle value and erases the solid/stripe signal.
  const LIT_THRESHOLD = 0.35;

  let validCount = 0;
  let blackCount = 0;
  let litCount = 0;
  let whiteCount = 0;
  let chromaticCount = 0;

  const binWeight = new Float64Array(HUE_BINS);
  const binSat = new Float64Array(HUE_BINS);
  const binVal = new Float64Array(HUE_BINS);
  const binCount = new Uint32Array(HUE_BINS);

  for (let i = 0; i < pixelCount; i++) {
    const alpha = data[i * 4 + 3];
    if (alpha < 200) continue; // outside the circular selection mask

    validCount++;
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    const { h, s, v } = rgbToHsv(r, g, b);

    if (v > 0.88) continue; // specular highlight, not paint color
    if (v < 0.22) {
      // glossy black balls show a wide range of dark reflections, not just near-pure-black
      blackCount++;
      if (categoryMap) categoryMap[i] = 1;
      continue;
    }
    if (v < LIT_THRESHOLD) continue; // shadowed, low-confidence for hue/white reading

    litCount++;
    if (s < 0.32) {
      // Low saturation alone means "neutral", regardless of exact brightness
      // within the already-lit range — a v>0.55 sub-requirement here used
      // to force moderately-lit near-gray pixels (e.g. a cue ball's dimmer
      // areas, s≈0.06 but v≈0.5) into the chromatic bucket just for not
      // being bright enough, which is wrong: they're clearly neutral, not
      // colorful, and it was inflating chromaticRatio enough to break the
      // cue-ball detection gate below.
      whiteCount++;
      if (categoryMap) categoryMap[i] = 2;
      continue;
    }

    chromaticCount++;
    if (categoryMap) categoryMap[i] = 3;
    const bin = Math.min(HUE_BINS - 1, Math.floor(h / 10));
    const weight = s * v;
    binWeight[bin] += weight;
    binSat[bin] += s;
    binVal[bin] += v;
    binCount[bin]++;
  }

  if (validCount === 0) return null;

  let bestBin = -1;
  let bestWeight = 0;
  for (let i = 0; i < HUE_BINS; i++) {
    if (binWeight[i] > bestWeight) {
      bestWeight = binWeight[i];
      bestBin = i;
    }
  }

  const dominant =
    bestBin >= 0 && binCount[bestBin] > 0
      ? {
          hue: bestBin * 10 + 5,
          sat: binSat[bestBin] / binCount[bestBin],
          val: binVal[bestBin] / binCount[bestBin],
        }
      : null;

  return {
    validCount,
    blackRatio: blackCount / validCount,
    whiteRatio: litCount > 0 ? whiteCount / litCount : 0,
    chromaticRatio: litCount > 0 ? chromaticCount / litCount : 0,
    dominant,
    categoryMap,
  };
}

/**
 * Maps a dominant hue/sat to one of this set's pool ball color keys.
 * Boundaries are the real midpoints between BASE_COLORS' hues (brown 22°,
 * yellow 45°, green 145°, blue 217°, purple 265°, pink 333°, red 358°).
 * @param {number} hue
 * @param {number} sat
 * @returns {keyof typeof COLOR_TABLE | null}
 */
function hueToColorKey(hue, sat) {
  if (sat < 0.2) return null;
  if (hue >= 345 || hue < 10) return 'red';
  if (hue < 33) return 'brown';
  if (hue < 95) return 'yellow';
  if (hue < 181) return 'green';
  if (hue < 241) return 'blue';
  if (hue < 299) return 'purple';
  return 'pink';
}

/**
 * @typedef {object} BallClassification
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {number|null} [number]
 * @property {string} [colorKey]
 * @property {string} [colorLabel]
 * @property {'solid'|'stripe'|'cue'} [type]
 * @property {string} [typeLabel]
 * @property {object} [debug]
 */

/**
 * @param {BallAnalysis | null} analysis
 * @param {object} [options]
 * @param {number} [options.stripeBlackThreshold] - blackRatio above this
 *   reads as a visible stripe cap. Higher than the default is appropriate
 *   for noisier crops (e.g. a raw rectangular bbox with background
 *   corners included) where some baseline black is just interference,
 *   not the ball itself.
 * @returns {BallClassification}
 */
export function classifyBall(analysis, { stripeBlackThreshold = 0.12 } = {}) {
  if (!analysis) {
    return { ok: false, reason: '目前角度可分析的像素不足，請旋轉球體。' };
  }

  const { whiteRatio, blackRatio, chromaticRatio, dominant } = analysis;

  if (blackRatio > 0.5) {
    return {
      ok: true,
      number: 8,
      colorKey: 'black',
      colorLabel: '黑色',
      type: 'solid',
      typeLabel: '實色',
      debug: { whiteRatio, blackRatio, chromaticRatio },
    };
  }

  if (whiteRatio > 0.55 && chromaticRatio < 0.15 && blackRatio < 0.3) {
    return {
      ok: true,
      number: null,
      colorKey: 'white',
      colorLabel: '白色',
      type: 'cue',
      typeLabel: '母球（白球）',
      debug: { whiteRatio, blackRatio, chromaticRatio },
    };
  }

  if (!dominant) {
    return { ok: false, reason: '無法辨識出明顯的球色，請旋轉球體嘗試其他角度。' };
  }

  const colorKey = hueToColorKey(dominant.hue, dominant.sat);
  if (!colorKey || !COLOR_TABLE[colorKey]) {
    return {
      ok: false,
      reason: `偵測到色相約 ${Math.round(dominant.hue)}°，但無法對應到已知的撞球顏色。`,
    };
  }

  // Stripe balls are colored-band + black cap in this set (not the
  // traditional white cap), so a visible cap shows up as extra black
  // beyond the small amount every ball has from its label's ring/digit.
  const entry = COLOR_TABLE[colorKey];
  const isStripe = blackRatio > stripeBlackThreshold;
  const number = isStripe ? entry.stripe : entry.solid;

  return {
    ok: true,
    number,
    colorKey,
    colorLabel: entry.label,
    type: isStripe ? 'stripe' : 'solid',
    typeLabel: isStripe ? '花色（條紋）' : '實色',
    debug: { ...dominant, whiteRatio, blackRatio, chromaticRatio },
  };
}

/**
 * @param {number} h 0-360
 * @param {number} s 0-1
 * @param {number} v 0-1
 * @returns {string} CSS hex color
 */
export function hsvToHex(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const toHex = (n) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
