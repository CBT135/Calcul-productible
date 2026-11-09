/* Calcul productible PV – lecture d'un rapport de simulation PVsyst (PDF) pour pré-remplir un projet.
   Le texte est extrait avec pdf.js ; la mise en page PVsyst en colonnes (x ≈ 42, 222, 312, 402 pt) est
   reconstituée en « cellules » libellé + valeur, lues colonne par colonne. Fonctionne dans le navigateur
   (window.PvsystImport) et sous Node (module.exports), pour les tests. */
(function (root) {
  'use strict';
  const COLS = [42, 222, 312, 402];
  const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  // Rapports PVsyst en français : libellés ramenés à leur équivalent anglais avant la lecture
  const FR = [
    [/^Rapport de simulation/, 'Simulation report'], [/Simulé le\s*:/, 'Simulation date:'],
    [/^Projet\s*:/, 'Project:'], [/^Variante\s*:/, 'Variant:'], [/^Albédo$/, 'Albedo'],
    [/^Site géographique$/, 'Geographical Site'], [/^Données météo$/, 'Weather data'],
    [/^Sheds illimités$/, 'Unlimited sheds'], [/^Configuration des sheds$/, 'Sheds configuration'],
    [/^Trackers illimités/, 'Unlimited Trackers'], [/^(Suivi|Tracker)s?,? axe horizontal/i, 'Tracking horizontal axis'],
    [/^Azimut de l'axe/, 'Axis azimuth'], [/^Backtracking activé/, 'Backtracking activated'],
    [/^(Esp\. entre trackers|Espacement (des|entre) trackers|Pas des trackers)/, 'Tracker Spacing'], [/^Largeur (des )?trackers?/, 'Tracker width'],
    [/^Nbre de trackers/, 'Nb. of trackers'], [/^Hauteur de l'axe( au-dessus du sol)?/, 'Axis height above ground'],
    [/^Inclinaison\/Azimut/, 'Tilt/Azimuth'], [/^Inclinaison/, 'Tilt'], [/^Azimut(?!h)/, 'Azimuth'],
    [/^Nbre de sheds/, 'Nb. of sheds'], [/^Esp\. entre sheds/, 'Sheds spacing'], [/^Largeur capteurs/, 'Sensitive width'],
    [/^Largeur (des )?sheds/, 'Sheds width'], [/^Chaînes en largeur/, 'Strings in width'],
    [/^Effet électrique des ombrages/, 'Shadings electrical effect'], [/^Effet électrique/, 'Electrical effect'],
    [/^Hauteur au-dessus du sol/, 'Height above ground'], [/^Système bifacial/, 'Bifacial system'],
    [/^Albédo du sol/, 'Ground albedo'], [/^Facteur de bifacialité/, 'Bifaciality factor'],
    [/^Facteur d'ombrage (arrière|face arrière)/, 'Rear shading factor'], [/^Perte (de )?mismatch (arrière|face arrière)/, 'Rear mismatch loss'],
    [/^Fraction transparente( des sheds)?/, 'Shed transparent fraction'], [/^Puissance active/, 'Active power'],
    [/^Plan fixe/, 'Fixed plane'], [/Dôme/g, 'Dome'],
    [/^Module PV$/, 'PV module'], [/^Onduleur$/, 'Inverter'], [/^Fabricant/, 'Manufacturer'], [/^Modèle/, 'Model'],
    [/^Puissance unitaire/, 'Unit Nom. Power'], [/^Nombre de modules PV/, 'Number of PV modules'], [/^Nombre d'onduleurs/, 'Number of inverters'],
    [/^Nominale \(STC\)/, 'Nominal (STC)'], [/^Puissance PV totale/, 'Total PV power'], [/^Puissance totale onduleur/, 'Total inverter power'],
    [/^(Sous-)?[Cc]hamp #/, 'Array #'], [/^En série/, 'In series'], [/^Uv \(vent\)/, 'Uv (wind)'],
    [/^Encrassement du champ/, 'Array Soiling Losses'], [/^Frac\. pertes/, 'Loss Fraction'], [/^LID\b.*$/i, 'LID - Light Induced Degradation'],
    [/^Perte de qualité module/, 'Module Quality Loss'], [/^Pertes de mismatch modules/, 'Module mismatch losses'],
    [/^Perte de "?mismatch"? (strings|chaînes)/, 'Strings Mismatch loss'], [/^Pertes câblage DC/, 'DC wiring losses'],
    [/^Rés(\.|istance) globale (de )?câblage/, 'Global wiring resistance'],
    [/^Effet d'incidence \(IAM\)\s*:/, 'Incidence effect (IAM):'], [/anti-reflets/, 'AR coating'], [/n\(verre\)/, 'n(glass)'],
    [/^constante \(ventilateurs\)/, 'constant (fans)'], [/kW depuis seuil de puissance/, 'kW from Power thresh.'], [/^Conso\. aux\. nocturne/, 'Night aux. cons.'],
    [/^Pertes câblage AC/, 'AC wiring losses'], [/^Sortie ond\./, 'Inv. output line'], [/^Ligne MT/, 'MV line'],
    [/^Pertes AC dans les transformateurs/, 'AC losses in transformers'], [/^Transfo MT/, 'MV transfo'],
    [/^Puissance nominale aux STC/, 'Nominal power at STC'], [/^Perte fer/, 'Iron Loss'], [/^Perte cuivre/, 'Copper loss'],
    [/^Indisponibilité du système/, 'Unavailability of the system'], [/^Fraction de temps/, 'Time fraction'],
    [/^Hauteur \[°\]/, 'Height [°]'], [/^Hauteur moyenne/, 'Average Height'],
    [/^Energie produite/, 'Produced Energy'], [/^Productible$/, 'Specific production'], [/^Indice perf\. PR/, 'Perf. Ratio PR'],
    [/^Indice perf\. bifacial/, 'Bifacial perf. ratio'], [/^Pas d'ombrages/, 'no Shadings'],
    [/kWh\/kWc\/an/g, 'kWh/kWp/year'], [/(k|M|G)Wh\/an/g, '$1Wh/year'], [/\b(k|M)Wc\b/g, '$1Wp'], [/\bWc\b/g, 'Wp'],
  ];
  const fr = (s) => FR.reduce((t, [re, to]) => t.replace(re, to), s);

  async function extractPages(pdfjsLib, data) {
    const doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push(tc.items.filter((i) => i.str && i.str.trim() && !/^PVsyst TRIAL$/i.test(i.str.trim()))
        .map((i) => ({ s: fr(i.str.replace(/\s+/g, ' ').trim()), x: i.transform[4], y: i.transform[5] })));
    }
    return pages;
  }

  // lignes (même ordonnée) puis cellules : une cellule commence sur un départ de colonne
  function structure(pages) {
    const lines = [], cells = [];
    pages.forEach((items, pi) => {
      const L = [];
      items.slice().sort((a, b) => b.y - a.y || a.x - b.x).forEach((i) => {
        const l = L.find((q) => Math.abs(q.y - i.y) < 2.5); if (l) l.it.push(i); else L.push({ y: i.y, it: [i] });
      });
      L.sort((a, b) => b.y - a.y).forEach((l) => {
        l.it.sort((a, b) => a.x - b.x);
        lines.push({ page: pi + 1, text: l.it.map((i) => i.s).join(' '), it: l.it });
        let cur = null;
        l.it.forEach((i) => {
          const c = COLS.findIndex((x) => Math.abs(i.x - x) < 4);
          if (c >= 0 || !cur) { cur = { page: pi + 1, col: c >= 0 ? c : COLS.reduce((b, x, k) => (i.x >= x - 4 ? k : b), 0), y: l.y, parts: [i.s] }; cells.push(cur); }
          else cur.parts.push(i.s);
        });
      });
    });
    cells.forEach((c) => (c.text = c.parts.join(' ').replace(/\s+/g, ' ').trim()));
    return { lines, cells, text: lines.map((l) => l.text).join('\n') };
  }

  const num = (s) => { if (s == null) return null; const m = String(s).replace(/ /g, ' ').match(/[-+]?\d[\d ]*(?:[.,]\d+)?/); return m ? Number(m[0].replace(/ /g, '').replace(',', '.')) : null; };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function parse(pages) {
    const { lines, cells, text } = structure(pages);
    const out = { notes: [], missing: [], found: [] };
    const re1 = (re) => { const m = text.match(re); return m ? m : null; };
    // première cellule dont le texte commence par le libellé ; valeur = reste de la cellule
    const cell = (label, from = 0, col = null) => {
      const r = new RegExp('^' + (typeof label === 'string' ? esc(label) : label.source) + '\\s*(.*)$', 'i');
      for (let k = from; k < cells.length; k++) { const c = cells[k]; if ((col == null || c.col === col) && r.test(c.text)) return { k, c, v: c.text.match(r)[1] }; }
      return null;
    };
    const val = (label, from, col) => { const r = cell(label, from, col); return r ? num(r.v) : null; };
    // cellule « libellé » qui suit l'en-tête de section, dans la même colonne
    const under = (header, label, span = 6) => {
      const h = cell(header); if (!h) return null;
      const r = new RegExp('^' + esc(label) + '\\s*(.*)$', 'i');
      let n = 0;
      for (let k = h.k + 1; k < cells.length && n < span * 4; k++) {
        const c = cells[k]; if (c.page !== h.c.page && c.page !== h.c.page + 1) break;
        if (c.col !== h.c.col) continue; n++;
        if (r.test(c.text)) return num(c.text.match(r)[1]);
      }
      return null;
    };
    const has = (re) => re.test(text);

    // ---- identité
    let m;
    out.version = (m = re1(/PVsyst V([\d.]+)/)) ? m[1] : null;
    out.project = (m = re1(/Project:\s*(.+)/)) ? m[1].trim() : null;
    out.variant = (m = re1(/Variant:\s*(.+)/)) ? m[1].trim() : null;
    out.simdate = (m = re1(/Simulation date:\s*\n?\s*([\d/]+ [\d:]+)/)) ? m[1] : null;
    if (!out.version || !/Simulation report|Simulation date/i.test(text)) throw new Error("ce PDF n'est pas un rapport de simulation PVsyst");

    // ---- site
    const lat = re1(/Latitude\s+([-\d.,]+)\s*°\s*\((N|S)\)/), lon = re1(/Longitude\s+([-\d.,]+)\s*°\s*\((E|W)\)/);
    out.site = {
      lat: lat ? num(lat[1]) * (lat[2] === 'S' ? -1 : 1) : null, lon: lon ? num(lon[1]) * (lon[2] === 'W' ? -1 : 1) : null,
      alt: val('Altitude'), albedo: val(/Albedo(?! Factor| Fraction)/),
    };
    const gs = cell('Geographical Site'); if (gs) { const n = cells.slice(gs.k + 1).find((c) => c.col === gs.c.col); out.site.name = n ? n.text : null; }
    const wd = cell('Weather data'); if (wd) { const n = cells.slice(wd.k + 1).filter((c) => c.col === wd.c.col).slice(0, 2).map((c) => c.text); out.weather = n.join(' – '); }

    // ---- structure
    const st = {}; out.structure = st;
    const tiltAz = [...text.matchAll(/Tilt\/Azimuth\s+(-?[\d.]+)\s*\/\s*(-?[\d.]+)\s*°/g)].map((x) => [Number(x[1]), Number(x[2])]);
    if (/Unlimited Trackers|Tracking horizontal axis|Single axis/i.test(text)) {
      st.type = 'tracker';
      st.axis_azimuth = val('Axis azimuth');
      const phi = re1(/Phi min \/ max\.?\s*-?\/?\+?\s*(-?[\d.]+)/); st.max_angle = phi ? Math.abs(Number(phi[1])) : null;
      st.backtrack = /Backtracking activated|with backtracking/i.test(text);
      st.pitch = val('Tracker Spacing') ?? val('Pitch');
      st.width = val('Sensitive width') ?? val('Tracker width');
      st.axis_height = val('Axis height above ground');
      st.n_rows = val('Nb. of trackers') ?? val('Nb. of sheds');
      if (/Axis Tilt\s+[1-9]/i.test(text) || /Tilted axis/i.test(text)) out.notes.push("Tracker à axe incliné : l'outil ne modélise que l'axe horizontal.");
    } else if (/Unlimited sheds|Sheds configuration/i.test(text)) {
      st.type = 'fixed';
      st.tilt = val(/Tilt(?!\/)/); st.azimuth = val(/Azimuth(?!\s*\[)/);
      if ((st.tilt == null || st.azimuth == null) && tiltAz.length) [st.tilt, st.azimuth] = tiltAz[0];
      st.pitch = val('Sheds spacing'); st.width = val('Sensitive width') ?? val('Sheds width');
      st.height = val('Height above ground'); st.n_rows = val('Nb. of sheds');
    } else if (/Dome|East-West|Est-Ouest/i.test(text) && tiltAz.length >= 2) {
      st.type = 'ew';
      const [[t1, a1], [, a2]] = tiltAz; st.tilt = t1;
      let o = Math.abs(Math.abs(a1 - a2) - 180) < 2 ? (a1 + a2) / 2 : a1 - 90; o = ((((o + 180) % 360) + 360) % 360) - 180;
      st.azimuth = Math.round(o * 10) / 10;
      st.pitch = val('Sheds spacing') ?? val('Pitch'); st.width = val('Sensitive width'); st.height = val('Height above ground');
      if (st.pitch == null) out.notes.push("Est-Ouest sans scène 3D dans PVsyst : l'entraxe, la largeur et la hauteur des chapelles sont à saisir.");
    } else {
      st.type = 'roof';
    }
    const siw = val('Strings in width');
    if (siw) { st.sub_in_height = siw; st.shading_configs = [{ sub_in_height: siw, share: 100 }]; }
    const ee = re1(/Electrical effect\s+([\d.]+)\s*%/i) || re1(/Fraction for electrical effect\s+([\d.]+)/i);
    if (ee) st.elec_effect = Number(ee[1]);
    else if (/electrical effect/i.test(text) && !/no Shadings/i.test(text)) st.elec_effect = 100;
    if (st.elec_effect && !siw && st.type !== 'roof') out.notes.push('Nombre de chaînes dans la largeur des tables absent du rapport : configuration d\'ombrage électrique à vérifier.');
    if (st.width && st.type !== 'roof') {          // modules dans la largeur, déduits de la largeur sensible
      const pt = Math.round(st.width / 2.25), ls = Math.round(st.width / 1.13);
      const ept = Math.abs(st.width - pt * 2.3) / (pt * 2.3 || 1), els = Math.abs(st.width - ls * 1.13) / (ls * 1.13 || 1);
      if (pt >= 1 && ept <= els) { st.n_high = pt; st.orientation = 'portrait'; } else if (ls >= 1) { st.n_high = ls; st.orientation = 'landscape'; }
      out.notes.push(`Modules dans la largeur des tables déduits de la largeur sensible (${st.width} m) : ${st.n_high} en ${st.orientation === 'portrait' ? 'portrait' : 'paysage'}, à vérifier.`);
    }

    // ---- bifacial
    out.bifacial = { enabled: /Bifacial system/i.test(text) };
    if (out.bifacial.enabled) Object.assign(out.bifacial, {
      albedo_ground: val('Ground albedo'), bifaciality: (val('Bifaciality factor') ?? null) != null ? val('Bifaciality factor') / 100 : null,
      rear_shading: val('Rear shading factor'), rear_mismatch: val('Rear mismatch loss'), transparent: val('Shed transparent fraction'),
    });
    if (st.type === 'fixed' && st.height == null) st.height = val('Height above ground');
    if ((st.type === 'fixed' || st.type === 'ew') && st.height == null && !out.bifacial.enabled && st.pitch != null) {
      st.height = 1.0; out.notes.push('Hauteur des tables absente (inutile sans bifacial dans PVsyst) : 1 m par défaut, sans effet sur la face avant.');
    }

    // ---- champ PV et onduleurs
    out.module = { model: null, pan: (re1(/([\w.\-+()\[\] ]+\.PAN)\b/i) || [])[1] || null };
    out.inverter = { model: null, ond: (re1(/([\w.\-+()\[\] ]+\.OND)\b/i) || [])[1] || null };
    const pm = cell('PV module'); if (pm) { const mo = cell('Model', pm.k, 0); out.module.model = mo ? mo.v : null; const mf = cell('Manufacturer', pm.k, 0); out.module.manufacturer = mf ? mf.v : null; }
    const iv = cells.find((c) => /^Inverter$/i.test(c.text)) ? cells.findIndex((c) => /^Inverter$/i.test(c.text)) : -1;
    if (iv >= 0) { const col = cells[iv].col; const mo = cell('Model', iv, col); out.inverter.model = mo ? mo.v : null; const mf = cell('Manufacturer', iv, col); out.inverter.manufacturer = mf ? mf.v : null; }
    out.module.pnom = (() => { const r = cell('Unit Nom. Power', pm ? pm.k : 0, 0); return r ? num(r.v) : null; })();
    // sous-champs (Array #n)
    const arrays = [];
    cells.forEach((c, k) => {
      const a = c.text.match(/^Array #(\d+)\s*-?\s*(.*)$/i);
      if (a && c.col === 0 && !arrays.some((x) => x.k0 === k)) arrays.push({ k0: k, no: Number(a[1]), name: a[2] || `Champ ${a[1]}` });
    });
    const modLine = (from, to) => {
      for (let k = from; k < to; k++) { const mm = cells[k].text.match(/^Modules\s+(\d+)\s*(?:strings?|units?|unités?|chaînes?)\s*x\s*(\d+)\s*In series/i); if (mm) return [Number(mm[1]), Number(mm[2])]; }
      return null;
    };
    const tot = cells.findIndex((c) => /^Total PV power/i.test(c.text));
    const lim0 = tot > 0 ? tot : cells.length;
    for (let i = arrays.length - 1; i >= 0; i--) if (arrays[i].k0 > lim0) arrays.splice(i, 1);
    if (arrays.length) {
      arrays.forEach((a, i) => {
        const end = i + 1 < arrays.length ? arrays[i + 1].k0 : lim0;
        const ml = modLine(a.k0, end); a.strings = ml ? ml[0] : null; a.series = ml ? ml[1] : null;
        for (let k = a.k0; k < end; k++) {
          const t = cells[k].text, ta = t.match(/^Tilt\/Azimuth\s+(-?[\d.]+)\s*\/\s*(-?[\d.]+)/), ni = t.match(/^Number of inverters\s+(\d+)/i), nm = t.match(/^Number of PV modules\s+(\d+)/i);
          if (ta) { a.tilt = Number(ta[1]); a.azimuth = Number(ta[2]); }
          if (ni) a.n_inv = Number(ni[1]);
          if (nm) a.n_mod = Number(nm[1]);
        }
      });
    }
    out.arrays = arrays.filter((a) => a.series);
    const ml = modLine(0, tot > 0 ? tot : cells.length);
    out.array = { n_modules: val('Number of PV modules'), n_strings: out.arrays.length ? out.arrays.reduce((s, a) => s + a.strings, 0) : ml ? ml[0] : null,
      n_series: out.arrays.length ? out.arrays[0].series : ml ? ml[1] : null };
    if (out.arrays.length > 1 && new Set(out.arrays.map((a) => a.series)).size > 1 && st.type !== 'roof') out.notes.push('Sous-champs avec des nombres de modules en série différents : le premier est retenu.');
    const ninvTot = (() => { const t = cell('Total inverter power'); if (!t) return val('Number of inverters'); const n = cell('Number of inverters', t.k); return n ? num(n.v) : val('Number of inverters'); })();
    out.inverters = { n_inv: ninvTot, unit_kw: (() => { const r = cell('Unit Nom. Power', iv >= 0 ? iv : 0, iv >= 0 ? cells[iv].col : null); return r ? num(r.v) : null; })() };
    const lim = re1(/Active power\s+([\d.,]+)\s*(kWac|MWac|kW|MW)/i);
    out.inverters.p_inj_kw = lim ? num(lim[1]) * (/^M/i.test(lim[2]) ? 1000 : 1) : null;
    // groupes d'onduleurs : chaînes réparties au plus juste
    if (out.array.n_strings && out.inverters.n_inv && st.type !== 'roof') {
      const S = out.array.n_strings, N = out.inverters.n_inv, q = Math.floor(S / N), r = S - q * N;
      out.inverters.groups = r ? [[r, q + 1], [N - r, q]] : [[N, q]];
      if (r) out.notes.push(`${S} chaînes sur ${N} onduleurs : ${r} onduleurs à ${q + 1} chaînes et ${N - r} à ${q}.`);
    }
    if (st.type === 'roof') {
      const F = out.arrays.length ? out.arrays : (tiltAz.length ? [{ name: 'Champ 1', tilt: tiltAz[0][0], azimuth: tiltAz[0][1], strings: out.array.n_strings, series: out.array.n_series, n_inv: ninvTot }] : []);
      st.fields = F.map((a, i) => {
        const ta = a.tilt != null ? [a.tilt, a.azimuth] : (tiltAz[i] || tiltAz[0] || [null, 0]);
        const n_inv = a.n_inv || 1, n_str = a.strings && n_inv ? Math.ceil(a.strings / n_inv) : null;
        if (a.strings && n_inv && a.strings % n_inv) out.notes.push(`${a.name} : ${a.strings} chaînes sur ${n_inv} onduleurs, arrondi à ${n_str} chaînes par onduleur.`);
        return { name: a.name || `Toit ${i + 1}`, tilt: ta[0], azimuth: ta[1], n_h: a.strings && a.series ? a.strings * a.series : null, n_v: 1,
          n_series: a.series, n_inv, n_str };
      });
      if (st.fields.length) out.notes.push('Toiture : le calepinage de chaque champ est forcé au nombre de modules du rapport (zone de pose non décrite par PVsyst).');
    }

    // ---- thermique, IAM, pertes
    out.thermal = { uc: val('Uc (const)'), uv: val('Uv (wind)') };
    const iam = re1(/Incidence effect \(IAM\):\s*(.+)/);
    out.iam = { text: iam ? iam[1].trim() : null };
    if (iam && /Fresnel/i.test(iam[1])) { const ng = re1(/n\(glass\)=([\d.]+)/), na = re1(/n\(AR\)=([\d.]+)/); out.iam.mode = 'fresnel'; out.iam.n = ng ? Number(ng[1]) : 1.526; out.iam.n_ar = na ? Number(na[1]) : (/AR coating/i.test(iam[1]) ? 1.29 : null); }
    else if (iam && /User defined/i.test(iam[1])) out.notes.push("IAM défini par l'utilisateur dans PVsyst : le profil du .PAN ou Fresnel est à choisir dans l'outil.");
    const L = {}; out.losses = L;
    L.soiling = under('Array Soiling Losses', 'Loss Fraction');
    L.lid = under('LID - Light Induced Degradation', 'Loss Fraction');
    L.quality = under('Module Quality Loss', 'Loss Fraction');
    L.mismatch = under('Module mismatch losses', 'Loss Fraction');
    L.string_mismatch = under('Strings Mismatch loss', 'Loss Fraction');
    L.dc_ohmic = under('DC wiring losses', 'Loss Fraction') ?? under('Global wiring resistance', 'Loss Fraction');
    const acw = lines.findIndex((l) => /^AC wiring losses/i.test(l.text));
    if (acw >= 0) {
      const after = lines.slice(acw, acw + 12).map((l) => l.text).join('\n');
      const a = after.match(/Inv\. output line[\s\S]*?Loss Fraction\s+([\d.]+)\s*%/i); L.ac_ohmic = a ? Number(a[1]) : null;
      const mv = after.match(/MV line[\s\S]*?Loss Fraction\s+([\d.]+)\s*%/i); L.mv_line = mv ? Number(mv[1]) : 0;
    }
    const trSn = re1(/Nominal power at STC\s+([\d.,]+)\s*(MVA|kVA)/i);
    if (trSn) {
      L.tr_enabled = true; L.tr_sn_kva = num(trSn[1]) * (/^M/i.test(trSn[2]) ? 1000 : 1);
      const ir = re1(/Iron Loss\s*\(([^)]*)\)\s+([\d.,]+)\s*(kVA|kW)/i); if (ir) { L.tr_iron_kw = num(ir[2]); L.tr_always_on = /24\s*\/\s*24/.test(ir[1]); }
      const cu = re1(/Copper loss\s+([\d.,]+)\s*(kVA|kW)/i); if (cu) L.tr_cu_kw = num(cu[1]);
    } else if (/AC losses in transformers|MV transfo/i.test(text)) {
      const fr = re1(/Iron loss fraction\s+([\d.]+)/i); if (fr) out.notes.push('Transformateur défini en fractions de pertes : à compléter.');
    } else { L.tr_enabled = false; }
    const fans = re1(/constant \(fans\)\s+([\d.,]+)\s*kW/i); if (fans) L.aux_w = num(fans[1]) * 1000;
    const thr = re1(/([\d.,]+)\s*kW from Power thresh/i); if (thr) L.aux_thresh_kw = num(thr[1]);
    const night = re1(/Night aux\. cons\.\s+([\d.,]+)\s*kW/i); if (night) L.aux_night_w = num(night[1]) * 1000;
    if (!fans && !night) { L.aux_w = 0; L.aux_night_w = 0; }
    const un = re1(/Unavailability of the system[\s\S]{0,200}?Time fraction\s+([\d.,]+)\s*%/i); L.availability = un ? num(un[1]) : 0;
    Object.keys(L).forEach((k) => L[k] == null && delete L[k]);

    // ---- horizon
    const hz = [];
    lines.forEach((l, i) => {
      if (/^Azimuth \[°\]/.test(l.text) && lines[i + 1] && /^Height \[°\]/.test(lines[i + 1].text)) {
        const az = l.text.replace(/^Azimuth \[°\]/, '').trim().split(/\s+/).map(Number), h = lines[i + 1].text.replace(/^Height \[°\]/, '').trim().split(/\s+/).map(Number);
        az.forEach((a, j) => Number.isFinite(a) && Number.isFinite(h[j]) && hz.push([a, h[j]]));
      }
    });
    out.horizon = hz.length >= 3 ? hz : null;
    if (!hz.length && /Average Height\s+[1-9]/i.test(text)) out.notes.push("Le rapport mentionne un horizon sans en donner les points : déposer le masque dans l'outil.");

    // ---- résultats et bilan mensuel
    const pe = re1(/Produced Energy\s+([\d.,\s]+?)\s*(kWh|MWh|GWh)\/year/i);
    out.results = {
      e_grid_mwh: pe ? num(pe[1]) * { kWh: 1e-3, MWh: 1, GWh: 1e3 }[pe[2]] : null,
      yield_kwh_kwc: num((re1(/Specific production\s+([\d.,]+)\s*kWh\/kWp/i) || [])[1]),
      pr: (() => { const p = re1(/Perf\. Ratio PR\s+([\d.,]+)\s*%/i); return p ? num(p[1]) / 100 : null; })(),
      pr_bifi: (() => { const p = re1(/Bifacial perf\. ratio\s+([\d.,]+)\s*%/i); return p ? num(p[1]) / 100 : null; })(),
      pnom_kwc: (() => { const t = cell('Total PV power'); const r = t ? cell('Nominal (STC)', t.k) : cell('Nominal (STC)'); if (!r) return null; const v = num(r.v); return /MWp/i.test(r.v) ? v * 1000 : v; })(),
    };
    const hdr = lines.findIndex((l) => /GlobHor/.test(l.text) && /GlobInc/.test(l.text) && /E_Grid/.test(l.text));
    if (hdr >= 0) {
      const cols = lines[hdr].text.split(/\s+/);
      const rows = [];
      for (const l of lines.slice(hdr + 1, hdr + 20)) {
        const w = l.text.split(/\s+/), mo = w[0].toLowerCase();
        const mi = MONTHS_EN.indexOf(mo) >= 0 ? MONTHS_EN.indexOf(mo) : MONTHS_FR.indexOf(mo);
        if (mi >= 0 || /^(year|année)$/i.test(mo)) rows.push({ m: mi >= 0 ? mi : 12, v: w.slice(1).map(num) });
      }
      if (rows.length >= 12) {
        const ix = (n) => cols.indexOf(n);
        const get = (n) => { const j = ix(n); return j < 0 ? null : rows.filter((r) => r.m < 12).sort((a, b) => a.m - b.m).map((r) => r.v[j]); };
        out.monthly = { ghi: get('GlobHor'), dif: get('DiffHor'), temp: get('T_Amb'), globinc: get('GlobInc'), globeff: get('GlobEff'),
          e_array_kwh: get('EArray'), e_grid_kwh: get('E_Grid'), pr: get('PR') };
      }
    }
    // diagramme de pertes (libellé + %)
    out.losses_diagram = lines.map((l) => l.text.match(/^([-+]?\d+[.,]\d+)\s*%\s+(.+)$/)).filter(Boolean)
      .map((x) => ({ pct: num(x[1]), label: x[2].replace(/\s+/g, ' ').trim() }));

    // ---- manquants
    const need = { 'site.lat': out.site.lat, 'site.lon': out.site.lon };
    if (st.type === 'fixed') Object.assign(need, { tilt: st.tilt, pitch: st.pitch, width: st.width, height: st.height });
    if (st.type === 'tracker') Object.assign(need, { pitch: st.pitch, width: st.width, axis_height: st.axis_height });
    if (st.type === 'ew') Object.assign(need, { pitch: st.pitch, width: st.width, height: st.height });
    const lab = { 'site.lat': 'latitude', 'site.lon': 'longitude', tilt: 'inclinaison', pitch: 'entraxe', width: 'largeur des tables', height: 'hauteur', axis_height: "hauteur d'axe" };
    out.missing = Object.entries(need).filter(([, v]) => v == null).map(([k]) => lab[k]);
    if (out.bifacial.enabled && st.type === 'fixed' && st.height == null) out.missing.push('hauteur du bord bas');
    return out;
  }

  const api = { extractPages, structure, parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PvsystImport = api;
})(typeof window !== 'undefined' ? window : this);
