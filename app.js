/* Calcul productible PV – interface (saisie, fichiers, résultats, exports). Le calcul tourne dans worker.js (Pyodide). */
'use strict';

// ------------------------------------------------------------------ valeurs par défaut (cas St-Seurin)
const DEFAULTS = {
  project: { name: 'Nouveau projet', variant: 'Var0', author: '' },
  site: { lat: 45.0034, lon: 0.0174, alt: 34, albedo: 0.20 },
  meteo: { tmy_has_horizon: false, gsa_mode: 'monthly', gsa_align_temp: false },
  horizon: { use: true },
  structure: { type: 'fixed', tilt: 16, azimuth: 180, pitch: 9.01, width: 7.19, height: 0.80, n_rows: 17,
    n_high: 3, orientation: 'portrait', sub_in_height: null, elec_effect: 80,
    axis_azimuth: 180, max_angle: 55, backtrack: true, axis_height: 1.5 },
  array: { n_series: 27, n_strings: 128 },
  inverters: { groups: [[4, 21], [2, 22]], t_offset: 0, p_inj_kw: null },
  bifacial: { enabled: true, bifaciality: null, albedo_ground: 0.17, rear_shading: 5, rear_mismatch: 10, transparent: 0 },
  thermal: { uc: 29, uv: 0 },
  iam: { mode: 'fresnel', n: 1.526, n_ar: 1.29 },
  losses: { soiling: 1.5, lid: 1.0, quality: 0, mismatch: 1.0, string_mismatch: 0.1, dc_ohmic: 1.0,
    ac_ohmic: 1.5, mv_line: 0.1, availability: 0, tr_enabled: true, tr_sn_kva: 2210, tr_iron_kw: 1.32,
    tr_cu_kw: 13.24, tr_always_on: true, aux_w: 500, aux_thresh_kw: 500, aux_night_w: 0, inv_night: false },
  p90: { meteo_var: 3.0, items: [
    ['Variabilité météo future sur 10 ans', 2.0],
    ['Modélisation (pertes DC, AC, ombrages, T°, disponibilité)', 2.5],
    ['Pertes spectrales et réflexion', 1.5], ['Transposition', 1.0], ['Paramètres des modules PV', 2.0],
    ['Efficacité onduleur', 0.5], ['Encrassement', 1.0], ['Mismatch', 0.9], ['Estimation dégradation', 0.9]] },
  lifetime: { years: 1, degradation: 0.4 },
};
const MONTHS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
const FILES = {
  tmy: { label: 'TMY PVGIS', accept: '.csv,.json,.htm,.html,.txt', req: true },
  pan: { label: 'Module .PAN', accept: '.pan,.PAN', req: true },
  ond: { label: 'Onduleur .OND', accept: '.ond,.OND', req: true },
  gsa: { label: 'Global Solar Atlas', accept: '.json,.htm,.html,.txt', req: false },
  horizon: { label: 'Masque lointain', accept: '.csv,.txt,.hor,.htm,.html', req: false },
  pvgis_monthly: { label: 'PVGIS mensuel (P90)', accept: '.csv,.txt,.htm,.html', req: false },
};
const STORE = 'calcul-productible.v1';

const clone = (o) => JSON.parse(JSON.stringify(o));
function deepMerge(base, over) {
  const out = clone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function set(o, p, v) { const ks = p.split('.'); let a = o; ks.slice(0, -1).forEach((k) => (a = a[k] = a[k] || {})); a[ks.at(-1)] = v; }
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = (v, d = 0) => (v == null || isNaN(v) ? '–' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pf = (v, d = 1) => (v == null || isNaN(v) ? '–' : nf(100 * v, d) + ' %');

const S = { cfg: clone(DEFAULTS), files: {}, names: {}, gsa: null, info: {}, check: null, res: null, ready: false, charts: {} };

// ------------------------------------------------------------------ worker
const worker = new Worker('worker.js');
let seq = 0; const pending = new Map();
worker.onmessage = (ev) => {
  const d = ev.data;
  if (d.type === 'status') return setStatus(d.text, 'busy', d.pct);
  if (d.type === 'ready') {
    S.ready = true; $('#engineInfo').textContent = `Moteur v${d.engine} · pvlib ${d.pvlib} · Pyodide`;
    setStatus('Moteur prêt. Déposez les fichiers et lancez la simulation.', 'ok', 100); refreshAll(); return;
  }
  const p = pending.get(d.id); if (!p) return; pending.delete(d.id);
  d.ok ? p.resolve(d.out) : p.reject(new Error(d.error));
};
worker.onerror = (e) => setStatus('Erreur du moteur : ' + (e.message || e), 'err');
function call(cmd, args) { const id = ++seq; worker.postMessage({ id, cmd, args }); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })); }
call('init').catch((e) => setStatus('Impossible de charger le moteur : ' + e.message, 'err'));

function setStatus(text, kind = '', pct = null) {
  $('#statusText').textContent = text; $('#statusDot').className = 'dot ' + kind;
  if (pct != null) $('#progress').style.width = (pct >= 100 ? 0 : pct) + '%';
}

// ------------------------------------------------------------------ champs de saisie
function num(path, label, unit = '', o = {}) {
  return `<div class="fld ${o.full ? 'full' : ''}" ${o.show ? `data-show="${o.show}"` : ''}>
    <label>${label}${unit ? `<i>${unit}</i>` : ''}</label>
    <input type="number" data-path="${path}" step="${o.step ?? 'any'}" ${o.min != null ? `min="${o.min}"` : ''} ${o.max != null ? `max="${o.max}"` : ''} ${o.ph ? `placeholder="${o.ph}"` : ''} ${o.ro ? 'readonly' : ''} ${o.title ? `title="${esc(o.title)}"` : ''}>
    ${o.hint ? `<div class="hint">${o.hint}</div>` : ''}</div>`;
}
function txt(path, label, o = {}) {
  return `<div class="fld ${o.full ? 'full' : ''}"><label>${label}</label><input type="text" data-path="${path}" ${o.ph ? `placeholder="${o.ph}"` : ''}></div>`;
}
function sel(path, label, opts, o = {}) {
  return `<div class="fld ${o.full ? 'full' : ''}" ${o.show ? `data-show="${o.show}"` : ''}><label>${label}</label><select data-path="${path}">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>${o.hint ? `<div class="hint">${o.hint}</div>` : ''}</div>`;
}
function chk(path, label, o = {}) {
  return `<div class="fld full" ${o.show ? `data-show="${o.show}"` : ''}><label class="chk"><input type="checkbox" data-path="${path}"> ${label}</label>${o.hint ? `<div class="hint">${o.hint}</div>` : ''}</div>`;
}
function drop(key, hint) {
  const f = FILES[key];
  return `<div class="fld full"><label>${f.label}${f.req ? '<i>obligatoire</i>' : '<i>optionnel</i>'}</label>
    <div class="drop" data-drop="${key}"><span class="ico">⇪</span><div class="dtxt" data-hint="${esc(hint || '')}"><b>Déposer ou choisir un fichier</b>${hint || ''}</div>
    <input type="file" accept="${f.accept}" hidden></div><div class="hint" id="info-${key}"></div></div>`;
}
function section(id, title, body, open = false) {
  return `<details class="sec" id="sec-${id}" ${open ? 'open' : ''}><summary><b>${title}</b><small id="sum-${id}"></small></summary><div class="secbody"><div class="grid">${body}</div></div></details>`;
}

