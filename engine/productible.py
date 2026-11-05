"""
Calcul productible - moteur de simulation PV au pas horaire, basé sur pvlib.

Chaîne de calcul (pas horaire) :
  TMY PVGIS (CSV/JSON) -> recalage optionnel Global Solar Atlas (mensuel ou annuel, GHI/DIF, T° en option)
  -> position solaire -> masque lointain (direct + facteur diffus) -> transposition Perez
  -> ombrages proches 1D entre rangées (sheds fixes, trackers mono-axe, Est-Ouest) + perte de vue du ciel
  -> salissure -> IAM -> face arrière (pvlib infinite sheds) -> modèle une diode PVsyst (.PAN) + thermique PVsyst
  -> pertes DC (ombrage électrique selon chaînes, LID, qualité, mismatch, mismatch arrière, ohmiques)
  -> onduleurs (.OND : rendement f(Pin, V), seuil, Pmax déclassée en température avec offset)
  -> auxiliaires, ohmiques AC, transformateur, ligne HTA, indisponibilité, limite d'injection
Sorties : mensuel, annuel, diagramme de pertes, alertes de dimensionnement, P50/P90, série horaire, export Excel.
"""
import io
import json
import math
import re

import numpy as np
import pandas as pd
import pvlib
from pvlib import irradiance, iam, shading, temperature, pvsystem, tracking
from pvlib.bifacial import infinite_sheds, utils as bfu
from scipy.interpolate import PchipInterpolator
from scipy.optimize import fsolve
from scipy.stats import norm

ENGINE_VERSION = "1.3.0"
MONTHS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc']
K_B, Q_E = 1.380649e-23, 1.602176634e-19


# ======================================================================================
# 1. Lecture des fichiers
# ======================================================================================
def _kv(text):
    kv = {}
    for line in text.replace('\r', '').split('\n'):
        if '=' in line:
            k, v = line.split('=', 1)
            kv.setdefault(k.strip(), v.strip())
    return kv


def _f(kv, key, default=None):
    try:
        return float(kv[key].replace(',', '.'))
    except (KeyError, ValueError):
        return default


def parse_pan(text):
    """Lit un fichier .PAN PVsyst (format texte, versions 6 à 8)."""
    kv = _kv(text)
    if 'PNom' not in kv or 'Isc' not in kv:
        raise ValueError("Fichier .PAN illisible : champs PNom / Isc absents (format binaire ancien ?)")
    pan = dict(
        manufacturer=kv.get('Manufacturer', ''), model=kv.get('Model', ''),
        technol=kv.get('Technol', ''), pnom=_f(kv, 'PNom'), isc=_f(kv, 'Isc'), voc=_f(kv, 'Voc'),
        imp=_f(kv, 'Imp'), vmp=_f(kv, 'Vmp'), mu_isc=_f(kv, 'muISC', 0.0) / 1000.0,
        mu_voc=_f(kv, 'muVocSpec', None), mu_pmp=_f(kv, 'muPmpReq', None),
        ns=int(_f(kv, 'NCelS', 60)), np_=int(_f(kv, 'NCelP', 1)), ndiode=int(_f(kv, 'NDiode', 3)),
        layout=kv.get('SubModuleLayout', ''),
        gamma=_f(kv, 'Gamma', 1.0), mu_gamma=_f(kv, 'muGamma', 0.0), rs=_f(kv, 'RSerie', 0.3),
        rsh=_f(kv, 'RShunt', 500.0), rsh0=_f(kv, 'Rp_0', None), rsh_exp=_f(kv, 'Rp_Exp', 5.5),
        width=_f(kv, 'Width', 1.0), height=_f(kv, 'Height', 2.0), absorb=_f(kv, 'Absorb', 0.9),
        bifaciality=_f(kv, 'BifacialityFactor', None), vmax_iec=_f(kv, 'VMaxIEC', None),
    )
    if pan['rsh0'] is None:
        pan['rsh0'] = 4 * pan['rsh']
    pan['area'] = pan['width'] * pan['height']
    pan['half_cells'] = 'Half' in pan['layout'] or pan['np_'] == 2
    # profil IAM utilisateur éventuel
    blk = re.search(r'PVObject_IAM=pvIAM(.*?)End of PVObject pvIAM', text, re.S)
    pts = []
    if blk:
        pts = [(float(a), float(b)) for a, b in
               re.findall(r'Point_\d+=\s*([\d.]+)\s*,\s*([\d.]+)', blk.group(1))]
    pan['iam_profile'] = pts
    # paramètres une diode IL_ref, I0_ref (méthode PVsyst : Isc et Voc imposés)
    nV = pan['gamma'] * pan['ns'] * K_B * 298.15 / Q_E

    def eqs(x):
        il, ln_i0 = x
        i0 = math.exp(ln_i0)
        return [il - i0 * (math.exp(pan['voc'] / nV) - 1) - pan['voc'] / pan['rsh'],
                il - i0 * (math.exp(pan['isc'] * pan['rs'] / nV) - 1)
                - pan['isc'] * pan['rs'] / pan['rsh'] - pan['isc']]

    il, ln_i0 = fsolve(eqs, [pan['isc'], math.log(1e-11)])
    pan['IL_ref'], pan['I0_ref'] = float(il), float(math.exp(ln_i0))
    return pan


def module_point(pan, g, t):
    """Point MPP (et Voc) d'un module pour irradiance g (W/m²) et température cellule t (°C)."""
    g = np.atleast_1d(np.asarray(g, float))
    t = np.broadcast_to(np.asarray(t, float), g.shape)
    prm = pvsystem.calcparams_pvsyst(g, t, pan['mu_isc'], pan['gamma'], pan['mu_gamma'],
                                     pan['IL_ref'], pan['I0_ref'], pan['rsh'], pan['rsh0'],
                                     pan['rs'], pan['ns'], R_sh_exp=pan['rsh_exp'])
    r = pvsystem.max_power_point(*prm, method='newton')
    voc = pvsystem.singlediode(*prm, method='newton')['v_oc']
    return r['p_mp'], r['i_mp'], r['v_mp'], np.asarray(voc)


def parse_ond(text):
    """Lit un fichier .OND PVsyst (format texte)."""
    kv = _kv(text)
    if 'PNomConv' not in kv:
        raise ValueError("Fichier .OND illisible : champ PNomConv absent")
    o = dict(
        manufacturer=kv.get('Manufacturer', ''), model=kv.get('Model', ''),
        pnom=_f(kv, 'PNomConv') * 1e3, pmax=_f(kv, 'PMaxOUT', _f(kv, 'PNomConv')) * 1e3,
        t_pnom=_f(kv, 'TPNom', None), t_pmax=_f(kv, 'TPMax', None),
        t_lim1=_f(kv, 'TPLim1', None), p_lim1=(_f(kv, 'PLim1', 0) or 0) * 1e3,
        t_limabs=_f(kv, 'TPLimAbs', None), p_limabs=(_f(kv, 'PLimAbs', 0) or 0) * 1e3,
        pseuil=_f(kv, 'PSeuil', 0.0), vmin=_f(kv, 'VMppMin', 0.0), vmax=_f(kv, 'VMPPMax', 1500.0),
        vabsmax=_f(kv, 'VAbsMax', _f(kv, 'VMPPMax', 1500.0)), imax_dc=_f(kv, 'IMaxDC', 0.0),
        idc_max_mppt=_f(kv, 'IDCMax', 0.0), n_mppt=int(_f(kv, 'NbMPPT', 1) or 1),
        night_w=_f(kv, 'Night_Loss', 0.0), effic_max=_f(kv, 'EfficMax', None),
        effic_euro=_f(kv, 'EfficEuro', None),
    )
    vnom = kv.get('VNomEff', '')
    o['vnom_eff'] = [float(x) for x in vnom.strip(',').split(',') if x.strip()] if vnom else []
    curves = []
    for name in ('ProfilPIOV1', 'ProfilPIOV2', 'ProfilPIOV3'):
        blk = re.search(name + r'=TCubicProfile(.*?)End of TCubicProfile', text, re.S)
        if blk:
            pts = [(float(a), float(b)) for a, b in
                   re.findall(r'Point_\d+=\s*([\d.]+)\s*,\s*([\d.]+)', blk.group(1))]
            pts = [p for p in pts if p[0] > 0 or p[1] > 0]
            if len(pts) >= 3:
                curves.append(pts)
    if not curves:
        blk = re.search(r'ProfilPIO=TCubicProfile(.*?)End of TCubicProfile', text, re.S)
        if blk:
            pts = [(float(a), float(b)) for a, b in
                   re.findall(r'Point_\d+=\s*([\d.]+)\s*,\s*([\d.]+)', blk.group(1))]
            pts = [p for p in pts if p[0] > 0 or p[1] > 0]
            if pts and max(p[0] for p in pts) < 20 * o['pnom'] / 1e3:   # profil en kW
                pts = [(a * 1e3, b * 1e3) for a, b in pts]
            curves.append(pts)
        o['vnom_eff'] = [0.5 * (o['vmin'] + o['vmax'])]
    o['curves'] = curves
    if len(o['vnom_eff']) != len(curves):
        o['vnom_eff'] = list(np.linspace(o['vmin'], o['vmax'], len(curves)))
    return o


def read_tmy(text, name=''):
    """TMY PVGIS au format CSV ou JSON (sorties de l'outil TMY de PVGIS 5.x)."""
    name = (name or '').lower()
    is_json = name.endswith('.json') or text.lstrip().startswith('{')
    info = dict(source='PVGIS', use_horizon=None, offset_h=0.0, db='', lat=None, lon=None, elev=None)
    if is_json:
        data, meta = pvlib.iotools.read_pvgis_tmy(io.StringIO(text), pvgis_format='json',
                                                   map_variables=True)
        loc = meta['inputs']['location']
        md = meta['inputs'].get('meteo_data', {})
        info.update(use_horizon=md.get('use_horizon'), db=md.get('radiation_db', ''),
                    offset_h=float(loc.get('irradiance_time_offset', 0) or 0),
                    lat=loc.get('latitude'), lon=loc.get('longitude'), elev=loc.get('elevation'),
                    years=f"{md.get('year_min', '')}-{md.get('year_max', '')}")
    else:
        data, meta = pvlib.iotools.read_pvgis_tmy(io.BytesIO(text.encode('utf-8')),
                                                   pvgis_format='csv', map_variables=True)
        m = re.search(r'Irradiance Time Offset \(h\):\s*([-\d.]+)', text)
        info['offset_h'] = float(m.group(1)) if m else 0.0
        for key, pat in (('lat', r'Latitude[^:]*:\s*([-\d.]+)'), ('lon', r'Longitude[^:]*:\s*([-\d.]+)'),
                         ('elev', r'Elevation[^:]*:\s*([-\d.]+)')):
            m = re.search(pat, text)
            info[key] = float(m.group(1)) if m else None
    w = data[['ghi', 'dni', 'dhi', 'temp_air', 'wind_speed']].astype(float).copy()
    if len(w) != 8760:
        raise ValueError(f"Le TMY doit contenir 8760 heures ({len(w)} lues)")
    w.index = pd.date_range('1990-01-01 00:00', periods=8760, freq='h', tz='UTC')
    w[['ghi', 'dni', 'dhi']] = w[['ghi', 'dni', 'dhi']].clip(lower=0)
    return w, info


