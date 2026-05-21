const VERSION = 'P14.5';
const STORAGE_KEY = 'totemmap.locations';
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
const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');
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
  } catch (e) {
    console.error('catalog failed', e);
  }
  loadMapFromUrl('Images/Map/stitched_final.png').catch(() => {
    setStatus('Missing stitched_final.png — drop the map below', true);
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
    const img = new Image();
    img.onload = () => {
      mapImg = img;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      overlay.setAttribute('width', img.naturalWidth);
      overlay.setAttribute('height', img.naturalHeight);
      overlay.setAttribute('viewBox', `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
      ctx.drawImage(img, 0, 0);
      fitView();
      redrawOverlay();
      renderList();
      resolve();
    };
    img.onerror = reject;
    img.src = url;
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
  const wrap = mapWrap.getBoundingClientRect();
  const s = Math.min(wrap.width / canvas.width, wrap.height / canvas.height) * 0.95;
  view.scale = s;
  view.x = (wrap.width - canvas.width * s) / 2;
  view.y = (wrap.height - canvas.height * s) / 2;
  applyView();
}

function applyView() {
  const t = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  canvas.style.transform = t;
  overlay.style.transform = t;
  // Cap the counter-scale so dots/labels don't balloon when zoomed far out.
  const inv = Math.min(1 / view.scale, MAX_INV_SCALE);
  overlay.querySelectorAll('[data-scale]').forEach(el => {
    const base = parseFloat(el.dataset.scale);
    if (el.tagName === 'circle') el.setAttribute('r', base * inv);
    else if (el.tagName === 'text') {
      el.setAttribute('font-size', base * inv);
      el.setAttribute('stroke-width', 2 * inv);
    } else if (el.tagName === 'image') {
      const size = base * inv;
      el.setAttribute('width', size);
      el.setAttribute('height', size);
      const cx = parseFloat(el.dataset.cx), cy = parseFloat(el.dataset.cy);
      el.setAttribute('x', cx - size / 2);
      el.setAttribute('y', cy - size / 2);
    }
  });
}

let dragging = false, dragStart = null;
mapWrap.addEventListener('mousedown', e => {
  dragging = true; mapWrap.classList.add('dragging');
  dragStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
});
window.addEventListener('mousemove', e => {
  if (!mapImg) return;
  if (dragging) {
    view.x = dragStart.vx + (e.clientX - dragStart.x);
    view.y = dragStart.vy + (e.clientY - dragStart.y);
    applyView();
  }
  const [px, py] = clientToPixel(e.clientX, e.clientY);
  hud.textContent = `px ${px.toFixed(0)}, ${py.toFixed(0)}  ·  zoom ${view.scale.toFixed(3)}`;
});
window.addEventListener('mouseup', () => { dragging = false; mapWrap.classList.remove('dragging'); });
mapWrap.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = mapWrap.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const factor = Math.exp(-e.deltaY * 0.0015);
  const ns = Math.max(0.02, Math.min(8, view.scale * factor));
  view.x = mx - (mx - view.x) * (ns / view.scale);
  view.y = my - (my - view.y) * (ns / view.scale);
  view.scale = ns;
  applyView();
}, { passive: false });

function clientToPixel(cx, cy) {
  const rect = mapWrap.getBoundingClientRect();
  return [(cx - rect.left - view.x) / view.scale, (cy - rect.top - view.y) / view.scale];
}

function applyT(T, gx, gz) {
  return [T.a * gx + T.b * gz + T.tx, T.c * gx + T.d * gz + T.ty];
}

async function readJpegComment(file) {
  try {
    const meta = await exifr.parse(file, { userComment: true, ifd0: true, xmp: false });
    if (meta) {
      const cand = meta.UserComment || meta.userComment || meta.ImageDescription || meta.Comment;
      if (cand && /P:/.test(typeof cand === 'string' ? cand : '')) return cand;
    }
  } catch {}
  const buf = new Uint8Array(await file.arrayBuffer());
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
  const queue = [];
  const skipped = [];
  for (const f of files) {
    try {
      const comment = await readJpegComment(f);
      const m = comment && comment.match(/P:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/);
      if (!m) { skipped.push(f.name); continue; }
      let thumb;
      try {
        const bmp = await createImageBitmap(f, { resizeWidth: 1600, resizeQuality: 'high' });
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        thumb = c.toDataURL('image/jpeg', 0.7);
        bmp.close?.();
      } catch { thumb = ''; }
      queue.push({ file: f.name, game: [parseFloat(m[1]), parseFloat(m[3])], thumb });
    } catch {
      skipped.push(f.name);
    }
  }
  fileInput.value = '';
  if (queue.length) await runPickerQueue(queue);
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
      showAnimalStep();
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
      }
    };

    const btnSkip = document.getElementById('modalSkip');
    const btnCancel = document.getElementById('modalCancel');
    btnSkip.addEventListener('click', next);
    btnCancel.addEventListener('click', cancelAll);
    btnBack.addEventListener('click', onBack);
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

searchEl.addEventListener('input', () => { searchTerm = searchEl.value.toLowerCase(); renderList(); });

function locLabel(l) { return l.displayName || l.title || l.file || 'Unnamed'; }

function renderList() {
  countEl.textContent = locations.length;
  const filtered = searchTerm
    ? locations.filter(l => locLabel(l).toLowerCase().includes(searchTerm) || (l.animal || '').toLowerCase().includes(searchTerm))
    : locations;
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
  let svg = '';
  for (const l of locations) {
    const [px, py] = applyT(transform, l.game[0], l.game[1]);
    const active = l.id === activeId;
    const enter = l.id === enterId ? ' enter' : '';
    const label = locLabel(l);
    const animal = l.animal;
    const stroke = active ? '#ffd591' : '#f0b86e';
    const labelY = py - (DOT_RADIUS + 4);
    if (animal) {
      svg += `<g class="loc${enter}" data-id="${l.id}">
        <circle cx="${px}" cy="${py}" data-scale="${DOT_RADIUS}" r="${DOT_RADIUS}" fill="rgba(14,17,22,0.92)" stroke="${stroke}" stroke-width="1.5"/>
        <image data-scale="${DOT_IMG}" data-cx="${px}" data-cy="${py}" href="${ANIMAL_IMG(animal)}" width="${DOT_IMG}" height="${DOT_IMG}" x="${px - DOT_IMG/2}" y="${py - DOT_IMG/2}" preserveAspectRatio="xMidYMid meet"/>
        <text data-scale="${DOT_TEXT}" x="${px}" y="${labelY}" text-anchor="middle"
          font-family="ui-sans-serif, system-ui, sans-serif" font-weight="600"
          fill="${stroke}" stroke="#0a0a0a" stroke-width="2" paint-order="stroke" font-size="${DOT_TEXT}">${escapeHtml(label)}</text>
      </g>`;
    } else {
      svg += `<g class="loc${enter}" data-id="${l.id}">
        <circle data-scale="6" cx="${px}" cy="${py}" r="6" fill="${stroke}" stroke="#1a1208" stroke-width="1.5"/>
        <text data-scale="${DOT_TEXT}" x="${px}" y="${py - 10}" text-anchor="middle"
          font-family="ui-sans-serif, system-ui, sans-serif" font-weight="600"
          fill="${stroke}" stroke="#0a0a0a" stroke-width="2" paint-order="stroke" font-size="${DOT_TEXT}">${escapeHtml(label)}</text>
      </g>`;
    }
  }
  overlay.innerHTML = svg;
  applyView();
  if (enterId) {
    requestAnimationFrame(() => {
      overlay.querySelectorAll('.loc.enter').forEach(g => g.classList.remove('enter'));
    });
  }
}

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), locations }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'locations.json';
  a.click();
});
document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', async e => {
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
document.getElementById('clearBtn').addEventListener('click', async () => {
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

window.addEventListener('resize', applyView);