function buildForm() {
  const st = (t) => `structure.type==${t}`;
  $('#form').innerHTML = [
    section('project', 'Projet', txt('project.name', 'Nom du projet', { full: true }) + txt('project.variant', 'Variante') + txt('project.author', 'Auteur'), true),
    section('site', 'Site', num('site.lat', 'Latitude', '°N', { step: 0.0001 }) + num('site.lon', 'Longitude', '°E', { step: 0.0001 }) +
      num('site.alt', 'Altitude', 'm') + num('site.albedo', 'Albédo du site', '', { step: 0.01, hint: 'Albédo vu par la face avant.' }) +
      `<div class="fld full"><div id="map"></div><div class="hint">Cliquer sur la carte ou déplacer le repère pour placer le site.</div>
      <label style="margin-top:8px">Télécharger les données pour ces coordonnées</label><div class="links" id="dlLinks"></div>
      <div class="hint">Chaque lien ouvre les données du site dans un nouvel onglet. Enregistrer la page (Ctrl+S / ⌘S) : le fichier .htm obtenu se dépose tel quel dans l'application.</div></div>`, true),
    section('meteo', 'Météo', drop('tmy', '<span>TMY PVGIS 5.3 au format CSV ou JSON</span>') +
      chk('meteo.tmy_has_horizon', "Le TMY a été téléchargé avec l'horizon PVGIS (« usehorizon »)", { hint: "Lu automatiquement dans un fichier JSON. Pour un CSV, cocher si l'option horizon était active : le masque PVGIS est alors déjà dans le direct. Recommandé : TMY sans horizon + masque déposé ci-dessous." }) +
      ''),
    section('horizon', 'Masque lointain', drop('horizon', '<span>CSV PVsyst (Azimut;Hauteur, 0 = Sud, Est &lt; 0) ou horizon PVGIS</span>') +
      chk('horizon.use', 'Appliquer le masque (direct coupé sous l\'horizon, diffus réduit)')),
    section('gsa', 'Global Solar Atlas', sel('meteo.gsa_mode', 'Recalage du TMY', [['monthly', 'Mensuel (GHI et DIF, 12 mois)'], ['annual', 'Annuel (GHI et DIF)'], ['none', 'Aucun (TMY brut)']], { full: true }) +
      chk('meteo.gsa_align_temp', 'Recaler aussi la température mensuelle sur GSA') +
      drop('gsa', '<span>JSON de l\'API GSA (.json ou page .htm enregistrée), ou coller le texte ci-dessous</span>') +
      `<div class="fld full"><textarea id="gsaPaste" placeholder='Coller ici la réponse JSON de https://api.globalsolaratlas.info/data/lta?loc=lat,lon'></textarea></div>
      <div class="fld full" id="gsaTable"></div>`),
    section('module', 'Modules', drop('pan', '<span>Fichier PVsyst .PAN</span>') +
      num('array.n_series', 'Modules en série', '', { step: 1, min: 1 }) + num('array.n_strings', 'Nombre de chaînes', '', { ro: true, hint: 'Calculé à partir des groupes d\'onduleurs.' }) +
      num('bifacial.bifaciality', 'Facteur de bifacialité', '', { step: 0.01, ph: 'valeur du .PAN', hint: 'Vide = valeur du .PAN.' }) +
      `<div class="fld"><label>Puissance DC</label><input type="text" id="pdcOut" readonly></div>`),
    section('inverter', 'Onduleurs', drop('ond', '<span>Fichier PVsyst .OND</span>') +
      `<div class="fld full groups"><label>Groupes d'onduleurs<i>nb onduleurs × chaînes par onduleur</i></label><div id="groups"></div>
      <button type="button" class="mini" id="addGroup">+ Ajouter un groupe</button></div>` +
      num('inverters.t_offset', 'Offset de température autour des onduleurs', '°C', { step: 0.5, full: true, hint: 'Ajouté à la température ambiante pour le déclassement en puissance (courbe Pmax / Pnom / PLim du .OND).' }) +
      num('inverters.p_inj_kw', "Limite de puissance d'injection", 'kW', { ph: 'aucune', full: true })),
    section('structure', 'Structure', `<div class="fld full"><label>Type de structure</label><div class="seg" id="stype">
        <button type="button" data-v="fixed">Sheds fixes</button><button type="button" data-v="tracker">Tracker mono-axe</button><button type="button" data-v="ew">Est-Ouest</button></div></div>` +
      num('structure.tilt', 'Inclinaison', '°', { show: 'structure.type!=tracker' }) +
      num('structure.azimuth', 'Azimut (PVsyst)', '°', { show: st('fixed'), hint: '0 = Sud, Est &lt; 0, Ouest &gt; 0.', title: 'Convention PVsyst' }) +
      num('structure.axis_azimuth', "Azimut de l'axe", '°', { show: st('tracker'), hint: '180 = axe Nord-Sud.' }) +
      num('structure.max_angle', 'Rotation maximale', '±°', { show: st('tracker') }) +
      chk('structure.backtrack', 'Backtracking', { show: st('tracker') }) +
      num('structure.pitch', 'Entraxe des rangées', 'm', { hint: 'Est-Ouest : distance entre faîtages.' }) +
      num('structure.width', 'Largeur sensible', 'm', { hint: 'Est-Ouest : largeur d\'un pan.' }) +
      num('structure.height', 'Hauteur du bord bas', 'm', { show: 'structure.type!=tracker' }) +
      num('structure.axis_height', "Hauteur de l'axe", 'm', { show: st('tracker') }) +
      num('structure.n_rows', 'Nombre de rangées', '', { step: 1, min: 1, hint: 'La 1re rangée n\'est pas ombrée.' }) +
      num('structure.n_high', 'Modules en hauteur', '', { step: 1, min: 1 }) +
      sel('structure.orientation', 'Pose des modules', [['portrait', 'Portrait'], ['landscape', 'Paysage']]) +
      `<div class="fld"><label>GCR / angle limite</label><input type="text" id="gcrOut" readonly></div>`),
    section('shading', 'Ombrage électrique', num('structure.elec_effect', "Fraction de l'effet électrique", '%', { hint: 'Ombrage « selon les chaînes » de PVsyst.' }) +
      num('structure.sub_in_height', 'Sous-chaînes en hauteur', '', { step: 1, min: 1, ph: 'auto', hint: 'Les chaînes suivent les rangées. Auto : 2 par module portrait en demi-cellules, 1 en cellules entières, 3 par module paysage.' })),
    section('bifacial', 'Bifacial', chk('bifacial.enabled', 'Prendre en compte la face arrière') +
      num('bifacial.albedo_ground', 'Albédo du sol', '', { step: 0.01 }) + num('bifacial.rear_shading', 'Ombrage arrière', '%') +
      num('bifacial.rear_mismatch', 'Mismatch arrière', '%') + num('bifacial.transparent', 'Fraction transparente', '%')),
    section('thermal', 'Thermique et IAM', num('thermal.uc', 'Uc', 'W/m²K') + num('thermal.uv', 'Uv', 'W/m²K/m/s') +
      sel('iam.mode', 'Modèle IAM', [['fresnel', 'Fresnel (verre + couche AR)'], ['pan', 'Profil utilisateur du .PAN']], { full: true }) +
      num('iam.n', 'Indice du verre', '', { step: 0.001, show: 'iam.mode==fresnel' }) + num('iam.n_ar', 'Indice couche AR', '', { step: 0.001, ph: 'sans', show: 'iam.mode==fresnel' })),
    section('dc', 'Pertes DC', num('losses.soiling', 'Salissure', '%') + num('losses.lid', 'LID', '%') + num('losses.quality', 'Qualité module', '%') +
      num('losses.mismatch', 'Mismatch modules', '%') + num('losses.string_mismatch', 'Mismatch chaînes', '%') + num('losses.dc_ohmic', 'Ohmiques DC à STC', '%')),
    section('ac', 'Pertes AC et système', num('losses.ac_ohmic', 'Ohmiques AC à STC', '%') + num('losses.mv_line', 'Ligne HTA à STC', '%') +
      chk('losses.tr_enabled', 'Transformateur') + num('losses.tr_sn_kva', 'Puissance transfo', 'kVA') + num('losses.tr_iron_kw', 'Pertes fer', 'kW') +
      num('losses.tr_cu_kw', 'Pertes cuivre nominales', 'kW') + chk('losses.tr_always_on', 'Transformateur connecté 24 h/24 (pertes fer la nuit)') +
      num('losses.aux_w', 'Auxiliaires de jour', 'W') + num('losses.aux_thresh_kw', 'Seuil auxiliaires', 'kW') + num('losses.aux_night_w', 'Auxiliaires de nuit', 'W') +
      chk('losses.inv_night', 'Consommation de nuit des onduleurs (.OND)') + num('losses.availability', 'Indisponibilité', '%')),
    section('p90', 'P50 / P90', num('p90.meteo_var', 'Variabilité météo interannuelle', '%', { step: 0.1, full: true, hint: 'Remplacée par la valeur calculée si le CSV mensuel PVGIS est déposé.' }) +
      drop('pvgis_monthly', '<span>CSV « Monthly data » de PVGIS (GHI mensuel par année)</span>') +
      `<div class="fld full"><label>Autres incertitudes<i>écart-type %</i></label><div id="p90items"></div><button type="button" class="mini" id="addP90">+ Ajouter</button></div>` +
      num('lifetime.years', 'Années simulées', '', { step: 1, min: 1 }) + num('lifetime.degradation', 'Dégradation annuelle', '%/an', { step: 0.05 })),
  ].join('');

  // liaisons génériques
  $$('[data-path]').forEach((el) => {
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      const p = el.dataset.path; let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'number') v = el.value === '' ? null : Number(el.value);
      else v = el.value;
      set(S.cfg, p, v); onChange(p);
    });
  });
  $$('#stype button').forEach((b) => b.addEventListener('click', () => { set(S.cfg, 'structure.type', b.dataset.v); onChange('structure.type'); }));
  $$('[data-drop]').forEach(bindDrop);
  $('#addGroup').addEventListener('click', () => { S.cfg.inverters.groups.push([1, 10]); renderGroups(); onChange('inverters.groups'); });
  $('#addP90').addEventListener('click', () => { S.cfg.p90.items.push(['Autre', 1.0]); renderP90Items(); onChange('p90.items'); });
  $('#gsaPaste').addEventListener('input', (e) => { const t = e.target.value.trim(); if (t) loadGsaText(t, 'collé'); });
}