def parse_horizon(text):
    """Masque d'horizon : CSV PVsyst (Azimut;Hauteur, 0 = Sud, -90 = Est) ou sortie PVGIS printhorizon.
    Retourne un tableau (azimut PVsyst °, hauteur °) trié, bouclé sur [-180, 180]."""
    pts = []
    for line in text.replace('\r', '').split('\n'):
        nums = re.findall(r'-?\d+(?:[.,]\d+)?', line)
        if len(nums) >= 2 and not re.search(r'[A-Za-z]{3,}', line.split(';')[0].split('\t')[0] + ' '):
            a, h = float(nums[0].replace(',', '.')), float(nums[1].replace(',', '.'))
            if -360 <= a <= 360 and -10 <= h <= 90:
                pts.append((a, h))
    if len(pts) < 3:
        raise ValueError("Masque d'horizon illisible (2 colonnes attendues : azimut ; hauteur)")
    arr = np.array(sorted(pts))
    if arr[:, 0].min() >= 0 and arr[:, 0].max() > 180:          # convention 0..360 Nord -> PVsyst
        arr[:, 0] = ((arr[:, 0] - 180 + 180) % 360) - 180
        arr = arr[np.argsort(arr[:, 0])]
    _, idx = np.unique(arr[:, 0], return_index=True)
    return arr[idx]


def horizon_height(hz, az_pvsyst):
    """Hauteur du masque (°) pour un azimut PVsyst (0 = Sud, Est négatif), interpolation périodique."""
    a = np.concatenate([hz[:, 0] - 360, hz[:, 0], hz[:, 0] + 360])
    h = np.concatenate([hz[:, 1]] * 3)
    return np.interp(az_pvsyst, a, h)


def parse_gsa(text):
    """Réponse JSON de l'API Global Solar Atlas (https://api.globalsolaratlas.info/data/lta?loc=lat,lon)."""
    d = json.loads(text)
    mon = d.get('monthly', {}).get('data', d.get('monthly', {}))
    ann = d.get('annual', {}).get('data', d.get('annual', {}))
    out = dict(ghi=mon.get('GHI'), dif=mon.get('DIF'), temp=mon.get('TEMP'),
               ghi_year=ann.get('GHI'), dif_year=ann.get('DIF'), temp_year=ann.get('TEMP'),
               dni_year=ann.get('DNI'), pvout=ann.get('PVOUT_csi'))
    if not out['ghi'] or len(out['ghi']) != 12:
        raise ValueError("JSON Global Solar Atlas : 12 valeurs mensuelles de GHI attendues")
    return out


def parse_pvgis_monthly(text):
    """CSV 'Monthly data' de PVGIS : variabilité interannuelle du GHI (écart-type / moyenne des années
    complètes), comme le classeur P50-P90."""
    rows = []
    mon_names = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    header = None
    for line in text.replace('\r', '').split('\n'):
        f = [x for x in re.split(r'[\t;, ]+', line.strip()) if x]
        if not f:
            continue
        low = [x.lower() for x in f]
        if 'year' in low and 'month' in low:
            header = low
            continue
        if header and len(f) >= len(header) - 1:
            try:
                y = int(f[header.index('year')])
                mtxt = f[header.index('month')].lower()[:3]
                m = mon_names.index(mtxt) + 1 if mtxt in mon_names else int(mtxt)
                col = next(i for i, h in enumerate(header) if h.startswith('h(h)') or h.startswith('h(i'))
                rows.append((y, m, float(f[col].replace(',', '.'))))
            except (ValueError, StopIteration, IndexError):
                continue
    if not rows:
        raise ValueError("CSV mensuel PVGIS : en-tête « year month H(h)_m » introuvable")
    df = pd.DataFrame(rows, columns=['year', 'month', 'ghi'])
    piv = df.pivot_table(index='year', columns='month', values='ghi', aggfunc='sum')
    full = piv.dropna() if piv.shape[1] == 12 else piv.iloc[0:0]
    tot = full.sum(axis=1)
    var = float(tot.std(ddof=1) / tot.mean()) if len(tot) >= 2 else None
    return dict(years=[int(y) for y in tot.index], totals=[float(v) for v in tot.values],
                monthly_mean=[float(piv[m].mean()) if m in piv else None for m in range(1, 13)],
                variability=var)


# ======================================================================================
# 2. Météo : recalage Global Solar Atlas
# ======================================================================================
def gsa_correct(w, sp, cz, gsa, mode='monthly', align_temp=False):
    """Recale le TMY sur Global Solar Atlas. mode : 'monthly' (12 mois) ou 'annual' (facteurs uniques)."""
    month = w.index.month
    cs = pvlib.clearsky.simplified_solis(90 - sp['apparent_zenith'].clip(upper=90))
    cs_dni = pd.Series(np.nan_to_num(cs['dni']), index=w.index)
    cs_ghi = pd.Series(np.nan_to_num(cs['ghi']), index=w.index)
    ghi0, dhi0, dni0 = w.ghi.copy(), w.dhi.copy(), w.dni.copy()
    dhi, dni = dhi0.copy(), dni0.copy()
    rows = []
    if mode == 'annual':
        g_tot = float(gsa.get('ghi_year') or sum(gsa['ghi'])) * 1000
        d_tot = float(gsa.get('dif_year') or sum(gsa['dif'])) * 1000
        kd = d_tot / dhi0.sum()
        kb = (g_tot - d_tot) / (ghi0 - dhi0).sum()
        targets = {m: (None, None, kd, kb) for m in range(1, 13)}
    else:
        targets = {m: (gsa['ghi'][m - 1] * 1000, gsa['dif'][m - 1] * 1000, None, None)
                   for m in range(1, 13)}
    for m in range(1, 13):
        sel = month == m
        g_t, d_t, kd, kb = targets[m]
        d_m, n_m, c_m = dhi0[sel].copy(), dni0[sel].copy(), cz[sel]
        if mode == 'annual':
            d_t = float(d_m.sum() * kd)
            g_t = d_t + float((n_m * c_m).sum() * kb)
        b_t = g_t - d_t
        n_clip = 0
        for _ in range(40):
            if d_m.sum() > 0:
                d_m = d_m * d_t / d_m.sum()
            b_m = (n_m * c_m).sum()
            if b_m > 0:
                n_m = n_m * b_t / b_m
            lim = 1.05 * cs_dni[sel]
            n_clip = max(n_clip, int((n_m > lim + 1).sum()))
            n_m = np.minimum(n_m, lim)
            over = (d_m + n_m * c_m - 1.10 * cs_ghi[sel]).clip(lower=0)
            d_m = (d_m - over).clip(lower=0)
            if abs((n_m * c_m).sum() - b_t) <= 1e-4 * max(b_t, 1) and abs(d_m.sum() - d_t) <= 1e-4 * max(d_t, 1):
                break
        dhi[sel], dni[sel] = d_m, n_m
        rows.append(dict(mois=MONTHS[m - 1], ghi_tmy=float(ghi0[sel].sum() / 1000),
                         dif_tmy=float(dhi0[sel].sum() / 1000), ghi_cible=float(g_t / 1000),
                         dif_cible=float(d_t / 1000),
                         k_diffus=float(d_t / dhi0[sel].sum()) if dhi0[sel].sum() else None,
                         k_direct=float(b_t / (ghi0[sel] - dhi0[sel]).sum()) if (ghi0[sel] - dhi0[sel]).sum() else None,
                         heures_ecretees=n_clip))
    out = w.copy()
    out['dhi'], out['dni'] = dhi, dni
    out['ghi'] = dhi + dni * cz
    if align_temp and gsa.get('temp'):
        dt = pd.Series(gsa['temp'], index=range(1, 13)) - w.temp_air.groupby(month).mean()
        out['temp_air'] = w.temp_air + dt.reindex(month).values
        for r, d in zip(rows, dt.values):
            r['dT'] = float(d)
    for r, m in zip(rows, range(1, 13)):
        r['ghi_corrige'] = float(out.ghi[month == m].sum() / 1000)
        r['dif_corrige'] = float(out.dhi[month == m].sum() / 1000)
        r['t_moy'] = float(out.temp_air[month == m].mean())
    return out, rows


# ======================================================================================
# 3. Géométrie et irradiance d'une face
# ======================================================================================
def _horizon_diffuse_factor(hz, tilt, az_pvlib):
    """Part du diffus isotrope du ciel vue par le plan malgré le masque lointain (intégration numérique)."""
    if hz is None:
        return 1.0
    az = np.radians(np.arange(0, 360, 2.0) + 1.0)
    el = np.radians(np.arange(0, 90, 1.0) + 0.5)
    A, E = np.meshgrid(az, el)
    t, a = math.radians(tilt), math.radians(az_pvlib)
    n = np.array([math.sin(t) * math.sin(a), math.sin(t) * math.cos(a), math.cos(t)])
    d = np.stack([np.cos(E) * np.sin(A), np.cos(E) * np.cos(A), np.sin(E)])
    cosi = np.clip(np.tensordot(n, d, axes=1), 0, None) * np.cos(E)
    hh = horizon_height(hz, np.degrees(A) - 180)
    vis = np.degrees(E) > hh
    tot = cosi.sum()
    return float((cosi * vis).sum() / tot) if tot > 0 else 1.0


