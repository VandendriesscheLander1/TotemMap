const VERSION = 'P14.5';
const STORAGE_KEY = 'totemmap.locations';
const FILTER_KEY = 'totemmap.filters';
const RARITY_ORDER = { Rare: 0, Uncommon: 1, Common: 2 };
const ANIMALS = ['Beaver','Deer','Duck','Rabbit','Rat','Squirrel'];
const ANIMAL_IMG = a => `Images/Animals/${a}.png`;

// ----- Cloud storage (Supabase) -----
const CFG = window.TOTEMMAP_CONFIG || {};
const CLOUD_ENABLED = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase);
const sb = CLOUD_ENABLED
  ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY)
  : null;
const TABLE = CFG.TABLE || 'locations';

// Row <-> in-memory location shape
function rowToLoc(r) {
  return {
    id: r.id,
    animal: r.animal || '',
    totemId: r.totem_id || '',
    displayName: r.display_name || '',
    weaponType: r.weapon_type || '',
    rarity: r.rarity || '',
    game: [Number(r.game_x), Number(r.game_z)],
    file: r.file || '',
    addedAt: r.added_at ? new Date(r.added_at).getTime() : Date.now(),
  };
}
function locToRow(l) {
  return {
    id: l.id,
    animal: l.animal || null,
    totem_id: l.totemId || null,
    display_name: l.displayName || null,
    weapon_type: l.weaponType || null,
    rarity: l.rarity || null,
    game_x: l.game[0],
    game_z: l.game[1],
    file: l.file || null,
    version: VERSION,
  };
}

// Cap how much overlay markers grow relative to the map when zoomed out.
// At view.scale below 1/MAX_INV_SCALE the dots stop "fighting" the zoom-out and
// begin shrinking with the map instead of expanding without bound.
const MAX_INV_SCALE = 12;

// Base sizes (svg units at scale=1). Effective screen size ≈ base.
const DOT_RADIUS = 10;
const DOT_IMG = 14;
const DOT_TEXT = 11;

const mapWrap = document.getElementById('mapWrap');
const mapEl = document.getElementById('mapImg');
const overlay = document.getElementById('overlay');
const hud = document.getElementById('hud');
const statusEl = document.getElementById('status');
const locationsEl = document.getElementById('locations');
const countEl = document.getElementById('count');
const searchEl = document.getElementById('search');

let mapImg = null;
let transform = null;
let view = { x: 0, y: 0, scale: 0.12 };
let locations = loadLocations();
let activeId = null;
let searchTerm = '';
let catalog = {};
let filters = loadFilters();

init();

async function init() {
  try {
    const res = await fetch('calibration.json');
    if (!res.ok) throw new Error('not ok');
    const data = await res.json();
    transform = data.transform;
    setStatus('');
  } catch {
    setStatus('Missing calibration.json — click to load', false);
    statusEl.style.cursor = 'pointer';
    statusEl.addEventListener('click', pickCalibrationFile);
  }
  try {
    const res = await fetch('temp.lua');
    const text = await res.text();
    catalog = parseCatalog(text);
    buildOCRIndex();
  } catch (e) {
    console.error('catalog failed', e);
  }
  renderFilters();
  loadMapFromUrl('Images/Map/stitched_final.jpg').catch(() => {
    setStatus('Missing stitched_final.jpg — drop the map below', true);
  });
  // cloud
  if (CLOUD_ENABLED) {
    await ensureAuth();
    await loadFromCloud();
    subscribeCloud();
  } else if (CFG.SUPABASE_URL || CFG.SUPABASE_ANON_KEY) {
    console.warn('TotemMap: partial Supabase config — falling back to localStorage');
  }
}

async function ensureAuth() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) return;
    const { error } = await sb.auth.signInAnonymously();
    if (error) {
      console.error('anon sign-in failed', error);
      setStatus('Auth failed — read-only mode', true);
      setTimeout(() => setStatus(''), 4000);
    }
  } catch (e) {
    console.error('auth error', e);
  }
}

async function loadFromCloud() {
  try {
    const { data, error } = await sb.from(TABLE).select('*').order('added_at', { ascending: true });
    if (error) throw error;
    locations = (data || []).map(rowToLoc);
    renderFilters();
    renderList();
    redrawOverlay();
  } catch (e) {
    console.error('cloud load failed', e);
    setStatus('Cloud load failed — using local cache', true);
    setTimeout(() => setStatus(''), 3500);
  }
}

function subscribeCloud() {
  sb.channel('locations-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TABLE }, payload => {
      const l = rowToLoc(payload.new);
      if (locations.some(x => x.id === l.id)) return;
      locations.push(l);
      renderList();
      redrawOverlay(l.id);
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: TABLE }, payload => {
      const id = payload.old?.id; if (!id) return;
      const n = locations.length;
      locations = locations.filter(x => x.id !== id);
      if (locations.length !== n) { renderList(); redrawOverlay(); }
    })
    .subscribe();
}