function fillForm() {
  $$('[data-path]').forEach((el) => {
    const v = get(S.cfg, el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v;
  });
  renderGroups(); renderP90Items(); applyVisibility();
}

function applyVisibility() {
  $$('[data-show]').forEach((el) => {
    const m = el.dataset.show.match(/^([\w.]+)(==|!=)(\w+)$/);
    const v = String(get(S.cfg, m[1]));
    el.style.display = (m[2] === '==' ? v === m[3] : v !== m[3]) ? '' : 'none';
  });
  $$('#stype button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.cfg.structure.type));
}

function renderGroups() {
  $('#groups').innerHTML = S.cfg.inverters.groups.map((g, i) => `<div class="grow">
    <input type="number" min="1" step="1" value="${g[0]}" data-g="${i},0" title="Nombre d'onduleurs">
    <input type="number" min="1" step="1" value="${g[1]}" data-g="${i},1" title="Chaînes par onduleur">
    <button type="button" data-del="${i}" title="Supprimer">×</button></div>`).join('') +
    '<div class="grow"><span>onduleurs</span><span>chaînes / onduleur</span><span></span></div>';
  $$('#groups [data-g]').forEach((el) => el.addEventListener('input', () => {
    const [i, j] = el.dataset.g.split(',').map(Number); S.cfg.inverters.groups[i][j] = Number(el.value) || 0; onChange('inverters.groups');
  }));
  $$('#groups [data-del]').forEach((b) => b.addEventListener('click', () => {
    if (S.cfg.inverters.groups.length > 1) { S.cfg.inverters.groups.splice(Number(b.dataset.del), 1); renderGroups(); onChange('inverters.groups'); }
  }));
}
function renderP90Items() {
  $('#p90items').innerHTML = S.cfg.p90.items.map((it, i) => `<div class="grow" style="grid-template-columns:1fr 70px 28px">
    <input type="text" value="${esc(it[0])}" data-p="${i},0"><input type="number" step="0.1" value="${it[1]}" data-p="${i},1">
    <button type="button" data-pdel="${i}">×</button></div>`).join('');
  $$('#p90items [data-p]').forEach((el) => el.addEventListener('input', () => {
    const [i, j] = el.dataset.p.split(',').map(Number); S.cfg.p90.items[i][j] = j ? Number(el.value) || 0 : el.value; onChange('p90.items');
  }));
  $$('#p90items [data-pdel]').forEach((b) => b.addEventListener('click', () => { S.cfg.p90.items.splice(Number(b.dataset.pdel), 1); renderP90Items(); onChange('p90.items'); }));
}

// ------------------------------------------------------------------ fichiers
function bindDrop(box) {
  const key = box.dataset.drop; const input = $('input[type=file]', box);
  box.addEventListener('click', (e) => { if (!e.target.classList.contains('clear')) input.click(); });
  input.addEventListener('change', () => input.files[0] && readFile(key, input.files[0]));
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('over'); e.dataTransfer.files[0] && readFile(key, e.dataTransfer.files[0]); });
}
async function readFile(key, file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
  text = unwrapHtml(text);
  if (key === 'gsa') return loadGsaText(text, file.name);
  S.files[key] = text; S.names[key] = file.name; S.info[key] = null;
  await parseFile(key); save(); refreshAll();
}
async function parseFile(key) {
  const text = S.files[key]; if (!text) return;
  const el = $('#info-' + key);
  try {
    if (key === 'pan') S.info.pan = await call('pan', { text });
    else if (key === 'ond') S.info.ond = await call('ond', { text });
    else if (key === 'horizon') S.info.horizon = await call('horizon', { text });
    else if (key === 'pvgis_monthly') S.info.pvgis_monthly = await call('monthly', { text });
    else if (key === 'tmy') {
      S.info.tmy = await call('tmy', { text, name: S.names.tmy });
      if (S.info.tmy.use_horizon != null) { S.cfg.meteo.tmy_has_horizon = !!S.info.tmy.use_horizon; fillForm(); }
    }
    el && (el.style.color = '');
  } catch (e) {
    S.info[key] = { error: e.message }; if (el) { el.textContent = '⚠ ' + e.message; el.style.color = 'var(--block)'; }
  }
}
// Une réponse d'API enregistrée par le navigateur (Ctrl+S) devient une page .htm : on en extrait le texte brut.
function unwrapHtml(text) {
  const head = text.slice(0, 2000).toLowerCase();
  if (!/^\s*(<!doctype html|<html|<head|<body|<pre|<meta)/.test(head) && !head.includes('<pre')) return text;
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const pres = [...doc.querySelectorAll('pre')].map((p) => p.textContent).filter((t) => t.trim());
  const out = pres.length ? pres.sort((a, b) => b.length - a.length)[0] : (doc.body ? doc.body.textContent : text);
  return out.replace(/\u00a0/g, ' ').trim() + '\n';
}
function clearFile(key) { delete S.files[key]; delete S.names[key]; delete S.info[key]; if (key === 'gsa') S.gsa = null; save(); refreshAll(); }

function loadGsaText(text, name) {
  try {
    const d = JSON.parse(text);
    const mon = (d.monthly && (d.monthly.data || d.monthly)) || {};
    const ann = (d.annual && (d.annual.data || d.annual)) || {};
    if (!Array.isArray(mon.GHI) || mon.GHI.length !== 12) throw new Error('12 valeurs mensuelles de GHI attendues');
    S.gsa = { ghi: mon.GHI.map(Number), dif: (mon.DIF || []).map(Number), temp: (mon.TEMP || []).map(Number),
      ghi_year: ann.GHI ?? null, dif_year: ann.DIF ?? null, temp_year: ann.TEMP ?? null, dni_year: ann.DNI ?? null, pvout: ann.PVOUT_csi ?? null };
    S.names.gsa = name; save(); refreshAll();
  } catch (e) { $('#info-gsa').textContent = '⚠ JSON Global Solar Atlas illisible : ' + e.message; $('#info-gsa').style.color = 'var(--block)'; }
}