def face_irradiance(ctx, face):
    """Irradiance d'une face (avant et arrière), ombrages et IAM. Retourne un dict de séries horaires."""
    w, sp, day, dni_extra, am = ctx['w'], ctx['sp'], ctx['day'], ctx['dni_extra'], ctx['am']
    zen, azi = sp['apparent_zenith'], sp['azimuth']
    st, cfg_s, bf, losses = ctx['structure'], ctx['cfg_struct'], ctx['bifacial'], ctx['losses']
    hz = ctx['horizon']
    width, pitch = float(cfg_s['width']), float(cfg_s['pitch'])
    gcr = width / pitch
    n_rows = max(int(cfg_s.get('n_rows', 10)), 1)
    edge = (n_rows - 1) / n_rows

    if face['kind'] == 'tracker':
        trk = tracking.singleaxis(zen, azi, axis_tilt=0, axis_azimuth=face['axis_azimuth'],
                                  max_angle=face['max_angle'], backtrack=face['backtrack'], gcr=gcr)
        tilt = trk['surface_tilt'].fillna(0.0)
        saz = trk['surface_azimuth'].fillna(face['axis_azimuth'] + 90)
        rot = trk['tracker_theta'].fillna(0.0)
        axis_az = face['axis_azimuth']
        h_center = float(cfg_s.get('axis_height', 1.5))
    else:
        tilt = pd.Series(face['tilt'], index=w.index, dtype=float)
        saz = pd.Series(face['azimuth'], index=w.index, dtype=float)
        axis_az = (face['azimuth'] - 90.0) % 360
        rot = pd.Series(face['tilt'], index=w.index, dtype=float)
        h_center = float(cfg_s.get('height', 1.0)) + width / 2 * math.sin(math.radians(face['tilt']))

    aoi = irradiance.aoi(tilt, saz, zen, azi)
    # masque lointain : direct coupé sous l'horizon
    if hz is not None:
        hsun = 90 - zen
        hmask = horizon_height(hz, azi.values - 180)
        beam_vis = pd.Series((hsun.values > hmask).astype(float), index=w.index)
    else:
        beam_vis = pd.Series(1.0, index=w.index)
    dni_eff = w.dni * beam_vis
    beam0 = (w.dni * np.cos(np.radians(aoi))).clip(lower=0).where(day, 0)
    beam = beam0 * beam_vis
    per = irradiance.perez(tilt, saz, w.dhi, w.dni, dni_extra, zen, azi, am,
                           return_components=True).fillna(0).clip(lower=0)
    d_iso, d_circ0, d_hor = per['poa_isotropic'], per['poa_circumsolar'], per['poa_horizon']
    d_circ = d_circ0 * beam_vis
    d_gnd = irradiance.get_ground_diffuse(tilt, w.ghi, albedo=ctx['albedo'])
    glob_inc0 = (beam0 + d_iso + d_circ0 + d_hor + d_gnd).where(day, 0)       # avant masque lointain
    # facteur diffus du masque lointain
    if hz is not None:
        if face['kind'] == 'tracker':
            grid = np.arange(0, 91, 5.0)
            fe = [_horizon_diffuse_factor(hz, g, (axis_az + 90) % 360) for g in grid]
            fw = [_horizon_diffuse_factor(hz, g, (axis_az - 90) % 360) for g in grid]
            f_hz = pd.Series(np.where(rot >= 0, np.interp(tilt, grid, fe), np.interp(tilt, grid, fw)),
                             index=w.index)
        else:
            f_hz = _horizon_diffuse_factor(hz, face['tilt'], face['azimuth'])
    else:
        f_hz = 1.0
    d_iso_h, d_hor_h = d_iso * f_hz, d_hor * f_hz
    glob_inc = (beam + d_iso_h + d_circ + d_hor_h + d_gnd).where(day, 0)       # après masque lointain
    # masque proche propre au champ (toiture) : direct coupé sous son profil, diffus réduit sur le masque combiné
    near = ctx.get('near')
    if near is not None:
        hsun = 90 - zen
        vis_n = pd.Series((hsun.values > horizon_height(near, azi.values - 180)).astype(float), index=w.index)
        beam_vis = beam_vis * vis_n
        dni_eff = w.dni * beam_vis
        beam = beam0 * beam_vis
        d_circ = d_circ0 * beam_vis
        grid_az = np.arange(-180, 181, 1.0)
        comb = np.column_stack([grid_az, np.maximum(horizon_height(near, grid_az),
                                                     horizon_height(hz, grid_az) if hz is not None else 0.0)])
        f_c = _horizon_diffuse_factor(comb, face['tilt'], face['azimuth'])
        d_iso_h, d_hor_h = d_iso * f_c, d_hor * f_c
    glob_inc_near = (beam + d_iso_h + d_circ + d_hor_h + d_gnd).where(day, 0)   # après masque proche du champ

    # ombrages proches 1D entre rangées
    fs = shading.shaded_fraction1d(zen, azi, axis_azimuth=axis_az, shaded_row_rotation=rot,
                                   collector_width=width, pitch=pitch)
    fs = pd.Series(np.nan_to_num(np.asarray(fs, float)), index=w.index).clip(0, 1).where(day, 0)
    fs_lin = fs * edge
    vf_free = (1 + np.cos(np.radians(tilt))) / 2
    vf_row = bfu.vf_row_sky_2d_integ(np.abs(tilt.values), gcr, 0.0, 1.0)
    diff_att = pd.Series((1 - vf_row / vf_free) * edge, index=w.index).clip(0, 1)
    sh_f = infinite_sheds.get_irradiance(tilt, saz, zen, azi, gcr, h_center, pitch, w.ghi, w.dhi,
                                         dni_eff, ctx['albedo'], model='haydavies', dni_extra=dni_extra)
    gnd_front = sh_f['poa_front_ground_diffuse'].fillna(0).clip(lower=0) * edge + d_gnd * (1 - edge)
    beam_sh = (beam + d_circ) * (1 - fs_lin)
    diff_sh = (d_iso_h + d_hor_h) * (1 - diff_att)
    front_after_shade = (beam_sh + diff_sh + gnd_front).where(day, 0)

    # salissure (scalaire ou mensuelle) + IAM
    soil_cfg = losses.get('soiling', 0.0)
    if isinstance(soil_cfg, (list, tuple)) and len(soil_cfg) == 12:
        soil = pd.Series(1 - np.array(soil_cfg, float)[w.index.month - 1] / 100, index=w.index)
    else:
        soil = 1 - float(soil_cfg) / 100
    iam_cfg = ctx['iam']
    if iam_cfg['mode'] == 'pan' and len(iam_cfg.get('profile', [])) >= 3:
        th = [p[0] for p in iam_cfg['profile']]
        val = [p[1] for p in iam_cfg['profile']]
        iam_b = pd.Series(iam.interp(aoi.values, th, val, method='linear', normalize=False),
                          index=w.index).fillna(0).clip(0, 1)
        iam_d = iam.marion_diffuse('interp', 30.0, theta_ref=th, iam_ref=val, normalize=False)
        iam_d = {'sky': float(np.mean(np.atleast_1d(iam_d['sky']))),
                 'ground': float(np.mean(np.atleast_1d(iam_d['ground'])))}
    else:
        n_g, n_ar = float(iam_cfg.get('n', 1.526)), iam_cfg.get('n_ar', 1.29)
        n_ar = float(n_ar) if n_ar else None
        iam_b = pd.Series(iam.physical(aoi.values, n=n_g, n_ar=n_ar), index=w.index).fillna(0)
        md = iam.marion_diffuse('physical', float(np.median(tilt[day])) if day.any() else 20.0,
                                n=n_g, n_ar=n_ar)
        iam_d = {'sky': float(md['sky']), 'ground': float(md['ground'])}
    front_eff = (beam_sh * soil * iam_b + diff_sh * soil * iam_d['sky']
                 + gnd_front * soil * iam_d['ground']).where(day, 0)

    # face arrière
    if bf['enabled']:
        sh_b = infinite_sheds.get_irradiance(tilt, saz, zen, azi, gcr, h_center, pitch, w.ghi, w.dhi,
                                             dni_eff, bf['albedo_ground'], model='haydavies',
                                             dni_extra=dni_extra, iam_back=iam_d['ground'],
                                             transmission_factor=bf['transparent'] / 100)
        rear_inc = sh_b['poa_back'].fillna(0).clip(lower=0).where(day, 0)
        rear_eff = rear_inc * (1 - bf['rear_shading'] / 100)
    else:
        rear_inc = rear_eff = pd.Series(0.0, index=w.index)

    # ombrage électrique selon chaînes (sur le direct)
    nh = max(int(ctx['sub_in_height']), 1)
    f_str = np.ceil(fs * nh - 1e-9) / nh
    elec_irr = (ctx['elec_effect'] * (f_str - fs).clip(lower=0) * edge * (beam + d_circ) * soil * iam_b)
    return dict(glob_inc0=glob_inc0, glob_inc=glob_inc, glob_inc_near=glob_inc_near, front_after_shade=front_after_shade,
                front_soil=front_after_shade * soil, front_eff=front_eff, rear_inc=rear_inc,
                rear_eff=rear_eff, elec_irr=elec_irr.where(day, 0), shaded_fraction=fs,
                diff_att=float(diff_att[day].mean()) if day.any() else 0.0,
                f_hz=float(np.mean(f_hz)) if not np.isscalar(f_hz) else float(f_hz),
                tilt=tilt, azimuth=saz)


# ======================================================================================
# 4. Alertes de dimensionnement
# ======================================================================================
def roof_layout(f, pan):
    """Calepinage d'un champ de toiture : nombre de modules en largeur et en hauteur (forçables)."""
    portrait = (f.get('orientation') or 'portrait') == 'portrait'
    mw, mh = (pan['width'], pan['height']) if portrait else (pan['height'], pan['width'])
    gap = float(f.get('gap') or 0)
    L, H = float(f.get('length') or 0), float(f.get('height') or 0)
    n_h = int(math.floor((L + gap) / (mw + gap) + 1e-9)) if L > 0 else 0
    n_v = int(math.floor((H + gap) / (mh + gap) + 1e-9)) if H > 0 else 0
    n_h_f = int(f['n_h']) if f.get('n_h') not in (None, '', 0) else n_h
    n_v_f = int(f['n_v']) if f.get('n_v') not in (None, '', 0) else n_v
    return dict(n_h_calc=n_h, n_v_calc=n_v, n_h=n_h_f, n_v=n_v_f, n_modules=n_h_f * n_v_f,
                pnom_kwc=n_h_f * n_v_f * pan['pnom'] / 1000, module_w=mw, module_h=mh,
                used_length=n_h_f * mw + max(n_h_f - 1, 0) * gap, used_height=n_v_f * mh + max(n_v_f - 1, 0) * gap)


def _lib(files, kind, idx):
    """Fichier .PAN / .OND n° idx : 0 = fichier principal, 1.. = fichiers supplémentaires."""
    idx = int(idx or 0)
    if idx == 0:
        return files.get(kind)
    extra = files.get(kind + '_extra') or []
    return extra[idx - 1] if 0 < idx <= len(extra) else None


def check_project(cfg, files):
    """Contrôles de dimensionnement de tout le projet (champ par champ en toiture)."""
    st = cfg['structure']
    if st.get('type') != 'roof':
        return check_design(parse_pan(files['pan']), parse_ond(files['ond']), cfg)
    alerts = []
    fields = st.get('fields') or []
    if not fields:
        return [dict(code='roof', level='block', title='Toiture', value=None, limit=None, unit='',
                     message='Aucun champ défini : ajouter au moins un toit.')]
    for k, f in enumerate(fields):
        nm = f.get('name') or f'Champ {k + 1}'
        pt, ot = _lib(files, 'pan', f.get('module')), _lib(files, 'ond', f.get('inverter'))
        if not pt or not ot:
            alerts.append(dict(code='roof_files', level='block', title=nm, value=None, limit=None, unit='',
                               message='Module ou onduleur non affecté (fichier manquant).'))
            continue
        pan, ond = parse_pan(pt), parse_ond(ot)
        lay = roof_layout(f, pan)
        n_inv, n_str = int(f.get('n_inv') or 0), int(f.get('n_str') or 0)
        wired = int(f.get('n_series') or 0) * n_inv * n_str
        cc = json.loads(json.dumps(cfg))
        cc['array'] = dict(n_series=int(f.get('n_series') or 0), n_strings=n_inv * n_str)
        cc['inverters']['groups'] = [[n_inv, n_str]]
        cc['structure']['shading_configs'] = []
        for a in check_design(pan, ond, cc):
            a['title'] = f"{nm} – {a['title']}"
            alerts.append(a)
        if wired > lay['n_modules']:
            alerts.append(dict(code='roof_layout', level='block', title=f'{nm} – Calepinage', value=wired,
                               limit=lay['n_modules'], unit='modules',
                               message=f"{wired} modules câblés pour {lay['n_modules']} modules posables "
                                       f"({lay['n_h']} × {lay['n_v']}) : simulation bloquée."))
        elif wired < lay['n_modules']:
            alerts.append(dict(code='roof_layout', level='warn', title=f'{nm} – Calepinage', value=wired,
                               limit=lay['n_modules'], unit='modules',
                               message=f"{lay['n_modules'] - wired} module(s) posable(s) non câblé(s) "
                                       f"({wired} câblés sur {lay['n_modules']}) : seuls les modules câblés sont simulés."))
    return alerts


