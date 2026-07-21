/**
 * Procedurally generates full-sphere (equirectangular) textures for pool
 * balls, using the reference photo only as a visual guide for colors and
 * label style. A flat crop of a photo can never cover the far side of a
 * sphere, so each ball is modeled as a real texture that has color
 * information everywhere — including the parts a single photo never shows.
 */

const WHITE = '#f5f1e6';
const INK = '#141414';

/** Base solid-ball hue -> hex, chosen to sit at well-separated HSV hues. */
const BASE_COLORS = {
  1: { hex: '#f2b705', label: '黃色' },
  2: { hex: '#1c4fa0', label: '藍色' },
  3: { hex: '#d81f26', label: '紅色' },
  4: { hex: '#e0679e', label: '粉紅色' },
  5: { hex: '#6c4a9c', label: '紫色' },
  6: { hex: '#1e8449', label: '綠色' },
  7: { hex: '#7b3f1d', label: '棕色' },
  8: { hex: '#141414', label: '黑色' },
};

/**
 * @typedef {object} BallDef
 * @property {number|'cue'} key
 * @property {number|null} number
 * @property {string} colorLabel
 * @property {'solid'|'stripe'|'cue'} type
 * @property {string} typeLabel
 */

/**
 * @param {number|'cue'} ballKey
 * @returns {BallDef}
 */
export function getBallDef(ballKey) {
  if (ballKey === 'cue') {
    return { key: 'cue', number: null, colorLabel: '白色', type: 'cue', typeLabel: '母球（白球）' };
  }
  const number = Number(ballKey);
  const isStripe = number > 8;
  const baseNumber = isStripe ? number - 8 : number;
  const base = BASE_COLORS[baseNumber];
  return {
    key: number,
    number,
    colorLabel: base.label,
    type: isStripe ? 'stripe' : 'solid',
    typeLabel: isStripe ? '花色（條紋）' : '實色',
  };
}

/**
 * Draws one white number-label circle (white disc + black ring + digits)
 * centered at (cx, cy) with the given radius.
 * @param {CanvasRenderingContext2D} ctx
 */
function drawLabel(ctx, cx, cy, radius, number) {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = WHITE;
  ctx.fill();
  ctx.lineWidth = radius * 0.12;
  ctx.strokeStyle = INK;
  ctx.stroke();

  ctx.fillStyle = INK;
  ctx.font = `bold ${Math.round(radius * 1.15)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), cx, cy + radius * 0.05);
}

/**
 * Builds an equirectangular canvas texture for the given ball. Mapped onto
 * a default THREE.SphereGeometry, image-y runs pole-to-pole and image-x
 * wraps around the equator, so a horizontal band centered vertically is a
 * literal stripe belt around the ball's middle.
 * @param {number|'cue'} ballKey
 * @returns {HTMLCanvasElement}
 */
export function createBallTexture(ballKey) {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (ballKey === 'cue') {
    ctx.fillStyle = WHITE;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(width * 0.5, height * 0.24, height * 0.02, 0, Math.PI * 2);
    ctx.fill();
    return canvas;
  }

  const number = Number(ballKey);
  const isStripe = number > 8;
  const baseNumber = isStripe ? number - 8 : number;
  const color = BASE_COLORS[baseNumber].hex;

  if (isStripe) {
    ctx.fillStyle = WHITE;
    ctx.fillRect(0, 0, width, height);

    const bandTop = height * 0.28;
    const bandBottom = height * 0.72;
    ctx.fillStyle = color;
    ctx.fillRect(0, bandTop, width, bandBottom - bandTop);

    // thin black seam where the colored band meets the white cap — the
    // detail that lets color analysis tell e.g. 3 (solid) from 11 (stripe)
    // apart even when both look like a plain patch of the same red hue.
    const seam = height * 0.02;
    ctx.fillStyle = INK;
    ctx.fillRect(0, bandTop - seam / 2, width, seam);
    ctx.fillRect(0, bandBottom - seam / 2, width, seam);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
  }

  const labelRadius = height * 0.11;
  for (const uFrac of [0.25, 0.75]) {
    drawLabel(ctx, width * uFrac, height * 0.5, labelRadius, number);
  }

  return canvas;
}

/** All selectable ball keys, in a sensible display order. */
export const ALL_BALL_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 'cue'];