function renderFileBoxes() {
  for (const key of Object.keys(FILES)) {
    const box = $(`[data-drop="${key}"]`); if (!box) continue;
    const loaded = key === 'gsa' ? !!S.gsa : !!S.files[key];
    box.classList.toggle('loaded', loaded);
    $('.dtxt', box).innerHTML = loaded ? `<b>${esc(S.names[key] || 'chargé')}</b><span>${fileSummary(key)}</span>` : `<b>Déposer ou choisir un fichier</b>${$('.dtxt', box).dataset.hint}`;
    $('.ico', box).textContent = loaded ? '✓' : '⇪';
    let c = $('.clear', box);
    if (loaded && !c) { c = document.createElement('button'); c.type = 'button'; c.className = 'clear'; c.textContent = '×'; c.title = 'Retirer'; c.onclick = (e) => { e.stopPropagation(); clearFile(key); }; box.appendChild(c); }
    if (!loaded && c) c.remove();
    const info = $('#info-' + key);
    if (info && !(S.info[key] && S.info[key].error)) { info.textContent = ''; info.style.color = ''; }
  }
  renderGsaTable();
}
function fileSummary(key) {
  const i = S.info[key];
  if (key === 'gsa' && S.gsa) return `GHI ${nf(S.gsa.ghi.reduce((a, b) => a + b, 0), 1)} · DIF ${nf(S.gsa.dif.reduce((a, b) => a + b, 0), 1)} kWh/m²`;
  if (!i) return S.ready ? 'lecture…' : 'lecture dès que le moteur est prêt';
  if (i.error) return 'erreur de lecture';
  if (key === 'pan') return `${esc(i.manufacturer)} ${esc(i.model)} · ${nf(i.pnom)} Wc · Voc ${nf(i.voc, 2)} V · Isc ${nf(i.isc, 2)} A${i.bifaciality ? ' · bifacialité ' + nf(i.bifaciality, 2) : ''}`;
  if (key === 'ond') return `${esc(i.manufacturer)} ${esc(i.model)} · ${nf(i.pnom / 1000)} kW (Pmax ${nf(i.pmax / 1000)} kW) · MPPT ${nf(i.vmin)}–${nf(i.vmax)} V · Imax ${nf(i.imax_dc)} A`;
  if (key === 'tmy') return `${esc(i.db || 'PVGIS')} ${i.years || ''} · ${nf(i.lat, 3)} / ${nf(i.lon, 3)} · GHI ${nf(i.ghi.reduce((a, b) => a + b, 0), 1)} kWh/m² · horizon ${i.use_horizon == null ? 'non précisé' : i.use_horizon ? 'inclus' : 'non inclus'}`;
  if (key === 'horizon') return `${i.length} points · hauteur max. ${nf(Math.max(...i.map((p) => p[1])), 1)}°`;
  if (key === 'pvgis_monthly') return `${i.years.length} années complètes (${i.years[0]}–${i.years.at(-1)}) · variabilité ${nf(100 * i.variability, 2)} %`;
  return '';
}
function renderGsaTable() {
  const box = $('#gsaTable'); if (!box) return;
  if (!S.gsa) { box.innerHTML = ''; return; }
  const tmy = S.info.tmy && !S.info.tmy.error ? S.info.tmy : null;
  box.innerHTML = `<table class="mtable"><tr><th>Mois</th><th>GHI GSA</th><th>DIF GSA</th><th>T GSA</th>${tmy ? '<th>GHI TMY</th><th>Écart</th>' : ''}</tr>` +
    MONTHS.map((m, i) => `<tr><td>${m}</td><td><input type="number" step="0.1" value="${(+S.gsa.ghi[i]).toFixed(1)}" data-gsa="ghi,${i}"></td>
      <td><input type="number" step="0.1" value="${(+S.gsa.dif[i] || 0).toFixed(1)}" data-gsa="dif,${i}"></td><td>${nf(S.gsa.temp[i], 1)}</td>
      ${tmy ? `<td>${nf(tmy.ghi[i], 1)}</td><td>${pf(S.gsa.ghi[i] / tmy.ghi[i] - 1, 0)}</td>` : ''}</tr>`).join('') +
    `<tr><td><b>Année</b></td><td><b>${nf(S.gsa.ghi.reduce((a, b) => a + b, 0), 1)}</b></td><td><b>${nf(S.gsa.dif.reduce((a, b) => a + b, 0), 1)}</b></td><td>${nf(S.gsa.temp_year, 1)}</td>
      ${tmy ? `<td><b>${nf(tmy.ghi.reduce((a, b) => a + b, 0), 1)}</b></td><td>${pf(S.gsa.ghi.reduce((a, b) => a + b, 0) / tmy.ghi.reduce((a, b) => a + b, 0) - 1, 1)}</td>` : ''}</tr></table>
      <div class="hint">Valeurs modifiables (kWh/m²). En recalage annuel, seuls les totaux annuels sont utilisés.</div>`;
  $$('[data-gsa]', box).forEach((el) => el.addEventListener('change', () => {
    const [k, i] = el.dataset.gsa.split(','); S.gsa[k][+i] = Number(el.value) || 0;
    if (k === 'ghi') S.gsa.ghi_year = S.gsa.ghi.reduce((a, b) => a + b, 0); else S.gsa.dif_year = S.gsa.dif.reduce((a, b) => a + b, 0);
    save(); renderGsaTable();
  }));
}