def _simulate_roof(cfg, files):
    """Toiture : une simulation par champ (inclinaison, orientation, module, onduleurs, masque proche),
    puis cumul des énergies et moyenne pondérée par la puissance des grandeurs spécifiques."""
    alerts = check_project(cfg, files)
    if any(a['level'] == 'block' for a in alerts):
        return dict(ok=False, blocked=True, alerts=alerts)
    fields = cfg['structure']['fields']
    # puissances AC des champs, pour répartir transformateur, auxiliaires et limite d'injection
    pac = []
    for f in fields:
        o = parse_ond(_lib(files, 'ond', f.get('inverter')))
        pac.append(o['pmax'] * int(f.get('n_inv') or 0))
    pac_tot = sum(pac) or 1.0
    runs = []
    near_masks = files.get('near_masks') or {}
    for k, f in enumerate(fields):
        share = pac[k] / pac_tot
        cc = json.loads(json.dumps(cfg))
        s2 = cc['structure']
        pan = parse_pan(_lib(files, 'pan', f.get('module')))
        s2.update(type='fixed', roof=True, field_name=f.get('name') or f'Champ {k + 1}', tilt=float(f['tilt']),
                  azimuth=float(f.get('azimuth') or 0), az_convention='sud0', n_rows=1, width=2.0,
                  pitch=2.0 / 0.9, height=float(f.get('mount_height') or 0.2),
                  sub_in_height=1, shading_configs=[dict(sub_in_height=1, share=100.0)])
        n_inv, n_str = int(f['n_inv']), int(f['n_str'])
        cc['array'] = dict(n_series=int(f['n_series']), n_strings=n_inv * n_str)
        cc['inverters']['groups'] = [[n_inv, n_str]]
        L = cc['losses']
        for key in ('tr_sn_kva', 'tr_iron_kw', 'tr_cu_kw', 'aux_w', 'aux_thresh_kw', 'aux_night_w'):
            if L.get(key) not in (None, ''):
                L[key] = float(L[key]) * share
        if cc['inverters'].get('p_inj_kw') not in (None, '', 0):
            cc['inverters']['p_inj_kw'] = float(cc['inverters']['p_inj_kw']) * share
        fk = dict(files)
        fk['pan'] = _lib(files, 'pan', f.get('module'))
        fk['ond'] = _lib(files, 'ond', f.get('inverter'))
        fk['near'] = near_masks.get(str(f.get('id'))) if f.get('id') is not None else None
        r = _simulate_one(cc, fk)
        if not r.get('ok'):
            r['alerts'] = alerts
            return r
        r['_layout'] = roof_layout(f, pan)
        runs.append((f, r))
    return _combine_fields(cfg, files, runs, alerts)


def _combine_fields(cfg, files, runs, alerts):
    P = [r['summary']['pnom_kwc'] for _, r in runs]
    Pt = sum(P)
    w = [p / Pt for p in P]
    base = runs[0][1]
    res = dict(base)
    res['config'] = cfg
    res['alerts'] = alerts
    ws = lambda get: sum(wi * get(r) for wi, (_, r) in zip(w, runs))
    sm = lambda get: sum(get(r) for _, r in runs)
    monthly = []
    for i, m in enumerate(base['monthly']):
        row = dict(m)
        for k in ('glob_inc', 'glob_eff', 'rear_inc'):
            row[k] = ws(lambda r, i=i, k=k: r['monthly'][i][k])
        for k in ('e_array', 'e_inv', 'e_grid'):
            row[k] = sm(lambda r, i=i, k=k: r['monthly'][i][k])
        row['yield_'] = row['e_grid'] * 1000 / Pt
        den = sm(lambda r, i=i: r['monthly'][i]['glob_inc'] * r['summary']['pnom_kwc'])
        row['pr'] = row['e_grid'] * 1000 / den if den else 0.0
        denb = sm(lambda r, i=i: (r['monthly'][i]['e_grid'] * 1000 / r['monthly'][i]['pr_bifi'])
                  if r['monthly'][i]['pr_bifi'] else 0.0)
        row['pr_bifi'] = row['e_grid'] * 1000 / denb if denb else 0.0
        monthly.append(row)
    res['monthly'] = monthly
    losses, prev = [], None
    for i, l in enumerate(base['losses']):
        row = dict(l)
        if l['value'] is not None:
            row['value'] = sm(lambda r, i=i: r['losses'][i]['value']) if l['unit'] == 'MWh' \
                else ws(lambda r, i=i: r['losses'][i]['value'])
        if l['pct'] is not None:
            row['pct'] = ws(lambda r, i=i: r['losses'][i]['pct'])
            if row['value'] is not None and prev not in (None, 0) and l['stage'] in ('irr', 'dc'):
                row['pct'] = 100 * (row['value'] / prev - 1)
        losses.append(row)
        if row['value'] is not None:
            prev = row['value']
    res['losses'] = losses
    summ = dict(base['summary'])
    for k, v in base['summary'].items():
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            summ[k] = ws(lambda r, k=k: r['summary'][k] or 0)
    for k in ('e_grid_mwh', 'pnom_kwc', 'pac_kva', 'n_modules', 'n_inverters'):
        summ[k] = sm(lambda r, k=k: r['summary'][k])
    summ['yield_kwh_kwc'] = summ['e_grid_mwh'] * 1000 / Pt
    summ['pr'] = monthly[12]['pr']
    summ['pr_bifi'] = monthly[12]['pr_bifi']
    summ['dc_ac'] = summ['pnom_kwc'] / summ['pac_kva'] if summ['pac_kva'] else None
    summ['limit_angle'] = None
    summ['sub_in_height'] = '–'
    res['p90'], res['lifetime'] = compute_p90(summ['yield_kwh_kwc'], Pt, cfg, files)
    summ['p90'], summ['p90_mwh'] = res['p90']['p90'], res['p90']['p90_mwh']
    res['summary'] = summ
    res['daily_kwh'] = [sum(r['daily_kwh'][j] for _, r in runs) for j in range(len(base['daily_kwh']))]
    hr = base['_hourly'].copy()
    for col in ('GlobInc', 'GlobEff', 'RearEff', 'T_cell', 'V_dc'):
        hr[col] = sum(wi * r['_hourly'][col] for wi, (_, r) in zip(w, runs)).round(2)
    for col in ('P_dc_kW', 'P_ac_kW', 'P_grid_kW'):
        hr[col] = sum(r['_hourly'][col] for _, r in runs).round(2)
    res['_hourly'] = hr
    res['faces'] = [fc for _, r in runs for fc in r['faces']]
    res['shading_configs'] = []
    res['fields'] = []
    for k, ((f, r), wi) in enumerate(zip(runs, w)):
        near_l = next((l['pct'] for l in r['losses'] if l['label'].startswith('Ombrage proche du champ')), None)
        res['fields'].append(dict(
            name=f.get('name') or f'Champ {k + 1}', tilt=float(f['tilt']), azimuth=float(f.get('azimuth') or 0),
            orientation=f.get('orientation') or 'portrait', length=f.get('length'), height=f.get('height'),
            n_h=r['_layout']['n_h'], n_v=r['_layout']['n_v'], n_modules_layout=r['_layout']['n_modules'],
            module=r['pan'].get('model'), n_modules=r['summary']['n_modules'], pnom_kwc=r['summary']['pnom_kwc'],
            n_series=int(f['n_series']), n_inv=int(f['n_inv']), n_str=int(f['n_str']), inverter=r['ond'].get('model'),
            pac_kva=r['summary']['pac_kva'], weight=wi, yield_kwh_kwc=r['summary']['yield_kwh_kwc'],
            pr=r['summary']['pr'], e_grid_mwh=r['summary']['e_grid_mwh'], glob_inc=r['summary']['glob_inc'],
            near_mask=near_l is not None and abs(near_l) > 0 or bool((files.get('near_masks') or {}).get(str(f.get('id')))),
            near_loss_pct=near_l))
    return res


def check_design(pan, ond, cfg):
    ns = int(cfg['array']['n_series'])
    alerts = []
    confs = cfg['structure'].get('shading_configs') or []
    if confs:
        tot = sum(float(c.get('share') or 0) for c in confs)
        if abs(tot - 100) > 0.01:
            alerts.append(dict(code='shading_share', level='block', title="Configurations d'ombrage électrique",
                               value=round(tot, 2), limit=100, unit='%',
                               message=f"La somme des parts de tables vaut {tot:.2f} % au lieu de 100 % : simulation bloquée."))
    if pan.get('mu_voc') is not None:
        voc_m10 = pan['voc'] + pan['mu_voc'] / 1000 * (-10 - 25)
    else:
        voc_m10 = float(module_point(pan, 1000.0, -10.0)[3][0])
    v_str = voc_m10 * ns
    block = v_str > ond['vabsmax']
    alerts.append(dict(code='voc_m10', level='block' if block else 'ok',
                       title='Tension à vide des chaînes à −10 °C',
                       value=round(v_str, 1), limit=ond['vabsmax'], unit='V',
                       message=(f"{ns} × {voc_m10:.2f} V = {v_str:.0f} V "
                                f"{'>' if block else '≤'} tension max. onduleur {ond['vabsmax']:.0f} V"
                                + (" : simulation bloquée, réduire le nombre de modules en série."
                                   if block else ""))))
    vmp60 = float(module_point(pan, 1000.0, 60.0)[2][0]) * ns
    low = vmp60 < ond['vmin']
    alerts.append(dict(code='vmp_60', level='warn' if low else 'ok',
                       title='Tension MPP des chaînes à 60 °C',
                       value=round(vmp60, 1), limit=ond['vmin'], unit='V',
                       message=(f"{ns} × {vmp60 / ns:.2f} V = {vmp60:.0f} V "
                                f"{'<' if low else '≥'} tension MPPT mini {ond['vmin']:.0f} V"
                                + (" : pertes par sortie de plage MPPT en été." if low else ""))))
    for n_inv, n_str in cfg['inverters']['groups']:
        i_dc = n_str * pan['isc']
        if ond['imax_dc'] and ond['imax_dc'] > 0:
            over = i_dc > ond['imax_dc']
            alerts.append(dict(code='idc', level='warn' if over else 'ok',
                               title=f'Courant DC max – groupe {n_inv} onduleur(s) × {n_str} chaînes',
                               value=round(i_dc, 1), limit=ond['imax_dc'], unit='A',
                               message=(f"{n_str} × Isc {pan['isc']:.2f} A = {i_dc:.0f} A "
                                        f"{'>' if over else '≤'} courant DC max. onduleur {ond['imax_dc']:.0f} A"
                                        + (" : écrêtage en courant possible." if over else ""))))
        else:
            alerts.append(dict(code='idc', level='warn', title='Courant DC max',
                               value=round(i_dc, 1), limit=None, unit='A',
                               message="Courant DC maximal non renseigné dans le .OND : vérification impossible."))
    return alerts


