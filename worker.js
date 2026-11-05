/* Calcul productible – Web Worker : charge Pyodide + pvlib et exécute le moteur Python. */
const PYODIDE_VERSION = 'v0.29.5';
const ENGINE_URL = 'engine/productible.py';
let py = null;
let ready = null;

function post(type, payload) { self.postMessage(Object.assign({ type }, payload || {})); }

async function init() {
  post('status', { text: 'Chargement de Python (Pyodide)…', pct: 5 });
  importScripts(`https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/pyodide.js`);
  py = await loadPyodide({ indexURL: `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/` });
  post('status', { text: 'Chargement de numpy, pandas, scipy…', pct: 25 });
  await py.loadPackage(['numpy', 'pandas', 'scipy', 'h5py', 'micropip', 'pytz']);
  post('status', { text: 'Installation de pvlib et openpyxl…', pct: 65 });
  const micropip = py.pyimport('micropip');
  await micropip.install(['pvlib==0.16.1', 'openpyxl']);
  post('status', { text: 'Chargement du moteur de calcul…', pct: 90 });
  const src = await (await fetch(ENGINE_URL + '?v=' + Date.now())).text();
  py.FS.writeFile('/home/pyodide/productible.py', src);
  py.runPython(`
import sys, json, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0, '/home/pyodide')
import productible as P
_last = None
def _check(files_json, cfg_json):
    cfg = P.merge(P.DEFAULTS, json.loads(cfg_json)); files = json.loads(files_json)
    p = P.parse_pan(files['pan']); o = P.parse_ond(files['ond'])
    return json.dumps(dict(alerts=P.check_project(cfg, files), pan=P._public(p), ond=P._public(o),
                           sub_in_height=P.default_sub_in_height(cfg['structure'], p)), default=float)
def _pan(pan):
    return json.dumps(P._public(P.parse_pan(pan)), default=float)
def _ond(ond):
    return json.dumps(P._public(P.parse_ond(ond)), default=float)
def _horizon(txt):
    return json.dumps(P.parse_horizon(txt).tolist())
def _tmy(txt, name):
    w, info = P.read_tmy(txt, name)
    m = w.groupby(w.index.month)
    info['ghi'] = (m.ghi.sum() / 1000).round(2).tolist(); info['dhi'] = (m.dhi.sum() / 1000).round(2).tolist()
    info['temp'] = m.temp_air.mean().round(2).tolist()
    return json.dumps(info, default=float)
def _monthly(txt):
    return json.dumps(P.parse_pvgis_monthly(txt), default=float)
def _run(cfg_json, files_json):
    global _last
    files = json.loads(files_json)
    _last = P.simulate(json.loads(cfg_json), files)
    return P.to_json(_last)
def _xlsx():
    return P.export_xlsx(_last)
def _csv():
    return _last['_hourly'].to_csv(sep=';', decimal=',')
`);
  post('ready', { engine: py.runPython('P.ENGINE_VERSION'), pvlib: py.runPython('P.pvlib.__version__') });
}

self.onmessage = async (ev) => {
  const { id, cmd, args } = ev.data;
  try {
    if (!ready) ready = init();
    await ready;
    let out;
    const call = (fn, ...a) => py.globals.get(fn)(...a);
    if (cmd === 'init') out = null;
    else if (cmd === 'check') out = JSON.parse(call('_check', JSON.stringify(args.files), JSON.stringify(args.cfg)));
    else if (cmd === 'pan') out = JSON.parse(call('_pan', args.text));
    else if (cmd === 'ond') out = JSON.parse(call('_ond', args.text));
    else if (cmd === 'horizon') out = JSON.parse(call('_horizon', args.text));
    else if (cmd === 'tmy') out = JSON.parse(call('_tmy', args.text, args.name || ''));
    else if (cmd === 'monthly') out = JSON.parse(call('_monthly', args.text));
    else if (cmd === 'run') {
      post('status', { text: 'Simulation horaire en cours…', pct: 50 });
      out = JSON.parse(call('_run', JSON.stringify(args.cfg), JSON.stringify(args.files)));
    } else if (cmd === 'xlsx') {
      const b = call('_xlsx');
      out = b.toJs(); b.destroy();
    } else if (cmd === 'csv') out = call('_csv');
    else throw new Error('Commande inconnue : ' + cmd);
    self.postMessage({ id, ok: true, out });
  } catch (e) {
    let msg = String(e && e.message || e);
    const m = msg.match(/(\w*Error: [^\n]+)\s*$/);
    self.postMessage({ id, ok: false, error: m ? m[1] : msg.split('\n').slice(-3).join(' ') });
  }
};
