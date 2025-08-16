/* Detection: js-aruco2 (AR.Detector)
   Geometry/warp: OpenCV.js
   Feature parity with your desktop app: auto px/cm, rectification, zoom/pan, pairwise measurement, label nudge, save annotated.
   Additions in this version:
   - Delete Selected measurement via button or Delete/Backspace key
   - Save as <originalName>_annotated.jpg
*/

// ---------- Configuration ----------
const MARKER_SIZE_CM = 5.0;              // side length of your marker in cm
const JSARUCO_DICT_NAME = 'ARUCO';       // or 'ARUCO_MIP_36h12' if your prints are MIP36h12
const DEFAULT_PX_PER_CM = 20;


// ---------- DOM ----------
const cvs = document.getElementById('stage');
const ctx = cvs.getContext('2d');
const statusEl = document.getElementById('status');

const btnLoad = document.getElementById('btnLoad');
const btnReset = document.getElementById('btnReset');
const btnClear = document.getElementById('btnClear');
const btnSave = document.getElementById('btnSave');
const btnDelete = document.getElementById('btnDelete');
const chkAuto = document.getElementById('chkAuto');
const ppcInput = document.getElementById('ppc');
const nudgeInput = document.getElementById('nudgestep');
const fileInput = (() => {
  const el = document.createElement('input');
  el.type = 'file'; el.accept = 'image/*'; el.style.display = 'none';
  document.body.appendChild(el);
  return el;
})();

// ---------- State ----------
let srcBGR = null;           // cv.Mat (BGR)
let rectBGR = null;          // cv.Mat (BGR)
let H_img2cm = null;         // cv.Mat 3x3
let H_rect = null;           // cv.Mat 3x3
let rectSize = null;         // [w,h]
let pxPerCm = DEFAULT_PX_PER_CM;

let baseScale = 1, zoom = 1, pan = [0,0], offset = [0,0], scale = 1;
let measurements = [];       // {p1Rect:[x,y], p2Rect:[x,y], value, units, color, textOffset:[dx,dy]}
let clickPtsRect = [];
const colors = [
  "#c3ca04ff", "#00ffffff", "#d400ffff", "#32cd32", "#11e15aff",

  // brights across the hue wheel
  "#ef4444", // red
  "#8b5cf6", // purple
  "#3b82f6", // blue
  "#14b8a6", // teal deep
  "#84cc16", // lime
  "#f97316", // orange deep
  "#f0abfc", // fuchsia light
  "#93c5fd"  // blue light
];
let selectedLabelIndex = -1;

let detector = null;
let originalFilenameBase = 'annotated';  // used when saving

// ---------- Utilities ----------
const setStatus = (t) => statusEl.textContent = t;

function ensureCanvasSize() {
  const wrap = document.getElementById('stageWrap');
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (cvs.width !== w || cvs.height !== h) { cvs.width = w; cvs.height = h; }
}

function setBaseScaleFromMat(mat) {
  const cw = cvs.width, ch = cvs.height;
  baseScale = Math.min(cw / mat.cols, ch / mat.rows);
}

function matToImageBitmap(matBGR) {
  const rgba = new cv.Mat();
  cv.cvtColor(matBGR, rgba, cv.COLOR_BGR2RGBA);
  const id = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  rgba.delete();
  return createImageBitmap(id);
}

function render() {
  ensureCanvasSize();
  ctx.clearRect(0,0,cvs.width,cvs.height);
  const mat = rectBGR || srcBGR;
  if (!mat) return;

  const dispW = Math.max(1, Math.floor(mat.cols * baseScale * zoom));
  const dispH = Math.max(1, Math.floor(mat.rows * baseScale * zoom));
  offset = [Math.floor((cvs.width - dispW)/2) + Math.floor(pan[0]),
            Math.floor((cvs.height - dispH)/2) + Math.floor(pan[1])];
  scale = baseScale * zoom;

  matToImageBitmap(mat).then(bmp => {
    ctx.drawImage(bmp, offset[0], offset[1], dispW, dispH);
    drawOverlays();
  });
}