# ======================================================================================
# 5. Simulation
# ======================================================================================
DEFAULTS = dict(
    project=dict(name='Projet', variant='Var0', author=''),
    site=dict(lat=45.0, lon=0.0, alt=0.0, albedo=0.20),
    meteo=dict(tmy_has_horizon=None, gsa_mode='monthly', gsa_align_temp=False),
    horizon=dict(use=True),
    structure=dict(fields=[], type='fixed', tilt=16.0, azimuth=0.0, az_convention='sud0', pitch=9.01, width=7.19, height=0.80,
                   n_rows=17, n_high=3, orientation='portrait', sub_in_height=None, elec_effect=80.0,
                   shading_configs=[dict(sub_in_height=None, share=100.0)],
                   axis_azimuth=0.0, max_angle=55.0, backtrack=True, axis_height=1.5),
    array=dict(n_series=27, n_strings=128),
    inverters=dict(groups=[[4, 21], [2, 22]], t_offset=0.0, p_inj_kw=None),
    bifacial=dict(enabled=True, bifaciality=None, albedo_ground=0.17, rear_shading=5.0,
                  rear_mismatch=10.0, transparent=0.0),
    thermal=dict(uc=29.0, uv=0.0),
    iam=dict(mode='fresnel', n=1.526, n_ar=1.29),
    losses=dict(soiling=1.5, lid=1.0, quality=0.0, mismatch=1.0, string_mismatch=0.1,
                dc_ohmic=1.0, ac_ohmic=1.5, mv_line=0.1, availability=0.0,
                tr_enabled=True, tr_sn_kva=2210.0, tr_iron_kw=1.32, tr_cu_kw=13.24, tr_always_on=True,
                aux_w=500.0, aux_thresh_kw=500.0, aux_night_w=0.0, inv_night=False),
    p90=dict(meteo_var=3.0, items=[
        ['Variabilité météo future sur 10 ans', 2.0],
        ['Modélisation (pertes DC, AC, ombrages, T°, disponibilité)', 2.5],
        ['Pertes spectrales et réflexion', 1.5], ['Transposition', 1.0],
        ['Paramètres des modules PV', 2.0], ['Efficacité onduleur', 0.5], ['Encrassement', 1.0],
        ['Mismatch', 0.9], ['Estimation dégradation', 0.9]]),
    lifetime=dict(years=1, degradation=0.4),
)


def merge(base, over):
    out = json.loads(json.dumps(base))
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge(out[k], v)
        else:
            out[k] = v
    return out


def default_sub_in_height(st, pan):
    n_high = int(st.get('n_high', 1))
    if st.get('orientation', 'portrait') == 'landscape':
        return n_high * max(pan.get('ndiode', 3), 1)
    return n_high * (2 if pan.get('half_cells') else 1)