function setStatus(msg, isError) {
  if (!msg) { statusEl.style.display = 'none'; return; }
  statusEl.style.display = 'block';
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', !!isError);
}

function pickCalibrationFile() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    const data = JSON.parse(await f.text());
    transform = data.transform;
    setStatus('');
  };
  inp.click();
}

function loadMapFromUrl(url) {
  return new Promise((resolve, reject) => {
    const onReady = () => {
      mapImg = mapEl;
      const w = mapEl.naturalWidth, h = mapEl.naturalHeight;
      mapEl.style.width = w + 'px';
      mapEl.style.height = h + 'px';
      overlay.setAttribute('width', w);
      overlay.setAttribute('height', h);
      overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);
      fitView();
      redrawOverlay();
      renderList();
      resolve();
    };
    mapEl.addEventListener('load', onReady, { once: true });
    mapEl.addEventListener('error', reject, { once: true });
    mapEl.src = url;
  });
}

function parseCatalog(luaText) {
  const out = {};
  const blockRe = /\["(\w+)\s+Totem"\]\s*=\s*\{\{([\s\S]*?)\}\}\s*,?/g;
  let m;
  while ((m = blockRe.exec(luaText))) {
    const animal = m[1] === 'Fawn' ? 'Deer' : m[1];
    const body = m[2];
    const parts = body.split(/\}\s*,\s*\{/);
    const arr = [];
    for (const p of parts) {
      const get = (k) => {
        const r = new RegExp(k + '\\s*=\\s*"([^"]*)"');
        const x = p.match(r); return x ? x[1] : '';
      };
      const id = get('id');
      if (!id) continue;
      arr.push({
        id,
        weaponType: get('weaponType'),
        displayName: get('displayName'),
        description: get('description'),
        rarity: get('rarity') || 'Common',
        animal,
      });
    }
    if (arr.length) out[animal] = arr;
  }
  return out;
}

function fitView() {
  if (!mapEl.naturalWidth) return;
  const wrap = mapWrap.getBoundingClientRect();
  const w = mapEl.naturalWidth, h = mapEl.naturalHeight;
  const s = Math.min(wrap.width / w, wrap.height / h) * 0.95;
  view.scale = s;
  view.x = (wrap.width - w * s) / 2;
  view.y = (wrap.height - h * s) / 2;
  applyView();
}

let _lastAppliedScale = null;
let _scaleEls = null; // cached node list of counter-scaled overlay children
function applyView() {
  const t = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  mapEl.style.transform = t;
  overlay.style.transform = t;
  if (view.scale === _lastAppliedScale) return;
  _lastAppliedScale = view.scale;
  const inv = Math.min(1 / view.scale, MAX_INV_SCALE);
  if (!_scaleEls) _scaleEls = overlay.querySelectorAll('[data-scale]');
  for (let i = 0; i < _scaleEls.length; i++) {
    const el = _scaleEls[i];
    const base = +el.dataset.scale;
    const tag = el.tagName;
    if (tag === 'circle') el.setAttribute('r', base * inv);
    else if (tag === 'text') {
      el.setAttribute('font-size', base * inv);
      el.setAttribute('stroke-width', 2 * inv);
    } else if (tag === 'image') {
      const size = base * inv;
      const cx = +el.dataset.cx, cy = +el.dataset.cy;
      el.setAttribute('width', size);
      el.setAttribute('height', size);
      el.setAttribute('x', cx - size / 2);
      el.setAttribute('y', cy - size / 2);
    }
  }
}
let _rafView = 0;
function scheduleApplyView() {
  if (_rafView) return;
  _rafView = requestAnimationFrame(() => { _rafView = 0; applyView(); });
}

let dragging = false, dragStart = null;
let _wrapRect = null;
function refreshWrapRect() { _wrapRect = mapWrap.getBoundingClientRect(); }
window.addEventListener('resize', refreshWrapRect);
window.addEventListener('scroll', refreshWrapRect, { passive: true });
refreshWrapRect();

let _pendingMouse = null, _rafMouse = 0;
function flushMouse() {
  _rafMouse = 0;
  const e = _pendingMouse; if (!e) return;
  if (!_wrapRect) refreshWrapRect();
  if (dragging) {
    view.x = dragStart.vx + (e.cx - dragStart.x);
    view.y = dragStart.vy + (e.cy - dragStart.y);
    applyView();
  }
  const px = (e.cx - _wrapRect.left - view.x) / view.scale;
  const py = (e.cy - _wrapRect.top  - view.y) / view.scale;
  hud.textContent = `px ${px.toFixed(0)}, ${py.toFixed(0)}  ·  zoom ${view.scale.toFixed(3)}`;
}
mapWrap.addEventListener('mousedown', e => {
  dragging = true; mapWrap.classList.add('dragging');
  dragStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
});
window.addEventListener('mousemove', e => {
  if (!mapImg) return;
  _pendingMouse = { cx: e.clientX, cy: e.clientY };
  if (!_rafMouse) _rafMouse = requestAnimationFrame(flushMouse);
});
window.addEventListener('mouseup', () => { dragging = false; mapWrap.classList.remove('dragging'); });