function rectToCanvas([x,y]) { return [offset[0] + x*scale, offset[1] + y*scale]; }
function canvasToRect([x,y]) { return [(x - offset[0]) / scale, (y - offset[1]) / scale]; }

function drawOverlays() {
  ctx.save();
  ctx.lineWidth = 2;
  for (let i=0;i<measurements.length;i++) {
    const m = measurements[i];
    const p1c = rectToCanvas(m.p1Rect);
    const p2c = rectToCanvas(m.p2Rect);
    ctx.strokeStyle = m.color;
    ctx.beginPath(); ctx.moveTo(p1c[0], p1c[1]); ctx.lineTo(p2c[0], p2c[1]); ctx.stroke();
    ctx.fillStyle = m.color;
    ctx.beginPath(); ctx.arc(p1c[0], p1c[1], 3, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(p2c[0], p2c[1], 3, 0, Math.PI*2); ctx.fill();

    const mid = [(p1c[0]+p2c[0])/2, (p1c[1]+p2c[1])/2];
    const tx = mid[0] + m.textOffset[0], ty = mid[1] + m.textOffset[1];
    ctx.font = 'bold 14px system-ui,Segoe UI,Roboto';
    ctx.fillText(`${m.value.toFixed(2)} ${m.units}`, tx, ty);

    // draw subtle selection marker (optional)
    if (i === selectedLabelIndex) {
      ctx.strokeStyle = '#7760faff';
      ctx.setLineDash([4,3]);
      ctx.strokeRect(tx-6, ty-16, ctx.measureText(`${m.value.toFixed(2)} ${m.units}`).width+12, 22);
      ctx.setLineDash([]);
    }
  }
  if (clickPtsRect.length % 2 === 1) {
    const last = rectToCanvas(clickPtsRect[clickPtsRect.length-1]);
    ctx.fillStyle = '#00ff3cff';
    ctx.beginPath(); ctx.arc(last[0], last[1], 3, 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

// ---------- Geometry helpers ----------
function orderCornersFloat32(pts8) {
  const pts = [];
  for (let i=0;i<4;i++) pts.push({x:pts8[2*i], y:pts8[2*i+1]});
  const sums = pts.map(p=>p.x+p.y);
  const diffs = pts.map(p=>p.y-p.x);
  const tl = pts[sums.indexOf(Math.min(...sums))];
  const br = pts[sums.indexOf(Math.max(...sums))];
  const tr = pts[diffs.indexOf(Math.min(...diffs))];
  const bl = pts[diffs.indexOf(Math.max(...diffs))];
  return new Float32Array([tl.x,tl.y, tr.x,tr.y, br.x,br.y, bl.x,bl.y]);
}

function computeH_img2cm(markerCornersImg, markerSizeCm) {
  const src = orderCornersFloat32(markerCornersImg);
  const dst = new Float32Array([0,0, markerSizeCm,0, markerSizeCm,markerSizeCm, 0,markerSizeCm]);
  const srcMat = cv.matFromArray(4,1,cv.CV_32FC2, src);
  const dstMat = cv.matFromArray(4,1,cv.CV_32FC2, dst);
  const H = cv.getPerspectiveTransform(srcMat, dstMat);
  srcMat.delete(); dstMat.delete();
  return H;
}

function perspectiveTransformPts(H, float2N) {
  const pts = cv.matFromArray(float2N.length/2,1,cv.CV_32FC2, new Float32Array(float2N));
  const out = new cv.Mat();
  cv.perspectiveTransform(pts, out, H);
  const r = out.data32F.slice(0, float2N.length);
  pts.delete(); out.delete();
  return r;
}

function buildRectification(H_img2cm, imgMat, pxPerCm, marginCm=0) {
  const w = imgMat.cols, h = imgMat.rows;
  const imgCorners = new Float32Array([0,0, w-1,0, w-1,h-1, 0,h-1]);
  const cmCorners = perspectiveTransformPts(H_img2cm, imgCorners);
  const xs = [cmCorners[0],cmCorners[2],cmCorners[4],cmCorners[6]];
  const ys = [cmCorners[1],cmCorners[3],cmCorners[5],cmCorners[7]];
  const minx = Math.min(...xs)-marginCm, maxx = Math.max(...xs)+marginCm;
  const miny = Math.min(...ys)-marginCm, maxy = Math.max(...ys)+marginCm;

  const T = cv.matFromArray(3,3,cv.CV_64F, new Float64Array([1,0,-minx, 0,1,-miny, 0,0,1]));
  const S = cv.matFromArray(3,3,cv.CV_64F, new Float64Array([pxPerCm,0,0, 0,pxPerCm,0, 0,0,1]));
  const TMP = new cv.Mat(), H_rect = new cv.Mat();
  cv.gemm(T, H_img2cm, 1, new cv.Mat(), 0, TMP);
  cv.gemm(S, TMP, 1, new cv.Mat(), 0, H_rect);
  T.delete(); S.delete(); TMP.delete();

  const widthPx  = Math.max(1, Math.ceil((maxx-minx)*pxPerCm));
  const heightPx = Math.max(1, Math.ceil((maxy-miny)*pxPerCm));
  return { H_rect, size:[widthPx, heightPx] };
}

function autoPxPerCmFromMarker(markerCornersImg, markerSizeCm) {
  const c = orderCornersFloat32(markerCornersImg);
  const v = (i,j)=>[c[2*j]-c[2*i], c[2*j+1]-c[2*i+1]];
  const L = u=>Math.hypot(u[0],u[1]);
  const edges = [L(v(0,1)), L(v(1,2)), L(v(2,3)), L(v(3,0))];
  const meanSidePx = edges.reduce((a,b)=>a+b,0)/4;
  if (markerSizeCm<=0) throw new Error('marker_size_cm must be > 0');
  return Math.max(1e-6, meanSidePx / markerSizeCm);
}

// ---------- js-aruco2 detection ----------
function detectBestArucoCorners_jsAruco2(imageData) {
  if (!detector) detector = new AR.Detector({ dictionaryName: JSARUCO_DICT_NAME });
  const markers = detector.detect(imageData);

  // Keep only ids in [0..49] to match DICT_5X5_50
  const filtered = (markers || []).filter(m => Number.isInteger(m.id) && m.id >= 0 && m.id < 50);
  if (filtered.length === 0) return null;

  // Pick the largest by area
  let best = null, bestArea = -1;
  for (const m of filtered) {
    const cs = m.corners;
    const pts = new Float32Array([cs[0].x,cs[0].y, cs[1].x,cs[1].y, cs[2].x,cs[2].y, cs[3].x,cs[3].y]);
    const A = Math.abs(
      (pts[0]*pts[3] + pts[2]*pts[5] + pts[4]*pts[7] + pts[6]*pts[1]) -
      (pts[1]*pts[2] + pts[3]*pts[4] + pts[5]*pts[6] + pts[7]*pts[0])
    ) / 2;
    if (A > bestArea) { bestArea = A; best = pts; }
  }
  return best ? orderCornersFloat32(best) : null;
}


function rectifyWithAruco() {
  // Convert srcBGR -> ImageData for js-aruco2
  const rgba = new cv.Mat();
  cv.cvtColor(srcBGR, rgba, cv.COLOR_BGR2RGBA);
  const id = new ImageData(new Uint8ClampedArray(rgba.data), srcBGR.cols, srcBGR.rows);
  rgba.delete();

  const corners = detectBestArucoCorners_jsAruco2(id);
  if (!corners) {
    if (rectBGR) { rectBGR.delete(); rectBGR = null; }
    if (H_img2cm) { H_img2cm.delete(); H_img2cm = null; }
    if (H_rect)   { H_rect.delete(); H_rect = null; }
    setStatus('No ArUco detected. Showing original image; measurements in pixels.');
    return false;
  }

  if (H_img2cm) H_img2cm.delete();
  H_img2cm = computeH_img2cm(corners, MARKER_SIZE_CM);

  if (chkAuto.checked) {
    try { pxPerCm = autoPxPerCmFromMarker(corners, MARKER_SIZE_CM); }
    catch { pxPerCm = DEFAULT_PX_PER_CM; }
  } else {
    const v = parseFloat(ppcInput.value);
    pxPerCm = (isFinite(v) && v>0) ? v : DEFAULT_PX_PER_CM;
  }
  ppcInput.value = (+pxPerCm).toFixed(3);

  if (H_rect) H_rect.delete();
  const built = buildRectification(H_img2cm, srcBGR, pxPerCm);
  H_rect = built.H_rect; rectSize = built.size;

  if (rectBGR) rectBGR.delete();
  rectBGR = new cv.Mat();
  cv.warpPerspective(srcBGR, rectBGR, H_rect, new cv.Size(rectSize[0], rectSize[1]));
  return true;
}

// ---------- Actions ----------
btnLoad.addEventListener('click', ()=> fileInput.click());

fileInput.addEventListener('change', e => {
  if (!e.target.files || !e.target.files[0]) return;
  const file = e.target.files[0];

  // derive original filename base (without extension)
  const name = (file.name || '').trim();
  const dot = name.lastIndexOf('.');
  originalFilenameBase = dot > 0 ? name.slice(0, dot) : (name || 'image');

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const tmp = document.createElement('canvas');
    tmp.width = img.naturalWidth; tmp.height = img.naturalHeight;
    tmp.getContext('2d').drawImage(img, 0, 0);
    const rgba = cv.imread(tmp);
    const bgr = new cv.Mat();
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    rgba.delete();
    if (srcBGR) srcBGR.delete();
    srcBGR = bgr;

    const ok = rectifyWithAruco();

    ensureCanvasSize();
    setBaseScaleFromMat(rectBGR || srcBGR);
    zoom = 1; pan = [0,0]; render();

    btnSave.disabled = false;
    btnClear.disabled = false;
    setStatus(ok && rectBGR
      ? `Rectified view @ ${pxPerCm.toFixed(3)} px/cm  (${(1/pxPerCm).toFixed(3)} cm/px).`
      : 'No ArUco. Measuring in pixels.');

    resetPoints(true);
    URL.revokeObjectURL(url);
  };
  img.onerror = () => { setStatus('Failed to load image.'); URL.revokeObjectURL(url); };
  img.src = url;
});

function onAutoToggle() {
  ppcInput.disabled = chkAuto.checked;
  if (srcBGR) {
    const ok = rectifyWithAruco();
    setBaseScaleFromMat(rectBGR || srcBGR);
    render();
    setStatus(ok && rectBGR ? `Rectified view @ ${pxPerCm.toFixed(3)} px/cm.` : 'No ArUco. Measuring in pixels.');
  }
}
chkAuto.addEventListener('change', onAutoToggle);
ppcInput.addEventListener('change', onAutoToggle);

function resetPoints(hard=false) {
  if (hard) {
    clickPtsRect = []; measurements = []; selectedLabelIndex = -1;
    btnReset.disabled = true; btnDelete.disabled = true; render(); return;
  }
  if (clickPtsRect.length % 2 === 1) {
    clickPtsRect.pop();
    btnReset.disabled = clickPtsRect.length === 0;
    render();
  }
  setStatus('Selection reset.');
}
btnReset.addEventListener('click', ()=>resetPoints());

function clearMeasurements() {
  clickPtsRect = []; measurements = []; selectedLabelIndex = -1;
  btnReset.disabled = true; btnDelete.disabled = true; render();
  setStatus('Measurements cleared.');
}
btnClear.addEventListener('click', clearMeasurements);

// NEW: delete currently selected measurement
function deleteSelected() {
  if (selectedLabelIndex < 0 || selectedLabelIndex >= measurements.length) {
    setStatus('No measurement selected to delete.');
    return;
  }
  const removed = measurements.splice(selectedLabelIndex, 1);
  selectedLabelIndex = -1;
  btnDelete.disabled = true;
  render();
  setStatus('Measurement deleted.');
}
btnDelete.addEventListener('click', deleteSelected);

async function saveAnnotated() {
  if (!srcBGR && !rectBGR) return;
  if (!measurements.length && !clickPtsRect.length) { alert('Nothing to save.'); return; }
  const mat = rectBGR || srcBGR;
  const off = document.createElement('canvas');
  off.width = mat.cols; off.height = mat.rows;
  const octx = off.getContext('2d');
  const bmp = await matToImageBitmap(mat);
  octx.drawImage(bmp, 0, 0);

  octx.save(); octx.lineWidth = 2; octx.font = 'bold 16px system-ui,Segoe UI,Roboto';
  for (const m of measurements) {
    octx.strokeStyle = octx.fillStyle = m.color;
    octx.beginPath(); octx.moveTo(m.p1Rect[0], m.p1Rect[1]); octx.lineTo(m.p2Rect[0], m.p2Rect[1]); octx.stroke();
    octx.beginPath(); octx.arc(m.p1Rect[0], m.p1Rect[1], 3, 0, Math.PI*2); octx.fill();
    octx.beginPath(); octx.arc(m.p2Rect[0], m.p2Rect[1], 3, 0, Math.PI*2); octx.fill();
    const mid = [(m.p1Rect[0]+m.p2Rect[0])/2, (m.p1Rect[1]+m.p2Rect[1])/2];
    const offImg = [m.textOffset[0] / scale, m.textOffset[1] / scale]; // convert from display px to image px
    octx.fillText(`${m.value.toFixed(2)} ${m.units}`, mid[0]+offImg[0], mid[1]+offImg[1]);
  }
  octx.restore();

  // Export JPEG with original filename base
  const suggestedName = `${originalFilenameBase}_annotated.jpg`;
  const url = off.toDataURL('image/jpeg', 0.92);
  const a = document.createElement('a');
  a.href = url; a.download = suggestedName; a.click();
}
btnSave.addEventListener('click', saveAnnotated);

// ---------- Interactions ----------
let isPanning = false, lastPan = [0,0];

cvs.addEventListener('mousedown', (ev) => {
  if (ev.button === 1) { isPanning = true; lastPan = [ev.clientX, ev.clientY]; }
  if (ev.button === 0 && ev.getModifierState && ev.getModifierState(' ')) {
    isPanning = true; lastPan = [ev.clientX, ev.clientY];
  }
});
window.addEventListener('mouseup', ()=> { isPanning = false; });
cvs.addEventListener('mousemove', (ev) => {
  if (!isPanning) return;
  const dx = ev.clientX - lastPan[0], dy = ev.clientY - lastPan[1];
  lastPan = [ev.clientX, ev.clientY];
  pan[0] += dx; pan[1] += dy; render();
});
cvs.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const factor = 1 + (ev.deltaY < 0 ? 0.1 : -0.1);
  if (factor <= 0) return;
  const ax = ev.offsetX, ay = ev.offsetY;
  const [wx, wy] = canvasToRect([ax, ay]);
  zoom = Math.max(0.1, Math.min(20.0, zoom * factor));
  render();
  const [nx, ny] = rectToCanvas([wx, wy]);
  pan[0] += (ax - nx); pan[1] += (ay - ny);
  render();
}, { passive:false });

window.addEventListener('keydown', (ev) => {
  if (ev.key === '+') { zoom = Math.min(20, zoom * 1.1); render(); }
  if (ev.key === '-') { zoom = Math.max(0.1, zoom / 1.1); render(); }
  if (ev.key === '0') { setBaseScaleFromMat(rectBGR || srcBGR); zoom = 1; pan=[0,0]; render(); }

  if (selectedLabelIndex >= 0 && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(ev.key)) {
    const step = parseInt(nudgeInput.value) || 5;
    const m = measurements[selectedLabelIndex];
    if (ev.key === 'ArrowLeft')  m.textOffset[0] -= step;
    if (ev.key === 'ArrowRight') m.textOffset[0] += step;
    if (ev.key === 'ArrowUp')    m.textOffset[1] -= step;
    if (ev.key === 'ArrowDown')  m.textOffset[1] += step;
    render();
  }

  // NEW: keyboard deletion of selected measurement
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedLabelIndex >= 0) {
    ev.preventDefault();
    deleteSelected();
  }
});