// ------------------------------------------------------------------ carte & liens
let map, marker;
function initMap() {
  if (!window.L) return;
  map = L.map('map', { zoomControl: true, attributionControl: true }).setView([S.cfg.site.lat, S.cfg.site.lon], 9);
  // Fonds IGN (Géoplateforme, licence ouverte Etalab) ; OpenStreetMap en secours hors de France
  const ign = (layer, fmt) => L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layer +
    '&STYLE=normal&TILEMATRIXSET=PM&FORMAT=' + fmt + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    { maxZoom: 19, attribution: '© <a href="https://geoservices.ign.fr" target="_blank" rel="noopener">IGN – Géoplateforme</a>' });
  const plan = ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png');
  const ortho = ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg');
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' });
  plan.addTo(map);
  L.control.layers({ 'Plan IGN': plan, 'Photographies aériennes IGN': ortho, 'OpenStreetMap (hors France)': osm }, null, { position: 'topright' }).addTo(map);
  marker = L.marker([S.cfg.site.lat, S.cfg.site.lon], { draggable: true }).addTo(map);
  const setLL = (ll) => { S.cfg.site.lat = +ll.lat.toFixed(5); S.cfg.site.lon = +ll.lng.toFixed(5); fillForm(); onChange('site.lat'); };
  map.on('click', (e) => { marker.setLatLng(e.latlng); setLL(e.latlng); });
  marker.on('dragend', () => setLL(marker.getLatLng()));
  $('#sec-site').addEventListener('toggle', () => setTimeout(() => map.invalidateSize(), 50));
}
function renderLinks() {
  const { lat, lon } = S.cfg.site; if (lat == null || lon == null) return;
  const b = 'https://re.jrc.ec.europa.eu/api/v5_3/';
  const L2 = [
    ['TMY PVGIS (JSON, sans horizon)', `${b}tmy?lat=${lat}&lon=${lon}&usehorizon=0&outputformat=json`],
    ['TMY PVGIS (CSV)', `${b}tmy?lat=${lat}&lon=${lon}&usehorizon=0&outputformat=csv`],
    ['Horizon PVGIS (CSV)', `${b}printhorizon?lat=${lat}&lon=${lon}&outputformat=csv`],
    ['PVGIS mensuel (CSV)', `${b}MRcalc?lat=${lat}&lon=${lon}&horirrad=1&avtemp=1&outputformat=csv`],
    ['Global Solar Atlas (JSON)', `https://api.globalsolaratlas.info/data/lta?loc=${lat},${lon}`],
    ['Carte GSA', `https://globalsolaratlas.info/map?c=${lat},${lon},11&s=${lat},${lon}&m=site`],
  ];
  $('#dlLinks').innerHTML = L2.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`).join('');
  if (marker && (Math.abs(marker.getLatLng().lat - lat) > 1e-6 || Math.abs(marker.getLatLng().lng - lon) > 1e-6)) { marker.setLatLng([lat, lon]); map.setView([lat, lon]); }
}

// ------------------------------------------------------------------ cohérence, alertes
let checkTimer = null;
function onChange(path) {
  if (path === 'inverters.groups' || path === 'array.n_series') syncStrings();
  applyVisibility(); renderDerived(); renderLinks(); save();
  clearTimeout(checkTimer); checkTimer = setTimeout(runCheck, 250);
}
function syncStrings() {
  S.cfg.array.n_strings = S.cfg.inverters.groups.reduce((a, g) => a + (g[0] || 0) * (g[1] || 0), 0);
  const el = $('[data-path="array.n_strings"]'); if (el) el.value = S.cfg.array.n_strings;
}
function renderDerived() {
  const c = S.cfg, pan = S.info.pan && !S.info.pan.error ? S.info.pan : null;
  const nmod = c.array.n_series * c.array.n_strings;
  $('#pdcOut').value = pan ? `${nf(nmod)} modules · ${nf(nmod * pan.pnom / 1000, 1)} kWc` : `${nf(nmod)} modules`;
  const gcr = c.structure.width / c.structure.pitch;
  let la = '';
  if (c.structure.type !== 'tracker') {
    const t = c.structure.tilt * Math.PI / 180, r = c.structure.pitch / c.structure.width;
    la = ` · angle limite ${nf(Math.atan(Math.sin(t) / (r - Math.cos(t))) * 180 / Math.PI, 1)}°`;
  }
  $('#gcrOut').value = `GCR ${pf(gcr, 1)}${la}`;
  const sub = $('[data-path="structure.sub_in_height"]');
  if (sub && S.check) sub.placeholder = `auto (${S.check.sub_in_height})`;
  // résumés des sections
  const ond = S.info.ond && !S.info.ond.error ? S.info.ond : null;
  const ninv = c.inverters.groups.reduce((a, g) => a + g[0], 0);
  const sums = {
    project: `${c.project.name} – ${c.project.variant}`, site: `${nf(c.site.lat, 4)} / ${nf(c.site.lon, 4)}`,
    meteo: S.files.tmy ? `TMY ✓${c.meteo.tmy_has_horizon ? ' · horizon PVGIS inclus' : ''}` : 'TMY manquant',
    gsa: c.meteo.gsa_mode === 'none' ? 'sans recalage' : (S.gsa ? `${c.meteo.gsa_mode === 'monthly' ? 'mensuel' : 'annuel'} ✓` : 'données manquantes'),
    horizon: S.files.horizon ? (c.horizon.use ? 'appliqué' : 'désactivé') : 'aucun',
    module: pan ? `${nf(nmod * pan.pnom / 1000, 1)} kWc · ${c.array.n_series} × ${c.array.n_strings}` : `${c.array.n_series} × ${c.array.n_strings}`,
    inverter: ond ? `${ninv} × ${nf(ond.pmax / 1000)} kW · DC/AC ${pan ? nf(nmod * pan.pnom / (ninv * ond.pmax), 2) : '–'}` : `${ninv} onduleurs`,
    structure: { fixed: `Sheds ${c.structure.tilt}° / ${c.structure.azimuth}°`, tracker: `Tracker ±${c.structure.max_angle}°${c.structure.backtrack ? ' backtracking' : ''}`, ew: `Est-Ouest ${c.structure.tilt}°` }[c.structure.type] + ` · GCR ${pf(gcr, 0)}`,
    shading: `${c.structure.elec_effect} % · ${c.structure.sub_in_height || (S.check ? S.check.sub_in_height : 'auto')} en hauteur`,
    bifacial: c.bifacial.enabled ? `albédo ${c.bifacial.albedo_ground}` : 'non',
    thermal: `Uc ${c.thermal.uc} · ${c.iam.mode === 'pan' ? 'IAM .PAN' : 'Fresnel'}`,
    dc: `${nf(c.losses.soiling, 1)} + ${nf(c.losses.lid, 1)} + ${nf(c.losses.mismatch, 1)} + ${nf(c.losses.dc_ohmic, 1)} %`,
    ac: `AC ${nf(c.losses.ac_ohmic, 1)} % · transfo ${c.losses.tr_enabled ? 'oui' : 'non'}`,
    p90: S.info.pvgis_monthly && !S.info.pvgis_monthly.error ? `météo ${nf(100 * S.info.pvgis_monthly.variability, 2)} % (PVGIS)` : `météo ${nf(c.p90.meteo_var, 1)} %`,
  };
  for (const [k, v] of Object.entries(sums)) { const e = $('#sum-' + k); if (e) e.textContent = v; }
}

async function runCheck() {
  if (!S.ready || !S.files.pan || !S.files.ond || (S.info.pan && S.info.pan.error) || (S.info.ond && S.info.ond.error)) { S.check = null; renderAlerts(); return; }
  try { S.check = await call('check', { pan: S.files.pan, ond: S.files.ond, cfg: S.cfg }); } catch (e) { S.check = { error: e.message }; }
  renderAlerts(); renderDerived();
}
function localAlerts() {
  const out = []; const c = S.cfg;
  if (c.meteo.gsa_mode !== 'none' && !S.gsa) out.push({ level: 'warn', title: 'Recalage GSA demandé', message: 'Aucune donnée Global Solar Atlas chargée : le TMY sera utilisé sans recalage.' });
  if (c.meteo.tmy_has_horizon && S.files.horizon && c.horizon.use) out.push({ level: 'warn', title: 'Masque lointain en double', message: "Le TMY contient déjà l'horizon PVGIS : le masque déposé s'ajoute (union des deux masques) et la ligne « masque lointain » du diagramme de pertes est sous-estimée." });
  if (S.info.tmy && !S.info.tmy.error && S.info.tmy.lat != null && (Math.abs(S.info.tmy.lat - c.site.lat) > 0.05 || Math.abs(S.info.tmy.lon - c.site.lon) > 0.05))
    out.push({ level: 'warn', title: 'Coordonnées', message: `Le TMY a été produit pour ${nf(S.info.tmy.lat, 3)} / ${nf(S.info.tmy.lon, 3)}, le site est saisi en ${nf(c.site.lat, 3)} / ${nf(c.site.lon, 3)}.`, fix: 'tmyll' });
  if (c.structure.width >= c.structure.pitch) out.push({ level: 'block', title: 'Géométrie', message: "La largeur sensible doit être inférieure à l'entraxe." });
  if (!(c.array.n_strings > 0)) out.push({ level: 'block', title: 'Câblage', message: 'Aucune chaîne : renseigner les groupes d\'onduleurs.' });
  return out;
}
function renderAlerts() {
  const list = [...((S.check && S.check.alerts) || []), ...localAlerts()];
  if (S.check && S.check.error) list.unshift({ level: 'block', title: 'Lecture .PAN / .OND', message: S.check.error });
  const lab = { ok: 'OK', warn: 'Alerte', block: 'Bloquant' };
  $('#alerts').innerHTML = list.length ? '<h3>Vérifications de dimensionnement</h3>' + list.map((a) => `<div class="al ${a.level}"><span class="badge">${lab[a.level]}</span><div><b>${esc(a.title)}</b><span>${esc(a.message)}</span>${a.fix === 'tmyll' ? ' <button type="button" class="mini" id="fixLL">Utiliser les coordonnées du TMY</button>' : ''}</div></div>`).join('')
    : '';
  const fix = $('#fixLL'); if (fix) fix.onclick = () => { S.cfg.site.lat = S.info.tmy.lat; S.cfg.site.lon = S.info.tmy.lon; if (S.info.tmy.elev != null) S.cfg.site.alt = S.info.tmy.elev; fillForm(); onChange('site.lat'); };
  renderChecklist(list);
}
function canRun(list) {
  const missing = ['tmy', 'pan', 'ond'].filter((k) => !S.files[k] || (S.info[k] && S.info[k].error));
  const blocked = (list || []).some((a) => a.level === 'block');
  return { ok: S.ready && !missing.length && !blocked, missing, blocked };
}
function renderChecklist(list) {
  const r = canRun(list);
  const items = Object.entries(FILES).map(([k, f]) => {
    const ok = k === 'gsa' ? !!S.gsa : !!S.files[k] && !(S.info[k] && S.info[k].error);
    return `<div class="${ok ? 'ok' : f.req ? '' : 'opt'}"><i>${ok ? '✓' : f.req ? '!' : '–'}</i>${f.label}</div>`;
  }).join('');
  $('#checklist').innerHTML = S.res ? '' : `<h3>Fichiers d'entrée</h3><div class="cl">${items}</div>
    <p class="note">${r.ok ? 'Tout est prêt : lancer la simulation.' : r.blocked ? 'Simulation bloquée : voir les vérifications ci-dessous.' : r.missing.length ? 'Fichiers obligatoires manquants : ' + r.missing.map((k) => FILES[k].label).join(', ') + '.' : 'Chargement du moteur…'}</p>`;
  $('#btnRun').disabled = !r.ok;
}
function refreshAll() {
  renderFileBoxes(); renderDerived(); renderLinks();
  for (const k of ['pan', 'ond', 'tmy', 'horizon', 'pvgis_monthly']) if (S.files[k] && !S.info[k] && S.ready) parseFile(k).then(() => { renderFileBoxes(); renderDerived(); runCheck(); });
  runCheck();
}

// ------------------------------------------------------------------ simulation
$('#btnRun').addEventListener('click', async () => {
  const btn = $('#btnRun'); btn.disabled = true;
  setStatus('Simulation horaire en cours…', 'busy', 40);
  const files = { tmy: S.files.tmy, tmy_name: S.names.tmy, pan: S.files.pan, ond: S.files.ond };
  if (S.files.horizon) files.horizon = S.files.horizon;
  if (S.files.pvgis_monthly) files.pvgis_monthly = S.files.pvgis_monthly;
  if (S.gsa) files.gsa = S.gsa;
  const cfg = clone(S.cfg);
  if (!S.gsa) cfg.meteo.gsa_mode = 'none';
  const t0 = performance.now();
  try {
    const res = await call('run', { cfg, files });
    S.res = res;
    if (res.blocked) { S.check = { alerts: res.alerts, sub_in_height: S.check?.sub_in_height }; renderAlerts(); setStatus('Simulation bloquée : voir les vérifications.', 'err', 100); return; }
    renderResults();
    setStatus(`Simulation terminée en ${nf((performance.now() - t0) / 1000, 1)} s · ${nf(res.summary.yield_kwh_kwc, 0)} kWh/kWc · PR ${pf(res.summary.pr, 1)}`, 'ok', 100);
    if (window.innerWidth < 860) { $('#side').classList.add('hide'); window.scrollTo(0, 0); }
  } catch (e) { setStatus('Erreur de simulation : ' + e.message, 'err', 100); }
  finally { btn.disabled = !canRun((S.check && S.check.alerts) || []).ok; }
});

function renderResults() {
  const r = S.res, s = r.summary;
  $('#results').hidden = false; renderChecklist([]);
  $('#tiles').innerHTML = [
    ['main', nf(s.yield_kwh_kwc, 0), 'kWh/kWc/an · P50'], ['', nf(s.e_grid_mwh, 0), 'MWh/an injectés'],
    ['pv', pf(s.pr, 1), 'Performance ratio'], ['', nf(r.p90.p90, 0), `kWh/kWc · P90 (${pf(r.p90.p90_ratio, 1)})`],
    ['', nf(s.glob_inc, 0), 'kWh/m² dans le plan'], ['', nf(s.pnom_kwc, 1), `kWc · DC/AC ${nf(s.dc_ac, 2)}`],
  ].map(([c, v, l]) => `<div class="tile ${c}"><b>${v}</b><span>${l}</span></div>`).join('');
  // tableau mensuel
  const rows = r.monthly.map((m, i) => `<tr class="${i === 12 ? 'tot' : ''}"><td>${m.mois}</td><td>${nf(m.ghi, 1)}</td><td>${nf(m.dhi, 1)}</td><td>${nf(m.t_amb, 1)}</td><td>${nf(m.glob_inc, 1)}</td><td>${nf(m.glob_eff, 1)}</td><td>${nf(m.rear_inc, 1)}</td><td>${nf(m.e_array, 1)}</td><td>${nf(m.e_grid, 1)}</td><td>${nf(m.yield_, 1)}</td><td>${pf(m.pr, 1)}</td><td>${pf(m.pr_bifi, 1)}</td></tr>`).join('');
  $('#tblMonthly').innerHTML = `<table class="res"><tr><th>Mois</th><th>GHI<br>kWh/m²</th><th>DIF<br>kWh/m²</th><th>T amb<br>°C</th><th>GlobInc<br>kWh/m²</th><th>GlobEff<br>kWh/m²</th><th>Arrière<br>kWh/m²</th><th>E champ<br>MWh</th><th>E injectée<br>MWh</th><th>Productible<br>kWh/kWc</th><th>PR</th><th>PR bifacial</th></tr>${rows}</table>`;
  drawCharts(); renderLosses(); renderMeteo(); renderP90(); renderHyp();
}

function chart(id, cfg) { if (S.charts[id]) S.charts[id].destroy(); S.charts[id] = new Chart($('#' + id), cfg); return S.charts[id]; }
Chart.defaults.animation = false; Chart.defaults.font.family = 'Inter, system-ui, sans-serif'; Chart.defaults.font.size = 11.5; Chart.defaults.color = '#5d6b7a';
function drawCharts() {
  const r = S.res, m = r.monthly.slice(0, 12);
  chart('chMonthly', {
    data: { labels: MONTHS, datasets: [
      { type: 'bar', label: 'Énergie injectée (MWh)', data: m.map((x) => x.e_grid), backgroundColor: '#f2a20c', borderRadius: 4, yAxisID: 'y' },
      { type: 'line', label: 'PR (%)', data: m.map((x) => 100 * x.pr), borderColor: '#18212b', backgroundColor: '#18212b', pointRadius: 3, tension: .25, yAxisID: 'y1' }] },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: { y: { title: { display: true, text: 'MWh' }, grid: { color: '#eef1f4' } }, y1: { position: 'right', min: 0, max: 100, title: { display: true, text: 'PR %' }, grid: { display: false } }, x: { grid: { display: false } } },
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => `${c.dataset.label} : ${nf(c.parsed.y, 1)}` } } } },
  });
  chart('chDaily', {
    type: 'line', data: { labels: r.daily_kwh.map((_, i) => i + 1), datasets: [{ label: 'MWh/jour', data: r.daily_kwh.map((v) => v / 1000), borderColor: '#a8650a', backgroundColor: '#f2a20c33', fill: true, pointRadius: 0, borderWidth: 1 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: 'Jour de l\'année' }, ticks: { maxTicksLimit: 12 }, grid: { display: false } }, y: { title: { display: true, text: 'MWh' }, grid: { color: '#eef1f4' } } } },
  });
  const ds = [];
  if (r.horizon) {
    const pts = [...r.horizon].sort((a, b) => a[0] - b[0]);
    ds.push({ label: 'Masque lointain', data: pts.map(([x, y]) => ({ x, y })), borderColor: '#5d6b7a', backgroundColor: '#5d6b7a55', fill: 'origin', pointRadius: 0, borderWidth: 1.5 });
  }
  const cols = ['#c0392b', '#f2a20c', '#4c4fe0'];
  const lab = { '06-21': '21 juin', '03-20': '20 mars', '12-21': '21 décembre' };
  r.sunpaths.forEach((p, i) => ds.push({ label: 'Soleil ' + lab[p.date], data: p.az.map((x, j) => ({ x, y: p.el[j] })), borderColor: cols[i], pointRadius: 0, borderWidth: 2, fill: false, showLine: true }));
  chart('chMask', { type: 'scatter', data: { datasets: ds.map((d) => Object.assign({ showLine: true }, d)) },
    options: { maintainAspectRatio: false, scales: { x: { min: -180, max: 180, ticks: { stepSize: 30 }, title: { display: true, text: 'Azimut PVsyst (°) – 0 = Sud, Est < 0' }, grid: { color: '#eef1f4' } }, y: { min: 0, max: 75, title: { display: true, text: 'Hauteur (°)' }, grid: { color: '#eef1f4' } } }, plugins: { legend: { position: 'bottom' } } } });
  const l = r.losses.find((x) => x.label.startsWith('Masque'));
  $('#maskNote').textContent = r.horizon ? `Perte due au masque lointain : ${nf(l.pct, 2)} % de l'irradiation dans le plan. Facteur diffus : ${r.faces.map((f) => `${f.name} ${nf(f.horizon_diffuse_factor, 3)}`).join(', ')}.` : 'Aucun masque lointain appliqué' + (r.tmy_info.use_horizon ? " (l'horizon PVGIS est inclus dans le TMY)." : '.');
}

