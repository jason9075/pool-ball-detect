/**
 * OpenCV.js-based replacement for analyzeBallTexture's pixel-counting core.
 * Same HSV thresholds, but with one real capability the hand-rolled loop
 * doesn't have: morphological cleanup + connected-component filtering on
 * the black mask, so scattered background-interference pixels (e.g. from
 * the camera-simulation's raw bbox crop) don't count the same as a real,
 * contiguous black cap — a few stray dark pixels in a corner no longer
 * inflate blackRatio the way a plain per-pixel ratio would.
 *
 * OpenCV.js Mats are WASM heap objects, not garbage-collected — every Mat
 * created here is explicitly .delete()'d, since this runs ~7.5 times/sec
 * and a leak would exhaust the WASM heap within seconds.
 */

import cvModule from '@techstark/opencv-js';

let cvInstance = null;
let cvLoadingPromise = null;

/** @returns {Promise<void>} resolves once cv.* functions are usable */
export function initOpenCv() {
  if (!cvLoadingPromise) {
    cvLoadingPromise = (async () => {
      let cv;
      if (cvModule instanceof Promise) {
        cv = await cvModule;
      } else if (cvModule.Mat) {
        cv = cvModule;
      } else {
        await new Promise((resolve) => {
          cvModule.onRuntimeInitialized = resolve;
        });
        cv = cvModule;
      }
      cvInstance = cv;
    })();
  }
  return cvLoadingPromise;
}

export function isOpenCvReady() {
  return cvInstance !== null;
}

/** Minimum connected-component area, as a fraction of total pixels, to count as a real blob rather than noise. */
const MIN_BLOB_AREA_FRACTION = 0.01;
const HUE_BINS = 36;

/**
 * @param {ImageData | {data: Uint8Array, width: number, height: number}} imageData
 * @param {object} [options]
 * @param {boolean} [options.trackCategories]
 * @returns {import('./colorAnalysis.js').BallAnalysis | null}
 */