// Left-click to place points / measure
cvs.addEventListener('click', (ev) => {
  if (ev.getModifierState && ev.getModifierState(' ')) return; // ignore when panning
  if (!srcBGR && !rectBGR) return;

  const mat = rectBGR || srcBGR;
  const [rx, ry] = canvasToRect([ev.offsetX, ev.offsetY]);
  if (rx < 0 || ry < 0 || rx >= mat.cols || ry >= mat.rows) return;

  clickPtsRect.push([rx, ry]);
  btnReset.disabled = true;

  if (clickPtsRect.length % 2 === 0) {
    const p1 = clickPtsRect[clickPtsRect.length-2];
    const p2 = clickPtsRect[clickPtsRect.length-1];
    const distPx = Math.hypot(p2[0]-p1[0], p2[1]-p1[1]);

    const rectMode = !!rectBGR;
    const units = (rectMode && pxPerCm>0) ? 'cm' : 'px';
    const value = (units==='cm') ? distPx/pxPerCm : distPx;

    const color = colors[measurements.length % colors.length];
    measurements.push({ p1Rect:p1, p2Rect:p2, value, units, color, textOffset:[0,-10] });
    setStatus(`Measured: ${value.toFixed(2)} ${units}`);
    render();
  } else {
    render();
  }
});

