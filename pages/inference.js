// YOLOv8n inference pipeline — preprocessing, postprocessing, NMS
// Ported from test_ikabotapi.py

const CLASSES = [
  "B", "2", "D", "X", "5", "M", "W", "A", "7", "4",
  "N", "L", "P", "V", "J", "H", "C", "3", "U", "Q",
  "Y", "S", "T", "K", "R", "E", "G", "F",
];

const SCORE_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.45;
const MODEL_SIZE = 640;

/**
 * Preprocess an image for YOLOv8n inference.
 * @param {ImageData} imageData — RGBA pixel data from canvas
 * @returns {{ tensor: Float32Array, scale: number }}
 */
function preprocess(imageData) {
  const { width, height, data } = imageData;
  const length = Math.max(width, height);
  const scale = length / MODEL_SIZE;

  // Create padded square canvas, resize to 640x640
  const padCanvas = new OffscreenCanvas(length, length);
  const padCtx = padCanvas.getContext("2d");
  // Black background by default
  const srcCanvas = new OffscreenCanvas(width, height);
  const srcCtx = srcCanvas.getContext("2d");
  srcCtx.putImageData(imageData, 0, 0);
  padCtx.drawImage(srcCanvas, 0, 0);

  const resizeCanvas = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE);
  const resizeCtx = resizeCanvas.getContext("2d");
  resizeCtx.drawImage(padCanvas, 0, 0, MODEL_SIZE, MODEL_SIZE);
  const resized = resizeCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);

  // Normalize to [0,1] float32, RGBA→RGB, HWC→CHW
  const pixels = resized.data;
  const chw = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  const planeSize = MODEL_SIZE * MODEL_SIZE;
  for (let i = 0; i < planeSize; i++) {
    const rgbaIdx = i * 4;
    chw[i] = pixels[rgbaIdx] / 255;                     // R
    chw[planeSize + i] = pixels[rgbaIdx + 1] / 255;     // G
    chw[2 * planeSize + i] = pixels[rgbaIdx + 2] / 255; // B
  }

  return { tensor: chw, scale };
}

/**
 * NMS — non-maximum suppression. Boxes are [x, y, w, h].
 */
function nms(boxes, scores, iouThreshold) {
  if (boxes.length === 0) return [];

  const x1 = boxes.map(b => b[0]);
  const y1 = boxes.map(b => b[1]);
  const x2 = boxes.map(b => b[0] + b[2]);
  const y2 = boxes.map(b => b[1] + b[3]);
  const areas = boxes.map(b => b[2] * b[3]);

  const order = scores
    .map((s, i) => [s, i])
    .sort((a, b) => b[0] - a[0])
    .map(pair => pair[1]);

  const keep = [];
  const suppressed = new Uint8Array(order.length);

  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    if (suppressed[oi]) continue;
    keep.push(i);

    for (let oj = oi + 1; oj < order.length; oj++) {
      if (suppressed[oj]) continue;
      const j = order[oj];

      const xx1 = Math.max(x1[i], x1[j]);
      const yy1 = Math.max(y1[i], y1[j]);
      const xx2 = Math.min(x2[i], x2[j]);
      const yy2 = Math.min(y2[i], y2[j]);
      const w = Math.max(0, xx2 - xx1);
      const h = Math.max(0, yy2 - yy1);
      const inter = w * h;
      const iou = inter / (areas[i] + areas[j] - inter);

      if (iou > iouThreshold) suppressed[oj] = 1;
    }
  }
  return keep;
}

/**
 * Postprocess YOLOv8n output into a captcha string.
 * @param {Float32Array} outputData — raw model output, shape (1, 32, 8400)
 * @param {number} scale
 * @returns {string}
 */
function postprocess(outputData, scale) {
  // Output is (1, 32, 8400) flattened. Transpose to (8400, 32).
  const rows = 8400;
  const cols = 32;

  const boxes = [];
  const scores = [];
  const classIds = [];

  for (let i = 0; i < rows; i++) {
    // Transposed access: output[i][j] = outputData[j * rows + i]
    let maxScore = -1;
    let maxIdx = 0;
    for (let c = 4; c < cols; c++) {
      const score = outputData[c * rows + i];
      if (score > maxScore) {
        maxScore = score;
        maxIdx = c - 4;
      }
    }

    if (maxScore >= SCORE_THRESHOLD) {
      const cx = outputData[0 * rows + i];
      const cy = outputData[1 * rows + i];
      const w = outputData[2 * rows + i];
      const h = outputData[3 * rows + i];
      boxes.push([cx - 0.5 * w, cy - 0.5 * h, w, h]);
      scores.push(maxScore);
      classIds.push(maxIdx);
    }
  }

  const keep = nms(boxes, scores, IOU_THRESHOLD);

  const detections = keep.map(idx => ({
    className: CLASSES[classIds[idx]],
    confidence: scores[idx],
    x: boxes[idx][0],
  }));

  detections.sort((a, b) => a.x - b.x);
  return detections.map(d => d.className).join("").toLowerCase();
}

// Export for use in offscreen.js
if (typeof globalThis !== "undefined") {
  globalThis.inference = { preprocess, postprocess };
}