def _simulate_one(cfg_in, files):
    cfg = merge(DEFAULTS, cfg_in)
    pan = parse_pan(files['pan'])
    ond = parse_ond(files['ond'])
    alerts = check_design(pan, ond, cfg)
    if any(a['level'] == 'block' for a in alerts):
        return dict(ok=False, blocked=True, alerts=alerts, pan=_public(pan), ond=_public(ond))

    w, tmy_info = read_tmy(files['tmy'], files.get('tmy_name', ''))
    if cfg['meteo'].get('tmy_has_horizon') is None and tmy_info['use_horizon'] is not None:
        cfg['meteo']['tmy_has_horizon'] = bool(tmy_info['use_horizon'])
    site = cfg['site']
    loc = pvlib.location.Location(float(site['lat']), float(site['lon']), altitude=float(site['alt']))
    t_sun = w.index + pd.Timedelta(hours=tmy_info['offset_h'])
    sp = loc.get_solarposition(t_sun, temperature=w.temp_air.values)
    sp.index = w.index
    cz = pd.Series(np.cos(np.radians(sp['zenith'].values)), index=w.index).clip(lower=0)

    meteo_rows, gsa = None, None
    w_raw = w.copy()
    if files.get('gsa') and cfg['meteo'].get('gsa_mode', 'none') != 'none':
        gsa = parse_gsa(files['gsa']) if isinstance(files['gsa'], str) else files['gsa']
        w, meteo_rows = gsa_correct(w, sp, cz, gsa, cfg['meteo']['gsa_mode'],
                                    bool(cfg['meteo'].get('gsa_align_temp')))
    hz = parse_horizon(files['horizon']) if files.get('horizon') and cfg['horizon'].get('use', True) else None
    near = parse_horizon(files['near']) if files.get('near') else None

    dni_extra = pd.Series(irradiance.get_extra_radiation(t_sun).values, index=w.index)
    am = pd.Series(pvlib.atmosphere.get_relative_airmass(sp['apparent_zenith'].values), index=w.index)
    day = sp['apparent_zenith'] < 90

    st = cfg['structure']
    stype = st['type']
    # Azimuts saisis en convention PVsyst (0 = Sud, Est < 0, Ouest > 0) ; pvlib : 180 = Sud.
    # 'az_convention': 'pvlib' conserve l'ancienne saisie (180 = Sud) pour les appels Python existants.
    to_pvlib = (lambda a: (float(a) + 180.0) % 360) if st.get('az_convention', 'sud0') in ('sud0', 'pvsyst') \
        else (lambda a: float(a) % 360)
    if stype == 'tracker':
        # axe : PVsyst 0 = axe Nord-Sud (rotation vers l'Est le matin) -> pvlib axis_azimuth 180
        faces = [dict(kind='tracker', share=1.0, axis_azimuth=to_pvlib(st['axis_azimuth']),
                      max_angle=float(st['max_angle']), backtrack=bool(st['backtrack']), name='Tracker')]
    elif stype == 'ew':
        # orientation du faîtage : 0 (Sud) -> pan Est à -90° et pan Ouest à +90° (PVsyst)
        o = float(st.get('azimuth') or 0.0) if st.get('az_convention', 'sud0') in ('sud0', 'pvsyst') else float(st.get('azimuth', 180.0)) - 180.0
        faces = [dict(kind='fixed', share=0.5, tilt=float(st['tilt']), azimuth=(o - 90.0 + 180.0) % 360,
                      azimuth_pvsyst=((o - 90.0 + 180.0) % 360) - 180.0, name='Est'),
                 dict(kind='fixed', share=0.5, tilt=float(st['tilt']), azimuth=(o + 90.0 + 180.0) % 360,
                      azimuth_pvsyst=((o + 90.0 + 180.0) % 360) - 180.0, name='Ouest')]
    else:
        faces = [dict(kind='fixed', share=1.0, tilt=float(st['tilt']), azimuth=to_pvlib(st['azimuth']),
                      name=st.get('field_name') or 'Fixe')]
    bif = cfg['bifacial']
    bifaciality = float(bif['bifaciality']) if bif.get('bifaciality') not in (None, '') else (
        pan['bifaciality'] if pan['bifaciality'] else 0.0)
    bf = dict(enabled=bool(bif['enabled']) and bifaciality > 0, albedo_ground=float(bif['albedo_ground']),
              rear_shading=float(bif['rear_shading']), transparent=float(bif['transparent']))
    sub_h = st.get('sub_in_height') or default_sub_in_height(st, pan)
    iam_cfg = dict(cfg['iam'])
    iam_cfg['profile'] = pan['iam_profile']
    ctx = dict(w=w, sp=sp, day=day, dni_extra=dni_extra, am=am, structure=st, cfg_struct=st,
               bifacial=bf, losses=cfg['losses'], horizon=hz, near=near, albedo=float(site['albedo']),
               iam=iam_cfg, sub_in_height=sub_h, elec_effect=float(st['elec_effect']) / 100)
    L = cfg['losses']
    ns, nstr = int(cfg['array']['n_series']), int(cfg['array']['n_strings'])
    n_mod = ns * nstr
    pnom = n_mod * pan['pnom']
    eta_stc = pan['pnom'] / (1000 * pan['area'])

    # --- par face : irradiance -> puissance DC
    agg = {}
    acc = lambda k, s, share: agg.__setitem__(k, agg.get(k, 0) + s * share)
    p_dc = pd.Series(0.0, index=w.index)
    v_w = pd.Series(0.0, index=w.index)
    face_info = []
    for face in faces:
        fi = face_irradiance(ctx, face)
        share = face['share']
        g_eff = fi['front_eff'] + bifaciality * fi['rear_eff'] if bf['enabled'] else fi['front_eff']
        t_cell = temperature.pvsyst_cell(g_eff, w.temp_air, w.wind_speed, u_c=float(cfg['thermal']['uc']),
                                         u_v=float(cfg['thermal']['uv']), module_efficiency=eta_stc,
                                         alpha_absorption=pan['absorb'])
        mask = g_eff > 1
        gp = g_eff.clip(lower=0.1)
        pm, im, vm, _ = module_point(pan, gp.values, t_cell.values)
        p_mod = pd.Series(pm, index=w.index).clip(lower=0).where(mask, 0)
        i_mod = pd.Series(im, index=w.index).where(mask, 0)
        v_mod = pd.Series(vm, index=w.index).where(mask, 0)
        pm25, _, _, _ = module_point(pan, gp.values, np.full(len(gp), 25.0))
        p_mod25 = pd.Series(pm25, index=w.index).clip(lower=0).where(mask, 0)
        nm = n_mod * share
        p_nom_stc = g_eff / 1000 * pnom * share
        p_irr = p_mod25 * nm
        p_tmp = p_mod * nm
        elec_frac = (fi['elec_irr'] / g_eff.where(mask)).fillna(0).clip(0, 1)
        p1 = p_tmp * (1 - elec_frac)
        p2 = p1 * (1 - L['lid'] / 100)
        p3 = p2 * (1 - L['quality'] / 100) * (1 - L['mismatch'] / 100) * (1 - L['string_mismatch'] / 100)
        rear_share = ((bifaciality * fi['rear_eff'] / g_eff.where(mask)).fillna(0)
                      if bf['enabled'] else 0.0)
        p4 = p3 * (1 - float(bif['rear_mismatch']) / 100 * rear_share)
        i_rel = i_mod / pan['imp']
        p5 = p4 * (1 - L['dc_ohmic'] / 100 * i_rel)
        p_dc += p5
        v_w += v_mod * ns * (1 - L['dc_ohmic'] / 100 * i_rel) * p5
        for k, s in (('glob_inc0', fi['glob_inc0']), ('glob_inc', fi['glob_inc']), ('glob_inc_near', fi['glob_inc_near']),
                     ('front_after_shade', fi['front_after_shade']), ('front_soil', fi['front_soil']),
                     ('front_eff', fi['front_eff']), ('rear_inc', fi['rear_inc']),
                     ('rear_eff', fi['rear_eff']), ('g_eff', g_eff)):
            acc(k, s, share)
        for k, s in (('p_nom', p_nom_stc), ('p_irr', p_irr), ('p_tmp', p_tmp), ('p1', p1), ('p2', p2),
                     ('p3', p3), ('p4', p4), ('p5', p5)):
            acc(k, s, 1.0)
        acc('t_cell_w', t_cell * p5, 1.0)
        face_info.append(dict(name=face['name'], share=share,
                              azimuth_pvsyst=round((face.get('azimuth', 180.0) % 360) - 180.0, 1)
                              if face['kind'] == 'fixed' else None,
                              diffuse_attenuation=round(fi['diff_att'], 4),
                              horizon_diffuse_factor=round(fi['f_hz'], 4)))
    v_arr = (v_w / p_dc.where(p_dc > 0)).fillna(0)
    t_cell_mean = (agg['t_cell_w'] / p_dc.where(p_dc > 0)).fillna(w.temp_air)

    # --- onduleurs
    curves = ond['curves']
    vref = np.array(ond['vnom_eff'], float)
    funcs = []
    for pts in curves:
        pts = np.array(pts)
        interp = PchipInterpolator(pts[:, 0], pts[:, 1])
        pmax_c, eff_top, p0 = pts[-1, 0], pts[-1, 1] / pts[-1, 0], pts[0, 0]
        funcs.append((interp, pmax_c, eff_top, p0))

    def inv_eff(pin, v):
        pin = np.asarray(pin, float)
        effs = []
        for interp, pmax_c, eff_top, p0 in funcs:
            e = np.where(pin > p0, interp(np.clip(pin, p0, pmax_c)) / np.where(pin > 0, pin, 1), 0.0)
            effs.append(np.where(pin > pmax_c, eff_top, e))
        effs = np.vstack(effs)
        if len(vref) == 1:
            return effs[0]
        vv = np.clip(np.asarray(v, float), vref.min(), vref.max())
        out = np.empty_like(pin)
        order = np.argsort(vref)
        for j in range(len(pin)):
            out[j] = np.interp(vv[j], vref[order], effs[order, j])
        return out

    t_inv = w.temp_air + float(cfg['inverters'].get('t_offset', 0.0))
    tp, pp = [], []
    for t_, p_ in ((ond['t_pmax'], ond['pmax']), (ond['t_pnom'], ond['pnom']),
                   (ond['t_lim1'], ond['p_lim1']), (ond['t_limabs'], ond['p_limabs'])):
        if t_ is not None and p_ and (not tp or t_ > tp[-1]):
            tp.append(t_)
            pp.append(p_)
    pmax_t = pd.Series(np.interp(t_inv, tp, pp) if tp else ond['pmax'], index=w.index)
    groups = [(int(a), int(b)) for a, b in cfg['inverters']['groups']]
    n_inv_tot = sum(a for a, b in groups)
    str_tot = sum(a * b for a, b in groups)
    pac_tot = pd.Series(0.0, index=w.index)
    loss_eff = loss_clip = loss_th = loss_vmin = pd.Series(0.0, index=w.index)
    for n_inv, n_str in groups:
        pdc_i = p_dc * (n_inv * n_str / str_tot) / n_inv
        below = pdc_i < ond['pseuil']
        loss_th = loss_th + pdc_i.where(below, 0) * n_inv
        pdc_i = pdc_i.where(~below, 0)
        # sortie de plage MPPT basse : l'onduleur se cale sur Vmin (perte approchée sur la courbe P-V)
        low_v = (v_arr > 0) & (v_arr < ond['vmin'])
        f_v = (v_arr / ond['vmin']).clip(upper=1).where(low_v, 1.0)
        loss_vmin = loss_vmin + pdc_i * (1 - f_v) * n_inv
        pdc_i = pdc_i * f_v
        eff = pd.Series(inv_eff(pdc_i.values, v_arr.values), index=w.index).where(pdc_i > 0, 0)
        pac_unclip = pdc_i * eff
        pac_i = np.minimum(pac_unclip, pmax_t)
        loss_clip = loss_clip + ((pac_unclip - pac_i) / eff.where(eff > 0, 1)) * n_inv
        loss_eff = loss_eff + (pdc_i - pac_unclip) * n_inv
        pac_tot = pac_tot + pac_i * n_inv
    night = pac_tot <= 0
    inv_night = pd.Series(np.where(night, ond['night_w'] * n_inv_tot, 0.0), index=w.index) \
        if L.get('inv_night') else pd.Series(0.0, index=w.index)

    # --- AC
    p_ac_ref = ond['pmax'] * n_inv_tot
    aux = pd.Series(np.where(pac_tot > float(L['aux_thresh_kw']) * 1e3, float(L['aux_w']),
                             np.where(night, float(L.get('aux_night_w', 0)), 0.0)), index=w.index)
    p_a = pac_tot - aux - inv_night
    ac_loss = L['ac_ohmic'] / 100 * (p_a.clip(lower=0) / p_ac_ref) * p_a.clip(lower=0)
    p_b = p_a - ac_loss
    if L.get('tr_enabled', True):
        iron = float(L['tr_iron_kw']) * 1e3
        iron_s = pd.Series(iron, index=w.index) if L.get('tr_always_on', True) \
            else pd.Series(np.where(night, 0.0, iron), index=w.index)
        tr_loss = iron_s + float(L['tr_cu_kw']) * 1e3 * (p_b.clip(lower=0) / (float(L['tr_sn_kva']) * 1e3)) ** 2
    else:
        tr_loss = pd.Series(0.0, index=w.index)
    p_c = p_b - tr_loss
    mv_loss = L['mv_line'] / 100 * (p_c.clip(lower=0) / p_ac_ref) * p_c.clip(lower=0)
    p_d = p_c - mv_loss
    p_inj = cfg['inverters'].get('p_inj_kw')
    if p_inj not in (None, '', 0):
        p_e = np.minimum(p_d, float(p_inj) * 1e3)
    else:
        p_e = p_d
    inj_loss = p_d - p_e
    avail = 1 - float(L.get('availability', 0.0)) / 100
    p_grid = p_e * avail
    avail_loss = p_e * (1 - avail)

    # --- agrégats
    pkwp = pnom / 1000
    S = lambda s: float(np.sum(s))
    df = pd.DataFrame({
        'GlobHor': w.ghi / 1000, 'DiffHor': w.dhi / 1000, 'T_Amb': w.temp_air,
        'GlobInc': agg['glob_inc0'] / 1000, 'GlobInc_masque': agg['glob_inc'] / 1000,
        'GlobEff': agg['front_eff'] / 1000, 'RearInc': agg['rear_inc'] / 1000,
        'RearEff': agg['rear_eff'] / 1000, 'EArray': p_dc / 1000, 'E_Inv': pac_tot / 1000,
        'E_Grid': p_grid / 1000})
    mon = df.groupby(df.index.month).agg(
        {'GlobHor': 'sum', 'DiffHor': 'sum', 'T_Amb': 'mean', 'GlobInc': 'sum', 'GlobInc_masque': 'sum',
         'GlobEff': 'sum', 'RearInc': 'sum', 'RearEff': 'sum', 'EArray': 'sum', 'E_Inv': 'sum',
         'E_Grid': 'sum'})
    tot = df.agg({'GlobHor': 'sum', 'DiffHor': 'sum', 'T_Amb': 'mean', 'GlobInc': 'sum',
                  'GlobInc_masque': 'sum', 'GlobEff': 'sum', 'RearInc': 'sum', 'RearEff': 'sum',
                  'EArray': 'sum', 'E_Inv': 'sum', 'E_Grid': 'sum'})
    mon.loc[13] = tot
    mon['Yield'] = mon['E_Grid'] / pkwp
    mon['PR'] = mon['E_Grid'] / (mon['GlobInc'] * pkwp)
    mon['PR_bifi'] = mon['E_Grid'] / ((mon['GlobInc'] + bifaciality * mon['RearInc'] * (1 if bf['enabled'] else 0)) * pkwp)
    monthly = []
    for i, (m, r) in enumerate(mon.iterrows()):
        monthly.append(dict(mois=MONTHS[m - 1] if m <= 12 else 'Année',
                            ghi=r.GlobHor, dhi=r.DiffHor, t_amb=r.T_Amb, glob_inc=r.GlobInc,
                            glob_eff=r.GlobEff, rear_inc=r.RearInc, e_array=r.EArray / 1000,
                            e_inv=r.E_Inv / 1000, e_grid=r.E_Grid / 1000, yield_=r.Yield,
                            pr=r.PR, pr_bifi=r.PR_bifi))

    gh, gi0 = S(w.ghi), S(agg['glob_inc0'])
    steps = [
        ('irr', 'Irradiation globale horizontale', None, gh / 1000, 'kWh/m²'),
        ('irr', 'Transposition dans le plan (GlobInc)', gi0 / gh - 1, gi0 / 1000, 'kWh/m²'),
        ('irr', 'Masque lointain (horizon)', S(agg['glob_inc']) / gi0 - 1, S(agg['glob_inc']) / 1000, 'kWh/m²'),
    ]
    if st.get('roof'):
        steps.append(('irr', 'Ombrage proche du champ (masque)', S(agg['glob_inc_near']) / S(agg['glob_inc']) - 1,
                      S(agg['glob_inc_near']) / 1000, 'kWh/m²'))
    steps += [
        ('irr', "Ombrages proches : perte d'irradiance", S(agg['front_after_shade']) / S(agg['glob_inc_near']) - 1,
         S(agg['front_after_shade']) / 1000, 'kWh/m²'),
        ('irr', 'Salissure', S(agg['front_soil']) / S(agg['front_after_shade']) - 1, S(agg['front_soil']) / 1000, 'kWh/m²'),
        ('irr', 'IAM sur le global', S(agg['front_eff']) / S(agg['front_soil']) - 1, S(agg['front_eff']) / 1000, 'kWh/m²'),
    ]
    if bf['enabled']:
        steps.append(('irr', 'Gain face arrière (bifacial)', S(agg['g_eff']) / S(agg['front_eff']) - 1,
                      S(agg['g_eff']) / 1000, 'kWh/m²'))
    e_nom = S(agg['p_nom'])
    steps += [
        ('dc', 'Énergie nominale du champ (rendement STC)', None, e_nom / 1e6, 'MWh'),
        ('dc', "Perte due au niveau d'irradiance", S(agg['p_irr']) / e_nom - 1, S(agg['p_irr']) / 1e6, 'MWh'),
        ('dc', 'Perte due à la température', S(agg['p_tmp']) / S(agg['p_irr']) - 1, S(agg['p_tmp']) / 1e6, 'MWh'),
        ('dc', 'Ombrage électrique selon chaînes', S(agg['p1']) / S(agg['p_tmp']) - 1, S(agg['p1']) / 1e6, 'MWh'),
        ('dc', 'LID', S(agg['p2']) / S(agg['p1']) - 1, S(agg['p2']) / 1e6, 'MWh'),
        ('dc', 'Qualité, mismatch modules et chaînes', S(agg['p3']) / S(agg['p2']) - 1, S(agg['p3']) / 1e6, 'MWh'),
        ('dc', 'Mismatch face arrière', S(agg['p4']) / S(agg['p3']) - 1, S(agg['p4']) / 1e6, 'MWh'),
        ('dc', 'Pertes ohmiques DC', S(agg['p5']) / S(agg['p4']) - 1, S(agg['p5']) / 1e6, 'MWh'),
    ]
    e_dc = S(p_dc)
    e_inv = S(pac_tot)
    steps += [
        ('inv', 'Énergie virtuelle du champ au MPP', None, e_dc / 1e6, 'MWh'),
        ('inv', 'Onduleur : seuil de puissance', -S(loss_th) / e_dc, None, 'MWh'),
        ('inv', 'Onduleur : tension sous la plage MPPT', -S(loss_vmin) / e_dc, None, 'MWh'),
        ('inv', 'Onduleur : rendement', -S(loss_eff) / e_dc, None, 'MWh'),
        ('inv', 'Onduleur : surpuissance / déclassement en température', -S(loss_clip) / e_dc,
         e_inv / 1e6, 'MWh'),
        ('ac', 'Auxiliaires et consommation de nuit', -(S(aux) + S(inv_night)) / e_inv, S(p_a) / 1e6, 'MWh'),
        ('ac', 'Pertes ohmiques AC', -S(ac_loss) / S(p_a), S(p_b) / 1e6, 'MWh'),
        ('ac', 'Transformateur', -S(tr_loss) / S(p_b) if S(p_b) else 0, S(p_c) / 1e6, 'MWh'),
        ('ac', 'Ligne HTA', -S(mv_loss) / S(p_c) if S(p_c) else 0, S(p_d) / 1e6, 'MWh'),
        ('ac', "Limitation de puissance d'injection", -S(inj_loss) / S(p_d) if S(p_d) else 0, S(p_e) / 1e6, 'MWh'),
        ('ac', 'Indisponibilité', -S(avail_loss) / S(p_e) if S(p_e) else 0, S(p_grid) / 1e6, 'MWh'),
        ('ac', 'Énergie injectée sur le réseau', None, S(p_grid) / 1e6, 'MWh'),
    ]
    loss_list = [dict(stage=a, label=b, pct=None if c is None else 100 * c, value=d, unit=e)
                 for a, b, c, d, e in steps]

    # --- P50 / P90
    y50 = float(mon.loc[13, 'Yield'])
    p90, lifetime = compute_p90(y50, pkwp, cfg, files)
    pxx = {90: p90['p90']}

    # --- trajectoires solaires pour le graphique de masque (solstices / équinoxe)
    sunpaths = []
    for d in ('1990-06-21', '1990-03-20', '1990-12-21'):
        tt = pd.date_range(d, periods=24 * 6, freq='10min', tz='UTC')
        s = loc.get_solarposition(tt)
        s = s[s.apparent_elevation > 0]
        sunpaths.append(dict(date=d[5:], az=[round(a - 180, 1) for a in s.azimuth],
                             el=[round(e, 1) for e in s.apparent_elevation]))

    summary = dict(
        e_grid_mwh=S(p_grid) / 1e6, yield_kwh_kwc=y50, pr=float(mon.loc[13, 'PR']),
        pr_bifi=float(mon.loc[13, 'PR_bifi']), pnom_kwc=pkwp, pac_kva=p_ac_ref / 1000,
        dc_ac=pnom / p_ac_ref, n_modules=n_mod, n_inverters=n_inv_tot,
        glob_hor=gh / 1000, glob_inc=gi0 / 1000, rear_inc=S(agg['rear_inc']) / 1000,
        t_amb=float(w.temp_air.mean()), bifaciality=bifaciality if bf['enabled'] else 0,
        sub_in_height=sub_h, gcr=float(st['width']) / float(st['pitch']),
        limit_angle=_limit_angle(st) if stype != 'tracker' else None,
        vmpp_mean=float(v_arr[p_dc > 0].mean()) if (p_dc > 0).any() else None,
        hours_tinv_over_tpmax=int((t_inv > (ond['t_pmax'] or 99)).sum()),
        p90=pxx[90], p90_mwh=pxx[90] * pkwp / 1000,
    )
    hourly = pd.DataFrame({
        'GHI': w.ghi.round(1), 'DHI': w.dhi.round(1), 'DNI': w.dni.round(1), 'T_amb': w.temp_air.round(2),
        'GlobInc': agg['glob_inc0'].round(1), 'GlobEff': agg['front_eff'].round(1),
        'RearEff': agg['rear_eff'].round(1), 'T_cell': t_cell_mean.round(2), 'V_dc': v_arr.round(1),
        'P_dc_kW': (p_dc / 1000).round(2), 'P_ac_kW': (pac_tot / 1000).round(2),
        'P_grid_kW': (p_grid / 1000).round(2)})
    hourly.index = hourly.index.strftime('%m-%d %H:%M')
    res = dict(ok=True, blocked=False, engine=ENGINE_VERSION, pvlib=pvlib.__version__,
               config=cfg, summary=summary, monthly=monthly, losses=loss_list, alerts=alerts,
               p90=p90, lifetime=lifetime, faces=face_info, meteo_correction=meteo_rows,
               tmy_info=tmy_info, gsa=gsa, horizon=hz.tolist() if hz is not None else None,
               sunpaths=sunpaths, pan=_public(pan), ond=_public(ond),
               daily_kwh=[float(x) for x in (p_grid.groupby(p_grid.index.dayofyear).sum() / 1000).values])
    res['_hourly'] = hourly
    return res