let _wheelAccum = 0, _wheelEv = null, _rafWheel = 0;
function flushWheel() {
  _rafWheel = 0;
  if (!_wheelEv) return;
  if (!_wrapRect) refreshWrapRect();
  const mx = _wheelEv.cx - _wrapRect.left, my = _wheelEv.cy - _wrapRect.top;
  const factor = Math.exp(-_wheelAccum * 0.0015);
  const ns = Math.max(0.02, Math.min(8, view.scale * factor));
  view.x = mx - (mx - view.x) * (ns / view.scale);
  view.y = my - (my - view.y) * (ns / view.scale);
  view.scale = ns;
  _wheelAccum = 0;
  _wheelEv = null;
  applyView();
}
mapWrap.addEventListener('wheel', e => {
  e.preventDefault();
  _wheelAccum += e.deltaY;
  _wheelEv = { cx: e.clientX, cy: e.clientY };
  if (!_rafWheel) _rafWheel = requestAnimationFrame(flushWheel);
}, { passive: false });

function clientToPixel(cx, cy) {
  if (!_wrapRect) refreshWrapRect();
  return [(cx - _wrapRect.left - view.x) / view.scale, (cy - _wrapRect.top - view.y) / view.scale];
}

function applyT(T, gx, gz) {
  return [T.a * gx + T.b * gz + T.tx, T.c * gx + T.d * gz + T.ty];
}

let _exifrPromise = null;
function loadExifr() {
  if (_exifrPromise) return _exifrPromise;
  _exifrPromise = new Promise((resolve, reject) => {
    if (window.exifr) return resolve(window.exifr);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/exifr/dist/full.umd.js';
    s.onload = () => resolve(window.exifr);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _exifrPromise;
}

// Scan only the JPEG header (first ~256KB) for the embedded COM marker — avoids
// reading the entire multi-MB file when we just need the coords comment.
async function readJpegCommentFromHeader(file) {
  const slice = file.slice(0, Math.min(file.size, 262144));
  const buf = new Uint8Array(await slice.arrayBuffer());
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) throw new Error('not a JPEG');
  let i = 2;
  while (i < buf.length - 4) {
    if (buf[i] !== 0xFF) break;
    const marker = buf[i + 1];
    if (marker === 0xD8 || marker === 0xD9) { i += 2; continue; }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (marker === 0xFE) {
      return new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(i + 4, i + 2 + len));
    }
    if (marker === 0xDA) break;
    i += 2 + len;
  }
  return '';
}

async function readJpegComment(file) {
  // Fast path: scan just the header for the COM marker.
  try {
    const c = await readJpegCommentFromHeader(file);
    if (c && /P:/.test(c)) return c;
  } catch {}
  // Fallback: full exifr parse (also slow path for files where the comment is in EXIF).
  try {
    const exifr = await loadExifr();
    const meta = await exifr.parse(file, { userComment: true, ifd0: true, xmp: false });
    if (meta) {
      const cand = meta.UserComment || meta.userComment || meta.ImageDescription || meta.Comment;
      if (cand && /P:/.test(typeof cand === 'string' ? cand : '')) return cand;
    }
  } catch {}
  return '';
}

async function makeThumb(file) {
  try {
    const bmp = await createImageBitmap(file, { resizeWidth: 1600, resizeQuality: 'medium' });
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.7));
    return blob ? URL.createObjectURL(blob) : '';
  } catch { return ''; }
}

// ---------- OCR: bottom-strip name detection + fuzzy match ----------
// Thumbnails show the in-game totem card with the name printed on the bottom
// strip ("THE REBOUND / Weapon Totem"). We OCR that strip, fuzzy-match against
// the catalog, and surface a one-tap confirm — saving two clicks per shot.
const OCR_CONFIDENT_SCORE = 0.32;
let _ocrWorkerPromise = null;
let _fusePromise = null;
let _fuse = null;
let _flatTotems = [];

function buildOCRIndex() {
  _flatTotems = [];
  for (const a of Object.keys(catalog)) for (const t of catalog[a]) {
    const stripped = (t.displayName || '').replace(/^the\s+/i, '').trim();
    _flatTotems.push({ animal: a, totem: t, name: t.displayName, alias: stripped });
  }
}