function renderLosses() {
  const L = S.res.losses;
  const maxAbs = Math.max(...L.filter((x) => x.pct != null).map((x) => Math.abs(x.pct)), 1);
  const lvl = (x) => x.pct == null;
  $('#lossList').innerHTML = L.map((x) => lvl(x) ? `<div class="loss lvl"><span>${esc(x.label)}</span><span></span><span></span><span class="val">${nf(x.value, 1)} ${x.unit}</span></div>`
    : `<div class="loss"><span>${esc(x.label)}</span><span class="pct ${x.pct < -0.005 ? 'neg' : x.pct > 0.005 ? 'pos' : ''}">${x.pct > 0 ? '+' : ''}${nf(x.pct, 2)} %</span>
       <span class="bar2"><i class="${x.pct > 0 ? 'pos' : ''}" style="width:${Math.min(100, 100 * Math.abs(x.pct) / maxAbs)}%"></i></span><span class="val">${x.value == null ? '' : nf(x.value, 1) + ' ' + x.unit}</span></div>`).join('');
}

function renderMeteo() {
  const r = S.res, t = r.tmy_info;
  let h = `<h3>Fichier météo</h3><table class="res kv"><tr><td>Source</td><td>${esc(t.db || t.source)} ${esc(t.years || '')}</td></tr>
    <tr><td>Coordonnées du fichier</td><td>${nf(t.lat, 4)} / ${nf(t.lon, 4)} · ${nf(t.elev)} m</td></tr>
    <tr><td>Décalage horaire de l'irradiance</td><td>${nf(t.offset_h * 60, 1)} min</td></tr>
    <tr><td>Horizon PVGIS inclus dans le TMY</td><td>${r.config.meteo.tmy_has_horizon ? 'oui' : 'non'}</td></tr>
    <tr><td>Recalage</td><td>${r.meteo_correction ? { monthly: 'Global Solar Atlas, mensuel', annual: 'Global Solar Atlas, annuel' }[r.config.meteo.gsa_mode] + (r.config.meteo.gsa_align_temp ? ' + température' : '') : 'aucun'}</td></tr></table>`;
  if (r.meteo_correction) {
    const mc = r.meteo_correction, sm = (k) => mc.reduce((a, b) => a + (b[k] || 0), 0);
    h += `<h3 style="margin-top:16px">Recalage du TMY sur Global Solar Atlas</h3><div class="tblwrap"><table class="res"><tr><th>Mois</th><th>GHI TMY</th><th>GHI GSA</th><th>GHI corrigé</th><th>DIF TMY</th><th>DIF GSA</th><th>DIF corrigé</th><th>k direct</th><th>k diffus</th><th>T moy.</th><th>h écrêtées</th></tr>` +
      mc.map((m) => `<tr><td>${m.mois}</td><td>${nf(m.ghi_tmy, 1)}</td><td>${nf(m.ghi_cible, 1)}</td><td>${nf(m.ghi_corrige, 1)}</td><td>${nf(m.dif_tmy, 1)}</td><td>${nf(m.dif_cible, 1)}</td><td>${nf(m.dif_corrige, 1)}</td><td>${nf(m.k_direct, 3)}</td><td>${nf(m.k_diffus, 3)}</td><td>${nf(m.t_moy, 1)}</td><td>${m.heures_ecretees}</td></tr>`).join('') +
      `<tr class="tot"><td>Année</td><td>${nf(sm('ghi_tmy'), 1)}</td><td>${nf(sm('ghi_cible'), 1)}</td><td>${nf(sm('ghi_corrige'), 1)}</td><td>${nf(sm('dif_tmy'), 1)}</td><td>${nf(sm('dif_cible'), 1)}</td><td>${nf(sm('dif_corrige'), 1)}</td><td></td><td></td><td>${nf(r.summary.t_amb, 1)}</td><td>${sm('heures_ecretees')}</td></tr></table></div>
      <p class="note">Diffus et direct sont multipliés séparément puis le GHI est recomposé (DIF + DNI × cos z). Le DNI horaire est plafonné à 1,05 × le ciel clair et l'énergie écrêtée est redistribuée sur le mois.</p>`;
  }
  $('#meteoBox').innerHTML = h;
}

