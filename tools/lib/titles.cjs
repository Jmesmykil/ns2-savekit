'use strict';
// Title id -> game name, from the community titledb, cached locally.
// The cache is fetched once (US.en.json) and reused offline; if the fetch fails
// the toolkit still works, it just shows the ids.
const fs = require('node:fs');
const path = require('node:path');

const CACHE = path.join(__dirname, '..', '..', 'config', 'titledb-cache.json');
const URL = 'https://raw.githubusercontent.com/blawar/titledb/master/US.en.json';

let map = null;

function load() {
  if (map) return map;
  map = {};
  try {
    map = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch { /* no cache yet */ }
  return map;
}

async function refresh() {
  try {
    const response = await fetch(URL, {signal: AbortSignal.timeout(20000)});
    if (!response.ok) return false;
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
    if (Object.keys(compact).length < 100) return false;
    fs.mkdirSync(path.dirname(CACHE), {recursive: true});
    fs.writeFileSync(CACHE, JSON.stringify(compact));
    map = compact;
    return true;
  } catch {
    return false;
  }
}

let overrides = null;

function localNames() {
  if (overrides) return overrides;
  overrides = {};
  try {
    const config = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', 'config', 'titles.json'), 'utf8'));
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

module.exports = {refresh, name, label, cachePath: CACHE};