function loadFuse() {
  if (_fuse) return Promise.resolve(_fuse);
  if (_fusePromise) return _fusePromise;
  _fusePromise = new Promise((resolve, reject) => {
    const done = () => {
      _fuse = new Fuse(_flatTotems, {
        keys: ['name', 'alias'], threshold: 0.5, includeScore: true, ignoreLocation: true,
      });
      resolve(_fuse);
    };
    if (window.Fuse) return done();
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js';
    s.onload = done; s.onerror = reject;
    document.head.appendChild(s);
  });
  return _fusePromise;
}

function getOCRWorker() {
  if (_ocrWorkerPromise) return _ocrWorkerPromise;
  _ocrWorkerPromise = (async () => {
    if (!window.Tesseract) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    const w = await Tesseract.createWorker('eng');
    await w.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz '-",
      tessedit_pageseg_mode: '11', // sparse text — find text wherever it appears in the image
    });
    return w;
  })();
  return _ocrWorkerPromise;
}

async function prepareForOCR(srcUrl) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i); i.onerror = rej;
    i.src = srcUrl;
  });
  // Downscale to 900px wide — fast enough for Tesseract, big enough to read.
  const targetW = 900;
  const scale = Math.min(1, targetW / img.width);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function matchTotemName(rawText) {
  if (!_fuse || !rawText) return null;
  const lines = rawText.split(/\n+/).map(s => s.trim()).filter(Boolean);
  let best = null;
  for (const line of lines) {
    if (/weapon\s*totem/i.test(line)) continue;
    // Strip non-alpha (digits from perf stats, punctuation, etc.)
    const query = line.replace(/[^A-Za-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (query.length < 3) continue;
    const stripped = query.replace(/^the\s+/i, '').trim();
    if (stripped.length < 3) continue;
    const r = _fuse.search(stripped)[0];
    if (r && (!best || r.score < best.score)) {
      best = { ...r.item, score: r.score, query };
    }
  }
  return best || null;
}

function startOCRFor(item) {
  if (!item.thumb) return;
  item.ocrPromise = (async () => {
    try {
      await loadFuse();
      const w = await getOCRWorker();
      const c = await prepareForOCR(item.thumb);
      const { data } = await w.recognize(c);
      const guess = matchTotemName(data.text);
      item.rawText = (data.text || '').trim();
      item.guess = guess;
      item.confident = !!(guess && guess.score <= OCR_CONFIDENT_SCORE);
      if (typeof _onItemGuessReady === 'function') _onItemGuessReady(item);
    } catch (e) {
      console.warn('OCR failed', e);
      item.guess = null;
      if (typeof _onItemGuessReady === 'function') _onItemGuessReady(item);
    }
  })();
}

let _onItemGuessReady = null;

const drop = document.getElementById('drop');
const fileInput = document.getElementById('fileInput');
fileInput.addEventListener('change', e => intake(e.target.files));
;['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hover'); }));
;['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hover'); }));
drop.addEventListener('drop', e => intake(e.dataTransfer.files));
;['dragenter','dragover'].forEach(ev => mapWrap.addEventListener(ev, e => { e.preventDefault(); }));
mapWrap.addEventListener('drop', e => { e.preventDefault(); intake(e.dataTransfer.files); });

async function intake(fileList) {
  if (!transform) { setStatus('Calibration missing — load calibration.json first', true); return; }
  const files = [...fileList].filter(f => /\.jpe?g$/i.test(f.name) || f.type === 'image/jpeg');
  if (!files.length) return;
  setStatus(`Reading ${files.length} file(s)…`, false);
  const skipped = [];
  // Process all files in parallel — header read + thumb decode are both async,
  // so this can take a queue of 20 screenshots from ~20× single-file time down
  // to ~1× (decode is the bottleneck and the browser pipelines it).
  const results = await Promise.all(files.map(async f => {
    try {
      const comment = await readJpegComment(f);
      const m = comment && comment.match(/P:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/);
      if (!m) { skipped.push(f.name); return null; }
      const thumb = await makeThumb(f);
      const item = { file: f.name, game: [parseFloat(m[1]), parseFloat(m[3])], thumb };
      startOCRFor(item);
      return item;
    } catch {
      skipped.push(f.name);
      return null;
    }
  }));
  const queue = results.filter(Boolean);
  fileInput.value = '';
  setStatus('');
  if (queue.length) await runPickerQueue(queue);
  // Release blob URLs we created for thumbs.
  for (const q of queue) if (q.thumb && q.thumb.startsWith('blob:')) URL.revokeObjectURL(q.thumb);
  if (skipped.length) {
    setStatus(`Skipped ${skipped.length} file(s) without coords`, true);
    setTimeout(() => setStatus(''), 3500);
  }
}