function renderP90() {
  const p = S.res.p90;
  $('#p90Box').innerHTML = `<h3>Productible P50 / P90</h3><div class="two"><div><table class="res kv">
    <tr><td>P50</td><td><b>${nf(p.p50, 1)} kWh/kWc</b> · ${nf(p.p50_mwh, 0)} MWh</td></tr>
    <tr><td>P75</td><td>${nf(p.p75, 1)} kWh/kWc</td></tr>
    <tr><td>P90</td><td><b>${nf(p.p90, 1)} kWh/kWc</b> · ${nf(p.p90_mwh, 0)} MWh · ${pf(p.p90_ratio, 1)} du P50</td></tr>
    <tr><td>P99</td><td>${nf(p.p99, 1)} kWh/kWc</td></tr>
    <tr><td>Incertitude combinée (1σ)</td><td>${nf(p.sigma_pct, 2)} %</td></tr>
    <tr><td>Variabilité météo</td><td>${esc(p.meteo_var_source)}</td></tr></table>
    <p class="note">Px = P50 × (1 − z<sub>x</sub> × σ), σ = racine de la somme des carrés des incertitudes ; z<sub>90</sub> = 1,2816 (loi normale).</p></div>
    <div><table class="res"><tr><th>Incertitude</th><th>σ</th></tr>${p.items.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${nf(b, 2)} %</td></tr>`).join('')}<tr class="tot"><td>Combinée</td><td>${nf(p.sigma_pct, 2)} %</td></tr></table></div></div>` +
    (S.res.lifetime.length > 1 ? `<h3 style="margin-top:14px">Évolution sur ${S.res.lifetime.length} ans (dégradation ${nf(S.res.config.lifetime.degradation, 2)} %/an)</h3><div class="tblwrap"><table class="res"><tr><th>Année</th><th>P50 kWh/kWc</th><th>P90 kWh/kWc</th><th>P50 MWh</th></tr>${S.res.lifetime.map((l) => `<tr><td>${l.annee}</td><td>${nf(l.p50, 1)}</td><td>${nf(l.p90, 1)}</td><td>${nf(l.e_p50_mwh, 0)}</td></tr>`).join('')}</table></div>` : '');
}

function renderHyp() {
  const r = S.res, s = r.summary, pan = r.pan, ond = r.ond, c = r.config;
  const kv = (rows) => `<table class="res kv">${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
  $('#hypBox').innerHTML = `<h3>Hypothèses de la simulation</h3><div class="two"><div>${kv([
    ['Module', `${esc(pan.manufacturer)} ${esc(pan.model)}`], ['Puissance / technologie', `${nf(pan.pnom)} Wc · ${esc(pan.technol)} · ${pan.ns} cellules série${pan.half_cells ? ' · demi-cellules' : ''}`],
    ['Vmp / Imp / Voc / Isc', `${nf(pan.vmp, 2)} V / ${nf(pan.imp, 2)} A / ${nf(pan.voc, 2)} V / ${nf(pan.isc, 2)} A`],
    ['Modèle une diode', `Rs ${nf(pan.rs, 3)} Ω · Rsh ${nf(pan.rsh)} Ω · Rsh(0) ${nf(pan.rsh0)} Ω · γ ${nf(pan.gamma, 3)} · μγ ${pan.mu_gamma}`],
    ['Coefficients T°', `μIsc ${nf(pan.mu_isc * 1000, 2)} mA/°C · μVoc ${nf(pan.mu_voc, 1)} mV/°C`],
    ['Champ', `${nf(s.n_modules)} modules · ${c.array.n_series} en série × ${c.array.n_strings} chaînes · ${nf(s.pnom_kwc, 1)} kWc`],
    ['Bifacialité retenue', s.bifaciality ? nf(s.bifaciality, 2) : 'non'],
    ['Onduleur', `${esc(ond.manufacturer)} ${esc(ond.model)}`],
    ['Puissance onduleur', `Pnom ${nf(ond.pnom / 1000)} kW à ${nf(ond.t_pnom)} °C · Pmax ${nf(ond.pmax / 1000)} kW à ${nf(ond.t_pmax)} °C · offset ${nf(c.inverters.t_offset, 1)} °C`],
    ['Groupes', c.inverters.groups.map(([a, b]) => `${a} × ${b} chaînes`).join(' + ') + ` · DC/AC ${nf(s.dc_ac, 2)}`],
    ['Plage MPPT / Vmax / Imax DC', `${nf(ond.vmin)}–${nf(ond.vmax)} V · ${nf(ond.vabsmax)} V · ${nf(ond.imax_dc)} A`],
    ['Tension MPP moyenne', `${nf(s.vmpp_mean)} V`]])}</div><div>${kv([
    ['Structure', { fixed: `Sheds fixes ${c.structure.tilt}° / azimut ${c.structure.azimuth}°`, tracker: `Tracker mono-axe, axe ${c.structure.axis_azimuth}°, ±${c.structure.max_angle}°, ${c.structure.backtrack ? 'avec' : 'sans'} backtracking`, ew: `Est-Ouest ${c.structure.tilt}°` }[c.structure.type]],
    ['Géométrie', `entraxe ${c.structure.pitch} m · largeur ${c.structure.width} m · GCR ${pf(s.gcr, 1)}${s.limit_angle != null ? ` · angle limite ${nf(s.limit_angle, 1)}°` : ''} · ${c.structure.n_rows} rangées`],
    ['Ombrage électrique', `${c.structure.elec_effect} % · ${s.sub_in_height} sous-chaînes en hauteur`],
    ['Ombrage proche du diffus', r.faces.map((f) => `${f.name} ${pf(f.diffuse_attenuation, 1)}`).join(', ')],
    ['Bifacial', c.bifacial.enabled ? `albédo sol ${c.bifacial.albedo_ground} · ombrage arrière ${c.bifacial.rear_shading} % · mismatch ${c.bifacial.rear_mismatch} %` : 'non'],
    ['Thermique', `Uc ${c.thermal.uc} · Uv ${c.thermal.uv}`], ['IAM', c.iam.mode === 'pan' ? 'profil du .PAN' : `Fresnel n=${c.iam.n}, n(AR)=${c.iam.n_ar ?? '–'}`],
    ['Pertes DC', `salissure ${c.losses.soiling} % · LID ${c.losses.lid} % · qualité ${c.losses.quality} % · mismatch ${c.losses.mismatch} + ${c.losses.string_mismatch} % · ohmiques ${c.losses.dc_ohmic} %`],
    ['Pertes AC', `ohmiques ${c.losses.ac_ohmic} % · HTA ${c.losses.mv_line} % · transfo ${c.losses.tr_enabled ? `${c.losses.tr_sn_kva} kVA, fer ${c.losses.tr_iron_kw} kW, cuivre ${c.losses.tr_cu_kw} kW` : 'non'}`],
    ['Système', `auxiliaires ${c.losses.aux_w} W > ${c.losses.aux_thresh_kw} kW · indisponibilité ${c.losses.availability} %${c.inverters.p_inj_kw ? ` · injection limitée à ${c.inverters.p_inj_kw} kW` : ''}`],
    ['Moteur', `v${r.engine} · pvlib ${r.pvlib}`]])}</div></div>`;
}

// ------------------------------------------------------------------ exports
function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
const baseName = () => `${S.cfg.project.name}_${S.cfg.project.variant}`.replace(/[^\w\-]+/g, '_');
$('#expXlsx').addEventListener('click', async () => {
  setStatus('Génération du classeur Excel…', 'busy', 60);
  try { const bytes = await call('xlsx'); download(baseName() + '_productible.xlsx', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); setStatus('Classeur Excel exporté.', 'ok', 100); }
  catch (e) { setStatus('Export Excel impossible : ' + e.message, 'err', 100); }
});
$('#expCsv').addEventListener('click', async () => { const t = await call('csv'); download(baseName() + '_horaire.csv', new Blob(['﻿' + t], { type: 'text/csv' })); });
$('#expJson').addEventListener('click', saveProject);
$('#btnSave').addEventListener('click', saveProject);
function saveProject() {
  const data = { app: 'calcul-productible', version: 1, saved: new Date().toISOString(), cfg: S.cfg, files: S.files, names: S.names, gsa: S.gsa };
  download(baseName() + '.json', new Blob([JSON.stringify(data)], { type: 'application/json' }));
}
$('#openProject').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text()); if (d.app !== 'calcul-productible') throw new Error('fichier projet non reconnu');
    S.cfg = deepMerge(DEFAULTS, d.cfg); S.files = d.files || {}; S.names = d.names || {}; S.gsa = d.gsa || null; S.info = {}; S.res = null;
    $('#results').hidden = true; fillForm(); save(); refreshAll(); setStatus(`Projet « ${S.cfg.project.name} » ouvert.`, 'ok', 100);
  } catch (err) { setStatus('Ouverture impossible : ' + err.message, 'err', 100); }
  e.target.value = '';
});
$('#btnNew').addEventListener('click', () => {
  if (!confirm('Repartir d\'un projet vierge ? Les saisies et fichiers actuels seront effacés.')) return;
  S.cfg = clone(DEFAULTS); S.files = {}; S.names = {}; S.gsa = null; S.info = {}; S.res = null; S.check = null;
  $('#results').hidden = true; fillForm(); save(); refreshAll();
});
$('#toggleSide').addEventListener('click', () => $('#side').classList.toggle('hide'));
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
  Object.values(S.charts).forEach((c) => c.resize());
}));

