'use strict';
// Title id -> game name, from the community titledb, cached locally.
// The cache is fetched once (US.en.json) and reused offline; if the fetch fails
// the toolkit still works, it just shows the ids.
const fs = require('node:fs');
const path = require('node:path');

const CACHE = path.join(__dirname, '..', '..', 'config', 'titledb-cache.json');
const URLS = [
  'https://raw.githubusercontent.com/blawar/titledb/master/US.en.json',
  // mirror, for networks where raw.githubusercontent is blocked
  'https://cdn.jsdelivr.net/gh/blawar/titledb@master/US.en.json',
];

let map = null;

function load() {
  if (map) return map;
  map = {};
  try {
    map = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch { /* no cache yet */ }
  return map;
}

// The cache is good for a week; only the first run (or a stale cache) fetches,
// so listing titles does not touch the network again.
async function refresh(maxAgeMs = 7 * 24 * 3600 * 1000) {
  try {
    const stat = fs.statSync(CACHE);
    if (Date.now() - stat.mtimeMs < maxAgeMs) return true;
  } catch { /* no cache: fetch */ }
  for (const url of URLS) {
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(20000)});
    if (!response.ok) continue;
    const data = await response.json();
    const compact = {};
    for (const [key, entry] of Object.entries(data)) {
      const name = entry && entry.name;
      // The map is keyed by NSU id; the application id is inside the entry.
      const id = String((entry && (entry.id || entry.app_id)) || key);
      if (typeof name === 'string' && name && /^[0-9a-f]{16}$/i.test(id)) {
        compact[id.toLowerCase()] = name;
      }
    }
    if (Object.keys(compact).length < 100) continue;
    fs.mkdirSync(path.dirname(CACHE), {recursive: true});
    fs.writeFileSync(CACHE, JSON.stringify(compact));
    map = compact;
    return true;
  } catch {
    continue;
  }
  }
  return false;
}

// True when at least one title can be named; the kit warns when it cannot.
function available() {
  const known = Object.keys(load()).length;
  const local = Object.keys(localNames()).length;
  return known + local > 0;
}

let overrides = null;

function localNames() {
  if (overrides) return overrides;
  overrides = {};
  try {
    const read = name => {
      try {
        return JSON.parse(fs.readFileSync(
          path.join(__dirname, '..', '..', 'config', name), 'utf8'));
      } catch { return {}; }
    };
    // titles.json ships a template; titles.local.json holds this console's ids.
    const local = read('titles.local.json');
    const config = {...read('titles.json'), ...local,
      names: {...(read('titles.json').names || {}), ...(local.names || {})}};
    for (const entry of config.names ? Object.entries(config.names) : []) {
      overrides[String(entry[0]).toLowerCase()] = entry[1];
    }
    for (const entry of config.write || []) {
      if (entry.name) overrides[String(entry.id).toLowerCase()] = entry.name;
    }
  } catch { /* no local names */ }
  return overrides;
}

function name(id) {
  const key = String(id).toLowerCase();
  // Local names win: they cover what titledb cannot (demos, trials, Switch 2).
  return localNames()[key] || load()[key] || null;
}

function label(id) {
  const found = name(id);
  return found ? found + '  (' + id + ')' : id;
}

// Filesystem-safe folder name: the game's own name, not its title id.
function slug(id) {
  const title = name(id) || String(id);
  const clean = title.replace(/[\u2122\u00ae]/g, '')   // (TM) / (R) signs
    .replace(/[\u00e9\u00e8]/gi, 'e')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')          // strip accents: Pokémon -> Pokemon
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/(^|-)TM(?=-|$)/gi, '$1')       // trademark sign from NFKD
    .replace(/-R$/i, '')
    .replace(/-TM-/g, '-').replace(/-TM$/i, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return clean || String(id).toLowerCase();
}

module.exports = {refresh, name, label, slug, available, cachePath: CACHE};