const modalBack = document.getElementById('modalBack');
const modalProgress = document.getElementById('modalProgress');
const modalFile = document.getElementById('modalFile');
const modalX = document.getElementById('modalX');
const modalZ = document.getElementById('modalZ');
const modalPx = document.getElementById('modalPx');
const modalPy = document.getElementById('modalPy');
const thumbEl = document.getElementById('thumb');
const modalTitle = document.getElementById('modalTitle');
const crumbs = document.getElementById('crumbs');
const stepAnimal = document.getElementById('stepAnimal');
const stepTotem = document.getElementById('stepTotem');
const btnBack = document.getElementById('modalBack2');
const ocrSuggest = document.getElementById('ocrSuggest');
const ocrName = document.getElementById('ocrName');
const ocrMeta = document.getElementById('ocrMeta');
const ocrConfirm = document.getElementById('ocrConfirm');

function runPickerQueue(queue) {
  return new Promise(resolve => {
    let i = 0;
    let pickedAnimal = null;

    const showItem = () => {
      const item = queue[i];
      const [px, py] = applyT(transform, item.game[0], item.game[1]);
      modalProgress.textContent = `${i + 1} of ${queue.length}`;
      modalFile.textContent = item.file;
      modalX.textContent = item.game[0].toFixed(2);
      modalZ.textContent = item.game[1].toFixed(2);
      modalPx.textContent = px.toFixed(0);
      modalPy.textContent = py.toFixed(0);
      thumbEl.src = item.thumb || '';
      pickedAnimal = null;
      renderSuggestion(item);
      showAnimalStep();
    };

    const renderSuggestion = (item) => {
      if (!item.thumb) { ocrSuggest.style.display = 'none'; return; }
      ocrSuggest.style.display = 'flex';
      ocrSuggest.classList.toggle('confident', !!item.confident);
      ocrSuggest.classList.toggle('nomatch', 'guess' in item && !item.guess);
      if (item.guess) {
        const g = item.guess;
        ocrName.textContent = g.totem.displayName;
        ocrMeta.textContent = `${g.animal} · ${g.totem.rarity}${item.confident ? '' : ' · low confidence — verify'}`;
        ocrConfirm.disabled = false;
        ocrConfirm.style.display = '';
      } else if ('guess' in item) {
        ocrName.textContent = 'No match — pick manually';
        ocrMeta.textContent = item.rawText ? `read: "${item.rawText.split('\n')[0].slice(0, 40)}"` : '';
        ocrConfirm.disabled = true;
        ocrConfirm.style.display = 'none';
      } else {
        ocrName.textContent = 'Scanning…';
        ocrMeta.textContent = '';
        ocrConfirm.disabled = true;
        ocrConfirm.style.display = 'none';
      }
    };

    _onItemGuessReady = (item) => { if (queue[i] === item) renderSuggestion(item); };

    const confirmGuess = () => {
      const item = queue[i];
      if (!item || !item.guess) return;
      pickedAnimal = item.guess.animal;
      save(item.guess.totem);
    };

    const showAnimalStep = () => {
      modalTitle.textContent = 'Which animal?';
      crumbs.innerHTML = 'Step 1 · <span class="cur">Choose animal</span> · Step 2 · Choose totem';
      stepAnimal.style.display = 'grid';
      stepTotem.style.display = 'none';
      btnBack.style.display = 'none';
      renderAnimalGrid();
    };

    const showTotemStep = (animal) => {
      pickedAnimal = animal;
      modalTitle.textContent = `${animal} · pick the totem`;
      crumbs.innerHTML = `Step 1 · <span style="color:var(--text)">${animal}</span> · Step 2 · <span class="cur">Choose totem</span>`;
      stepAnimal.style.display = 'none';
      stepTotem.style.display = 'block';
      btnBack.style.display = 'inline-block';
      renderTotemGrid(animal);
    };

    const renderAnimalGrid = () => {
      stepAnimal.innerHTML = '';
      for (const a of ANIMALS) {
        const ct = (catalog[a] || []).length;
        const card = document.createElement('div');
        card.className = 'animal-card';
        card.innerHTML = `
          <img src="${ANIMAL_IMG(a)}" alt="${a}" />
          <div class="name">${a}</div>
          <div class="ct">${ct} totem${ct === 1 ? '' : 's'}</div>`;
        card.addEventListener('click', () => showTotemStep(a));
        stepAnimal.appendChild(card);
      }
    };

    const renderTotemGrid = (animal) => {
      stepTotem.innerHTML = '';
      const items = (catalog[animal] || []).slice().sort((a, b) => {
        const r = (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9);
        if (r) return r;
        return a.displayName.localeCompare(b.displayName);
      });
      const groups = {};
      for (const t of items) (groups[t.rarity] ||= []).push(t);
      const order = ['Rare','Uncommon','Common'];
      for (const rar of order) {
        const list = groups[rar]; if (!list || !list.length) continue;
        const wrap = document.createElement('div');
        wrap.className = `rarity-group ${rar}`;
        wrap.innerHTML = `<h4>${rar} · ${list.length}</h4>`;
        const grid = document.createElement('div');
        grid.className = 'totem-grid';
        for (const t of list) {
          const card = document.createElement('div');
          card.className = `totem-card ${t.rarity}`;
          card.innerHTML = `
            <div class="tname">${escapeHtml(t.displayName)}</div>
            <div class="tmeta"><span>${escapeHtml(t.weaponType)}</span><span class="rarity ${t.rarity}" style="font-size:9px;letter-spacing:.05em">${t.rarity}</span></div>
            <div class="desc">${escapeHtml(t.description || '')}</div>`;
          card.addEventListener('click', () => save(t));
          grid.appendChild(card);
        }
        wrap.appendChild(grid);
        stepTotem.appendChild(wrap);
      }
    };

    const save = (totem) => {
      const item = queue[i];
      addLocation({
        id: crypto.randomUUID(),
        animal: pickedAnimal,
        totemId: totem.id,
        displayName: totem.displayName,
        weaponType: totem.weaponType,
        rarity: totem.rarity,
        game: item.game,
        file: item.file,
        addedAt: Date.now(),
      });
      next();
    };

    const next = () => { i++; if (i >= queue.length) close(); else showItem(); };

    const close = () => {
      modalBack.classList.remove('show');
      document.removeEventListener('keydown', onKey);
      btnSkip.removeEventListener('click', next);
      btnCancel.removeEventListener('click', cancelAll);
      btnBack.removeEventListener('click', onBack);
      ocrConfirm.removeEventListener('click', confirmGuess);
      _onItemGuessReady = null;
      ocrSuggest.style.display = 'none';
      resolve();
    };

    const cancelAll = () => close();
    const onBack = () => showAnimalStep();
    const onKey = e => {
      if (e.key === 'Escape' && e.shiftKey) { e.preventDefault(); cancelAll(); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        if (stepTotem.style.display !== 'none') showAnimalStep();
        else next();
      } else if (e.key === 'Enter') {
        const item = queue[i];
        if (item && item.guess) { e.preventDefault(); confirmGuess(); }
      }
    };

    const btnSkip = document.getElementById('modalSkip');
    const btnCancel = document.getElementById('modalCancel');
    btnSkip.addEventListener('click', next);
    btnCancel.addEventListener('click', cancelAll);
    btnBack.addEventListener('click', onBack);
    ocrConfirm.addEventListener('click', confirmGuess);
    document.addEventListener('keydown', onKey);
    modalBack.classList.add('show');
    showItem();
  });
}

