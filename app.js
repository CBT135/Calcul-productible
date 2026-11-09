/* Calcul productible PV – interface (saisie, fichiers, résultats, exports). Le calcul tourne dans worker.js (Pyodide). */
'use strict';

// ------------------------------------------------------------------ projet vierge
// Les champs propres au projet sont vides ; seules les hypothèses génériques (pertes, thermique, IAM,
// incertitudes P90…) gardent une valeur standard, modifiable.
const DEFAULTS = {
  project: { name: '', variant: 'Var0', author: '' },
  site: { lat: null, lon: null, alt: null, albedo: 0.20 },
  meteo: { tmy_has_horizon: false, gsa_mode: 'monthly', gsa_align_temp: true, use_gsa: true, use_mdb: false },
  module: { lowlight_cal: 'auto' },
  horizon: { use: true },
  structure: { type: 'fixed', tilt: null, azimuth: 0, az_convention: 'sud0', pitch: null, width: null, height: null, n_rows: null,
    n_high: null, orientation: 'portrait', sub_in_height: null, elec_effect: 80,
    shading_configs: [{ sub_in_height: null, share: 100 }], fields: [],
    axis_azimuth: 0, max_angle: 55, backtrack: true, axis_height: 1.5 },
  array: { n_series: null, n_strings: 0 },
  inverters: { groups: [[null, null]], t_offset: 0, p_inj_kw: null },
  bifacial: { enabled: true, bifaciality: null, albedo_ground: 0.17, rear_shading: 5, rear_mismatch: 10, transparent: 0 },
  thermal: { uc: 29, uv: 0 },
  iam: { mode: 'fresnel', n: 1.526, n_ar: 1.29 },
  losses: { soiling: 1.5, lid: 1.0, quality: 0, mismatch: 1.0, string_mismatch: 0.1, dc_ohmic: 1.0,
    ac_ohmic: 1.5, mv_line: 0.1, availability: 0, tr_enabled: true, tr_sn_kva: null, tr_iron_kw: null,
    tr_cu_kw: null, tr_always_on: true, aux_w: 500, aux_thresh_kw: 500, aux_night_w: 0, inv_night: false },
  p90: { meteo_var: 3.0, items: [
    ['Variabilité météo future sur 10 ans', 2.0],
    ['Modélisation (pertes DC, AC, ombrages, T°, disponibilité)', 2.5],
    ['Pertes spectrales et réflexion', 1.5], ['Transposition', 1.0], ['Paramètres des modules PV', 2.0],
    ['Efficacité onduleur', 0.5], ['Encrassement', 1.0], ['Mismatch', 0.9], ['Estimation dégradation', 0.9]] },
  lifetime: { years: 1, degradation: 0.4 },
  extract: { tz: 'Europe/Paris', stamp: 'start', sensor: 'modules', sensor_tilt: null, sensor_azimuth: null, meter: 'grid' },
};
const MONTHS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
const FILES = {
  tmy: { label: 'TMY PVGIS', accept: '.csv,.json,.htm,.html,.txt', req: true },
  pan: { label: 'Module .PAN', accept: '.pan,.PAN', req: true },
  ond: { label: 'Onduleur .OND', accept: '.ond,.OND', req: true },
  gsa: { label: 'Global Solar Atlas', accept: '.json,.htm,.html,.txt', req: false },
  mdb: { label: 'Base météo mensuelle', accept: '.csv,.txt', req: false },
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

const S = { cfg: clone(DEFAULTS), files: {}, names: {}, gsa: null, mdb: null, pvsyst: null, lib: { pan: [], ond: [] }, near: {}, info: {}, check: null, res: null, ready: false, charts: {}, ext: null, exFile: null };

// ------------------------------------------------------------------ worker
const worker = new Worker('worker.js');
let seq = 0; const pending = new Map();
worker.onmessage = (ev) => {
  const d = ev.data;
  if (d.type === 'status') return setStatus(d.text, 'busy', d.pct);
  if (d.type === 'ready') {
    S.ready = true; parseLib(); $('#engineInfo').textContent = `Moteur v${d.engine} · pvlib ${d.pvlib} · Pyodide`;
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
// Lien de téléchargement des données du site, affiché au-dessus de la zone de dépôt correspondante
const DL = {
  tmy: ['TMY PVGIS (JSON)', (la, lo) => `https://re.jrc.ec.europa.eu/api/v5_3/tmy?lat=${la}&lon=${lo}&usehorizon=0&outputformat=json`],
  horizon: ['Horizon PVGIS (CSV)', (la, lo) => `https://re.jrc.ec.europa.eu/api/v5_3/printhorizon?lat=${la}&lon=${lo}&outputformat=csv`],
  gsa: ['Global Solar Atlas (JSON)', (la, lo) => `https://api.globalsolaratlas.info/data/lta?loc=${la},${lo}`],
  pvgis_monthly: ['PVGIS mensuel (CSV)', (la, lo) => `https://re.jrc.ec.europa.eu/api/v5_3/MRcalc?lat=${la}&lon=${lo}&horirrad=1&avtemp=1&outputformat=csv`],
};
function drop(key, hint) {
  const f = FILES[key];
  return `<div class="fld full"><label>${f.label}${f.req ? '<i>obligatoire</i>' : '<i>optionnel</i>'}</label>
    ${DL[key] ? `<div class="links dl" id="dl-${key}"></div>` : ''}
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
      num('site.alt', 'Altitude', 'm', { hint: 'Renseignée automatiquement depuis les coordonnées (IGN RGE ALTI, ou Copernicus DEM hors de France), modifiable.' }) + num('site.albedo', 'Albédo du site', '', { step: 0.01, hint: 'Albédo vu par la face avant.' }) +
      `<div class="fld full"><div id="map"></div><div class="hint">Cliquer sur la carte ou déplacer le repère pour placer le site. Les liens de téléchargement des données du site apparaissent au-dessus de chaque fichier à déposer : la page s'ouvre dans un nouvel onglet, l'enregistrer (Ctrl+S / ⌘S) puis déposer le fichier .htm obtenu.</div></div>`, true),
    section('meteo', 'Météo', drop('tmy', '<span>TMY PVGIS 5.3 au format CSV ou JSON</span>') +
      chk('meteo.tmy_has_horizon', "Le TMY a été téléchargé avec l'horizon PVGIS (« usehorizon »)", { hint: "Lu automatiquement dans un fichier JSON. Pour un CSV, cocher si l'option horizon était active : le masque PVGIS est alors déjà dans le direct. Recommandé : TMY sans horizon + masque déposé ci-dessous." }) +
      sel('meteo.gsa_mode', 'Recalage du TMY sur la base de référence', [['monthly', 'Mensuel (GHI et DIF, 12 mois)'], ['annual', 'Annuel (GHI et DIF)']], { full: true, hint: 'La base de référence est Global Solar Atlas ou la base météo mensuelle déposée plus bas (une seule à la fois).' }) +
      chk('meteo.gsa_align_temp', 'Recaler aussi la température mensuelle sur la base de référence')),
    section('horizon', 'Masque lointain', drop('horizon', '<span>CSV Azimut;Hauteur (0 = Sud, Est &lt; 0) ou horizon PVGIS</span>') +
      chk('horizon.use', 'Appliquer le masque (direct coupé sous l\'horizon, diffus réduit)')),
    section('gsa', 'Global Solar Atlas', chk('meteo.use_gsa', 'Recaler le TMY sur Global Solar Atlas') +
      drop('gsa', '<span>JSON de l\'API GSA (.json ou page .htm enregistrée), ou coller le texte ci-dessous</span>') +
      `<div class="fld full"><textarea id="gsaPaste" placeholder='Coller ici la réponse JSON de https://api.globalsolaratlas.info/data/lta?loc=lat,lon'></textarea></div>
      <div class="fld full" id="gsaTable"></div>`),
    section('mdb', 'Base météo mensuelle', chk('meteo.use_mdb', 'Recaler le TMY sur cette base mensuelle', { hint: 'Cochée automatiquement au dépôt d\'une base : le recalage sur Global Solar Atlas est alors décoché.' }) +
      drop('mdb', '<span>CSV de moyennes mensuelles long terme : Solargis Prospect (LTA P1M, format PVsyst) ou tout CSV avec une colonne Month et des colonnes GHI, DIF, T</span>') +
      '<div class="fld full" id="mdbTable"></div>'),
    section('structure', 'Structure', `<div class="fld full"><label>Type de structure</label><div class="seg" id="stype">
        <button type="button" data-v="fixed">Sheds fixes</button><button type="button" data-v="ew">Est-Ouest</button><button type="button" data-v="tracker">Tracker mono-axe</button><button type="button" data-v="roof">Toiture</button></div></div>` +
      `<div class="fld full" data-show="structure.type==roof"><div id="roofFields"></div>
        <button type="button" class="mini" id="addField">+ Ajouter un toit</button>
        <div class="hint">Un champ par pan de toiture. Le calepinage propose le nombre de modules posables selon les dimensions de la zone, le module et la pose ; il peut être forcé. Tout ce qui est derrière le plan des modules est considéré comme masqué. Le masque proche d'un champ (obstacles, autres pans) s'ajoute au masque lointain.</div></div>` +
      num('structure.tilt', 'Inclinaison', '°', { show: 'structure.type!=tracker&&structure.type!=roof' }) +
      num('structure.azimuth', 'Azimut', '°', { show: st('fixed'), hint: '0 = Sud, Est &lt; 0, Ouest &gt; 0.' }) +
      `<div class="fld" data-show="structure.type==ew"><label>Orientation du faîtage<i>°</i></label><input type="number" step="any" data-path="structure.azimuth">
        <div class="hint" id="ewHint">0 = Sud : pan Est à −90°, pan Ouest à +90°.</div></div>` +
      num('structure.axis_azimuth', "Azimut de l'axe", '°', { show: st('tracker'), hint: '0 = axe Nord-Sud (rotation Est-Ouest).' }) +
      num('structure.max_angle', 'Rotation maximale', '±°', { show: st('tracker') }) +
      chk('structure.backtrack', 'Backtracking', { show: st('tracker') }) +
      num('structure.pitch', 'Entraxe des rangées', 'm', { show: 'structure.type!=roof', hint: 'Est-Ouest : distance entre faîtages.' }) +
      num('structure.width', 'Largeur sensible', 'm', { show: 'structure.type!=roof', hint: 'Est-Ouest : largeur d\'un pan.' }) +
      num('structure.height', 'Hauteur du bord bas', 'm', { show: 'structure.type!=tracker&&structure.type!=roof' }) +
      num('structure.axis_height', "Hauteur de l'axe", 'm', { show: st('tracker') }) +
      num('structure.n_rows', 'Nombre de rangées', '', { show: 'structure.type!=roof', step: 1, min: 1, hint: 'La 1re rangée n\'est pas ombrée.' }) +
      num('structure.n_high', 'Modules en hauteur', '', { show: 'structure.type!=roof', step: 1, min: 1 }) +
      sel('structure.orientation', 'Pose des modules', [['portrait', 'Portrait'], ['landscape', 'Paysage']], { show: 'structure.type!=roof' }) +
      `<div class="fld" data-show="structure.type!=roof"><label>GCR / angle limite</label><input type="text" id="gcrOut" readonly></div>`),
    section('shading', 'Ombrage électrique', num('structure.elec_effect', "Fraction de l'effet électrique", '%', { hint: 'Perte électrique des sous-chaînes partiellement ombrées.' }) +
      `<div class="fld full groups" data-show="structure.type!=roof"><label>Configurations de câblage<i>sous-chaînes en hauteur · % des tables</i></label><div id="shconfs"></div>
      <button type="button" class="mini" id="addShconf">+ Ajouter une configuration</button>
      <div class="hint">Une étude de productible est calculée par configuration, puis les résultats sont moyennés au prorata des tables. Le total doit faire 100 %. Les chaînes suivent les rangées ; « auto » = 2 sous-chaînes par module portrait en demi-cellules, 1 en cellules entières, 3 par module paysage.</div></div>`),
    section('module', 'Modules', drop('pan', '<span>Fichier .PAN (format texte)</span>') +
      num('array.n_series', 'Modules en série', '', { show: 'structure.type!=roof', step: 1, min: 1 }) + num('array.n_strings', 'Nombre de chaînes', '', { show: 'structure.type!=roof', ro: true, hint: 'Calculé à partir des groupes d\'onduleurs.' }) +
      `<div class="fld full groups" data-show="structure.type==roof"><label>Autres modules<i>affectables aux champs</i></label><div id="lib-pan"></div>
        <label class="mini filebtn">+ Ajouter un module (.PAN)<input type="file" accept=".pan,.PAN,.htm,.html,.txt" hidden data-lib="pan"></label></div>` +
      num('bifacial.bifaciality', 'Facteur de bifacialité', '', { step: 0.01, ph: 'valeur du .PAN', hint: 'Vide = valeur du .PAN.' }) +
      sel('module.lowlight_cal', 'Calage du rendement en faible éclairement', [['auto', 'Automatique (si le .PAN contient des mesures)'], ['force', 'Toujours caler sur le .PAN'], ['off', 'Jamais (modèle à une diode brut)']], { full: true, hint: 'En automatique, le modèle à une diode est corrigé pour reproduire les rendements relatifs du .PAN seulement si celui-ci contient un jeu de mesures (point de référence marqué « True », ex. fichiers de laboratoire). Sinon, les points déclarés sont souvent recalculés à partir du modèle et le calage n\'apporte rien.' }) +
      `<div class="fld"><label>Puissance DC</label><input type="text" id="pdcOut" readonly></div>`),
    section('inverter', 'Onduleurs', drop('ond', '<span>Fichier .OND (format texte)</span>') +
      `<div class="fld full groups" data-show="structure.type==roof"><label>Autres onduleurs<i>affectables aux champs</i></label><div id="lib-ond"></div>
        <label class="mini filebtn">+ Ajouter un onduleur (.OND)<input type="file" accept=".ond,.OND,.htm,.html,.txt" hidden data-lib="ond"></label></div>` +
      `<div class="fld full groups" data-show="structure.type!=roof"><label>Groupes d'onduleurs<i>nb onduleurs × chaînes par onduleur</i></label><div id="groups"></div>
      <button type="button" class="mini" id="addGroup">+ Ajouter un groupe</button></div>` +
      num('inverters.t_offset', 'Offset de température autour des onduleurs', '°C', { step: 0.5, full: true, hint: 'Ajouté à la température ambiante pour le déclassement en puissance (courbe Pmax / Pnom / PLim du .OND).' }) +
      num('inverters.p_inj_kw', "Limite de puissance d'injection", 'kW', { ph: 'aucune', full: true })),
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
      `<div class="fld full groups"><label>Autres incertitudes<i>écart-type %</i></label><div id="p90items"></div><button type="button" class="mini" id="addP90">+ Ajouter</button></div>` +
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
  $$('#stype button').forEach((b) => b.addEventListener('click', () => {
    const prev = S.cfg.structure.type;
    set(S.cfg, 'structure.type', b.dataset.v);
    if (b.dataset.v === 'roof' && prev !== 'roof') applyRoofDefaults();
    fillForm(); onChange('structure.type');
  }));
  $('#addField').addEventListener('click', () => { addField(); });
  $$('[data-lib]').forEach((inp) => inp.addEventListener('change', async () => {
    const f = inp.files[0]; if (!f) return; inp.value = '';
    await addLib(inp.dataset.lib, f);
  }));
  $$('[data-drop]').forEach(bindDrop);
  $('#addGroup').addEventListener('click', () => { S.cfg.inverters.groups.push([null, null]); renderGroups(); onChange('inverters.groups'); });
  $('#addShconf').addEventListener('click', () => {
    const used = S.cfg.structure.shading_configs.reduce((a, c) => a + (Number(c.share) || 0), 0);
    S.cfg.structure.shading_configs.push({ sub_in_height: 1, share: Math.max(0, +(100 - used).toFixed(2)) });
    renderShconfs(); onChange('structure.shading_configs');
  });
  $('#addP90').addEventListener('click', () => { S.cfg.p90.items.push(['Autre', 1.0]); renderP90Items(); onChange('p90.items'); });
  $('#gsaPaste').addEventListener('input', (e) => { const t = e.target.value.trim(); if (t) loadGsaText(t, 'collé'); });
}

function fillForm() {
  $$('[data-path]').forEach((el) => {
    const v = get(S.cfg, el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v;
  });
  renderGroups(); renderShconfs(); renderP90Items(); renderLib(); renderRoof(); applyVisibility();
}

function applyVisibility() {
  $$('[data-show]').forEach((el) => {
    const ok = el.dataset.show.split('&&').every((cond) => {
      const m = cond.trim().match(/^([\w.]+)(==|!=)(\w+)$/);
      const v = String(get(S.cfg, m[1]));
      return m[2] === '==' ? v === m[3] : v !== m[3];
    });
    el.style.display = ok ? '' : 'none';
  });
  $$('#stype button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.cfg.structure.type));
}

// ------------------------------------------------------------------ toiture
const ROOF_DEFAULTS = [['structure.elec_effect', 100], ['bifacial.enabled', false], ['thermal.uc', 20], ['losses.tr_enabled', false],
  ['losses.mv_line', 0], ['losses.aux_w', 0], ['losses.aux_night_w', 0]];
function applyRoofDefaults() {
  ROOF_DEFAULTS.forEach(([p, v]) => set(S.cfg, p, v));
  if (!S.cfg.structure.fields.length) S.cfg.structure.fields.push(newField(1));
  setStatus('Toiture : effet électrique 100 %, bifacial décoché, Uc = 20, sans transformateur, ligne HTA et auxiliaires à zéro (modifiables).', 'ok', 100);
}
function newField(n) {
  return { id: Date.now() + n, name: `Toit ${n}`, tilt: null, azimuth: 0, length: null, height: null, orientation: 'portrait', gap: 0.02,
    n_h: null, n_v: null, module: 0, n_series: null, inverter: 0, n_inv: 1, n_str: null };
}
function addField() {
  const F = S.cfg.structure.fields, last = F[F.length - 1];
  const f = newField(F.length + 1);
  if (last) Object.assign(f, { module: last.module, inverter: last.inverter, orientation: last.orientation, gap: last.gap });
  F.push(f); renderRoof(); onChange('structure.fields');
}
function modInfo(idx) { return idx ? (S.lib.pan[idx - 1] || {}).info : S.info.pan; }
function ondInfo(idx) { return idx ? (S.lib.ond[idx - 1] || {}).info : S.info.ond; }
function libOptions(kind, sel) {
  const main = kind === 'pan' ? S.info.pan : S.info.ond, nm = (i) => (i && !i.error ? `${i.model}${kind === 'pan' ? ` (${nf(i.pnom)} Wc)` : ` (${nf(i.pmax / 1000)} kW)`}` : '');
  const opts = [[0, S.files[kind] ? nm(main) || S.names[kind] : `${kind === 'pan' ? 'Module' : 'Onduleur'} principal (à déposer)`]]
    .concat(S.lib[kind].map((x, i) => [i + 1, nm(x.info) || x.name]));
  return opts.map(([v, l]) => `<option value="${v}" ${Number(sel) === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
}
function layout(f) {
  const p = modInfo(f.module); if (!p || p.error) return null;
  const portrait = (f.orientation || 'portrait') === 'portrait';
  const mw = portrait ? p.width : p.height, mh = portrait ? p.height : p.width, g = Number(f.gap) || 0;
  const nh = f.length > 0 ? Math.floor((Number(f.length) + g) / (mw + g) + 1e-9) : 0;
  const nv = f.height > 0 ? Math.floor((Number(f.height) + g) / (mh + g) + 1e-9) : 0;
  const n_h = f.n_h > 0 ? Number(f.n_h) : nh, n_v = f.n_v > 0 ? Number(f.n_v) : nv;
  return { nh, nv, n_h, n_v, n: n_h * n_v, kwc: n_h * n_v * p.pnom / 1000, pnom: p.pnom, uw: n_h * mw + Math.max(n_h - 1, 0) * g, uh: n_v * mh + Math.max(n_v - 1, 0) * g };
}
function fieldReadout(f, i) {
  const L = layout(f), o = ondInfo(f.inverter);
  const wired = (Number(f.n_series) || 0) * (Number(f.n_inv) || 0) * (Number(f.n_str) || 0);
  const lay = !L ? 'Calepinage : déposer le module affecté pour le calcul.'
    : `Calepinage : ${L.n_h} × ${L.n_v} = <b>${nf(L.n)} modules · ${nf(L.kwc, 2)} kWc</b>${(f.n_h > 0 || f.n_v > 0) ? ' (forcé)' : ''} · emprise ${nf(L.uw, 2)} × ${nf(L.uh, 2)} m`
      + (L.n_h * L.n_v !== L.nh * L.nv ? ` · proposé ${L.nh} × ${L.nv}` : '');
  const wir = !wired ? 'Câblage : renseigner modules en série, onduleurs et chaînes.'
    : `Câblage : ${f.n_inv} onduleur(s) × ${f.n_str} chaîne(s) de ${f.n_series} = <b>${nf(wired)} modules${L ? ` · ${nf(wired * L.pnom / 1000, 2)} kWc` : ''}</b>`
      + (o && !o.error && L ? ` · DC/AC ${nf(wired * L.pnom / (f.n_inv * o.pmax), 2)}` : '')
      + (L && wired !== L.n ? ` · <span style="color:${wired > L.n ? 'var(--block)' : 'var(--warn)'}">${wired > L.n ? 'dépasse le calepinage' : `${L.n - wired} module(s) non câblé(s)`}</span>` : '');
  return `${lay}<br>${wir}`;
}
function renderRoof() {
  const box = $('#roofFields'); if (!box) return;
  const F = S.cfg.structure.fields;
  const n = (i, k, lab, unit, o = {}) => `<div class="fld"><label>${lab}${unit ? `<i>${unit}</i>` : ''}</label><input type="number" step="${o.step ?? 'any'}" ${o.min != null ? `min="${o.min}"` : ''} value="${F[i][k] ?? ''}" data-f="${i},${k}" ${o.ph ? `placeholder="${o.ph}"` : ''}></div>`;
  box.innerHTML = F.map((f, i) => {
    const L = layout(f), nm = S.near[f.id];
    return `<div class="fieldcard">
      <div class="fchead"><input type="text" value="${esc(f.name)}" data-f="${i},name" title="Nom du champ"><button type="button" class="mini" data-fmap="${i}" title="Relever orientation et dimensions sur la vue aérienne">Vue aérienne</button><button type="button" class="mini" data-fdel="${i}" ${F.length < 2 ? 'hidden' : ''} title="Supprimer ce toit">Supprimer</button></div>
      <div class="grid">
        ${n(i, 'tilt', 'Inclinaison', '°')}${n(i, 'azimuth', 'Orientation', '° (0 = Sud, Est &lt; 0)')}
        ${n(i, 'length', 'Longueur de la zone', 'm (horizontale)')}${n(i, 'height', 'Hauteur de la zone', 'm (selon la pente)')}
        <div class="fld"><label>Pose</label><select data-f="${i},orientation"><option value="portrait" ${f.orientation !== 'landscape' ? 'selected' : ''}>Portrait</option><option value="landscape" ${f.orientation === 'landscape' ? 'selected' : ''}>Paysage</option></select></div>
        ${n(i, 'gap', 'Espacement entre modules', 'm')}
        ${n(i, 'n_h', 'Modules à l\'horizontale', '', { step: 1, min: 1, ph: L ? `auto (${L.nh})` : 'auto' })}${n(i, 'n_v', 'Modules à la verticale', '', { step: 1, min: 1, ph: L ? `auto (${L.nv})` : 'auto' })}
        <div class="fld full"><label>Module</label><select data-f="${i},module">${libOptions('pan', f.module)}</select></div>
        ${n(i, 'n_series', 'Modules en série', '', { step: 1, min: 1 })}
        <div class="fld"><label>Onduleur</label><select data-f="${i},inverter">${libOptions('ond', f.inverter)}</select></div>
        ${n(i, 'n_inv', 'Nombre d\'onduleurs', '', { step: 1, min: 1 })}${n(i, 'n_str', 'Chaînes par onduleur', '', { step: 1, min: 1 })}
        <div class="fld full"><label>Masque proche du champ<i>optionnel · CSV Azimut;Hauteur</i></label>
          <div class="nearbox">${nm ? `<span>✓ ${esc(nm.name)}</span><button type="button" class="mini" data-nclr="${i}">Retirer</button>` : '<span class="hint">Aucun masque proche</span>'}
          <label class="mini filebtn">${nm ? 'Remplacer' : 'Déposer un masque'}<input type="file" accept=".csv,.txt,.hor,.htm,.html" hidden data-near="${i}"></label></div></div>
        <div class="fld full fro" id="fro-${i}">${fieldReadout(f, i)}</div>
      </div></div>`;
  }).join('');
  // un clic dans orientation, longueur ou hauteur ouvre le relevé sur la vue aérienne (sauf en saisie manuelle)
  $$('#roofFields [data-f$=",azimuth"], #roofFields [data-f$=",length"], #roofFields [data-f$=",height"]').forEach((el) => el.addEventListener('click', () => {
    const i = +el.dataset.f.split(',')[0];
    if (!RMANUAL.has(F[i].id)) openRoofMap(i);
  }));
  $$('#roofFields [data-fmap]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.fmap; RMANUAL.delete(F[i].id); openRoofMap(i); }));
  $$('#roofFields [data-f]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
    const [i, k] = el.dataset.f.split(','); const f = F[+i];
    f[k] = el.tagName === 'SELECT' ? (k === 'orientation' ? el.value : Number(el.value)) : el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
    if (el.tagName === 'SELECT') renderRoof(); else { const r = $('#fro-' + i); if (r) r.innerHTML = fieldReadout(f, +i); }
    onChange('structure.fields');
  }));
  $$('#roofFields [data-fdel]').forEach((b) => b.addEventListener('click', () => {
    const i = +b.dataset.fdel; delete S.near[F[i].id]; F.splice(i, 1); renderRoof(); onChange('structure.fields');
  }));
  $$('#roofFields [data-nclr]').forEach((b) => b.addEventListener('click', () => { delete S.near[F[+b.dataset.nclr].id]; renderRoof(); save(); }));
  $$('#roofFields [data-near]').forEach((inp) => inp.addEventListener('change', async () => {
    const file = inp.files[0]; if (!file) return; const f = F[+inp.dataset.near];
    const text = unwrapHtml(await file.text());
    try { if (S.ready) await call('horizon', { text }); S.near[f.id] = { name: file.name, text }; renderRoof(); save(); }
    catch (e) { setStatus(`Masque proche « ${file.name} » illisible : ${e.message}`, 'err', 100); }
  }));
}
// ------------------------------------------------------------------ relevé de toiture sur vue aérienne
// Clics : 1 bord bas gauche, 2 bord bas droit, 3 bord haut droit, 4 bord haut gauche. La zone est rendue
// rectangulaire : la longueur est la distance 1-2, l'orientation est perpendiculaire à 1-2 (vers le bas de pente),
// la hauteur en plan est la moyenne des distances des points 3 et 4 à la droite 1-2, ramenée selon la pente.
const RMANUAL = new Set();
let RM = null, rmap = null, rlayer = null;
const STEPS = ['bord bas gauche', 'bord bas droit', 'bord haut droit', 'bord haut gauche'];
function rmXY(ll) { const o = RM.o; return [(ll.lng - o.lng) * Math.cos(o.lat * Math.PI / 180) * 111320, (ll.lat - o.lat) * 110540]; }
function rmLL(p) { const o = RM.o; return L.latLng(o.lat + p[1] / 110540, o.lng + p[0] / (Math.cos(o.lat * Math.PI / 180) * 111320)); }
function rmCompute(pts) {
  if (pts.length < 2) return null;
  const [a, b] = pts.map(rmXY); const d = [b[0] - a[0], b[1] - a[1]]; const len = Math.hypot(d[0], d[1]);
  if (len < 0.05) return null;
  const u = [d[0] / len, d[1] / len];
  let n = [u[1], -u[0]];                       // face des modules (vers le bas de pente), à droite de 1→2 vu du haut
  let up = [-n[0], -n[1]];
  const others = pts.slice(2).map(rmXY);
  if (others.length) {
    const s0 = (others[0][0] - a[0]) * up[0] + (others[0][1] - a[1]) * up[1];
    if (s0 < 0) { n = [-n[0], -n[1]]; up = [-up[0], -up[1]]; }   // le haut de toiture est du côté du point 3
  }
  const hs = others.map((p) => Math.abs((p[0] - a[0]) * up[0] + (p[1] - a[1]) * up[1]));
  const h = hs.length ? hs.reduce((x, y) => x + y, 0) / hs.length : 0;
  const compass = (Math.atan2(n[0], n[1]) * 180 / Math.PI + 360) % 360;   // 0 = Nord, 90 = Est
  const az = ((compass - 180 + 540) % 360) - 180;                          // 0 = Sud, Est < 0
  const corners = [a, b, [b[0] + up[0] * h, b[1] + up[1] * h], [a[0] + up[0] * h, a[1] + up[1] * h]];
  return { az: Math.round(az * 10) / 10, len, h, corners: corners.map(rmLL) };
}
function rmTilt() { const v = parseFloat(($('#rmTilt').value || '').replace(',', '.')); return Number.isFinite(v) && v >= 0 && v < 89 ? v : null; }
function rmRender(mouse) {
  if (!rlayer) return;
  rlayer.clearLayers();
  const pts = RM.pts.slice(); const live = mouse && pts.length >= 2 && pts.length < 4 ? pts.concat([mouse]) : pts;
  if (RM.prev) L.polygon(RM.prev, { color: '#ffffff', weight: 1.5, dashArray: '5 5', fill: false }).addTo(rlayer);
  const r = rmCompute(live);
  if (r && live.length >= 3) L.polygon(r.corners, { color: '#f2a20c', weight: 2.5, fillColor: '#f2a20c', fillOpacity: 0.25 }).addTo(rlayer);
  else if (live.length >= 2 || (mouse && pts.length === 1)) L.polyline((mouse && pts.length === 1 ? pts.concat([mouse]) : live).slice(0, 2), { color: '#f2a20c', weight: 3 }).addTo(rlayer);
  if (r && live.length >= 3) {   // flèche : direction de la face des modules (vers le bas de pente)
    const a = rmXY(r.corners[0]), b = rmXY(r.corners[1]), c = rmXY(r.corners[3]);
    const m0 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dn = [a[0] - c[0], a[1] - c[1]], k = Math.hypot(dn[0], dn[1]) || 1, l = Math.min(3, r.len / 4);
    L.polyline([rmLL([m0[0] - dn[0] / k * 0.5, m0[1] - dn[1] / k * 0.5]), rmLL([m0[0] + dn[0] / k * l, m0[1] + dn[1] / k * l])], { color: '#4fc3f7', weight: 3 }).addTo(rlayer);
  }
  pts.forEach((p, k) => L.marker(p, { icon: L.divIcon({ className: 'rmpt', html: `<span>${k + 1}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false }).addTo(rlayer));
  const t = rmTilt(), next = pts.length < 4 ? `Clic ${pts.length + 1}/4 : <b>${STEPS[pts.length]}</b>` : '<b>Relevé complet</b>';
  let info = '';
  if (r) {
    info = `Orientation <b>${nf(r.az, 1)}°</b> · longueur <b>${nf(r.len, 2)} m</b>`;
    if (live.length >= 3) info += ` · hauteur en plan ${nf(r.h, 2)} m → <b>${t != null ? nf(r.h / Math.cos(t * Math.PI / 180), 2) + ' m selon la pente' : 'inclinaison à renseigner'}</b>`;
  }
  $('#rmStep').innerHTML = next; $('#rmInfo').innerHTML = info || 'Zoomer à la molette, puis cliquer les angles de la zone de calepinage.';
  $('#rmApply').disabled = RM.pts.length < 4 || t == null;
}
function ensureRoofModal() {
  if ($('#roofModal')) return;
  const m = document.createElement('div'); m.id = 'roofModal'; m.hidden = true;
  m.innerHTML = `<div class="rmbox"><div class="rmhead"><b id="rmTitle">Relevé de toiture</b>
      <label>Inclinaison <input type="number" id="rmTilt" step="any" min="0" max="89" style="width:70px"> °</label>
      <button type="button" class="rmx" id="rmClose" title="Fermer">×</button></div>
    <div class="rmbar"><span id="rmStep"></span><span id="rmInfo"></span></div>
    <div id="rmMap"></div>
    <div class="rmfoot"><button type="button" class="mini" id="rmUndo">Annuler le dernier point</button><button type="button" class="mini" id="rmReset">Recommencer</button>
      <button type="button" class="mini" id="rmManual">Saisir à la main</button><span style="flex:1"></span>
      <button type="button" class="primary" id="rmApply">Valider</button></div></div>`;
  document.body.appendChild(m);
  const ign = (layer, fmt, z) => L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layer + '&STYLE=normal&TILEMATRIXSET=PM&FORMAT=' + fmt + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    { maxZoom: 22, maxNativeZoom: z, attribution: '© <a href="https://geoservices.ign.fr" target="_blank" rel="noopener">IGN – Géoplateforme</a>' });
  rmap = L.map('rmMap', { doubleClickZoom: false, zoomSnap: 0.5, wheelPxPerZoomLevel: 90, maxZoom: 22 });
  const ortho = ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg', 20).addTo(rmap);
  L.control.layers({ 'Photographies aériennes IGN': ortho, 'Plan IGN': ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png', 19) }, null, { position: 'topright' }).addTo(rmap);
  L.control.scale({ imperial: false }).addTo(rmap);
  rlayer = L.layerGroup().addTo(rmap);
  rmap.on('click', (e) => { if (RM && RM.pts.length < 4) { RM.pts.push(e.latlng); rmRender(); } });
  rmap.on('mousemove', (e) => { if (RM && RM.pts.length && RM.pts.length < 4) rmRender(e.latlng); });
  $('#rmUndo').onclick = () => { RM.pts.pop(); rmRender(); };
  $('#rmReset').onclick = () => { RM.pts = []; rmRender(); };
  $('#rmTilt').oninput = () => rmRender();
  $('#rmApply').onclick = () => closeRoofMap(true);
  $('#rmClose').onclick = () => closeRoofMap(RM && RM.pts.length === 4 && rmTilt() != null);
  $('#rmManual').onclick = () => {
    const f = S.cfg.structure.fields[RM.i]; RMANUAL.add(f.id); closeRoofMap(false);
    const el = $(`[data-f="${RM_last},azimuth"]`); if (el) el.focus();
    setStatus(`${f.name} : saisie manuelle de l'orientation et des dimensions (bouton « Vue aérienne » pour revenir au relevé).`, 'ok', 100);
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && RM) closeRoofMap(false); });
}
let RM_last = 0;
function openRoofMap(i) {
  const f = S.cfg.structure.fields[i];
  if (S.cfg.site.lat == null || S.cfg.site.lon == null) { setStatus('Renseigner d\'abord les coordonnées du site (section Site) pour ouvrir la vue aérienne.', 'err', 100); return; }
  ensureRoofModal();
  RM_last = i;
  RM = { i, pts: [], o: { lat: S.cfg.site.lat, lng: S.cfg.site.lon }, prev: f.geom ? f.geom.map((p) => L.latLng(p[0], p[1])) : null };
  $('#rmTitle').textContent = `Relevé de toiture – ${f.name || 'Champ ' + (i + 1)}`;
  $('#rmTilt').value = f.tilt ?? '';
  $('#roofModal').hidden = false;
  setTimeout(() => {
    rmap.invalidateSize();
    if (RM.prev) rmap.fitBounds(L.latLngBounds(RM.prev).pad(1.5), { maxZoom: 21 }); else rmap.setView([RM.o.lat, RM.o.lng], 19);
    rmRender();
  }, 30);
}
function closeRoofMap(apply) {
  if (!RM) return;
  if (apply) {
    const r = rmCompute(RM.pts), t = rmTilt(), f = S.cfg.structure.fields[RM.i];
    f.tilt = t; f.azimuth = r.az; f.length = Math.round(r.len * 100) / 100;
    f.height = Math.round(r.h / Math.cos(t * Math.PI / 180) * 100) / 100;
    f.geom = r.corners.map((p) => [+p.lat.toFixed(7), +p.lng.toFixed(7)]);
    setStatus(`${f.name} : orientation ${nf(f.azimuth, 1)}°, zone ${nf(f.length, 2)} × ${nf(f.height, 2)} m (selon la pente, inclinaison ${nf(t, 1)}°).`, 'ok', 100);
    renderRoof(); onChange('structure.fields');
  }
  $('#roofModal').hidden = true; RM = null;
}
// bibliothèque de modules / onduleurs supplémentaires (toiture)
async function addLib(kind, file) {
  const text = unwrapHtml(await file.text());
  const item = { name: file.name, text, info: null };
  try { item.info = await call(kind, { text }); } catch (e) { setStatus(`${file.name} illisible : ${e.message}`, 'err', 100); return; }
  S.lib[kind].push(item); renderLib(); renderRoof(); save(); onChange('lib');
}
function renderLib() {
  for (const kind of ['pan', 'ond']) {
    const box = $('#lib-' + kind); if (!box) continue;
    box.innerHTML = S.lib[kind].map((x, i) => `<div class="grow" style="grid-template-columns:1fr 28px"><span style="color:var(--ink)">${i + 1}. ${esc(x.name)}${x.info && !x.info.error ? ` – ${esc(x.info.model)}` : ''}</span>
      <button type="button" data-ldel="${kind},${i}" title="Retirer">×</button></div>`).join('') || '<span class="hint">Aucun autre fichier. Le fichier principal ci-dessus est affectable aux champs.</span>';
  }
  $$('[data-ldel]').forEach((b) => b.addEventListener('click', () => {
    const [kind, i] = b.dataset.ldel.split(','); const idx = +i + 1;
    S.lib[kind].splice(+i, 1);
    const key = kind === 'pan' ? 'module' : 'inverter';
    S.cfg.structure.fields.forEach((f) => { if (f[key] === idx) f[key] = 0; else if (f[key] > idx) f[key] -= 1; });
    renderLib(); renderRoof(); save(); onChange('lib');
  }));
}
async function parseLib() {
  for (const kind of ['pan', 'ond']) for (const x of S.lib[kind]) if (!x.info && x.text) { try { x.info = await call(kind, { text: x.text }); } catch (e) { x.info = { error: e.message }; } }
  renderLib(); renderRoof();
}
function checkFiles() {
  const f = { pan: S.files.pan, ond: S.files.ond, pan_extra: S.lib.pan.map((x) => x.text), ond_extra: S.lib.ond.map((x) => x.text) };
  return f;
}
function renderGroups() {
  $('#groups').innerHTML = S.cfg.inverters.groups.map((g, i) => `<div class="grow">
    <input type="number" min="1" step="1" value="${g[0] ?? ''}" data-g="${i},0" title="Nombre d'onduleurs">
    <input type="number" min="1" step="1" value="${g[1] ?? ''}" data-g="${i},1" title="Chaînes par onduleur">
    <button type="button" data-del="${i}" title="Supprimer">×</button></div>`).join('') +
    '<div class="grow"><span>onduleurs</span><span>chaînes / onduleur</span><span></span></div>';
  $$('#groups [data-g]').forEach((el) => el.addEventListener('input', () => {
    const [i, j] = el.dataset.g.split(',').map(Number); S.cfg.inverters.groups[i][j] = el.value === '' ? null : Number(el.value); onChange('inverters.groups');
  }));
  $$('#groups [data-del]').forEach((b) => b.addEventListener('click', () => {
    if (S.cfg.inverters.groups.length > 1) { S.cfg.inverters.groups.splice(Number(b.dataset.del), 1); renderGroups(); onChange('inverters.groups'); }
  }));
}
function shTotal() { return S.cfg.structure.shading_configs.reduce((a, c) => a + (Number(c.share) || 0), 0); }
function renderShconfs() {
  const L2 = S.cfg.structure.shading_configs;
  const auto = S.check && S.check.sub_in_height ? `auto (${S.check.sub_in_height})` : 'auto';
  $('#shconfs').innerHTML = L2.map((c, i) => `<div class="grow" style="grid-template-columns:auto 1fr 1fr 28px">
    <span style="font-weight:600;color:var(--ink)">Config. ${i + 1}</span>
    <input type="number" min="1" step="1" value="${c.sub_in_height ?? ''}" placeholder="${auto}" data-sh="${i},sub_in_height" title="Sous-chaînes en hauteur">
    <input type="number" min="0" max="100" step="0.01" value="${c.share}" data-sh="${i},share" title="Part des tables (%)">
    <button type="button" data-shdel="${i}" title="Supprimer" ${L2.length < 2 ? 'disabled style="visibility:hidden"' : ''}>×</button></div>`).join('') +
    `<div class="grow" style="grid-template-columns:auto 1fr 1fr 28px"><span></span><span>sous-chaînes en hauteur</span>
    <span id="shTot" style="font-weight:600;color:${Math.abs(shTotal() - 100) > 0.01 ? 'var(--block)' : 'var(--ok)'}">total ${nf(shTotal(), 2)} %</span><span></span></div>`;
  $$('#shconfs [data-sh]').forEach((el) => el.addEventListener('input', () => {
    const [i, k] = el.dataset.sh.split(',');
    L2[+i][k] = el.value === '' ? (k === 'share' ? 0 : null) : Number(el.value);
    const t = $('#shTot'); t.textContent = `total ${nf(shTotal(), 2)} %`; t.style.color = Math.abs(shTotal() - 100) > 0.01 ? 'var(--block)' : 'var(--ok)';
    onChange('structure.shading_configs');
  }));
  $$('#shconfs [data-shdel]').forEach((b) => b.addEventListener('click', () => {
    if (L2.length > 1) { L2.splice(Number(b.dataset.shdel), 1); renderShconfs(); onChange('structure.shading_configs'); }
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
  if (key === 'mdb') return loadMdbText(text, file.name);
  S.files[key] = text; S.names[key] = file.name; S.info[key] = null;
  await parseFile(key); save(); refreshAll();
}
async function parseFile(key) {
  const text = S.files[key]; if (!text) return;
  const el = $('#info-' + key);
  try {
    if (key === 'pan') { S.info.pan = await call('pan', { text }); renderRoof(); }
    else if (key === 'ond') { S.info.ond = await call('ond', { text }); renderRoof(); }
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
function clearFile(key) {
  delete S.files[key]; delete S.names[key]; delete S.info[key];
  if (key === 'gsa') S.gsa = null;
  if (key === 'mdb') { S.mdb = null; if (S.cfg.meteo.use_mdb) { S.cfg.meteo.use_mdb = false; S.cfg.meteo.use_gsa = true; fillForm(); } }
  save(); refreshAll();
}
// Base météo mensuelle long terme (Solargis Prospect « LTA P1M pvsyst » ou CSV générique)
const MOIS_KEYS = { jan: 1, janv: 1, feb: 2, fev: 2, fevr: 2, mar: 3, mars: 3, apr: 4, avr: 4, may: 5, mai: 5, jun: 6, juin: 6, jul: 7, juil: 7, aug: 8, aou: 8, aout: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const JOURS_MOIS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const normTxt = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
function parseMonthlyDb(text) {
  const lines = text.replace(/\r/g, '').split('\n'), meta = {};
  lines.forEach((l) => { const m = l.match(/^#\s*([^:]+):\s*(.+)$/); if (m) meta[normTxt(m[1])] = m[2].trim(); });
  const hi = lines.findIndex((l) => /^\s*(month|mois)\b/.test(normTxt(l)));
  if (hi < 0) throw new Error('ligne d\'en-tête « Month » introuvable');
  const sep = lines[hi].includes(';') ? ';' : lines[hi].includes('\t') ? '\t' : ',';
  const head = lines[hi].split(sep).map(normTxt);
  const col = (re) => head.findIndex((h) => re.test(h));
  const cj = { ghi: col(/^(ghi|gh\b|glob)/), dif: col(/^(dif|dhi)/), dni: col(/^(dni|bn)/), temp: col(/^(t24|temp|tamb|t2m|ta\b|t_?air)/), alb: col(/^alb/), wind: col(/^(ws|wind|vent)/) };
  if (cj.ghi < 0) throw new Error('colonne GHI introuvable');
  const v = Object.fromEntries(Object.keys(cj).map((k) => [k, Array(12).fill(null)]));
  for (const l of lines.slice(hi + 1)) {
    const f = l.split(sep).map((x) => x.trim()); if (!f[0]) continue;
    const key = normTxt(f[0]).replace(/[^a-z0-9]/g, '');
    const m = /^\d+$/.test(key) && +key >= 1 && +key <= 12 ? +key : (MOIS_KEYS[key.slice(0, 4)] || MOIS_KEYS[key.slice(0, 3)]);
    if (!m) continue;
    for (const [k, j] of Object.entries(cj)) if (j >= 0 && f[j] !== undefined && f[j] !== '' && f[j] !== '-') { const x = Number(f[j].replace(',', '.')); if (Number.isFinite(x)) v[k][m - 1] = x; }
  }
  if (v.ghi.some((x) => x == null)) throw new Error('12 valeurs mensuelles de GHI attendues');
  const full = (a) => a.every((x) => x != null);
  const msum = (a) => (full(a) && Math.max(...a) < 12 ? a.map((x, i) => x * JOURS_MOIS[i]) : a);
  const sum = (a) => a.reduce((p, q) => p + q, 0);
  const ghi = msum(v.ghi), dif = full(v.dif) ? msum(v.dif) : null, dni = full(v.dni) ? msum(v.dni) : null, temp = full(v.temp) ? v.temp : null;
  const num = (k) => { const m = (meta[k] || '').match(/[-+]?\d+(?:[.,]\d+)?/); return m ? Number(m[0].replace(',', '.')) : null; };
  const low = text.toLowerCase();
  return { source: low.includes('solargis') ? 'Solargis' : low.includes('meteonorm') ? 'Meteonorm' : 'Base mensuelle',
    ghi, dif, dni, temp, albedo: full(v.alb) ? v.alb : null, wind: full(v.wind) ? v.wind : null,
    ghi_year: sum(ghi), dif_year: dif ? sum(dif) : null, dni_year: dni ? sum(dni) : null, temp_year: temp ? sum(temp) / 12 : null,
    site: meta['site name'] || null, lat: num('latitude'), lon: num('longitude'), elev: num('elevation'), issued: meta.issued || null, report: meta['report number'] || null };
}
function loadMdbText(text, name) {
  try {
    S.mdb = parseMonthlyDb(text);
    if (!S.mdb.dif) throw new Error('colonne de diffus (DIF ou DHI) introuvable');
    S.names.mdb = name; S.cfg.meteo.use_mdb = true; S.cfg.meteo.use_gsa = false;
    fillForm(); save(); refreshAll();
  } catch (e) { $('#info-mdb').textContent = '⚠ Base météo mensuelle illisible : ' + e.message; $('#info-mdb').style.color = 'var(--block)'; }
}
function meteoRef() {
  const m = S.cfg.meteo;
  if (m.use_mdb && S.mdb) return S.mdb;
  if (m.use_gsa && S.gsa) return Object.assign({ source: 'Global Solar Atlas' }, S.gsa);
  return null;
}

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
    const loaded = key === 'gsa' ? !!S.gsa : key === 'mdb' ? !!S.mdb : !!S.files[key];
    box.classList.toggle('loaded', loaded);
    $('.dtxt', box).innerHTML = loaded ? `<b>${esc(S.names[key] || 'chargé')}</b><span>${fileSummary(key)}</span>` : `<b>Déposer ou choisir un fichier</b>${$('.dtxt', box).dataset.hint}`;
    $('.ico', box).textContent = loaded ? '✓' : '⇪';
    let c = $('.clear', box);
    if (loaded && !c) { c = document.createElement('button'); c.type = 'button'; c.className = 'clear'; c.textContent = '×'; c.title = 'Retirer'; c.onclick = (e) => { e.stopPropagation(); clearFile(key); }; box.appendChild(c); }
    if (!loaded && c) c.remove();
    const info = $('#info-' + key);
    if (info && !(S.info[key] && S.info[key].error)) { info.textContent = ''; info.style.color = ''; }
  }
  renderGsaTable(); renderMdbTable();
}
function fileSummary(key) {
  const i = S.info[key];
  if (key === 'mdb' && S.mdb) return `${esc(S.mdb.source)}${S.mdb.issued ? ' · ' + esc(S.mdb.issued.slice(0, 10)) : ''} · GHI ${nf(S.mdb.ghi_year, 1)} · DIF ${nf(S.mdb.dif_year, 1)} kWh/m²${S.mdb.temp_year != null ? ' · T ' + nf(S.mdb.temp_year, 1) + ' °C' : ''}`;
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

function renderMdbTable() {
  const box = $('#mdbTable'); if (!box) return;
  const d = S.mdb; if (!d) { box.innerHTML = ''; return; }
  const tmy = S.info.tmy && !S.info.tmy.error ? S.info.tmy : null, sum = (a) => a.reduce((p, q) => p + q, 0);
  box.innerHTML = `<table class="mtable"><tr><th>Mois</th><th>GHI</th><th>DIF</th><th>T</th>${tmy ? '<th>GHI TMY</th><th>Écart</th>' : ''}</tr>` +
    MONTHS.map((m, i) => `<tr><td>${m}</td><td><input type="number" step="0.1" value="${(+d.ghi[i]).toFixed(1)}" data-mdb="ghi,${i}"></td>
      <td><input type="number" step="0.1" value="${(+d.dif[i]).toFixed(1)}" data-mdb="dif,${i}"></td><td>${d.temp ? nf(d.temp[i], 1) : '–'}</td>
      ${tmy ? `<td>${nf(tmy.ghi[i], 1)}</td><td>${pf(d.ghi[i] / tmy.ghi[i] - 1, 0)}</td>` : ''}</tr>`).join('') +
    `<tr><td><b>Année</b></td><td><b>${nf(sum(d.ghi), 1)}</b></td><td><b>${nf(sum(d.dif), 1)}</b></td><td>${d.temp_year != null ? nf(d.temp_year, 1) : '–'}</td>
      ${tmy ? `<td><b>${nf(sum(tmy.ghi), 1)}</b></td><td>${pf(sum(d.ghi) / sum(tmy.ghi) - 1, 1)}</td>` : ''}</tr></table>
      <div class="hint">${esc(d.source)}${d.site ? ' · ' + esc(d.site) : ''}${d.lat != null ? ` · ${nf(d.lat, 4)} / ${nf(d.lon, 4)}` : ''}${d.report ? ' · rapport ' + esc(d.report) : ''}. Cumuls mensuels en kWh/m², modifiables.</div>`;
  $$('[data-mdb]', box).forEach((el) => el.addEventListener('change', () => {
    const [k, i] = el.dataset.mdb.split(','); d[k][+i] = Number(el.value) || 0;
    d[k + '_year'] = d[k].reduce((p, q) => p + q, 0); save(); renderMdbTable(); renderFileBoxes();
  }));
}

// ------------------------------------------------------------------ carte & liens
let map, marker;
function initMap() {
  if (!window.L) return;
  const hasLL = S.cfg.site.lat != null && S.cfg.site.lon != null;
  map = L.map('map', { zoomControl: true, attributionControl: true }).setView(hasLL ? [S.cfg.site.lat, S.cfg.site.lon] : [46.6, 2.4], hasLL ? 9 : 5);
  // Fonds IGN (Géoplateforme, licence ouverte Etalab) ; OpenStreetMap en secours hors de France
  const ign = (layer, fmt) => L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layer +
    '&STYLE=normal&TILEMATRIXSET=PM&FORMAT=' + fmt + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    { maxZoom: 19, attribution: '© <a href="https://geoservices.ign.fr" target="_blank" rel="noopener">IGN – Géoplateforme</a>' });
  const plan = ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png');
  const ortho = ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg');
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' });
  plan.addTo(map);
  L.control.layers({ 'Plan IGN': plan, 'Photographies aériennes IGN': ortho, 'OpenStreetMap (hors France)': osm }, null, { position: 'topright' }).addTo(map);
  if (hasLL) placeMarker([S.cfg.site.lat, S.cfg.site.lon]);
  map.on('click', (e) => { placeMarker(e.latlng); setLL(e.latlng); });
  $('#sec-site').addEventListener('toggle', () => setTimeout(() => map.invalidateSize(), 50));
}
function setLL(ll) { S.cfg.site.lat = +ll.lat.toFixed(5); S.cfg.site.lon = +ll.lng.toFixed(5); fillForm(); onChange('site.lat'); }
// Altitude du site : IGN RGE ALTI (France), sinon Open-Meteo (Copernicus DEM 90 m)
let altTimer = null, altSeq = 0;
function scheduleAltitude(delay = 600) { clearTimeout(altTimer); altTimer = setTimeout(fetchAltitude, delay); }
async function fetchAltitude() {
  const { lat, lon } = S.cfg.site; if (lat == null || lon == null) return;
  const my = ++altSeq; let z = null, src = '';
  try {
    const r = await fetch(`https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=${lon}&lat=${lat}&resource=ign_rge_alti_wld&zonly=true`);
    const v = (await r.json()).elevations?.[0];
    if (Number.isFinite(v) && v > -1000) { z = v; src = 'IGN RGE ALTI'; }
  } catch (e) { /* service indisponible : repli */ }
  if (z == null) {
    try { const v = (await (await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`)).json()).elevation?.[0]; if (Number.isFinite(v)) { z = v; src = 'Copernicus DEM (Open-Meteo)'; } } catch (e) { /* ignore */ }
  }
  if (my !== altSeq || z == null) return;
  S.cfg.site.alt = Math.round(z);
  const el = $('[data-path="site.alt"]'); if (el) el.value = S.cfg.site.alt;
  onChange('site.alt', true);
  setStatus(`Altitude du site : ${nf(S.cfg.site.alt)} m (${src}).`, 'ok', 100);
}
function placeMarker(ll) {
  if (!map) return;
  if (!marker) { marker = L.marker(ll, { draggable: true }).addTo(map); marker.on('dragend', () => setLL(marker.getLatLng())); }
  else marker.setLatLng(ll);
}
function renderLinks() {
  const { lat, lon } = S.cfg.site;
  const ok = lat != null && lon != null;
  for (const [key, [label, url]] of Object.entries(DL)) {
    const e = $('#dl-' + key); if (!e) continue;
    e.innerHTML = ok ? `<a href="${url(lat, lon)}" target="_blank" rel="noopener" title="Ouvre les données du site dans un nouvel onglet : l'enregistrer (Ctrl+S / ⌘S) puis déposer le fichier ci-dessous">⤓ ${label}</a>`
      : '<span class="hint">Renseigner les coordonnées du site pour obtenir le lien de téléchargement.</span>';
  }
  if (!ok) return;
  if (map && (!marker || Math.abs(marker.getLatLng().lat - lat) > 1e-6 || Math.abs(marker.getLatLng().lng - lon) > 1e-6)) { placeMarker([lat, lon]); map.setView([lat, lon], Math.max(map.getZoom(), 9)); }
}

// ------------------------------------------------------------------ cohérence, alertes
let checkTimer = null;
function onChange(path) {
  if (path === 'inverters.groups' || path === 'array.n_series') syncStrings();
  if (path === 'site.lat' || path === 'site.lon') scheduleAltitude();
  // une seule base de référence pour le recalage du TMY
  if (path === 'meteo.use_mdb' && S.cfg.meteo.use_mdb && S.cfg.meteo.use_gsa) { S.cfg.meteo.use_gsa = false; fillForm(); }
  if (path === 'meteo.use_gsa' && S.cfg.meteo.use_gsa && S.cfg.meteo.use_mdb) { S.cfg.meteo.use_mdb = false; fillForm(); }
  applyVisibility(); renderDerived(); renderLinks(); save();
  clearTimeout(checkTimer); checkTimer = setTimeout(runCheck, 250);
}
function syncStrings() {
  S.cfg.array.n_strings = S.cfg.inverters.groups.reduce((a, g) => a + (g[0] || 0) * (g[1] || 0), 0);
  const el = $('[data-path="array.n_strings"]'); if (el) el.value = S.cfg.array.n_strings;
}
function ewFaces(o) {
  const n = (a) => ((((a + 180) % 360) + 360) % 360) - 180, f = (a) => (a > 0 ? '+' : a < 0 ? '−' : '') + nf(Math.abs(a), 0) + '°';
  const v = Number(o) || 0; return `pan Est ${f(n(v - 90))}, pan Ouest ${f(n(v + 90))}`;
}
function renderDerived() {
  const c = S.cfg, pan = S.info.pan && !S.info.pan.error ? S.info.pan : null;
  const roof = c.structure.type === 'roof';
  const rf = roof ? c.structure.fields.map((f) => { const L = layout(f); const n = (Number(f.n_series) || 0) * (Number(f.n_inv) || 0) * (Number(f.n_str) || 0); const o = ondInfo(f.inverter);
    return { n, kwc: L ? n * L.pnom / 1000 : 0, kva: o && !o.error ? (Number(f.n_inv) || 0) * o.pmax / 1000 : 0, ninv: Number(f.n_inv) || 0 }; }) : [];
  const rsum = (k) => rf.reduce((a, x) => a + x[k], 0);
  const nmod = roof ? rsum('n') : c.array.n_series * c.array.n_strings;
  $('#pdcOut').value = roof ? `${nf(nmod)} modules câblés · ${nf(rsum('kwc'), 2)} kWc (${rf.length} toit${rf.length > 1 ? 's' : ''})`
    : pan ? `${nf(nmod)} modules · ${nf(nmod * pan.pnom / 1000, 1)} kWc` : `${nf(nmod)} modules`;
  const gcr = c.structure.width / c.structure.pitch;
  let la = '';
  if (c.structure.type !== 'tracker') {
    const t = c.structure.tilt * Math.PI / 180, r = c.structure.pitch / c.structure.width;
    la = ` · angle limite ${nf(Math.atan(Math.sin(t) / (r - Math.cos(t))) * 180 / Math.PI, 1)}°`;
  }
  $('#gcrOut').value = `GCR ${pf(gcr, 1)}${la}`;
  const eh = $('#ewHint'); if (eh) eh.textContent = `0 = Sud, Est < 0, Ouest > 0. Ici : ${ewFaces(c.structure.azimuth)}.`;
  if (S.check && S.check.sub_in_height) $$('#shconfs [data-sh$=",sub_in_height"]').forEach((el) => (el.placeholder = `auto (${S.check.sub_in_height})`));
  // résumés des sections
  const ond = S.info.ond && !S.info.ond.error ? S.info.ond : null;
  const ninv = c.inverters.groups.reduce((a, g) => a + g[0], 0);
  const sums = {
    project: c.project.name ? `${c.project.name} – ${c.project.variant}` : 'à renseigner', site: c.site.lat == null ? 'à renseigner' : `${nf(c.site.lat, 4)} / ${nf(c.site.lon, 4)}`,
    meteo: S.files.tmy ? `TMY ✓${c.meteo.tmy_has_horizon ? ' · horizon PVGIS inclus' : ''} · recalage ${meteoRef() ? `${c.meteo.gsa_mode === 'monthly' ? 'mensuel' : 'annuel'} sur ${meteoRef().source}` : 'aucun'}` : 'TMY manquant',
    gsa: !c.meteo.use_gsa ? (S.gsa ? 'chargé, non utilisé' : 'non utilisé') : (S.gsa ? 'recalage ✓' : 'données manquantes'),
    mdb: S.mdb ? (c.meteo.use_mdb ? `${S.mdb.source} · recalage ✓` : `${S.mdb.source} · non utilisé`) : (c.meteo.use_mdb ? 'données manquantes' : 'aucune'),
    horizon: S.files.horizon ? (c.horizon.use ? 'appliqué' : 'désactivé') : 'aucun',
    module: roof ? (nmod ? `${nf(rsum('kwc'), 2)} kWc · ${nf(nmod)} modules` : 'à renseigner') : !(c.array.n_series > 0) ? 'à renseigner' : pan ? `${nf(nmod * pan.pnom / 1000, 1)} kWc · ${c.array.n_series} × ${c.array.n_strings}` : `${c.array.n_series} × ${c.array.n_strings}`,
    inverter: roof ? (rsum('ninv') ? `${rsum('ninv')} onduleur(s) · ${nf(rsum('kva'), 1)} kVA` : 'à renseigner') : !(ninv > 0) ? 'à renseigner' : ond ? `${ninv} × ${nf(ond.pmax / 1000)} kW · DC/AC ${pan ? nf(nmod * pan.pnom / (ninv * ond.pmax), 2) : '–'}` : `${ninv} onduleurs`,
    structure: roof ? `Toiture · ${c.structure.fields.length} toit(s) : ` + c.structure.fields.map((f) => `${f.tilt ?? '–'}°/${f.azimuth ?? 0}°`).join(', ') : { fixed: `Sheds ${c.structure.tilt ?? '–'}° / ${c.structure.azimuth ?? '–'}°`, tracker: `Tracker ±${c.structure.max_angle ?? '–'}°${c.structure.backtrack ? ' backtracking' : ''}`, ew: `Est-Ouest ${c.structure.tilt ?? '–'}° · ${ewFaces(c.structure.azimuth)}` }[c.structure.type] + ` · GCR ${pf(gcr, 0)}`,
    shading: roof ? `${c.structure.elec_effect} %` : `${c.structure.elec_effect} % · ` + c.structure.shading_configs.map((x) => `${x.sub_in_height || (S.check ? S.check.sub_in_height : 'auto')} (${nf(x.share, 2)} %)`).join(' + '),
    bifacial: c.bifacial.enabled ? `albédo ${c.bifacial.albedo_ground}` : 'non',
    thermal: `Uc ${c.thermal.uc} · ${c.iam.mode === 'pan' ? 'IAM .PAN' : 'Fresnel'}`,
    dc: `${nf(c.losses.soiling, 1)} + ${nf(c.losses.lid, 1)} + ${nf(c.losses.mismatch, 1)} + ${nf(c.losses.dc_ohmic, 1)} %`,
    ac: `AC ${nf(c.losses.ac_ohmic, 1)} % · transfo ${c.losses.tr_enabled ? 'oui' : 'non'}`,
    p90: S.info.pvgis_monthly && !S.info.pvgis_monthly.error ? `météo ${nf(100 * S.info.pvgis_monthly.variability, 2)} % (PVGIS)` : `météo ${nf(c.p90.meteo_var, 1)} %`,
  };
  for (const [k, v] of Object.entries(sums)) { const e = $('#sum-' + k); if (e) e.textContent = v; }
}

async function runCheck() {
  const roof = S.cfg.structure.type === 'roof';
  if (roof ? missingFields().some((m) => m.startsWith('Toit') || m.startsWith('Champ') || m === 'Au moins un toit')
    : (!(S.cfg.array.n_series > 0) || missingFields().includes("Groupes d'onduleurs"))) { S.check = null; renderAlerts(); return; }
  if (!S.ready || !S.files.pan || !S.files.ond || (S.info.pan && S.info.pan.error) || (S.info.ond && S.info.ond.error)) { S.check = null; renderAlerts(); return; }
  try { S.check = await call('check', { files: checkFiles(), cfg: S.cfg }); } catch (e) { S.check = { error: e.message }; }
  renderAlerts(); renderDerived();
}
const REQUIRED = [
  ['site.lat', 'Latitude'], ['site.lon', 'Longitude'], ['site.alt', 'Altitude'],
  ['structure.tilt', 'Inclinaison', (c) => c.structure.type !== 'tracker' && c.structure.type !== 'roof'], ['structure.pitch', 'Entraxe des rangées', (c) => c.structure.type !== 'roof'],
  ['structure.width', 'Largeur sensible', (c) => c.structure.type !== 'roof'], ['structure.height', 'Hauteur du bord bas', (c) => c.structure.type !== 'tracker' && c.structure.type !== 'roof'],
  ['structure.axis_height', "Hauteur de l'axe", (c) => c.structure.type === 'tracker'],
  ['structure.n_rows', 'Nombre de rangées', (c) => c.structure.type !== 'roof'], ['structure.n_high', 'Modules en hauteur', (c) => c.structure.type !== 'roof'], ['array.n_series', 'Modules en série', (c) => c.structure.type !== 'roof'],
  ['losses.tr_sn_kva', 'Puissance transfo', (c) => c.losses.tr_enabled], ['losses.tr_iron_kw', 'Pertes fer', (c) => c.losses.tr_enabled],
  ['losses.tr_cu_kw', 'Pertes cuivre nominales', (c) => c.losses.tr_enabled],
];
function missingFields() {
  const c = S.cfg;
  const out = REQUIRED.filter(([p, , cond]) => (!cond || cond(c)) && (get(c, p) == null || get(c, p) === '' || Number.isNaN(get(c, p)))).map(([, l]) => l);
  if (c.structure.type === 'roof') {
    if (!c.structure.fields.length) out.push('Au moins un toit');
    const lab = { tilt: 'inclinaison', length: 'longueur', height: 'hauteur', n_series: 'modules en série', n_inv: 'onduleurs', n_str: 'chaînes par onduleur' };
    c.structure.fields.forEach((f, i) => {
      const forced = f.n_h > 0 && f.n_v > 0;
      const m = Object.keys(lab).filter((k) => !(forced && (k === 'length' || k === 'height')) && (f[k] == null || f[k] === '' || Number.isNaN(f[k]) || (k !== 'tilt' && !(f[k] > 0))));
      if (m.length) out.push(`${f.name || 'Champ ' + (i + 1)} (${m.map((k) => lab[k]).join(', ')})`);
    });
  } else if (!c.inverters.groups.length || c.inverters.groups.some((g) => !(g[0] > 0) || !(g[1] > 0))) out.push("Groupes d'onduleurs");
  return out;
}
function localAlerts() {
  const out = []; const c = S.cfg;
  const miss = missingFields();
  if (miss.length) out.push({ level: 'block', title: 'Champs à renseigner', message: miss.join(', ') + '.' });
  if (c.meteo.use_gsa && !c.meteo.use_mdb && !S.gsa) out.push({ level: 'warn', title: 'Recalage GSA demandé', message: 'Aucune donnée Global Solar Atlas chargée : le TMY sera utilisé sans recalage.' });
  if (c.meteo.use_mdb && !S.mdb) out.push({ level: 'warn', title: 'Recalage sur la base mensuelle demandé', message: 'Aucune base météo mensuelle chargée : le TMY sera utilisé sans recalage.' });
  if (c.meteo.use_mdb && S.mdb && S.mdb.lat != null && c.site.lat != null && (Math.abs(S.mdb.lat - c.site.lat) > 0.05 || Math.abs(S.mdb.lon - c.site.lon) > 0.05))
    out.push({ level: 'warn', title: 'Coordonnées de la base mensuelle', message: `La base ${S.mdb.source} a été produite pour ${nf(S.mdb.lat, 3)} / ${nf(S.mdb.lon, 3)}, le site est saisi en ${nf(c.site.lat, 3)} / ${nf(c.site.lon, 3)}.` });
  if (c.meteo.tmy_has_horizon && S.files.horizon && c.horizon.use) out.push({ level: 'warn', title: 'Masque lointain en double', message: "Le TMY contient déjà l'horizon PVGIS : le masque déposé s'ajoute (union des deux masques) et la ligne « masque lointain » du diagramme de pertes est sous-estimée." });
  if (S.info.tmy && !S.info.tmy.error && S.info.tmy.lat != null && (Math.abs(S.info.tmy.lat - c.site.lat) > 0.05 || Math.abs(S.info.tmy.lon - c.site.lon) > 0.05))
    out.push({ level: 'warn', title: 'Coordonnées', message: `Le TMY a été produit pour ${nf(S.info.tmy.lat, 3)} / ${nf(S.info.tmy.lon, 3)}, le site est saisi en ${nf(c.site.lat, 3)} / ${nf(c.site.lon, 3)}.`, fix: 'tmyll' });
  if (c.structure.width != null && c.structure.pitch != null && c.structure.width >= c.structure.pitch) out.push({ level: 'block', title: 'Géométrie', message: "La largeur sensible doit être inférieure à l'entraxe." });
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
    const ok = k === 'gsa' ? !!S.gsa : k === 'mdb' ? !!S.mdb : !!S.files[k] && !(S.info[k] && S.info[k].error);
    return `<div class="${ok ? 'ok' : f.req ? '' : 'opt'}"><i>${ok ? '✓' : f.req ? '!' : '–'}</i>${f.label}</div>`;
  }).join('');
  $('#btnExtract').disabled = !(S.ready && S.files.pan && S.files.ond && !r.blocked && S.cfg.site.lat != null && S.cfg.site.lon != null);
  $('#checklist').innerHTML = S.res || S.ext ? '' : `<h3>Fichiers d'entrée</h3><div class="cl">${items}</div>
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
  if (S.cfg.structure.type === 'roof') {
    Object.assign(files, { pan_extra: S.lib.pan.map((x) => x.text), ond_extra: S.lib.ond.map((x) => x.text), near_masks: {} });
    S.cfg.structure.fields.forEach((f) => { if (S.near[f.id]) files.near_masks[String(f.id)] = S.near[f.id].text; });
  }
  const ref = meteoRef();
  if (ref) files.gsa = ref;
  const cfg = clone(S.cfg);
  if (!ref) cfg.meteo.gsa_mode = 'none';
  const t0 = performance.now();
  try {
    const res = await call('run', { cfg, files });
    S.res = res; S.ext = null; $('#extractResults').hidden = true; closeExtractCard();
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
  $('#shResults').innerHTML = r.fields ? '' : shConfTable(r);
  $('#fieldsResults').innerHTML = fieldsTable(r);
  drawCharts(); renderLosses(); renderMeteo(); renderP90(); renderHyp(); renderPvsystCmp();
}
function renderPvsystCmp() {
  const box = $('#pvsystCmp'), P = S.pvsyst, r = S.res;
  if (!P || !r) { box.hidden = true; box.innerHTML = ''; return; }
  const s = r.summary, R = P.results || {}, M = P.monthly || {}, sum = (a) => (a ? a.reduce((x, y) => x + y, 0) : null);
  const d = (a, b) => (a != null && b ? pf(a / b - 1, 1) : '–');
  const row = (l, a, b, f) => `<tr><td>${l}</td><td>${a == null ? '–' : f(a)}</td><td>${b == null ? '–' : f(b)}</td><td>${d(a, b)}</td></tr>`;
  let h = `<h3>Comparaison avec l'étude PVsyst importée</h3><p class="note">${esc(P.project || '')} – ${esc(P.variant || '')} · PVsyst ${esc(P.version || '')} · ${esc(P.simdate || '')}${P.weather ? ' · météo : ' + esc(P.weather) : ''}</p>
    <div class="tblwrap"><table class="res"><tr><th>Grandeur</th><th>Outil</th><th>PVsyst</th><th>Écart</th></tr>` +
    row('Productible (kWh/kWc/an)', s.yield_kwh_kwc, R.yield_kwh_kwc, (v) => nf(v, 0)) +
    row('Énergie injectée (MWh/an)', s.e_grid_mwh, R.e_grid_mwh, (v) => nf(v, 0)) +
    row('Performance ratio', s.pr, R.pr, (v) => pf(v, 2)) +
    row('Puissance crête (kWc)', s.pnom_kwc, R.pnom_kwc, (v) => nf(v, 1)) +
    row('GHI (kWh/m²)', s.glob_hor, sum(M.ghi), (v) => nf(v, 1)) +
    row('GlobInc (kWh/m²)', s.glob_inc, sum(M.globinc), (v) => nf(v, 1)) + '</table></div>';
  if (M.e_grid_kwh && M.e_grid_kwh.length === 12)
    h += `<div class="tblwrap" style="margin-top:10px"><table class="res"><tr><th>Mois</th>${MONTHS.map((m) => `<th>${m}</th>`).join('')}</tr>
      <tr><td>Outil (MWh)</td>${r.monthly.slice(0, 12).map((m) => `<td>${nf(m.e_grid, 1)}</td>`).join('')}</tr>
      <tr><td>PVsyst (MWh)</td>${M.e_grid_kwh.map((v) => `<td>${nf(v / 1000, 1)}</td>`).join('')}</tr>
      <tr><td>Écart</td>${M.e_grid_kwh.map((v, i) => `<td>${v ? pf(r.monthly[i].e_grid / (v / 1000) - 1, 0) : '–'}</td>`).join('')}</tr></table></div>`;
  box.innerHTML = h; box.hidden = false;
}

function fieldsTable(r) {
  const F = r.fields || []; if (!F.length) return '';
  return `<h3>Champs de toiture</h3><div class="tblwrap"><table class="res"><tr><th>Champ</th><th>Incl. / orient.</th><th>Calepinage</th><th>Module</th><th>kWc</th><th>Onduleurs</th><th>Masque proche</th><th>GlobInc<br>kWh/m²</th><th>Productible<br>kWh/kWc</th><th>PR</th><th>MWh</th></tr>` +
    F.map((f) => `<tr><td>${esc(f.name)}</td><td>${nf(f.tilt, 0)}° / ${nf(f.azimuth, 0)}°</td><td>${f.n_h} × ${f.n_v} (${f.n_modules} câblés)</td><td>${esc(f.module)}</td><td>${nf(f.pnom_kwc, 2)}</td><td>${f.n_inv} × ${esc(f.inverter)}</td><td>${f.near_mask ? nf(f.near_loss_pct, 2) + ' %' : '–'}</td><td>${nf(f.glob_inc, 1)}</td><td>${nf(f.yield_kwh_kwc, 1)}</td><td>${pf(f.pr, 1)}</td><td>${nf(f.e_grid_mwh, 2)}</td></tr>`).join('') +
    `<tr class="tot"><td>Total / moyenne pondérée</td><td></td><td>${nf(r.summary.n_modules)} modules</td><td></td><td>${nf(r.summary.pnom_kwc, 2)}</td><td>${nf(r.summary.n_inverters)}</td><td></td><td>${nf(r.summary.glob_inc, 1)}</td><td>${nf(r.summary.yield_kwh_kwc, 1)}</td><td>${pf(r.summary.pr, 1)}</td><td>${nf(r.summary.e_grid_mwh, 2)}</td></tr></table></div>`;
}
function shConfTable(r) {
  const L2 = r.shading_configs || []; if (!L2.length) return '';
  return `<h3>Configurations d'ombrage électrique</h3><div class="tblwrap"><table class="res"><tr><th>Configuration</th><th>Sous-chaînes en hauteur</th><th>Part des tables</th><th>Perte ombrage électrique</th><th>Productible kWh/kWc</th><th>PR</th><th>Contribution MWh</th></tr>` +
    L2.map((c, i) => `<tr><td>Config. ${i + 1}</td><td>${c.sub_in_height}${c.auto ? ' (auto)' : ''}</td><td>${nf(c.share, 2)} %</td><td>${nf(c.elec_loss_pct, 2)} %</td><td>${nf(c.yield_kwh_kwc, 1)}</td><td>${pf(c.pr, 1)}</td><td>${nf(c.e_grid_mwh, 1)}</td></tr>`).join('') +
    `<tr class="tot"><td>Moyenne pondérée</td><td></td><td>${nf(L2.reduce((a, c) => a + c.share, 0), 2)} %</td><td>${nf((r.losses.find((l) => l.label.startsWith('Ombrage électrique')) || {}).pct, 2)} %</td><td>${nf(r.summary.yield_kwh_kwc, 1)}</td><td>${pf(r.summary.pr, 1)}</td><td>${nf(r.summary.e_grid_mwh, 1)}</td></tr></table></div>`;
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
    options: { maintainAspectRatio: false, scales: { x: { min: -180, max: 180, ticks: { stepSize: 30 }, title: { display: true, text: 'Azimut (°) – 0 = Sud, Est < 0' }, grid: { color: '#eef1f4' } }, y: { min: 0, max: 75, title: { display: true, text: 'Hauteur (°)' }, grid: { color: '#eef1f4' } } }, plugins: { legend: { position: 'bottom' } } } });
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
    <tr><td>Recalage</td><td>${r.meteo_correction ? `${esc(r.meteo_ref || 'Global Solar Atlas')}, ${r.config.meteo.gsa_mode === 'monthly' ? 'mensuel' : 'annuel'}` + (r.config.meteo.gsa_align_temp ? ' + température' : '') : 'aucun'}</td></tr></table>`;
  if (r.meteo_correction) {
    const mc = r.meteo_correction, sm = (k) => mc.reduce((a, b) => a + (b[k] || 0), 0);
    h += `<h3 style="margin-top:16px">Recalage du TMY sur ${esc(r.meteo_ref || 'Global Solar Atlas')}</h3><div class="tblwrap"><table class="res"><tr><th>Mois</th><th>GHI TMY</th><th>GHI réf.</th><th>GHI corrigé</th><th>DIF TMY</th><th>DIF réf.</th><th>DIF corrigé</th><th>k direct</th><th>k diffus</th><th>T moy.</th><th>h écrêtées</th></tr>` +
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
    ['Faible éclairement', (() => {
      const m = c.module && c.module.lowlight_cal, pts = pan.lowlight && pan.lowlight.length > 1;
      const applied = pan.lowlight_applied ?? (pts && (m === 'force' || (m !== 'off' && m !== false && pan.lowlight_measured)));
      if (applied) return 'calé sur le .PAN' + (m === 'force' ? ' (forcé)' : ' (mesures)') + ' : ' + pan.lowlight.filter(([g]) => g !== 1000).map(([g, v]) => `${nf(g, 0)} W/m² ${v > 0 ? '+' : ''}${nf(v, 2)} %`).join(' · ');
      if (m === 'off' || m === false) return 'modèle à une diode non calé (désactivé)';
      return pts ? 'modèle à une diode non calé (.PAN sans jeu de mesures)' : 'modèle à une diode non calé (aucun point dans le .PAN)';
    })()],
    ['Coefficients T°', `μIsc ${nf(pan.mu_isc * 1000, 2)} mA/°C · μVoc ${nf(pan.mu_voc, 1)} mV/°C`],
    ['Champ', r.fields ? `${nf(s.n_modules)} modules sur ${r.fields.length} toit(s) · ${nf(s.pnom_kwc, 2)} kWc (détail par champ dans la synthèse)` : `${nf(s.n_modules)} modules · ${c.array.n_series} en série × ${c.array.n_strings} chaînes · ${nf(s.pnom_kwc, 1)} kWc`],
    ['Bifacialité retenue', s.bifaciality ? nf(s.bifaciality, 2) : 'non'],
    ['Onduleur', `${esc(ond.manufacturer)} ${esc(ond.model)}`],
    ['Puissance onduleur', `Pnom ${nf(ond.pnom / 1000)} kW à ${nf(ond.t_pnom)} °C · Pmax ${nf(ond.pmax / 1000)} kW à ${nf(ond.t_pmax)} °C · offset ${nf(c.inverters.t_offset, 1)} °C`],
    ['Groupes', r.fields ? r.fields.map((f) => `${esc(f.name)} : ${f.n_inv} × ${f.n_str} chaînes de ${f.n_series}`).join(' · ') + ` · DC/AC ${nf(s.dc_ac, 2)}` : c.inverters.groups.map(([a, b]) => `${a} × ${b} chaînes`).join(' + ') + ` · DC/AC ${nf(s.dc_ac, 2)}`],
    ['Plage MPPT / Vmax / Imax DC', `${nf(ond.vmin)}–${nf(ond.vmax)} V · ${nf(ond.vabsmax)} V · ${nf(ond.imax_dc)} A`],
    ['Tension MPP moyenne', `${nf(s.vmpp_mean)} V`]])}</div><div>${kv([
    ['Structure', r.fields ? 'Toiture : ' + r.fields.map((f) => `${esc(f.name)} ${nf(f.tilt, 0)}° / ${nf(f.azimuth, 0)}°, zone ${nf(f.length, 2)} × ${nf(f.height, 2)} m, ${f.orientation === 'landscape' ? 'paysage' : 'portrait'} ${f.n_h} × ${f.n_v}`).join(' · ') : { fixed: `Sheds fixes ${c.structure.tilt}° / azimut ${c.structure.azimuth}°`, tracker: `Tracker mono-axe, axe ${c.structure.axis_azimuth}°, ±${c.structure.max_angle}°, ${c.structure.backtrack ? 'avec' : 'sans'} backtracking`, ew: `Est-Ouest ${c.structure.tilt}°, faîtage ${c.structure.azimuth}° : ${ewFaces(c.structure.azimuth)}` }[c.structure.type]],
    ['Géométrie', r.fields ? 'plan unique par champ, sans ombrage entre rangées ; tout ce qui est derrière le plan des modules est masqué' : `entraxe ${c.structure.pitch} m · largeur ${c.structure.width} m · GCR ${pf(s.gcr, 1)}${s.limit_angle != null ? ` · angle limite ${nf(s.limit_angle, 1)}°` : ''} · ${c.structure.n_rows} rangées`],
    ['Ombrage électrique', r.fields ? `${c.structure.elec_effect} %` : `${c.structure.elec_effect} % · ` + (r.shading_configs || []).map((x) => `${x.sub_in_height} sous-chaînes en hauteur sur ${nf(x.share, 2)} % des tables`).join(' + ')],
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
const baseName = () => `${S.cfg.project.name || 'projet'}_${S.cfg.project.variant || ''}`.replace(/[^\w\-]+/g, '_');
$('#expXlsx').addEventListener('click', async () => {
  setStatus('Génération du classeur Excel…', 'busy', 60);
  try { const bytes = await call('xlsx'); download(baseName() + '_productible.xlsx', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); setStatus('Classeur Excel exporté.', 'ok', 100); }
  catch (e) { setStatus('Export Excel impossible : ' + e.message, 'err', 100); }
});
$('#expCsv').addEventListener('click', async () => { const t = await call('csv'); download(baseName() + '_horaire.csv', new Blob(['﻿' + t], { type: 'text/csv' })); });
$('#expJson').addEventListener('click', saveProject);
$('#btnSave').addEventListener('click', saveProject);
function saveProject() {
  const data = { app: 'calcul-productible', version: 1, saved: new Date().toISOString(), cfg: S.cfg, files: S.files, names: S.names, gsa: S.gsa, mdb: S.mdb, pvsyst: S.pvsyst,
    lib: { pan: S.lib.pan.map(({ name, text }) => ({ name, text })), ond: S.lib.ond.map(({ name, text }) => ({ name, text })) }, near: S.near };
  download(baseName() + '.json', new Blob([JSON.stringify(data)], { type: 'application/json' }));
}
$('#openProject').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { loadProject(JSON.parse(await f.text())); } catch (err) { setStatus('Ouverture impossible : ' + err.message, 'err', 100); }
  e.target.value = '';
});
function loadProject(d) {
  if (d.app !== 'calcul-productible') throw new Error('fichier projet non reconnu');
  resetView();
  S.cfg = migrate(d.cfg); S.files = d.files || {}; S.names = d.names || {}; S.gsa = d.gsa || null; S.mdb = d.mdb || null; S.pvsyst = d.pvsyst || null; S.info = {}; S.res = null; S.check = null;
  S.lib = { pan: (d.lib && d.lib.pan) || [], ond: (d.lib && d.lib.ond) || [] }; S.near = d.near || {}; if (S.ready) parseLib();
  fillForm(); syncStrings(); save(); refreshAll();
  setStatus(`Projet « ${S.cfg.project.name} – ${S.cfg.project.variant} » ouvert.` + (d.note ? ' ' + d.note : ''), 'ok', 100);
}
// Efface tout ce qui reste affiché du projet précédent (résultats, graphiques, champs libres, repère sur la carte).
function resetView() {
  $('#results').hidden = true; $('#extractResults').hidden = true; S.ext = null; S.exFile = null; closeExtractCard();
  Object.values(S.charts).forEach((c) => c.destroy()); S.charts = {};
  ['#tiles', '#tblMonthly', '#pvsystCmp', '#shResults', '#fieldsResults', '#lossList', '#meteoBox', '#p90Box', '#hypBox', '#report'].forEach((q) => { const e = $(q); if (e) e.innerHTML = ''; });
  $$('#form input[type=file]').forEach((i) => (i.value = ''));
  const gp = $('#gsaPaste'); if (gp) gp.value = '';
  $$('#form .hint[id^="info-"]').forEach((e) => { e.textContent = ''; e.style.color = ''; });
  if (marker) { marker.remove(); marker = null; }
  if (map) map.setView([46.6, 2.4], 5);
}
$('#btnNew').addEventListener('click', () => {
  if (!confirm('Repartir d\'un projet vierge ? Les saisies et fichiers actuels seront effacés.')) return;
  resetView();
  S.cfg = clone(DEFAULTS); S.files = {}; S.names = {}; S.gsa = null; S.mdb = null; S.pvsyst = null; S.info = {}; S.res = null; S.check = null; S.lib = { pan: [], ond: [] }; S.near = {};
  fillForm(); syncStrings(); save(); refreshAll();
  $$('details.sec').forEach((d) => (d.open = d.id === 'sec-project' || d.id === 'sec-site'));
  setStatus('Nouveau projet : renseigner le site, déposer les fichiers puis lancer la simulation.', 'ok', 100);
});
$('#toggleSide').addEventListener('click', () => $('#side').classList.toggle('hide'));
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
  Object.values(S.charts).forEach((c) => c.resize());
}));

// ------------------------------------------------------------------ vues aériennes du rapport (IGN, WMS)
const ROOF_COLORS = ['#f2a20c', '#4fc3f7', '#e5484d', '#46a758', '#8e4ec6', '#f76b15', '#12a594', '#d6409f'];
function merc(lat, lon) { const R = 6378137; return [R * lon * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))]; }
// Image aérienne centrée sur (lat, lon), largeur au sol widthM ; draw(ctx, px) dessine par-dessus (px : [lat, lon] -> pixels)
function aerialImage(lat, lon, widthM, W, H, draw) {
  const k = 1 / Math.cos(lat * Math.PI / 180), [cx, cy] = merc(lat, lon);
  const hw = widthM * k / 2, hh = hw * H / W;
  const bbox = [cx - hw, cy - hh, cx + hw, cy + hh];
  const url = 'https://data.geopf.fr/wms-r?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ORTHOIMAGERY.ORTHOPHOTOS&STYLES=&CRS=EPSG:3857'
    + `&BBOX=${bbox.join(',')}&WIDTH=${W}&HEIGHT=${H}&FORMAT=image/jpeg`;
  const px = ([la, lo]) => { const [x, y] = merc(la, lo); return [(x - bbox[0]) / (bbox[2] - bbox[0]) * W, (bbox[3] - y) / (bbox[3] - bbox[1]) * H]; };
  return new Promise((resolve) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    const t = setTimeout(() => resolve(null), 15000);
    img.onload = () => {
      clearTimeout(t);
      try {
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, W, H); draw(ctx, px);
        // échelle graphique
        const mpp = widthM / W, nice = [5, 10, 20, 25, 50, 100, 200, 250, 500].find((v) => v / mpp > W / 7) || 500, len = nice / mpp;
        ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(10, H - 30, len + 50, 22);
        ctx.fillStyle = '#18212b'; ctx.fillRect(16, H - 16, len, 4); ctx.font = '600 12px Inter, sans-serif'; ctx.fillText(`${nice} m`, len + 22, H - 13);
        ctx.font = '11px Inter, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(W - 128, H - 20, 128, 20);
        ctx.fillStyle = '#18212b'; ctx.fillText('© IGN – Géoplateforme', W - 122, H - 6);
        // nord
        ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(W - 24, 26, 16, 0, 7); ctx.fill();
        ctx.fillStyle = '#18212b'; ctx.beginPath(); ctx.moveTo(W - 24, 13); ctx.lineTo(W - 30, 30); ctx.lineTo(W - 18, 30); ctx.fill();
        ctx.font = '700 10px Inter, sans-serif'; ctx.fillText('N', W - 27.5, 40);
        resolve(cv.toDataURL('image/jpeg', 0.88));
      } catch (e) { resolve(null); }
    };
    img.onerror = () => { clearTimeout(t); resolve(null); };
    img.src = url;
  });
}
function siteAerial(c) {
  return aerialImage(c.site.lat, c.site.lon, 320, 1000, 520, (ctx, px) => {
    const [x, y] = px([c.site.lat, c.site.lon]);
    ctx.fillStyle = '#f2a20c'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x - 14, y - 20, x - 14, y - 38, x, y - 38); ctx.bezierCurveTo(x + 14, y - 38, x + 14, y - 20, x, y); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#18212b'; ctx.beginPath(); ctx.arc(x, y - 27, 5, 0, 7); ctx.fill();
  });
}
function roofsAerial(c) {
  const F = (c.structure.fields || []).map((f, i) => ({ f, i })).filter(({ f }) => f.geom && f.geom.length === 4);
  if (!F.length) return Promise.resolve(null);
  const pts = F.flatMap(({ f }) => f.geom);
  const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length, lon0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const xs = pts.map((p) => (p[1] - lon0) * Math.cos(lat0 * Math.PI / 180) * 111320), ys = pts.map((p) => (p[0] - lat0) * 110540);
  const W = 1000, H = 560;
  const span = Math.max(30, (Math.max(...xs) - Math.min(...xs)) * 1.5, (Math.max(...ys) - Math.min(...ys)) * 1.5 * W / H);
  const latc = lat0 + (Math.max(...ys) + Math.min(...ys)) / 2 / 110540, lonc = lon0 + (Math.max(...xs) + Math.min(...xs)) / 2 / (Math.cos(lat0 * Math.PI / 180) * 111320);
  return aerialImage(latc, lonc, span, W, H, (ctx, px) => {
    F.forEach(({ f, i }) => {
      const col = ROOF_COLORS[i % ROOF_COLORS.length], q = f.geom.map(px);
      ctx.fillStyle = col + '55'; ctx.strokeStyle = col; ctx.lineWidth = 3;
      ctx.beginPath(); q.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill(); ctx.stroke();
      // flèche vers le bas de pente (face des modules)
      const m = [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2], top = [(q[2][0] + q[3][0]) / 2, (q[2][1] + q[3][1]) / 2];
      const cxy = [(m[0] + top[0]) / 2, (m[1] + top[1]) / 2];
      const d = [m[0] - top[0], m[1] - top[1]], l = Math.hypot(d[0], d[1]) || 1, u = [d[0] / l, d[1] / l], a = Math.min(26, l * 0.35);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cxy[0] - u[0] * a, cxy[1] - u[1] * a); ctx.lineTo(cxy[0] + u[0] * a, cxy[1] + u[1] * a); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.beginPath(); const tip = [cxy[0] + u[0] * (a + 8), cxy[1] + u[1] * (a + 8)];
      ctx.moveTo(tip[0], tip[1]); ctx.lineTo(tip[0] - u[0] * 12 - u[1] * 7, tip[1] - u[1] * 12 + u[0] * 7); ctx.lineTo(tip[0] - u[0] * 12 + u[1] * 7, tip[1] - u[1] * 12 - u[0] * 7); ctx.fill();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cxy[0] - u[0] * (a + 14), cxy[1] - u[1] * (a + 14), 13, 0, 7); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#18212b'; ctx.font = '700 13px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), cxy[0] - u[0] * (a + 14), cxy[1] - u[1] * (a + 14)); ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    });
  });
}
function roofsLegend(r, c) {
  const F = r.fields || [];
  return `<table class="legend"><tr><th></th><th>Champ</th><th>Inclinaison / orientation</th><th>Zone (selon la pente)</th><th>Calepinage</th><th>kWc</th><th>Productible</th></tr>` +
    F.map((f, i) => { const g = (c.structure.fields[i] || {}).geom; return `<tr><td><span class="sw" style="background:${ROOF_COLORS[i % ROOF_COLORS.length]}">${i + 1}</span></td><td>${esc(f.name)}${g ? '' : ' <i>(non relevé sur la vue aérienne)</i>'}</td><td>${nf(f.tilt, 0)}° / ${nf(f.azimuth, 0)}°</td><td>${nf(f.length, 2)} × ${nf(f.height, 2)} m</td><td>${f.n_h} × ${f.n_v}</td><td>${nf(f.pnom_kwc, 2)}</td><td>${nf(f.yield_kwh_kwc, 0)} kWh/kWc</td></tr>`; }).join('') +
    `</table><p class="cap">Les flèches indiquent la direction vers laquelle les modules sont orientés (bas de pente).</p>`;
}

$('#expPdf').addEventListener('click', async () => {
  const r = S.res, s = r.summary, c = r.config, p = r.p90;
  setStatus('Préparation du rapport (vues aériennes)…', 'busy', 60);
  const [siteImg, roofImg] = await Promise.all([siteAerial(c), r.fields ? roofsAerial(c) : Promise.resolve(null)]);
  setStatus('Rapport prêt : boîte de dialogue d\'impression.', 'ok', 100);
  const aerialSite = siteImg ? `<figure class="aerial"><img src="${siteImg}"><figcaption>Vue aérienne du site (${nf(c.site.lat, 5)} °N / ${nf(c.site.lon, 5)} °E)</figcaption></figure>`
    : '<p class="cap">Vue aérienne indisponible (hors couverture IGN ou réseau).</p>';
  const aerialRoofs = !r.fields ? '' : roofImg ? `<div class="keep"><h2>Implantation des toits</h2><figure class="aerial roofs"><img src="${roofImg}"></figure>${roofsLegend(r, c)}</div>`
    : `<h2>Implantation des toits</h2><p class="cap">Aucun toit relevé sur la vue aérienne (bouton « Vue aérienne » de chaque toit).</p>${roofsLegend(r, c)}`;
  const img = (id) => { const ch = S.charts[id]; return ch ? `<img src="${ch.toBase64Image('image/png', 1)}">` : ''; };
  // forcer le rendu des graphiques cachés
  $$('.tab').forEach((t) => t.classList.add('on')); Object.values(S.charts).forEach((ch) => { ch.resize(); ch.update('none'); });
  const kv = (rows) => `<table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
  const html = `<h1>${esc(c.project.name)} – ${esc(c.project.variant)}</h1>
    <div class="sub">Rapport de simulation de productible · ${new Date().toLocaleDateString('fr-FR')}${c.project.author ? ' · ' + esc(c.project.author) : ''} · moteur v${r.engine}, pvlib ${r.pvlib}</div>
    <div class="kpis"><div><b>${nf(s.yield_kwh_kwc, 0)}</b>kWh/kWc/an (P50)</div><div><b>${nf(s.e_grid_mwh, 0)}</b>MWh/an</div><div><b>${pf(s.pr, 1)}</b>PR</div><div><b>${nf(p.p90, 0)}</b>kWh/kWc (P90)</div></div>
    <h2>Site et système</h2><div class="cols"><div>${kv([['Site', `${nf(c.site.lat, 4)} °N / ${nf(c.site.lon, 4)} °E · ${nf(c.site.alt)} m`], ['Météo', `${esc(r.tmy_info.db || 'PVGIS')} ${esc(r.tmy_info.years || '')}${r.meteo_correction ? ' recalé ' + esc(r.meteo_ref || 'Global Solar Atlas') + ' (' + (c.meteo.gsa_mode === 'monthly' ? 'mensuel' : 'annuel') + ')' : ''}`], ['GHI / GlobInc', `${nf(s.glob_hor, 1)} / ${nf(s.glob_inc, 1)} kWh/m²`], ['Masque lointain', r.horizon ? 'oui' : 'non'], ['Structure', r.fields ? `Toiture, ${r.fields.length} champ(s)` : { fixed: `Sheds ${c.structure.tilt}° / ${c.structure.azimuth}°`, tracker: `Tracker ±${c.structure.max_angle}°`, ew: `Est-Ouest ${c.structure.tilt}° · ${ewFaces(c.structure.azimuth)}` }[c.structure.type] + ` · GCR ${pf(s.gcr, 1)}`]])}</div>
    <div>${kv([['Modules', r.fields ? [...new Set(r.fields.map((f) => f.module))].map(esc).join(', ') + ` · ${nf(s.n_modules)} modules` : `${nf(s.n_modules)} × ${esc(r.pan.model)} (${nf(r.pan.pnom)} Wc)`], ['Puissance DC', `${nf(s.pnom_kwc, 1)} kWc`], ['Onduleurs', r.fields ? `${s.n_inverters} : ` + [...new Set(r.fields.map((f) => f.inverter))].map(esc).join(', ') : `${s.n_inverters} × ${esc(r.ond.model)}`], ['Puissance AC', `${nf(s.pac_kva)} kVA · DC/AC ${nf(s.dc_ac, 2)}`], ['Bifacial', s.bifaciality ? 'oui, ' + nf(s.bifaciality, 2) : 'non']])}</div></div>
    ${aerialSite}
    <h2>Vérifications de dimensionnement</h2><table><tr><th>Vérification</th><th>Statut</th><th>Détail</th></tr>${r.alerts.map((a) => `<tr><td>${esc(a.title)}</td><td>${{ ok: 'OK', warn: 'Alerte', block: 'Bloquant' }[a.level]}</td><td>${esc(a.message)}</td></tr>`).join('')}</table>
    <h2>Résultats mensuels</h2>${img('chMonthly')}
    <table><tr><th>Mois</th><th>GHI</th><th>DIF</th><th>T amb</th><th>GlobInc</th><th>GlobEff</th><th>Arrière</th><th>E champ MWh</th><th>E injectée MWh</th><th>kWh/kWc</th><th>PR</th></tr>${r.monthly.map((m, i) => `<tr class="${i === 12 ? 'tot' : ''}"><td>${m.mois}</td><td>${nf(m.ghi, 1)}</td><td>${nf(m.dhi, 1)}</td><td>${nf(m.t_amb, 1)}</td><td>${nf(m.glob_inc, 1)}</td><td>${nf(m.glob_eff, 1)}</td><td>${nf(m.rear_inc, 1)}</td><td>${nf(m.e_array, 1)}</td><td>${nf(m.e_grid, 1)}</td><td>${nf(m.yield_, 1)}</td><td>${pf(m.pr, 1)}</td></tr>`).join('')}</table>
    <h2 class="pb">Diagramme de pertes</h2><table><tr><th>Poste</th><th>Variation</th><th>Valeur</th></tr>${r.losses.map((x) => `<tr${x.pct == null ? ' class="tot"' : ''}><td>${esc(x.label)}</td><td>${x.pct == null ? '' : (x.pct > 0 ? '+' : '') + nf(x.pct, 2) + ' %'}</td><td>${x.value == null ? '' : nf(x.value, 1) + ' ' + x.unit}</td></tr>`).join('')}</table>
    <h2>P50 / P90</h2><div class="cols"><div>${kv([['P50', `${nf(p.p50, 1)} kWh/kWc · ${nf(p.p50_mwh, 0)} MWh`], ['P75', `${nf(p.p75, 1)} kWh/kWc`], ['P90', `${nf(p.p90, 1)} kWh/kWc · ${nf(p.p90_mwh, 0)} MWh`], ['P99', `${nf(p.p99, 1)} kWh/kWc`], ['Incertitude combinée', `${nf(p.sigma_pct, 2)} %`], ['Variabilité météo', esc(p.meteo_var_source)]])}</div>
    <div><table><tr><th>Incertitude</th><th>σ</th></tr>${p.items.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${nf(b, 2)} %</td></tr>`).join('')}</table></div></div>
    ${r.meteo_correction ? `<h2>Recalage météo ${esc(r.meteo_ref || 'Global Solar Atlas')}</h2><table><tr><th>Mois</th><th>GHI TMY</th><th>GHI réf.</th><th>GHI corrigé</th><th>DIF TMY</th><th>DIF réf.</th><th>DIF corrigé</th></tr>${r.meteo_correction.map((m) => `<tr><td>${m.mois}</td><td>${nf(m.ghi_tmy, 1)}</td><td>${nf(m.ghi_cible, 1)}</td><td>${nf(m.ghi_corrige, 1)}</td><td>${nf(m.dif_tmy, 1)}</td><td>${nf(m.dif_cible, 1)}</td><td>${nf(m.dif_corrige, 1)}</td></tr>`).join('')}</table>` : ''}
    ${r.horizon ? `<h2>Masque lointain</h2>${img('chMask')}` : ''}
    ${r.fields ? '<h2>Champs de toiture</h2>' + fieldsTable(r).replace(/<h3>.*?<\/h3>/, '').replace(/<\/?div[^>]*>/g, '').replace('<table class="res">', '<table class="res wide">') + aerialRoofs : ''}
    ${(r.shading_configs || []).length > 1 ? '<h2>Ombrage électrique</h2>' + shConfTable(r).replace(/<h3>.*?<\/h3>/, '').replace(/<\/?div[^>]*>/g, '') : ''}
    <h2 class="pb">Hypothèses détaillées</h2><div class="hyp">${$('#hypBox').innerHTML.replace(/<h3>.*?<\/h3>/, '').replace(/class="two"/, 'class="stack"')}</div>
    <div class="foot">Calcul productible – simulation horaire pvlib (Perez, sheds 2D, modèle à une diode, courbes de rendement onduleur). Résultats indicatifs, à confronter à un logiciel de référence pour un usage contractuel. Crédits : pvlib (BSD 3-Clause), Pyodide (MPL 2.0) ; données PVGIS © Union européenne (JRC) et Global Solar Atlas 2.0 © Solargis / World Bank Group (CC BY 4.0) selon les fichiers utilisés.</div>`;
  $('#report').innerHTML = html;
  $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + $('#tabs button.on').dataset.tab));
  setTimeout(() => window.print(), 300);
});

// ------------------------------------------------------------------ persistance locale
// Projets enregistrés avant les configurations multiples : reprise du nombre de sous-chaînes saisi.
function migrate(raw) {
  const cfg = deepMerge(DEFAULTS, raw || {});
  const rs = (raw && raw.structure) || {};
  if (raw && raw.structure && !rs.az_convention) {
    const conv = (a) => (a == null ? a : ((((Number(a) - 180) % 360) + 540) % 360) - 180);
    cfg.structure.azimuth = rs.type === 'ew' ? 0 : conv(rs.azimuth ?? 180);
    cfg.structure.axis_azimuth = conv(rs.axis_azimuth ?? 180);
    cfg.structure.az_convention = 'sud0';
  }
  const ll = raw && raw.module && raw.module.lowlight_cal;
  if (ll === true || ll === undefined) cfg.module.lowlight_cal = 'auto'; else if (ll === false) cfg.module.lowlight_cal = 'off';
  const rm = (raw && raw.meteo) || {};
  if (rm.gsa_mode === 'none') { cfg.meteo.gsa_mode = 'monthly'; if (rm.use_gsa === undefined) cfg.meteo.use_gsa = false; }
  if (!Array.isArray(rs.shading_configs) || !rs.shading_configs.length) cfg.structure.shading_configs = [{ sub_in_height: rs.sub_in_height ?? null, share: 100 }];
  return cfg;
}
function save() { try { localStorage.setItem(STORE, JSON.stringify({ cfg: S.cfg, files: S.files, names: S.names, gsa: S.gsa, mdb: S.mdb, pvsyst: S.pvsyst, lib: { pan: S.lib.pan.map(({ name, text }) => ({ name, text })), ond: S.lib.ond.map(({ name, text }) => ({ name, text })) }, near: S.near })); } catch (e) { try { localStorage.setItem(STORE, JSON.stringify({ cfg: S.cfg, names: {}, files: {}, gsa: S.gsa })); } catch (e2) { /* stockage indisponible */ } } }
function load() {
  try { const d = JSON.parse(localStorage.getItem(STORE) || 'null'); if (d) { S.cfg = migrate(d.cfg); S.files = d.files || {}; S.names = d.names || {}; S.gsa = d.gsa || null; S.mdb = d.mdb || null; S.pvsyst = d.pvsyst || null; S.lib = { pan: (d.lib && d.lib.pan) || [], ond: (d.lib && d.lib.ond) || [] }; S.near = d.near || {}; } } catch (e) { /* ignore */ }
}

load(); buildForm(); fillForm(); syncStrings(); initMap(); refreshAll();

// ------------------------------------------------------------------ extrait météo mesuré (exploitation)
function simFiles() {
  const files = { pan: S.files.pan, ond: S.files.ond };
  if (S.cfg.structure.type === 'roof') {
    Object.assign(files, { pan_extra: S.lib.pan.map((x) => x.text), ond_extra: S.lib.ond.map((x) => x.text), near_masks: {} });
    S.cfg.structure.fields.forEach((f) => { if (S.near[f.id]) files.near_masks[String(f.id)] = S.near[f.id].text; });
  }
  return files;
}
function closeExtractCard() { const c = $('#extractCard'); if (c) { c.hidden = true; c.innerHTML = ''; } $('#btnExtract')?.classList.remove('on'); }
$('#btnExtract').addEventListener('click', () => {
  if (!$('#extractCard').hidden) return closeExtractCard();
  renderExtractCard();
  $('#btnExtract').classList.add('on');
  $('#extractCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
function renderExtractCard() {
  const e = S.cfg.extract = Object.assign(clone(DEFAULTS.extract), S.cfg.extract || {});
  const t = S.cfg.structure.type;
  const sensors = [['modules', t === 'tracker' ? 'Sur le tracker (plan des modules)' : t === 'roof' ? 'Plan du premier toit' : 'Plan des modules']];
  if (t === 'ew') { sensors[0] = ['modules', 'Pan Est']; sensors.push(['west', 'Pan Ouest']); }
  sensors.push(['horizontal', 'Horizontal (GHI)'], ['custom', 'Autre plan…']);
  const opt = (path, label, opts) => `<div class="fld"><label>${label}</label><select data-ex="${path}">${opts.map(([v, l]) => `<option value="${v}" ${String(e[path]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
  const c = $('#extractCard'); c.hidden = false;
  c.innerHTML = `<div class="head2"><div><h3>Simuler un extrait météo</h3>
      <p class="note" style="margin-top:4px">Fichier Excel ou CSV horodaté : GTI (ou GHI), diffus si disponible, température ambiante et, si possible, l'énergie mesurée. La simulation reprend toutes les saisies du projet ; elle démarre dès le dépôt du fichier.</p></div>
      <button type="button" class="x" id="exClose" title="Fermer">×</button></div>
    <div class="links dl"><a href="modele_extrait_meteo.xlsx" download>Télécharger le modèle de fichier météo vierge (.xlsx)</a></div>
    <div class="grid">
      ${opt('tz', 'Fuseau horaire des données', [['Europe/Paris', 'Heure légale française (été / hiver)'], ['UTC', 'UTC'], ['UTC+1', 'UTC+1 (heure d\'hiver toute l\'année)'], ['UTC+2', 'UTC+2']])}
      ${opt('stamp', 'Horodatage', [['start', 'Début de période'], ['end', 'Fin de période']])}
      ${opt('sensor', 'Plan du capteur GTI', sensors)}
      <div class="fld" data-exc ${e.sensor === 'custom' ? '' : 'hidden'}><label>Inclinaison capteur (°)</label><input type="number" step="any" data-ex="sensor_tilt" value="${e.sensor_tilt ?? ''}"></div>
      <div class="fld" data-exc ${e.sensor === 'custom' ? '' : 'hidden'}><label>Orientation capteur (0 = Sud, Est &lt; 0)</label><input type="number" step="any" data-ex="sensor_azimuth" value="${e.sensor_azimuth ?? ''}"></div>
      ${opt('meter', 'Production mesurée au', [['grid', 'Point d\'injection (compteur)'], ['inverter', 'Sortie des onduleurs (AC)']])}
    </div>
    <div class="drop ${S.exFile ? 'loaded' : ''}" id="exDrop"><span class="ico">${S.exFile ? '✓' : '⇪'}</span><div class="dtxt"><b>${S.exFile ? esc(S.exFile.name) : 'Déposer ou choisir le fichier météo'}</b>${S.exFile ? 'Cliquer pour changer de fichier ; modifier une option relance la simulation.' : '.xlsx, .xls ou .csv · pas de 10 min à 1 h'}</div>
      <input type="file" accept=".xlsx,.xlsm,.csv,.txt" hidden></div>`;
  $('#exClose').addEventListener('click', closeExtractCard);
  $$('#extractCard [data-ex]').forEach((el) => el.addEventListener('change', () => {
    const k = el.dataset.ex; e[k] = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
    $$('#extractCard [data-exc]').forEach((x) => (x.hidden = e.sensor !== 'custom'));
    save(); if (S.exFile && (k !== 'sensor' || e.sensor !== 'custom' || (e.sensor_tilt != null))) runExtract();
  }));
  const box = $('#exDrop'), input = $('input', box);
  box.addEventListener('click', () => input.click());
  input.addEventListener('change', () => input.files[0] && loadExtract(input.files[0]));
  box.addEventListener('dragover', (ev) => { ev.preventDefault(); box.classList.add('over'); });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', (ev) => { ev.preventDefault(); box.classList.remove('over'); ev.dataTransfer.files[0] && loadExtract(ev.dataTransfer.files[0]); });
}
async function loadExtract(file) {
  S.exFile = { name: file.name, data: new Uint8Array(await file.arrayBuffer()) };
  renderExtractCard(); runExtract();
}
async function runExtract() {
  if (!S.exFile) return;
  const b1 = $('#btnRun'), b2 = $('#btnExtract'); b1.disabled = true; b2.disabled = true;
  setStatus('Simulation de l\'extrait météo…', 'busy', 40);
  const t0 = performance.now();
  try {
    const res = await call('extract', { cfg: clone(S.cfg), files: simFiles(), data: S.exFile.data, name: S.exFile.name });
    if (res.blocked) { S.check = { alerts: res.alerts, sub_in_height: S.check?.sub_in_height }; renderAlerts(); setStatus('Simulation bloquée : voir les vérifications.', 'err', 100); return; }
    S.ext = res; S.res = null; $('#results').hidden = true;
    renderExtract();
    const x = res.extract.summary;
    setStatus(`Extrait simulé en ${nf((performance.now() - t0) / 1000, 1)} s · ${x.n_hours} h · ${nf(x.e_sim_kwh / 1000, 2)} MWh simulés` + (x.ratio != null ? ` · mesuré / simulé ${pf(x.ratio, 1)}` : ''), 'ok', 100);
  } catch (err) { setStatus('Extrait météo : ' + err.message, 'err', 100); }
  finally { renderChecklist((S.check && S.check.alerts) || []); }
}
function renderExtract() {
  const r = S.ext, X = r.extract, s = X.summary, has = s.e_meas_kwh != null;
  $('#extractResults').hidden = false; renderChecklist((S.check && S.check.alerts) || []);
  const unit = s.e_sim_kwh > 20000 ? ['MWh', 1000, 2] : ['kWh', 1, 0];
  $('#exTiles').innerHTML = [
    ['main', nf(s.e_sim_kwh / unit[1], unit[2]), `${unit[0]} simulés · ${s.n_days} j`],
    ['', has ? nf(s.e_meas_kwh / unit[1], unit[2]) : '–', `${unit[0]} mesurés`],
    ['pv', has ? pf(s.ratio, 1) : '–', 'Mesuré / simulé'],
    ['', has && s.ratio_ok != null ? pf(s.ratio_ok, 1) : '–', `Hors arrêts probables (${s.n_outage_h} h)`],
    ['', nf(s.gti_meas_kwh_m2, 1), `kWh/m² mesurés (${esc(s.sensor)})`],
    ['', s.pr_meas != null ? `${pf(s.pr_meas, 1)} / ${pf(s.pr_sim_ref, 1)}` : pf(s.pr_sim, 1), s.pr_meas != null ? 'PR mesuré / simulé' : 'PR simulé'],
  ].map(([c, v, l]) => `<div class="tile ${c}"><b>${v}</b><span>${l}</span></div>`).join('');
  const se = X.series;
  chart('chExtract', {
    data: { labels: se.t, datasets: [
      { type: 'line', label: 'Simulée (kWh/h)', data: se.sim.map((v) => Math.max(0, v)), borderColor: '#f2a20c', backgroundColor: '#f2a20c33', fill: true, pointRadius: 0, borderWidth: 1.5, yAxisID: 'y' },
      ...(has ? [{ type: 'line', label: 'Mesurée (kWh/h)', data: se.meas.map((v) => (v == null ? null : Math.max(0, v))), borderColor: '#18212b', pointRadius: 0, borderWidth: 1.5, spanGaps: false, yAxisID: 'y' }] : []),
      { type: 'line', label: 'Irradiance mesurée (W/m²)', data: se.gti, borderColor: '#4c4fe0', borderDash: [4, 3], pointRadius: 0, borderWidth: 1, yAxisID: 'y1' }] },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: { x: { ticks: { maxTicksLimit: 14, autoSkip: true }, grid: { display: false } }, y: { title: { display: true, text: 'kWh par heure' }, grid: { color: '#eef1f4' }, min: 0 },
        y1: { position: 'right', min: 0, title: { display: true, text: 'W/m²' }, grid: { display: false } } },
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => `${c.dataset.label} : ${nf(c.parsed.y, 1)}` } } } },
  });
  $('#exNote').textContent = `Période ${s.period_start} – ${s.period_end} (${s.tz}) · production mesurée : ${s.meter}.` + (s.n_outage_h ? ` ${s.n_outage_h} h d'arrêt probable (production mesurée < 5 % du simulé), soit ${nf(s.e_outage_kwh, 0)} kWh simulés.` : '');
  const D = X.daily;
  $('#exDaily').innerHTML = `<table class="res"><tr><th>Date</th><th>Irradiation<br>mesurée kWh/m²</th><th>GlobInc<br>simulé kWh/m²</th><th>T amb<br>°C</th><th>E simulée<br>kWh</th><th>E mesurée<br>kWh</th><th>Mesuré /<br>simulé</th><th>PR<br>mesuré</th><th>Heures<br>d'arrêt</th></tr>` +
    D.map((d) => `<tr><td>${d.date}</td><td>${nf(d.gti, 2)}</td><td>${nf(d.glob_inc, 2)}</td><td>${nf(d.t_amb, 1)}</td><td>${nf(d.e_sim, 0)}</td><td>${d.e_meas == null ? '–' : nf(d.e_meas, 0)}</td><td class="${d.ratio != null && d.ratio < 0.9 ? 'neg' : ''}">${d.ratio == null ? '–' : pf(d.ratio, 1)}</td><td>${d.pr_meas == null ? '–' : pf(d.pr_meas, 1)}</td><td>${d.outage_h || ''}</td></tr>`).join('') +
    `<tr class="tot"><td>Période</td><td>${nf(s.gti_meas_kwh_m2, 2)}</td><td>${nf(s.glob_inc_kwh_m2, 2)}</td><td>${nf(s.t_amb, 1)}</td><td>${nf(s.e_sim_kwh, 0)}</td><td>${has ? nf(s.e_meas_kwh, 0) : '–'}</td><td>${has ? pf(s.ratio, 1) : '–'}</td><td>${s.pr_meas == null ? '–' : pf(s.pr_meas, 1)}</td><td>${s.n_outage_h || ''}</td></tr></table>`;
  const I = X.info, cols = Object.entries(I.columns).map(([k, v]) => `${k} → « ${esc(v)} »`).join(' · ');
  $('#exInfo').innerHTML = `<table class="res kv">
    <tr><td>Fichier</td><td>${esc(S.exFile ? S.exFile.name : '')} · ${I.n_rows} lignes · pas de ${nf(I.step_min, 0)} min → ${I.n_hours} h</td></tr>
    <tr><td>Colonnes reconnues</td><td>${cols}</td></tr>
    <tr><td>Irradiance</td><td>${esc(s.method)} · capteur : ${esc(s.sensor)}</td></tr>
    <tr><td>Contrôle de la décomposition</td><td>GTI recalculé ${nf(s.gti_model_kwh_m2, 2)} kWh/m² pour ${nf(s.gti_meas_kwh_m2, 2)} mesurés</td></tr>
    <tr><td>Production mesurée</td><td>${has ? `${s.n_hours_meas} h renseignées · ${esc(s.meter)}` : 'absente du fichier : simulation seule'}</td></tr>
    <tr><td>Hypothèses propres à l'extrait</td><td>Masque lointain non appliqué (déjà vu par le capteur) · pas de recalage Global Solar Atlas · indisponibilité 0 % · autres pertes reprises du projet</td></tr>
    ${I.warnings.length ? `<tr><td>Remarques</td><td class="ex-warn">${I.warnings.map(esc).join(' ; ')}</td></tr>` : ''}
    <tr><td>Moteur</td><td>v${r.engine} · pvlib ${r.pvlib}</td></tr></table>`;
  const L = r.losses, maxAbs = Math.max(...L.filter((x) => x.pct != null).map((x) => Math.abs(x.pct)), 1);
  $('#exLosses').innerHTML = L.filter((x) => !/Masque lointain|Indisponibilit/.test(x.label)).map((x) => x.pct == null ? `<div class="loss lvl"><span>${esc(x.label)}</span><span></span><span></span><span class="val">${nf(x.value, 2)} ${x.unit}</span></div>`
    : `<div class="loss"><span>${esc(x.label)}</span><span class="pct ${x.pct < -0.005 ? 'neg' : x.pct > 0.005 ? 'pos' : ''}">${x.pct > 0 ? '+' : ''}${nf(x.pct, 2)} %</span><span class="bar2"><i class="${x.pct > 0 ? 'pos' : ''}" style="width:${Math.min(100, 100 * Math.abs(x.pct) / maxAbs)}%"></i></span><span class="val">${x.value == null ? '' : nf(x.value, 2) + ' ' + x.unit}</span></div>`).join('');
}
$('#exXlsx').addEventListener('click', async () => {
  setStatus('Génération du classeur Excel…', 'busy', 60);
  try { const bytes = await call('xlsx'); download(baseName() + '_extrait.xlsx', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); setStatus('Classeur Excel exporté.', 'ok', 100); }
  catch (e) { setStatus('Export Excel impossible : ' + e.message, 'err', 100); }
});
$('#exCsv').addEventListener('click', async () => { const t = await call('csv'); download(baseName() + '_extrait_horaire.csv', new Blob(['﻿' + t], { type: 'text/csv' })); });

// ------------------------------------------------------------------ import d'un rapport PVsyst (.pdf)
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
function loadScript(src) { return new Promise((ok, ko) => { const e = document.createElement('script'); e.src = src; e.onload = ok; e.onerror = () => ko(new Error('chargement de ' + src)); document.head.appendChild(e); }); }
$('#importPvsyst').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  setStatus('Lecture du rapport PVsyst…', 'busy', 30);
  try {
    if (!window.pdfjsLib) { await loadScript(PDFJS + 'pdf.min.js'); window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; }
    const pages = await PvsystImport.extractPages(window.pdfjsLib, new Uint8Array(await f.arrayBuffer()));
    const r = PvsystImport.parse(pages); r.file = f.name;
    showImport(r); setStatus('Rapport PVsyst lu : vérifier puis créer le projet.', 'ok', 100);
  } catch (err) { setStatus('Import PVsyst impossible : ' + err.message, 'err', 100); }
});
function showImport(r) {
  const st = r.structure, L = r.losses, B = r.bifacial, A = r.array, I = r.inverters, R = r.results;
  const T = { fixed: 'Sheds fixes', tracker: 'Tracker mono-axe', ew: 'Est-Ouest', roof: 'Toiture / plans fixes' }[st.type];
  const mt = (v, d = 2) => (v != null ? nf(v, d) + ' m' : '–');
  const geo = st.type === 'tracker' ? `axe ${nf(st.axis_azimuth ?? 0, 0)}°, ±${nf(st.max_angle, 0)}°${st.backtrack ? ', backtracking' : ''} · entraxe ${mt(st.pitch)} · largeur ${mt(st.width)} · axe à ${mt(st.axis_height)} · ${st.n_rows ?? '–'} rangées`
    : st.type === 'roof' ? (st.fields || []).map((f) => `${esc(f.name)} : ${nf(f.tilt, 0)}° / ${nf(f.azimuth, 0)}°, ${f.n_h} modules (${f.n_inv} ond. × ${f.n_str} ch. × ${f.n_series})`).join('<br>')
    : `${nf(st.tilt, 0)}° / ${st.type === 'ew' ? 'faîtage ' + nf(st.azimuth, 0) + '° (' + ewFaces(st.azimuth) + ')' : nf(st.azimuth, 0) + '°'} · entraxe ${mt(st.pitch)} · largeur ${mt(st.width)} · hauteur ${mt(st.height)} · ${st.n_rows ?? '–'} rangées`;
  const rows = [
    ['Site', `${esc(r.site.name || '')} · ${nf(r.site.lat, 4)} / ${nf(r.site.lon, 4)} · ${nf(r.site.alt, 0)} m · albédo ${nf(r.site.albedo, 2)}`],
    ['Structure', `${T} · ${geo}`],
    ['Ombrage électrique', st.type === 'roof' ? '–' : `${st.elec_effect != null ? st.elec_effect + ' %' : '–'}${st.sub_in_height ? ' · ' + st.sub_in_height + ' chaînes dans la largeur' : ''}`],
    ['Module', `${esc(r.module.manufacturer || '')} ${esc(r.module.model || '')} · ${nf(r.module.pnom, 0)} Wc${r.module.pan ? ' · ' + esc(r.module.pan) : ''}`],
    ['Champ', st.type === 'roof' ? `${nf(A.n_modules)} modules` : `${A.n_series} en série × ${A.n_strings} chaînes = ${nf(A.n_series * A.n_strings)} modules · ${nf(R.pnom_kwc, 1)} kWc`],
    ['Onduleurs', `${esc(r.inverter.manufacturer || '')} ${esc(r.inverter.model || '')} · ${I.n_inv} × ${nf(I.unit_kw, 0)} kW${I.groups ? ' · ' + I.groups.map((g) => g[0] + ' × ' + g[1] + ' ch.').join(' + ') : ''}${I.p_inj_kw ? " · limite d'injection " + nf(I.p_inj_kw) + ' kW' : ''}`],
    ['Bifacial', B.enabled ? `bifacialité ${nf(B.bifaciality, 2)} · albédo sol ${nf(B.albedo_ground, 2)} · ombrage ${nf(B.rear_shading, 1)} % · mismatch ${nf(B.rear_mismatch, 1)} % · transparence ${nf(B.transparent, 1)} %` : 'non'],
    ['Thermique, IAM', `Uc ${nf(r.thermal.uc, 1)} · Uv ${nf(r.thermal.uv, 1)} · ${esc(r.iam.text || '–')}`],
    ['Pertes DC', `salissure ${nf(L.soiling, 2)} % · LID ${nf(L.lid, 2)} % · qualité ${nf(L.quality, 2)} % · mismatch ${nf(L.mismatch, 2)} %${L.string_mismatch != null ? ' + ' + nf(L.string_mismatch, 2) + ' %' : ''} · ohmiques ${nf(L.dc_ohmic, 2)} %`],
    ['Pertes AC', `ohmiques ${nf(L.ac_ohmic, 2)} % · ligne HTA ${nf(L.mv_line ?? 0, 2)} %${L.tr_enabled ? ` · transfo ${nf(L.tr_sn_kva)} kVA (fer ${nf(L.tr_iron_kw, 2)} kW${L.tr_always_on ? ' 24 h/24' : ''}, cuivre ${nf(L.tr_cu_kw, 2)} kW)` : ' · sans transformateur'} · auxiliaires ${nf((L.aux_w || 0) / 1000, 2)} kW${L.aux_thresh_kw ? ' au-delà de ' + nf(L.aux_thresh_kw) + ' kW' : ''}, nuit ${nf((L.aux_night_w || 0) / 1000, 2)} kW · indisponibilité ${nf(L.availability, 2)} %`],
    ['Horizon', r.horizon ? `${r.horizon.length} points (hauteur max. ${nf(Math.max(...r.horizon.map((p) => p[1])), 1)}°)` : 'aucun profil dans le rapport'],
    ['Météo', `${esc(r.weather || '–')}${r.monthly && r.monthly.ghi ? ` · bilan mensuel GHI ${nf(r.monthly.ghi.reduce((a, b) => a + b, 0), 1)} kWh/m²` : ''}`],
    ['Résultats PVsyst', `${nf(R.yield_kwh_kwc, 0)} kWh/kWc/an · ${nf(R.e_grid_mwh, 0)} MWh/an · PR ${pf(R.pr, 2)}`],
  ];
  const todo = [...r.missing.map((m) => `Saisir : ${m}.`), ...r.notes];
  const files = ['TMY PVGIS du site (lien dans la section Météo une fois le projet créé)', `Module .PAN${r.module.pan ? ' : ' + esc(r.module.pan) : r.module.model ? ' : ' + esc(r.module.model) : ''}`, `Onduleur .OND${r.inverter.model ? ' : ' + esc(r.inverter.model) : ''}`];
  const m = $('#importModal');
  m.innerHTML = `<div class="imbox"><div class="rmhead"><b>Import PVsyst · ${esc(r.project || '')} – ${esc(r.variant || '')}</b><span class="note">PVsyst ${esc(r.version)} · ${esc(r.simdate || '')}</span><button type="button" class="rmx" id="imClose" title="Fermer">×</button></div>
    <div class="imbody"><h4>Informations retrouvées</h4><table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>
    ${todo.length ? `<h4>À vérifier ou compléter</h4><ul>${todo.map((t) => `<li class="warn">${esc(t)}</li>`).join('')}</ul>` : ''}
    <h4>Fichiers à déposer ensuite</h4><ul>${files.map((t) => `<li>${t}</li>`).join('')}</ul>
    <h4>Options</h4>
    ${r.monthly && r.monthly.ghi && r.monthly.dif ? '<label><input type="checkbox" id="imMdb" checked><span>Utiliser le bilan météo mensuel du rapport (GHI, DIF, température) comme base de recalage du TMY, à la place de Global Solar Atlas</span></label>' : ''}
    ${r.horizon ? `<label><input type="checkbox" id="imHz" checked><span>Reprendre le masque d'horizon du rapport (${r.horizon.length} points)</span></label>` : ''}
    <label><input type="checkbox" id="imRef" checked><span>Garder les résultats PVsyst pour les comparer à la simulation</span></label>
    <p class="note">Le projet en cours sera remplacé. Les pertes et hypothèses non décrites dans le rapport gardent les valeurs standard de l'outil.</p></div>
    <div class="imfoot"><button type="button" id="imCancel">Annuler</button><button type="button" class="primary" id="imApply">Créer le projet</button></div></div>`;
  m.hidden = false;
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  $('#imClose').onclick = close; $('#imCancel').onclick = close;
  $('#imApply').onclick = () => { const o = { mdb: !!($('#imMdb') && $('#imMdb').checked), hz: !!($('#imHz') && $('#imHz').checked), ref: $('#imRef').checked }; close(); applyImport(r, o); };
}
function applyImport(r, o) {
  resetView();
  S.cfg = clone(DEFAULTS); S.files = {}; S.names = {}; S.gsa = null; S.mdb = null; S.pvsyst = null; S.info = {}; S.res = null; S.check = null; S.lib = { pan: [], ond: [] }; S.near = {};
  const c = S.cfg, st = r.structure, def = (v, d) => (v == null ? d : v);
  Object.assign(c.project, { name: r.project || '', variant: r.variant || 'Var0' });
  Object.assign(c.site, { lat: r.site.lat, lon: r.site.lon, alt: r.site.alt, albedo: def(r.site.albedo, c.site.albedo) });
  c.structure.type = st.type;
  ['tilt', 'azimuth', 'pitch', 'width', 'height', 'n_rows', 'n_high', 'orientation', 'elec_effect', 'axis_azimuth', 'max_angle', 'backtrack', 'axis_height'].forEach((k) => { if (st[k] != null) c.structure[k] = st[k]; });
  if (st.shading_configs) c.structure.shading_configs = st.shading_configs;
  if (st.type === 'roof') {
    c.structure.elec_effect = 100;
    c.structure.fields = (st.fields || []).map((f, i) => Object.assign(newField(i + 1), f, { module: 0, inverter: 0 }));
  } else {
    c.array.n_series = r.array.n_series;
    if (r.inverters.groups) c.inverters.groups = r.inverters.groups;
  }
  c.inverters.p_inj_kw = r.inverters.p_inj_kw;
  c.bifacial.enabled = !!r.bifacial.enabled;
  ['albedo_ground', 'bifaciality', 'rear_shading', 'rear_mismatch', 'transparent'].forEach((k) => { if (r.bifacial[k] != null) c.bifacial[k] = r.bifacial[k]; });
  if (r.thermal.uc != null) c.thermal.uc = r.thermal.uc;
  if (r.thermal.uv != null) c.thermal.uv = r.thermal.uv;
  if (r.iam.mode === 'fresnel') Object.assign(c.iam, { mode: 'fresnel', n: r.iam.n, n_ar: def(r.iam.n_ar, c.iam.n_ar) });
  Object.entries(r.losses).forEach(([k, v]) => { if (v != null && k in c.losses) c.losses[k] = v; });
  if (o.hz && r.horizon) { S.files.horizon = 'Azimut;Hauteur\n' + r.horizon.map(([a, h]) => `${a};${h}`).join('\n') + '\n'; S.names.horizon = 'Horizon du rapport PVsyst'; c.horizon.use = true; }
  if (o.mdb && r.monthly) {
    const M = r.monthly, sum = (a) => a.reduce((p, q) => p + q, 0);
    S.mdb = { source: 'PVsyst' + (r.weather ? ' (' + r.weather.split(' – ').pop() + ')' : ''), ghi: M.ghi, dif: M.dif, temp: M.temp, ghi_year: sum(M.ghi), dif_year: sum(M.dif),
      temp_year: M.temp ? sum(M.temp) / 12 : null, site: r.site.name, lat: r.site.lat, lon: r.site.lon, report: r.file };
    S.names.mdb = 'Bilan mensuel du rapport PVsyst'; c.meteo.use_mdb = true; c.meteo.use_gsa = false;
  }
  if (o.ref) S.pvsyst = { file: r.file, project: r.project, variant: r.variant, version: r.version, simdate: r.simdate, weather: r.weather,
    module: r.module, inverter: r.inverter, results: r.results, monthly: r.monthly, losses_diagram: r.losses_diagram };
  fillForm(); syncStrings(); save(); refreshAll();
  if (st.type === 'roof') renderRoof();
  if (c.site.lat != null && c.site.lon != null && map) { placeMarker([c.site.lat, c.site.lon]); map.setView([c.site.lat, c.site.lon], 14); }
  $$('details.sec').forEach((d) => (d.open = ['sec-meteo', 'sec-module', 'sec-inverter'].includes(d.id)));
  setStatus(`Projet créé depuis le rapport PVsyst « ${r.project} – ${r.variant} ». Déposer le TMY PVGIS, le .PAN et le .OND, puis lancer la simulation.`, 'ok', 100);
}