// Right-click to select nearest label
cvs.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (!measurements.length) { selectedLabelIndex = -1; btnDelete.disabled = true; render(); return; }
  const mx = ev.offsetX, my = ev.offsetY;
  let bestI = -1, bestD = 1e9;
  for (let i=0;i<measurements.length;i++) {
    const m = measurements[i];
    const p1c = rectToCanvas(m.p1Rect), p2c = rectToCanvas(m.p2Rect);
    const mid = [(p1c[0]+p2c[0])/2, (p1c[1]+p2c[1])/2];
    const tx = mid[0] + m.textOffset[0], ty = mid[1] + m.textOffset[1];
    const d = Math.hypot(mx - tx, my - ty);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  selectedLabelIndex = bestI;
  btnDelete.disabled = selectedLabelIndex < 0;
  setStatus(selectedLabelIndex >= 0 ? 'Label selected. Use arrow keys to move it, or Delete to remove.' : 'Right-click near a label to select.');
  render();
});

// ---------- Library init ----------
(function init() {
  // js-aruco2 must be present
  if (!window.AR || !AR.Detector) {
    setStatus('js-aruco2 not loaded. Ensure cv.js then aruco.js are included before app.js');
    return;
  }
  // OpenCV.js readiness
  if (typeof cv !== 'undefined') {
    cv['onRuntimeInitialized'] = () => {
      setStatus('Libraries ready. Load an image with a known-size ArUco marker.');
      ensureCanvasSize(); render();
    };
  } else {
    setStatus('OpenCV.js not loaded.');
  }
})();

window.addEventListener('resize', render);