function loadLocations() {
  // Cloud mode hydrates later via loadFromCloud(); start empty to avoid mixing.
  if (CLOUD_ENABLED) return [];
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}
let saveTimer = null;
function persist() {
  if (CLOUD_ENABLED) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(locations)), 200);
}
async function addLocation(loc) {
  locations.push(loc);
  renderFilters();
  renderList();
  redrawOverlay(loc.id);
  if (CLOUD_ENABLED) {
    const { error } = await sb.from(TABLE).insert(locToRow(loc));
    if (error) {
      console.error('cloud insert failed', error);
      setStatus('Cloud save failed — point only saved locally', true);
      setTimeout(() => setStatus(''), 4000);
    }
  } else {
    persist();
  }
}
async function deleteLocation(id) {
  locations = locations.filter(l => l.id !== id);
  renderList();
  redrawOverlay();
  if (CLOUD_ENABLED) {
    const { error } = await sb.from(TABLE).delete().eq('id', id);
    if (error) console.error('cloud delete failed', error);
  } else {
    persist();
  }
}

let _searchTimer = 0;
searchEl.addEventListener('input', () => {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => { searchTerm = searchEl.value.toLowerCase(); renderList(); }, 120);
});

function locLabel(l) { return l.displayName || l.title || l.file || 'Unnamed'; }