$('#expPdf').addEventListener('click', () => {
  const r = S.res, s = r.summary, c = r.config, p = r.p90;
  const img = (id) => { const ch = S.charts[id]; return ch ? `<img src="${ch.toBase64Image('image/png', 1)}">` : ''; };
  // forcer le rendu des graphiques cachés
  $$('.tab').forEach((t) => t.classList.add('on')); Object.values(S.charts).forEach((ch) => { ch.resize(); ch.update('none'); });
  const kv = (rows) => `<table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
  const html = `<h1>${esc(c.project.name)} – ${esc(c.project.variant)}</h1>
    <div class="sub">Rapport de simulation de productible · ${new Date().toLocaleDateString('fr-FR')}${c.project.author ? ' · ' + esc(c.project.author) : ''} · moteur v${r.engine}, pvlib ${r.pvlib}</div>
    <div class="kpis"><div><b>${nf(s.yield_kwh_kwc, 0)}</b>kWh/kWc/an (P50)</div><div><b>${nf(s.e_grid_mwh, 0)}</b>MWh/an</div><div><b>${pf(s.pr, 1)}</b>PR</div><div><b>${nf(p.p90, 0)}</b>kWh/kWc (P90)</div></div>
    <h2>Site et système</h2><div class="cols"><div>${kv([['Site', `${nf(c.site.lat, 4)} °N / ${nf(c.site.lon, 4)} °E · ${nf(c.site.alt)} m`], ['Météo', `${esc(r.tmy_info.db || 'PVGIS')} ${esc(r.tmy_info.years || '')}${r.meteo_correction ? ' recalé Global Solar Atlas (' + c.meteo.gsa_mode + ')' : ''}`], ['GHI / GlobInc', `${nf(s.glob_hor, 1)} / ${nf(s.glob_inc, 1)} kWh/m²`], ['Masque lointain', r.horizon ? 'oui' : 'non'], ['Structure', { fixed: `Sheds ${c.structure.tilt}° / ${c.structure.azimuth}°`, tracker: `Tracker ±${c.structure.max_angle}°`, ew: `Est-Ouest ${c.structure.tilt}°` }[c.structure.type] + ` · GCR ${pf(s.gcr, 1)}`]])}</div>
    <div>${kv([['Modules', `${nf(s.n_modules)} × ${esc(r.pan.model)} (${nf(r.pan.pnom)} Wc)`], ['Puissance DC', `${nf(s.pnom_kwc, 1)} kWc`], ['Onduleurs', `${s.n_inverters} × ${esc(r.ond.model)}`], ['Puissance AC', `${nf(s.pac_kva)} kVA · DC/AC ${nf(s.dc_ac, 2)}`], ['Bifacial', s.bifaciality ? 'oui, ' + nf(s.bifaciality, 2) : 'non']])}</div></div>
    <h2>Vérifications de dimensionnement</h2><table><tr><th>Vérification</th><th>Statut</th><th>Détail</th></tr>${r.alerts.map((a) => `<tr><td>${esc(a.title)}</td><td>${{ ok: 'OK', warn: 'Alerte', block: 'Bloquant' }[a.level]}</td><td>${esc(a.message)}</td></tr>`).join('')}</table>
    <h2>Résultats mensuels</h2>${img('chMonthly')}
    <table><tr><th>Mois</th><th>GHI</th><th>DIF</th><th>T amb</th><th>GlobInc</th><th>GlobEff</th><th>Arrière</th><th>E champ MWh</th><th>E injectée MWh</th><th>kWh/kWc</th><th>PR</th></tr>${r.monthly.map((m, i) => `<tr class="${i === 12 ? 'tot' : ''}"><td>${m.mois}</td><td>${nf(m.ghi, 1)}</td><td>${nf(m.dhi, 1)}</td><td>${nf(m.t_amb, 1)}</td><td>${nf(m.glob_inc, 1)}</td><td>${nf(m.glob_eff, 1)}</td><td>${nf(m.rear_inc, 1)}</td><td>${nf(m.e_array, 1)}</td><td>${nf(m.e_grid, 1)}</td><td>${nf(m.yield_, 1)}</td><td>${pf(m.pr, 1)}</td></tr>`).join('')}</table>
    <h2 class="pb">Diagramme de pertes</h2><table><tr><th>Poste</th><th>Variation</th><th>Valeur</th></tr>${r.losses.map((x) => `<tr${x.pct == null ? ' class="tot"' : ''}><td>${esc(x.label)}</td><td>${x.pct == null ? '' : (x.pct > 0 ? '+' : '') + nf(x.pct, 2) + ' %'}</td><td>${x.value == null ? '' : nf(x.value, 1) + ' ' + x.unit}</td></tr>`).join('')}</table>
    <h2>P50 / P90</h2><div class="cols"><div>${kv([['P50', `${nf(p.p50, 1)} kWh/kWc · ${nf(p.p50_mwh, 0)} MWh`], ['P75', `${nf(p.p75, 1)} kWh/kWc`], ['P90', `${nf(p.p90, 1)} kWh/kWc · ${nf(p.p90_mwh, 0)} MWh`], ['P99', `${nf(p.p99, 1)} kWh/kWc`], ['Incertitude combinée', `${nf(p.sigma_pct, 2)} %`], ['Variabilité météo', esc(p.meteo_var_source)]])}</div>
    <div><table><tr><th>Incertitude</th><th>σ</th></tr>${p.items.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${nf(b, 2)} %</td></tr>`).join('')}</table></div></div>
    ${r.meteo_correction ? `<h2>Recalage météo Global Solar Atlas</h2><table><tr><th>Mois</th><th>GHI TMY</th><th>GHI GSA</th><th>GHI corrigé</th><th>DIF TMY</th><th>DIF GSA</th><th>DIF corrigé</th></tr>${r.meteo_correction.map((m) => `<tr><td>${m.mois}</td><td>${nf(m.ghi_tmy, 1)}</td><td>${nf(m.ghi_cible, 1)}</td><td>${nf(m.ghi_corrige, 1)}</td><td>${nf(m.dif_tmy, 1)}</td><td>${nf(m.dif_cible, 1)}</td><td>${nf(m.dif_corrige, 1)}</td></tr>`).join('')}</table>` : ''}
    ${r.horizon ? `<h2>Masque lointain</h2>${img('chMask')}` : ''}
    <h2 class="pb">Hypothèses détaillées</h2>${$('#hypBox').innerHTML.replace(/<h3>.*?<\/h3>/, '').replace(/class="two"/, 'class="cols"')}
    <div class="foot">Calcul productible – simulation horaire pvlib (Perez, sheds 2D, modèle une diode PVsyst, courbes .OND). Résultats indicatifs, à confronter à un logiciel de référence pour un usage contractuel. Crédits : pvlib (BSD 3-Clause), Pyodide (MPL 2.0) ; données PVGIS © Union européenne (JRC) et Global Solar Atlas 2.0 © Solargis / World Bank Group (CC BY 4.0) selon les fichiers utilisés.</div>`;
  $('#report').innerHTML = html;
  $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + $('#tabs button.on').dataset.tab));
  setTimeout(() => window.print(), 300);
});

// ------------------------------------------------------------------ persistance locale
function save() { try { localStorage.setItem(STORE, JSON.stringify({ cfg: S.cfg, files: S.files, names: S.names, gsa: S.gsa })); } catch (e) { try { localStorage.setItem(STORE, JSON.stringify({ cfg: S.cfg, names: {}, files: {}, gsa: S.gsa })); } catch (e2) { /* stockage indisponible */ } } }
function load() {
  try { const d = JSON.parse(localStorage.getItem(STORE) || 'null'); if (d) { S.cfg = deepMerge(DEFAULTS, d.cfg); S.files = d.files || {}; S.names = d.names || {}; S.gsa = d.gsa || null; } } catch (e) { /* ignore */ }
}

load(); buildForm(); fillForm(); syncStrings(); initMap(); refreshAll();