def compute_p90(y50, pkwp, cfg, files):
    """P50/P75/P90/P99 : sigma = racine de la somme des carrés, Px = P50 x (1 - z_x sigma)."""
    p90cfg = cfg['p90']
    meteo_var = p90cfg.get('meteo_var')
    var_source = 'saisie'
    if files.get('pvgis_monthly'):
        try:
            mv = parse_pvgis_monthly(files['pvgis_monthly'])
            if mv['variability'] is not None:
                meteo_var = 100 * mv['variability']
                var_source = f"PVGIS mensuel {mv['years'][0]}-{mv['years'][-1]} ({len(mv['years'])} ans)"
        except ValueError:
            pass
    items = [['Variabilité météo interannuelle', float(meteo_var or 0)]] + \
        [[a, float(b)] for a, b in p90cfg['items']]
    sigma = math.sqrt(sum(b ** 2 for a, b in items))
    pxx = {p: y50 * (1 - norm.ppf(p / 100) * sigma / 100) for p in (75, 90, 99)}
    p90 = dict(p50=y50, sigma_pct=sigma, items=items, meteo_var_source=var_source,
               p75=pxx[75], p90=pxx[90], p99=pxx[99], p90_ratio=pxx[90] / y50 if y50 else None,
               p50_mwh=y50 * pkwp / 1000, p90_mwh=pxx[90] * pkwp / 1000, z90=norm.ppf(0.9))
    years = int(cfg['lifetime'].get('years', 1) or 1)
    deg = float(cfg['lifetime'].get('degradation', 0) or 0) / 100
    lifetime = [dict(annee=y, p50=y50 * (1 - deg) ** (y - 1), p90=pxx[90] * (1 - deg) ** (y - 1),
                     e_p50_mwh=y50 * (1 - deg) ** (y - 1) * pkwp / 1000) for y in range(1, years + 1)]
    return p90, lifetime


def shading_configs(cfg, pan):
    """Configurations d'ombrage électrique : [{sub_in_height, share (%), auto}]."""
    st = cfg['structure']
    confs = st.get('shading_configs') or [dict(sub_in_height=st.get('sub_in_height'), share=100.0)]
    out = []
    for c in confs:
        n = c.get('sub_in_height')
        auto = n in (None, '', 0)
        out.append(dict(sub_in_height=int(default_sub_in_height(st, pan) if auto else n),
                        share=float(c.get('share') or 0), auto=auto))
    return out


def simulate(cfg_in, files):
    """Une étude de productible par configuration d'ombrage électrique, puis moyenne pondérée
    (part des tables) de toutes les grandeurs : séries horaires, bilans mensuels, pertes, synthèse, P90."""
    cfg = merge(DEFAULTS, cfg_in)
    if cfg['structure'].get('type') == 'roof':
        return _simulate_roof(cfg, files)
    pan = parse_pan(files['pan'])
    ond = parse_ond(files['ond'])
    alerts = check_design(pan, ond, cfg)
    if any(a['level'] == 'block' for a in alerts):
        return dict(ok=False, blocked=True, alerts=alerts, pan=_public(pan), ond=_public(ond))
    confs = shading_configs(cfg, pan)
    runs = []
    for c in confs:
        if c['share'] <= 0:
            continue
        cc = json.loads(json.dumps(cfg))
        cc['structure']['sub_in_height'] = c['sub_in_height']
        cc['structure']['shading_configs'] = [dict(sub_in_height=c['sub_in_height'], share=100.0)]
        r = _simulate_one(cc, files)
        if not r.get('ok'):
            r['alerts'] = check_design(pan, parse_ond(files['ond']), cfg)
            return r
        runs.append((c, r))
    if not runs:
        return dict(ok=False, blocked=True, alerts=check_design(pan, parse_ond(files['ond']), cfg),
                    pan=_public(pan), ond=_public(parse_ond(files['ond'])))
    tot = sum(c['share'] for c, _ in runs)
    wts = [c['share'] / tot for c, _ in runs]
    base = runs[0][1]

    def wavg(get):
        vals = [get(r) for _, r in runs]
        if any(v is None for v in vals):
            return vals[0]
        return sum(w * v for w, v in zip(wts, vals))

    res = dict(base)
    res['config'] = cfg
    res['alerts'] = check_design(pan, parse_ond(files['ond']), cfg)
    # bilans mensuels : toutes les grandeurs sont linéaires (même GlobInc) -> moyenne pondérée exacte
    res['monthly'] = []
    for i, m in enumerate(base['monthly']):
        row = dict(m)
        for k, v in m.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                row[k] = wavg(lambda r, i=i, k=k: r['monthly'][i][k])
        res['monthly'].append(row)
    # diagramme de pertes : valeurs pondérées, pourcentages recalculés quand c'est possible
    losses, prev = [], None
    for i, l in enumerate(base['losses']):
        row = dict(l)
        row['value'] = wavg(lambda r, i=i: r['losses'][i]['value'])
        if l['pct'] is not None:
            row['pct'] = wavg(lambda r, i=i: r['losses'][i]['pct'])
            if row['value'] is not None and prev not in (None, 0) and l['stage'] in ('irr', 'dc'):
                row['pct'] = 100 * (row['value'] / prev - 1)
        losses.append(row)
        if row['value'] is not None:
            prev = row['value']
    res['losses'] = losses
    summ = dict(base['summary'])
    for k, v in base['summary'].items():
        if isinstance(v, (int, float)) and not isinstance(v, bool) and k not in ('sub_in_height',):
            summ[k] = wavg(lambda r, k=k: r['summary'][k])
    summ['sub_in_height'] = ' / '.join(str(c['sub_in_height']) for c, _ in runs)
    pkwp = summ['pnom_kwc']
    res['p90'], res['lifetime'] = compute_p90(summ['yield_kwh_kwc'], pkwp, cfg, files)
    summ['p90'], summ['p90_mwh'] = res['p90']['p90'], res['p90']['p90_mwh']
    res['summary'] = summ
    res['daily_kwh'] = [sum(w * r['daily_kwh'][j] for w, (_, r) in zip(wts, runs)) for j in range(len(base['daily_kwh']))]
    hr = sum(w * r['_hourly'] for w, (_, r) in zip(wts, runs))
    res['_hourly'] = hr.round(2)
    res['shading_configs'] = []
    for (c, r), w in zip(runs, wts):
        el = next((l['pct'] for l in r['losses'] if l['label'].startswith('Ombrage électrique')), None)
        res['shading_configs'].append(dict(sub_in_height=c['sub_in_height'], auto=c['auto'], share=c['share'],
                                           weight=w, yield_kwh_kwc=r['summary']['yield_kwh_kwc'],
                                           e_grid_mwh=r['summary']['e_grid_mwh'] * w, pr=r['summary']['pr'],
                                           elec_loss_pct=el))
    return res


def _limit_angle(st):
    t = math.radians(float(st['tilt']))
    r = float(st['pitch']) / float(st['width'])
    return math.degrees(math.atan(math.sin(t) / (r - math.cos(t))))


def _public(d):
    out = {}
    for k, v in d.items():
        if k in ('curves',):
            out[k] = [[list(p) for p in c] for c in v]
        elif isinstance(v, (int, float, str, bool, list)) or v is None:
            out[k] = v
        elif isinstance(v, np.generic):
            out[k] = v.item()
    return out


def to_json(res):
    r = {k: v for k, v in res.items() if not k.startswith('_')}
    return json.dumps(r, default=lambda o: o.item() if isinstance(o, np.generic) else str(o))