export function analyzeBallTextureCv(imageData, { trackCategories = false } = {}) {
  const cv = cvInstance;
  if (!cv) return null;

  const { data, width, height } = imageData;
  const mats = [];
  const track = (mat) => {
    mats.push(mat);
    return mat;
  };

  try {
    const rgba = track(cv.matFromArray(height, width, cv.CV_8UC4, data));

    const channels = track(new cv.MatVector());
    cv.split(rgba, channels);
    const alphaMask = track(new cv.Mat());
    cv.threshold(channels.get(3), alphaMask, 199, 255, cv.THRESH_BINARY);
    const validCount = cv.countNonZero(alphaMask);
    if (validCount === 0) return null;

    const bgr = track(new cv.Mat());
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    const hsv = track(new cv.Mat());
    cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);

    const hsvChannels = track(new cv.MatVector());
    cv.split(hsv, hsvChannels);
    const hMat = hsvChannels.get(0); // 0-179
    const sMat = hsvChannels.get(1); // 0-255
    const vMat = hsvChannels.get(2); // 0-255

    // Thresholds mirror colorAnalysis.js exactly, rescaled from 0-1 to 0-255.
    const notSpecular = track(new cv.Mat());
    cv.threshold(vMat, notSpecular, 0.88 * 255, 255, cv.THRESH_BINARY_INV);

    const blackRaw = track(new cv.Mat());
    cv.threshold(vMat, blackRaw, 0.22 * 255, 255, cv.THRESH_BINARY_INV);
    const blackMaskRaw = track(new cv.Mat());
    cv.bitwise_and(blackRaw, alphaMask, blackMaskRaw);

    // The improvement OpenCV enables: open (erode+dilate) to drop
    // salt-and-pepper noise, then keep only components at least
    // MIN_BLOB_AREA_FRACTION of the frame — a real black cap is one
    // solid region; scattered interference pixels never form one.
    const kernel = track(cv.Mat.ones(3, 3, cv.CV_8U));
    const blackOpened = track(new cv.Mat());
    cv.morphologyEx(blackMaskRaw, blackOpened, cv.MORPH_OPEN, kernel);

    const labels = track(new cv.Mat());
    const stats = track(new cv.Mat());
    const centroids = track(new cv.Mat());
    const numLabels = cv.connectedComponentsWithStats(blackOpened, labels, stats, centroids);
    const minArea = width * height * MIN_BLOB_AREA_FRACTION;
    const keepLabel = new Uint8Array(numLabels); // avoids extra Mat allocs per label
    let blackCount = 0;
    for (let label = 1; label < numLabels; label++) {
      const area = stats.intAt(label, cv.CC_STAT_AREA);
      if (area < minArea) continue;
      keepLabel[label] = 1;
      blackCount += area;
    }
    const blackMask = track(new cv.Mat.zeros(height, width, cv.CV_8U));
    const labelsData = labels.data32S;
    const blackMaskData = blackMask.data;
    for (let i = 0; i < labelsData.length; i++) {
      if (keepLabel[labelsData[i]]) blackMaskData[i] = 255;
    }

    const litRaw = track(new cv.Mat());
    cv.threshold(vMat, litRaw, 0.35 * 255, 255, cv.THRESH_BINARY);
    const litMask = track(new cv.Mat());
    cv.bitwise_and(litRaw, notSpecular, litMask);
    cv.bitwise_and(litMask, alphaMask, litMask);
    const litCount = cv.countNonZero(litMask);

    // Low saturation alone means "neutral" within the already-lit range —
    // no extra brightness requirement (see the matching comment in
    // colorAnalysis.js for why that broke cue-ball detection).
    const sLow = track(new cv.Mat());
    cv.threshold(sMat, sLow, 0.32 * 255, 255, cv.THRESH_BINARY_INV);
    const whiteMask = track(new cv.Mat());
    cv.bitwise_and(sLow, litMask, whiteMask);
    const whiteCount = cv.countNonZero(whiteMask);

    const notWhite = track(new cv.Mat());
    cv.bitwise_not(whiteMask, notWhite);
    const chromaticMask = track(new cv.Mat());
    cv.bitwise_and(notWhite, litMask, chromaticMask);
    const chromaticCount = cv.countNonZero(chromaticMask);

    // Weighted hue histogram (weight = s*v) restricted to chromaticMask —
    // OpenCV's calcHist has no weight parameter, so this part stays a
    // direct pass over the typed-array views, same as the hand-rolled path.
    const binWeight = new Float64Array(HUE_BINS);
    const binSat = new Float64Array(HUE_BINS);
    const binVal = new Float64Array(HUE_BINS);
    const binCount = new Uint32Array(HUE_BINS);
    const hData = hMat.data;
    const sData = sMat.data;
    const vData = vMat.data;
    const maskData = chromaticMask.data;
    const categoryMap = trackCategories ? new Uint8Array(width * height) : null;
    for (let i = 0; i < maskData.length; i++) {
      if (categoryMap) {
        if (blackMask.data[i]) categoryMap[i] = 1;
        else if (whiteMask.data[i]) categoryMap[i] = 2;
        else if (maskData[i]) categoryMap[i] = 3;
      }
      if (!maskData[i]) continue;
      const h = (hData[i] / 179) * 360;
      const s = sData[i] / 255;
      const v = vData[i] / 255;
      const bin = Math.min(HUE_BINS - 1, Math.floor(h / 10));
      const weight = s * v;
      binWeight[bin] += weight;
      binSat[bin] += s;
      binVal[bin] += v;
      binCount[bin]++;
    }

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
        ? { hue: bestBin * 10 + 5, sat: binSat[bestBin] / binCount[bestBin], val: binVal[bestBin] / binCount[bestBin] }
        : null;

    return {
      validCount,
      blackRatio: blackCount / validCount,
      whiteRatio: litCount > 0 ? whiteCount / litCount : 0,
      chromaticRatio: litCount > 0 ? chromaticCount / litCount : 0,
      dominant,
      categoryMap,
    };
  } finally {
    for (const mat of mats) mat.delete();
  }
}