function renderList() {
  const visible = locations.filter(isVisible);
  countEl.textContent = visible.length === locations.length
    ? locations.length
    : `${visible.length} / ${locations.length}`;
  const filtered = searchTerm
    ? visible.filter(l => locLabel(l).toLowerCase().includes(searchTerm) || (l.animal || '').toLowerCase().includes(searchTerm))
    : visible;
  locationsEl.innerHTML = '';
  for (const l of filtered) {
    const li = document.createElement('li');
    if (l.id === activeId) li.classList.add('active');
    const animal = l.animal || '';
    const rarity = l.rarity || '';
    const meta = [l.weaponType, rarity].filter(Boolean).join(' · ');
    li.innerHTML = `
      ${animal ? `<img class="ico" src="${ANIMAL_IMG(animal)}" alt="${animal}" />` : `<span class="ico" style="display:inline-block;width:26px;height:26px;border-radius:50%;background:var(--accent)"></span>`}
      <div class="meta">
        <div class="title" title="${escapeHtml(locLabel(l))}">${escapeHtml(locLabel(l))}</div>
        <div class="sub">
          <span class="rarity ${rarity}">${escapeHtml(meta)}</span>
          <span class="coord">${l.game[0].toFixed(0)}, ${l.game[1].toFixed(0)}</span>
        </div>
      </div>
      <button class="del" title="Delete">×</button>`;
    li.addEventListener('click', e => {
      if (e.target.classList.contains('del')) deleteLocation(l.id);
      else focusLocation(l.id);
    });
    locationsEl.appendChild(li);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function focusLocation(id) {
  const loc = locations.find(l => l.id === id); if (!loc || !transform) return;
  activeId = id;
  const [px, py] = applyT(transform, loc.game[0], loc.game[1]);
  const wrap = mapWrap.getBoundingClientRect();
  const targetScale = Math.max(view.scale, 0.5);
  view.scale = targetScale;
  view.x = wrap.width / 2 - px * targetScale;
  view.y = wrap.height / 2 - py * targetScale;
  applyView();
  renderList();
  redrawOverlay();
}

function redrawOverlay(enterId) {
  if (!transform) return;
  const showLabels = filters.showLabels;
  let svg = '';
  for (const l of locations) {
    if (!isVisible(l)) continue;
    const [px, py] = applyT(transform, l.game[0], l.game[1]);
    const active = l.id === activeId;
    const enter = l.id === enterId ? ' enter' : '';
    const label = locLabel(l);
    const animal = l.animal;
    const stroke = active ? '#ffd591' : '#f0b86e';
    const labelY = py - (DOT_RADIUS + 4);
    const labelSvg = showLabels
      ? `<text data-scale="${DOT_TEXT}" x="${px}" y="${animal ? labelY : py - 10}" text-anchor="middle"
          font-family="ui-sans-serif, system-ui, sans-serif" font-weight="600"
          fill="${stroke}" stroke="#0a0a0a" stroke-width="2" paint-order="stroke" font-size="${DOT_TEXT}">${escapeHtml(label)}</text>`
      : '';
    if (animal) {
      svg += `<g class="loc${enter}" data-id="${l.id}">
        <circle cx="${px}" cy="${py}" data-scale="${DOT_RADIUS}" r="${DOT_RADIUS}" fill="rgba(14,17,22,0.92)" stroke="${stroke}" stroke-width="1.5"/>
        <image data-scale="${DOT_IMG}" data-cx="${px}" data-cy="${py}" href="${ANIMAL_IMG(animal)}" width="${DOT_IMG}" height="${DOT_IMG}" x="${px - DOT_IMG/2}" y="${py - DOT_IMG/2}" preserveAspectRatio="xMidYMid meet"/>
        ${labelSvg}
      </g>`;
    } else {
      svg += `<g class="loc${enter}" data-id="${l.id}">
        <circle data-scale="6" cx="${px}" cy="${py}" r="6" fill="${stroke}" stroke="#1a1208" stroke-width="1.5"/>
        ${labelSvg}
      </g>`;
    }
  }
  overlay.innerHTML = svg;
  _lastAppliedScale = null;
  _scaleEls = null;
  applyView();
  if (enterId) {
    requestAnimationFrame(() => {
      overlay.querySelectorAll('.loc.enter').forEach(g => g.classList.remove('enter'));
    });
  }
}

document.getElementById('exportBtn')?.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), locations }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'locations.json';
  a.click();
});
document.getElementById('importBtn')?.addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile')?.addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  const data = JSON.parse(await f.text());
  const incoming = Array.isArray(data) ? data : (data.locations || []);
  const existing = new Set(locations.map(l => l.id));
  const added = [];
  for (const l of incoming) {
    if (!l.game) continue;
    const id = (l.id && !existing.has(l.id)) ? l.id : crypto.randomUUID();
    existing.add(id);
    const loc = {
      id,
      animal: l.animal || '',
      totemId: l.totemId || '',
      displayName: l.displayName || l.title || '',
      weaponType: l.weaponType || '',
      rarity: l.rarity || '',
      game: l.game,
      file: l.file || '',
      addedAt: l.addedAt || Date.now(),
    };
    locations.push(loc);
    added.push(loc);
  }
  renderList();
  redrawOverlay();
  if (CLOUD_ENABLED && added.length) {
    const { error } = await sb.from(TABLE).insert(added.map(locToRow));
    if (error) {
      console.error('cloud import failed', error);
      setStatus('Cloud import failed — saved locally only', true);
      setTimeout(() => setStatus(''), 4000);
    }
  } else {
    persist();
  }
  e.target.value = '';
});
document.getElementById('clearBtn')?.addEventListener('click', async () => {
  if (!locations.length) return;
  const warn = CLOUD_ENABLED
    ? `Delete all ${locations.length} location(s) from the SHARED cloud database? Everyone will lose them.`
    : `Delete all ${locations.length} location(s)?`;
  if (!confirm(warn)) return;
  const ids = locations.map(l => l.id);
  locations = [];
  renderList();
  redrawOverlay();
  if (CLOUD_ENABLED) {
    const { error } = await sb.from(TABLE).delete().in('id', ids);
    if (error) console.error('cloud clear failed', error);
  } else {
    persist();
  }
});