# ======================================================================================
# 6. Export Excel
# ======================================================================================
def export_xlsx(res):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
    wb = Workbook()
    H = Font(bold=True, color='FFFFFF')
    HF = PatternFill('solid', fgColor='18212B')
    T = Font(bold=True, size=14)
    thin = Side(style='thin', color='E2E6EB')

    def table(ws, r0, headers, rows, fmts=None):
        for j, h in enumerate(headers, 1):
            c = ws.cell(r0, j, h)
            c.font, c.fill = H, HF
            c.alignment = Alignment(wrap_text=True, vertical='center')
        for i, row in enumerate(rows, 1):
            for j, v in enumerate(row, 1):
                c = ws.cell(r0 + i, j, v)
                c.border = Border(bottom=thin)
                if fmts and j - 1 < len(fmts) and fmts[j - 1]:
                    c.number_format = fmts[j - 1]
        return r0 + len(rows) + 2

    def widths(ws, ws_w):
        for j, x in enumerate(ws_w, 1):
            ws.column_dimensions[get_column_letter(j)].width = x

    cfg, s, p9 = res['config'], res['summary'], res['p90']
    # Synthèse
    ws = wb.active
    ws.title = 'Synthèse'
    ws['A1'] = f"{cfg['project']['name']} – {cfg['project']['variant']}"
    ws['A1'].font = T
    ws['A2'] = f"Calcul productible v{res['engine']} (pvlib {res['pvlib']}) – {cfg['project'].get('author', '')}"
    rows = [['Puissance DC', s['pnom_kwc'], 'kWc'], ['Puissance AC (Pmax)', s['pac_kva'], 'kVA'],
            ['Ratio DC/AC', s['dc_ac'], ''], ['GHI', s['glob_hor'], 'kWh/m²'],
            ['Irradiation dans le plan (GlobInc)', s['glob_inc'], 'kWh/m²'],
            ['Irradiation arrière', s['rear_inc'], 'kWh/m²'],
            ['Énergie injectée P50', s['e_grid_mwh'], 'MWh/an'],
            ['Productible spécifique P50', s['yield_kwh_kwc'], 'kWh/kWc/an'],
            ['Performance ratio', s['pr'], ''], ['PR bifacial', s['pr_bifi'], ''],
            ['Productible P90', p9['p90'], 'kWh/kWc/an'], ['Énergie P90', p9['p90_mwh'], 'MWh/an'],
            ['Incertitude combinée (1σ)', p9['sigma_pct'] / 100, '']]
    table(ws, 4, ['Indicateur', 'Valeur', 'Unité'], rows, [None, '#,##0.0', None])
    for r in (12, 13, 17):
        ws.cell(r, 2).number_format = '0.0%'
    ws.cell(17, 2).number_format = '0.00%'
    widths(ws, [42, 16, 14])

    # Hypothèses
    ws = wb.create_sheet('Hypothèses')
    flat = []

    def walk(prefix, d):
        for k, v in d.items():
            if isinstance(v, dict):
                walk(f"{prefix}{k}.", v)
            else:
                flat.append([f"{prefix}{k}", json.dumps(v, ensure_ascii=False) if isinstance(v, list) else v])
    walk('', cfg)
    r = table(ws, 1, ['Paramètre saisi', 'Valeur'], flat)
    pan_rows = [[k, v if not isinstance(v, list) else json.dumps(v)] for k, v in res['pan'].items()]
    r = table(ws, r, ['Module (.PAN)', 'Valeur'], pan_rows)
    ond_rows = [[k, v if not isinstance(v, list) else json.dumps(v)[:3000]] for k, v in res['ond'].items()]
    r = table(ws, r, ['Onduleur (.OND)', 'Valeur'], ond_rows)
    ti = [[k, v] for k, v in res['tmy_info'].items()]
    r = table(ws, r, ['Fichier météo', 'Valeur'], ti)
    fa = [[f['name'], f['share'], f['diffuse_attenuation'], f['horizon_diffuse_factor']] for f in res['faces']]
    table(ws, r, ['Face', 'Part des chaînes', 'Atténuation diffus (ombrage proche)', 'Facteur diffus horizon'], fa)
    widths(ws, [44, 60, 22, 22])

    # Météo
    ws = wb.create_sheet('Météo')
    if res['meteo_correction']:
        rows = [[m['mois'], m['ghi_tmy'], m['ghi_cible'], m['ghi_corrige'], m['dif_tmy'], m['dif_cible'],
                 m['dif_corrige'], m['k_direct'], m['k_diffus'], m.get('dT'), m['t_moy'], m['heures_ecretees']]
                for m in res['meteo_correction']]
        table(ws, 1, ['Mois', 'GHI TMY', 'GHI cible GSA', 'GHI corrigé', 'DIF TMY', 'DIF cible', 'DIF corrigé',
                      'k direct', 'k diffus', 'ΔT appliqué', 'T moy.', 'h écrêtées'], rows,
              [None] + ['0.0'] * 6 + ['0.000', '0.000', '0.00', '0.0', '0'])
    else:
        ws['A1'] = 'TMY utilisé sans recalage'
    widths(ws, [10] + [13] * 11)

    # Mensuel
    ws = wb.create_sheet('Résultats mensuels')
    rows = [[m['mois'], m['ghi'], m['dhi'], m['t_amb'], m['glob_inc'], m['glob_eff'], m['rear_inc'],
             m['e_array'], m['e_inv'], m['e_grid'], m['yield_'], m['pr'], m['pr_bifi']] for m in res['monthly']]
    table(ws, 1, ['Mois', 'GHI kWh/m²', 'DIF kWh/m²', 'T amb °C', 'GlobInc kWh/m²', 'GlobEff kWh/m²',
                  'Arrière kWh/m²', 'E champ MWh', 'E onduleurs MWh', 'E injectée MWh', 'kWh/kWc', 'PR',
                  'PR bifacial'], rows,
          [None, '0.0', '0.0', '0.0', '0.0', '0.0', '0.0', '#,##0.0', '#,##0.0', '#,##0.0', '0.0', '0.0%', '0.0%'])
    widths(ws, [10] + [14] * 12)

    # Pertes
    ws = wb.create_sheet('Diagramme de pertes')
    rows = [[l['label'], None if l['pct'] is None else l['pct'] / 100, l['value'], l['unit']]
            for l in res['losses']]
    table(ws, 1, ['Poste', 'Variation', 'Valeur après poste', 'Unité'], rows, [None, '+0.00%;-0.00%', '#,##0.0', None])
    widths(ws, [52, 12, 18, 10])

    # P90
    ws = wb.create_sheet('P50-P90')
    rows = [[a, b / 100] for a, b in p9['items']]
    r = table(ws, 1, ['Incertitude', 'Écart-type'], rows, [None, '0.0%'])
    rows = [['Incertitude combinée (racine de la somme des carrés)', p9['sigma_pct'] / 100],
            ['Source variabilité météo', p9['meteo_var_source']],
            ['P50 (kWh/kWc)', p9['p50']], ['P75 (kWh/kWc)', p9['p75']], ['P90 (kWh/kWc)', p9['p90']],
            ['P99 (kWh/kWc)', p9['p99']], ['P90 / P50', p9['p90_ratio']],
            ['P50 (MWh)', p9['p50_mwh']], ['P90 (MWh)', p9['p90_mwh']]]
    r0 = r
    r = table(ws, r, ['Résultat', 'Valeur'], rows)
    ws.cell(r0 + 1, 2).number_format = '0.00%'
    ws.cell(r0 + 7, 2).number_format = '0.0%'
    rows = [[l['annee'], l['p50'], l['p90'], l['e_p50_mwh']] for l in res['lifetime']]
    table(ws, r, ['Année', 'P50 kWh/kWc', 'P90 kWh/kWc', 'P50 MWh'], rows, [None, '0.0', '0.0', '#,##0.0'])
    widths(ws, [56, 18, 18, 14])

    # Champs de toiture
    if res.get('fields'):
        ws = wb.create_sheet('Champs')
        rows = [[f['name'], f['tilt'], f['azimuth'], f['orientation'], f['length'], f['height'],
                 f"{f['n_h']} × {f['n_v']}", f['n_modules_layout'], f['module'], f['n_modules'], f['pnom_kwc'],
                 f"{f['n_inv']} × {f['n_str']} chaînes de {f['n_series']}", f['inverter'], f['pac_kva'],
                 'oui' if f['near_mask'] else 'non', None if f['near_loss_pct'] is None else f['near_loss_pct'] / 100,
                 f['glob_inc'], f['yield_kwh_kwc'], f['pr'], f['e_grid_mwh']] for f in res['fields']]
        s = res['summary']
        rows.append(['Total', None, None, None, None, None, None, sum(f['n_modules_layout'] for f in res['fields']), None,
                     s['n_modules'], s['pnom_kwc'], None, None, s['pac_kva'], None, None, s['glob_inc'],
                     s['yield_kwh_kwc'], s['pr'], s['e_grid_mwh']])
        table(ws, 1, ['Champ', 'Inclinaison °', 'Azimut ° (0 = Sud)', 'Pose', 'Longueur m', 'Hauteur m', 'Calepinage',
                      'Modules posables', 'Module', 'Modules câblés', 'kWc', 'Câblage', 'Onduleur', 'kVA',
                      'Masque proche', 'Perte masque proche', 'GlobInc kWh/m²', 'kWh/kWc', 'PR', 'E injectée MWh'], rows,
              [None, '0.0', '0', None, '0.00', '0.00', None, '0', None, '0', '#,##0.00', None, None, '#,##0.0', None,
               '+0.00%;-0.00%', '0.0', '0.0', '0.0%', '#,##0.0'])
        widths(ws, [16, 11, 13, 10, 11, 10, 11, 11, 26, 11, 10, 24, 26, 9, 10, 12, 12, 10, 8, 12])

    # Configurations d'ombrage électrique
    if res.get('shading_configs'):
        ws = wb.create_sheet('Ombrage électrique')
        rows = [[i + 1, c['sub_in_height'], 'auto' if c['auto'] else 'saisi', c['share'] / 100,
                 None if c['elec_loss_pct'] is None else c['elec_loss_pct'] / 100, c['yield_kwh_kwc'], c['pr'],
                 c['e_grid_mwh']] for i, c in enumerate(res['shading_configs'])]
        rows.append(['Total pondéré', '', '', sum(c['share'] for c in res['shading_configs']) / 100, None,
                     res['summary']['yield_kwh_kwc'], res['summary']['pr'], res['summary']['e_grid_mwh']])
        table(ws, 1, ['Configuration', 'Sous-chaînes en hauteur', 'Origine', 'Part des tables',
                      'Perte ombrage électrique', 'Productible kWh/kWc', 'PR', 'Contribution MWh'], rows,
              [None, '0', None, '0.00%', '+0.00%;-0.00%', '0.0', '0.0%', '#,##0.0'])
        widths(ws, [16, 22, 10, 14, 22, 20, 10, 18])

    # Alertes
    ws = wb.create_sheet('Alertes')
    rows = [[a['title'], {'ok': 'OK', 'warn': 'Alerte', 'block': 'Bloquant'}[a['level']], a['value'],
             a['limit'], a['unit'], a['message']] for a in res['alerts']]
    table(ws, 1, ['Vérification', 'Statut', 'Valeur', 'Limite', 'Unité', 'Détail'], rows)
    widths(ws, [44, 10, 10, 10, 8, 90])

    # Horaire
    ws = wb.create_sheet('Horaire')
    hr = res['_hourly']
    ws.append(['Date (UTC)'] + list(hr.columns))
    for c in ws[1]:
        c.font, c.fill = H, HF
    for idx, row in zip(hr.index, hr.itertuples(index=False)):
        ws.append([idx] + [float(x) for x in row])
    widths(ws, [14] + [11] * len(hr.columns))
    ws.freeze_panes = 'B2'

    bio = io.BytesIO()
    wb.save(bio)
    return bio.getvalue()