// ----- Filters -----
function loadFilters() {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}');
    return {
      animals: new Set(raw.animals || []),
      rarities: new Set(raw.rarities || []),
      weapons: new Set(raw.weapons || []),
      showLabels: raw.showLabels !== false,
    };
  } catch {
    return { animals: new Set(), rarities: new Set(), weapons: new Set(), showLabels: true };
  }
}
function persistFilters() {
  localStorage.setItem(FILTER_KEY, JSON.stringify({
    animals: [...filters.animals],
    rarities: [...filters.rarities],
    weapons: [...filters.weapons],
    showLabels: filters.showLabels,
  }));
}
function isVisible(l) {
  if (l.animal && filters.animals.has(l.animal)) return false;
  if (l.rarity && filters.rarities.has(l.rarity)) return false;
  if (l.weaponType && filters.weapons.has(l.weaponType)) return false;
  return true;
}
function collectWeapons() {
  const set = new Set();
  for (const a of Object.keys(catalog)) for (const t of catalog[a]) if (t.weaponType) set.add(t.weaponType);
  for (const l of locations) if (l.weaponType) set.add(l.weaponType);
  return [...set].sort();
}
function onFilterChange() {
  persistFilters();
  renderFilters();
  renderList();
  redrawOverlay();
}
function renderFilters() {
  const an = document.getElementById('filterAnimals');
  if (!an) return;
  an.innerHTML = '';
  for (const a of ANIMALS) {
    const on = !filters.animals.has(a);
    const chip = document.createElement('div');
    chip.className = `chip ${on ? 'on' : 'off'}`;
    chip.innerHTML = `<img src="${ANIMAL_IMG(a)}" alt="" />${a}`;
    chip.title = on ? `Hide ${a}` : `Show ${a}`;
    chip.addEventListener('click', () => {
      if (on) filters.animals.add(a); else filters.animals.delete(a);
      onFilterChange();
    });
    an.appendChild(chip);
  }
  const rEl = document.getElementById('filterRarities');
  rEl.innerHTML = '';
  for (const rar of ['Rare','Uncommon','Common']) {
    const on = !filters.rarities.has(rar);
    const chip = document.createElement('div');
    chip.className = `chip rarity-${rar} ${on ? 'on' : 'off'}`;
    chip.textContent = rar;
    chip.addEventListener('click', () => {
      if (on) filters.rarities.add(rar); else filters.rarities.delete(rar);
      onFilterChange();
    });
    rEl.appendChild(chip);
  }
  const wEl = document.getElementById('filterWeapons');
  wEl.innerHTML = '';
  const weapons = collectWeapons();
  if (!weapons.length) {
    wEl.innerHTML = '<span class="filter-empty">—</span>';
  } else {
    for (const wt of weapons) {
      const on = !filters.weapons.has(wt);
      const chip = document.createElement('div');
      chip.className = `chip ${on ? 'on' : 'off'}`;
      chip.textContent = wt;
      chip.addEventListener('click', () => {
        if (on) filters.weapons.add(wt); else filters.weapons.delete(wt);
        onFilterChange();
      });
      wEl.appendChild(chip);
    }
  }
  const lbl = document.getElementById('filterLabels');
  if (lbl) lbl.checked = filters.showLabels;
  const total = filters.animals.size + filters.rarities.size + filters.weapons.size;
  const badge = document.getElementById('filterCount');
  if (badge) {
    if (total > 0) { badge.style.display = ''; badge.textContent = `${total} hidden`; }
    else badge.style.display = 'none';
  }
}
document.getElementById('filterReset')?.addEventListener('click', () => {
  filters = { animals: new Set(), rarities: new Set(), weapons: new Set(), showLabels: true };
  onFilterChange();
});
document.getElementById('filterLabels')?.addEventListener('change', e => {
  filters.showLabels = e.target.checked;
  persistFilters();
  redrawOverlay();
});

window.addEventListener('resize', () => { refreshWrapRect(); applyView(); });
