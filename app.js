"use strict";
/* Mon bus — version web. Même logique que l'appli télé (Screen.java / Gtfs.java) :
   horaires GTFS précalculés dans data.json + temps réel GTFS-RT Citéa + météo Open-Meteo. */

const RT_URL = "https://proxy.transport.data.gouv.fr/resource/citea-valence-gtfs-rt-trip-update";
const VP_URL = "https://proxy.transport.data.gouv.fr/resource/citea-valence-gtfs-rt-vehicle-position";
const TILES = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const VALENCE = [44.9313, 4.8949];
const MIN = 60000, HOUR = 60 * MIN;
const LIVE_EVERY = 30000, VEH_EVERY = 15000, WEATHER_EVERY = 30 * MIN, GLIDE = 2500;
const $ = (id) => document.getElementById(id);

// ---------- Réglages (gardés sur le téléphone) ----------
/** dir : 0 = aller (Pôle Bus → Briffaut), 1 = retour. walk / walkBack : marche jusqu'à l'arrêt de départ. */
const settings = { lines: ["C2", "C5"], walk: 5, walkBack: 5, margin: 1, dir: 0 };
try { Object.assign(settings, JSON.parse(localStorage.getItem("monbus") || "{}")); } catch (e) {}
function saveSettings() { try { localStorage.setItem("monbus", JSON.stringify(settings)); } catch (e) {} }
const walk = () => (settings.dir ? settings.walkBack : settings.walk);
const lineSet = () => new Set(settings.lines.map((l) => l.toUpperCase()));

// ---------- Heure de Paris ----------
const fmt = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
function parts(t) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(t))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, H: +o.hour % 24, M: +o.minute, S: +o.second, wd: o.weekday };
}
const hm = (t) => { const p = parts(t); return String(p.H).padStart(2, "0") + ":" + String(p.M).padStart(2, "0"); };
/** Minuit « GTFS » d'un jour de Paris : midi moins 12 h (juste aussi aux changements d'heure). */
function base(y, m, d) {
  const guess = Date.UTC(y, m - 1, d, 12);
  const p = parts(guess);
  const off = Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) - guess;
  return guess - off - 12 * HOUR;
}
function inMin(ms) {
  const m = Math.floor(ms / MIN);
  return m < 60 ? `dans ${m} min` : `dans ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

// ---------- Protobuf GTFS-RT, décodé à la main ----------
class Pb {
  constructor(b, p = 0, end = b.length) { this.b = b; this.p = p; this.end = end; }
  more() { return this.p < this.end; }
  bytes() { const s = this.p; while (this.b[this.p++] & 0x80); return [s, this.p]; }
  varint() { const [s, e] = this.bytes(); let v = 0, k = 1; for (let i = s; i < e; i++) { v += (this.b[i] & 0x7f) * k; k *= 128; } return v; }
  int32() { const [s, e] = this.bytes(); let v = 0; for (let i = s; i < e && i < s + 5; i++) v |= (this.b[i] & 0x7f) << (7 * (i - s)); return v | 0; }
  f32() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getFloat32(0, true); this.p += 4; return v; }
  sub() { const n = this.varint(); const r = new Pb(this.b, this.p, this.p + n); this.p += n; return r; }
  str() { const n = this.varint(); const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
  skip(wt) { if (wt === 0) this.bytes(); else if (wt === 1) this.p += 8; else if (wt === 2) { const n = this.varint(); this.p += n; } else if (wt === 5) this.p += 4; else this.p = this.end; }
  *fields() { while (this.more()) { const t = this.varint(); yield [Math.floor(t / 8), t & 7]; } }
}
function* entities(buf) {
  const msg = new Pb(buf);
  for (const [f, wt] of msg.fields()) { if (f === 2 && wt === 2) yield msg.sub(); else msg.skip(wt); }
}

function stopTimeUpdate(p) {
  const s = { seq: -1, stop: "", time: -1, delay: 0, hasDelay: false, skipped: false };
  let arrT = -1, depT = -1, arrD = null, depD = null;
  for (const [f, wt] of p.fields()) {
    if (f === 1 && wt === 0) s.seq = p.varint();
    else if (f === 4 && wt === 2) s.stop = p.str();
    else if (f === 5 && wt === 0) s.skipped = p.varint() === 1;
    else if ((f === 2 || f === 3) && wt === 2) {
      const ev = p.sub(); let time = -1, delay = null;
      for (const [g, w] of ev.fields()) {
        if (g === 1 && w === 0) delay = ev.int32();
        else if (g === 2 && w === 0) time = ev.varint();
        else ev.skip(w);
      }
      if (f === 2) { arrT = time; arrD = delay; } else { depT = time; depD = delay; }
    } else p.skip(wt);
  }
  s.time = depT > 0 ? depT : arrT;
  const dl = depD !== null ? depD : arrD;
  if (dl !== null) { s.delay = dl; s.hasDelay = true; }
  return s;
}
/** Heure réelle à l'arrêt n° seq : donnée exacte, sinon retard du dernier arrêt connu avant. */
function estimate(stus, seq, stop, tripDelay, l) {
  let exact = null, before = null, minSeq = Infinity;
  for (const s of stus) {
    if (s.seq === seq || (s.seq < 0 && s.stop === stop)) exact = s;
    if (s.seq >= 0) { minSeq = Math.min(minSeq, s.seq); if (s.seq <= seq && (!before || s.seq > before.seq)) before = s; }
  }
  if (exact) {
    if (exact.skipped) l.canceled = true;
    else if (exact.time > 0) l.time = exact.time;
    else if (exact.hasDelay) { l.delay = exact.delay; l.hasDelay = true; }
  } else if (before && before.hasDelay) { l.delay = before.delay; l.hasDelay = true; }
  else if (stus.length && minSeq !== Infinity && minSeq > seq) l.gone = true;
  else if (tripDelay !== null) { l.delay = tripDelay; l.hasDelay = true; }
}
const newLive = () => ({ time: -1, delay: 0, hasDelay: false, canceled: false, gone: false });
const known = (l) => l.time > 0 || l.hasDelay;
const apply = (l, sched) => (l.time > 0 ? l.time * 1000 : l.hasDelay ? sched + l.delay * 1000 : sched);

function parseTripUpdates(buf, wanted) {
  const out = new Map();
  for (const ent of entities(buf)) {
    for (const [f, wt] of ent.fields()) {
      if (!(f === 3 && wt === 2)) { ent.skip(wt); continue; }
      const tu = ent.sub();
      let trip = null, canceled = false, tripDelay = null; const stus = [];
      for (const [g, w] of tu.fields()) {
        if (g === 1 && w === 2) {
          const td = tu.sub();
          for (const [h, x] of td.fields()) {
            if (h === 1 && x === 2) trip = td.str();
            else if (h === 4 && x === 0) canceled = td.varint() === 3;
            else td.skip(x);
          }
        } else if (g === 2 && w === 2) stus.push(stopTimeUpdate(tu.sub()));
        else if (g === 5 && w === 0) tripDelay = tu.int32();
        else tu.skip(w);
      }
      const d = trip && wanted.get(trip);
      if (!d) continue;
      const l = newLive();
      out.set(trip, l);
      if (canceled) { l.canceled = true; continue; }
      l.arrival = newLive();
      estimate(stus, d.seq, d.stop, tripDelay, l);
      estimate(stus, d.aseq, null, tripDelay, l.arrival);
      if (l.arrival.canceled) l.canceled = true;
    }
  }
  return out;
}

function parseVehicles(buf) {
  const out = [];
  for (const ent of entities(buf)) {
    for (const [f, wt] of ent.fields()) {
      if (!(f === 4 && wt === 2)) { ent.skip(wt); continue; }
      const p = ent.sub();
      const v = { trip: "", route: "", id: "", label: "", lat: 0, lon: 0, bearing: -1, ts: 0 };
      for (const [g, w] of p.fields()) {
        if (g === 1 && w === 2) {
          const td = p.sub();
          for (const [h, x] of td.fields()) { if (h === 1 && x === 2) v.trip = td.str(); else if (h === 5 && x === 2) v.route = td.str(); else td.skip(x); }
        } else if (g === 2 && w === 2) {
          const ps = p.sub();
          for (const [h, x] of ps.fields()) {
            if (x === 5 && h === 1) v.lat = ps.f32(); else if (x === 5 && h === 2) v.lon = ps.f32();
            else if (x === 5 && h === 3) v.bearing = ps.f32(); else ps.skip(x);
          }
        } else if (g === 5 && w === 0) v.ts = p.varint();
        else if (g === 8 && w === 2) {
          const vd = p.sub();
          for (const [h, x] of vd.fields()) { if (h === 1 && x === 2) v.id = vd.str(); else if (h === 2 && x === 2) v.label = vd.str(); else vd.skip(x); }
        } else p.skip(w);
      }
      if (v.lat && v.lon) out.push(v);
    }
  }
  return out;
}

async function getBytes(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

// ---------- État ----------
let data = null, deps = [], depByTrip = new Map();
let live = new Map(), liveAt = 0, lastLive = 0, liveBusy = false;
let marks = new Map(), vehAt = 0, lastVeh = 0, vehBusy = false;
let weather = null, lastWeather = 0;
let runs = [], best = null, byTrip = new Map();
let view = "times";

function services(y, m, d) {
  const ymd = y * 10000 + m * 100 + d;
  const monday0 = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  const s = new Set();
  for (const [sid, days, a, b] of data.weekly) if (ymd >= a && ymd <= b && days[monday0] === "1") s.add(sid);
  for (const sid of data.added[ymd] || []) s.add(sid);
  for (const sid of data.removed[ymd] || []) s.delete(sid);
  return s;
}

function keep(m, r, now) {
  const o = m.get(r.d.trip);
  if (!o || Math.abs(r.sched - now) < Math.abs(o.sched - now)) m.set(r.d.trip, r);
}

function compute() {
  runs = []; best = null; byTrip = new Map();
  if (!data) return;
  const now = Date.now(), fresh = now - liveAt < 3 * MIN, lines = lineSet();
  for (let k = -1; k <= 1; k++) {
    const p = parts(now + k * 24 * HOUR);
    const sv = services(p.y, p.m, p.d), b = base(p.y, p.m, p.d);
    for (const d of deps) {
      if (!sv.has(d.service) || !lines.has(d.line.toUpperCase())) continue;
      const r = { d, sched: b + d.dep * 1000, arr: b + d.arr * 1000, live: false, gone: false, delayMin: 0 };
      if (r.sched < now - 2 * HOUR || r.sched > now + 20 * HOUR) continue;
      r.real = r.sched;
      const near = Math.abs(r.sched - now) < 3 * HOUR;
      const l = fresh ? live.get(d.trip) : null;
      if (l && near) {
        if (l.canceled) continue;
        if (l.gone) {
          r.gone = r.live = true;
          if (l.arrival && known(l.arrival)) r.arr = apply(l.arrival, r.arr);
          keep(byTrip, r, now);
          continue;
        }
        if (known(l)) {
          r.live = true;
          r.real = apply(l, r.sched);
          r.delayMin = Math.round((r.real - r.sched) / MIN);
          r.arr = l.arrival && known(l.arrival) ? apply(l.arrival, r.arr) : r.arr + (r.real - r.sched);
        }
      }
      if (near) keep(byTrip, r, now);
      if (r.real < now) continue;
      runs.push(r);
    }
  }
  runs.sort((a, b) => a.real - b.real);
  const need = (walk() + settings.margin) * MIN;
  runs = runs.filter((r) => r.real - need >= now - 20000);
  for (const r of runs) {
    if (r.real > runs[0].real + 45 * MIN) break;
    if (!best || r.arr < best.arr || (r.arr === best.arr && r.real < best.real)) best = r;
  }
}

// ---------- Réseau ----------
async function fetchLive() {
  if (liveBusy || !data) return;
  liveBusy = true; lastLive = Date.now();
  try { live = parseTripUpdates(await getBytes(RT_URL), depByTrip); liveAt = Date.now(); } catch (e) {}
  liveBusy = false;
  render();
}

async function fetchVehicles() {
  if (vehBusy) return;
  vehBusy = true; lastVeh = Date.now();
  try {
    const list = parseVehicles(await getBytes(VP_URL));
    const now = Date.now(), next = new Map();
    for (const v of list) {
      const key = v.id || v.label || v.trip;
      const old = marks.get(key);
      const glide = old && Math.abs(old.v.lat - v.lat) + Math.abs(old.v.lon - v.lon) < 0.02;
      const cur = glide ? pos(old, now) : [v.lat, v.lon];
      next.set(key, { v, lat0: cur[0], lon0: cur[1], t0: now, marker: old && old.marker });
    }
    for (const [k, m] of marks) if (!next.has(k) && m.marker) m.marker.remove();
    marks = next; vehAt = now;
  } catch (e) {}
  vehBusy = false;
  render();
}

async function fetchWeather() {
  lastWeather = Date.now();
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${spot()[0]}&longitude=${spot()[1]}&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe%2FParis&forecast_days=3`;
    weather = await (await fetch(u)).json();
  } catch (e) { lastWeather -= WEATHER_EVERY - 3 * MIN; }
  renderWeather();
}

/** Météo et carte centrées sur l'arrêt de départ (pas d'adresse personnelle dans ce site public). */
const spot = () => (data ? data.dirs[0].from.pos : VALENCE);
/** Le sens choisi : {from, to, leave, deps}. */
const cur = () => data.dirs[settings.dir] || data.dirs[0];

// ---------- Affichage : horaires ----------
function render() {
  compute();
  const now = Date.now();
  $("clock").textContent = hm(now);
  if (view === "times") renderTimes(now); else renderMap(now);
}

function renderTimes(now) {
  const to = data ? cur().to.label : "Briffaut", from = data ? cur().from.label : "Pôle Bus";
  if (data) $("leave-label").textContent = cur().leave;
  $("next-to").textContent = "Prochain bus vers " + to;
  $("next-at").textContent = "Passage à " + from;
  $("walk-min").textContent = walk() + " min";
  document.querySelectorAll(".from-label").forEach((e) => (e.textContent = from));
  const r = best;
  if (!r) {
    $("next-line").textContent = data ? "Pas de bus" : "…";
    $("next-status").textContent = data ? `Aucun ${settings.lines.join(" / ")} vers ${to} dans les prochaines heures` : "Chargement des horaires…";
    $("next-time").textContent = "--:--";
    $("leave-time").textContent = "--:--";
    $("leave-in").textContent = "";
    $("runs").replaceChildren();
    return;
  }
  $("next-line").textContent = "Ligne " + r.d.line;
  const st = !r.live ? "Horaire prévu"
    : r.delayMin > 0 ? `● Temps réel · ${r.delayMin} min de retard`
    : r.delayMin < 0 ? `● Temps réel · ${-r.delayMin} min d'avance` : "● Temps réel · à l'heure";
  $("next-status").textContent = `${st} · arrivée à ${to} ${hm(r.arr)}`;
  $("next-time").textContent = hm(r.real);
  const leave = r.real - (walk() + settings.margin) * MIN, urgent = leave - now < MIN;
  $("leave-time").textContent = hm(leave);
  $("leave-in").textContent = urgent ? "Pars maintenant !" : inMin(leave - now + MIN - 1);
  $("leave-in").classList.toggle("now", urgent);
  $("runs").replaceChildren(...runs.slice(0, 5).map((q) => {
    const li = document.createElement("li");
    if (q === best) li.className = "sel";
    if (q.live) li.classList.add("live");
    li.innerHTML = `<span class="t">${hm(q.real)}</span><span class="dot"></span><span class="s">${q.d.line} · ${hm(q.arr)}</span>`;
    return li;
  }));
}

function sky(code) {
  const sun = '<circle cx="16" cy="14" r="5" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
    [0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<line x1="16" y1="5" x2="16" y2="2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" transform="rotate(${a} 16 14)"/>`).join("");
  const cloud = (y) => `<path d="M9 ${y + 12}h15a5 5 0 0 0 0-10 7 7 0 0 0-13-2 5 5 0 0 0-2 12Z" fill="currentColor" stroke="var(--bg)" stroke-width="2"/>`;
  let s;
  if (code === 0) s = sun.replace(/cy="14"/, 'cy="16"').replace(/16 14/g, "16 16").replace(/y1="5" x2="16" y2="2"/g, 'y1="7" x2="16" y2="4"');
  else if (code <= 2) s = `<g transform="translate(-3 -3) scale(.8)">${sun}</g>` + cloud(14);
  else if (code === 3) s = cloud(9);
  else if (code === 45 || code === 48) s = cloud(4) + '<path d="M7 24h18M9 28h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>';
  else {
    const snow = (code >= 71 && code <= 77) || code === 85 || code === 86;
    s = cloud(3) + (snow ? '<g fill="currentColor"><circle cx="11" cy="25" r="1.8"/><circle cx="17" cy="27" r="1.8"/><circle cx="23" cy="25" r="1.8"/></g>'
      : '<path d="M12 22l-2 5M18 22l-2 5M24 22l-2 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>');
  }
  return `<svg class="sky" viewBox="0 0 32 32" aria-hidden="true">${s}</svg>`;
}

function renderWeather() {
  const w = weather;
  if (!w || !w.current) return;
  const d = w.daily, names = ["Aujourd'hui", "Demain"];
  let html = `<div class="now">${sky(w.current.weather_code)}<span>${Math.round(w.current.temperature_2m)}°C</span></div>`;
  for (let i = 0; i < Math.min(3, d.time.length); i++) {
    const label = names[i] || new Date(d.time[i] + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long" }).replace(/^./, (c) => c.toUpperCase());
    html += `<div class="day"><span>${label}</span>${sky(d.weather_code[i])}<b>${Math.round(d.temperature_2m_min[i])}° ${Math.round(d.temperature_2m_max[i])}°</b></div>`;
  }
  $("weather").innerHTML = html;
}

// ---------- Affichage : carte ----------
let map = null, routeLayer = null, fitted = false;
const color = (route) => {
  const r = data && data.routes[route];
  return r ? ["#" + r[1], "#" + r[2], r[0]] : ["#161616", "#FFFFFF", route];
};
function pos(m, now) {
  let k = Math.min(1, Math.max(0, (now - m.t0) / GLIDE));
  k = k * k * (3 - 2 * k);
  return [m.lat0 + (m.v.lat - m.lat0) * k, m.lon0 + (m.v.lon - m.lon0) * k];
}
const passed = (r, now) => r && (r.gone || r.real < now - 30000);

function initMap() {
  map = L.map("map", { zoomControl: false, attributionControl: true, zoomSnap: 0.25 }).setView(spot(), 14);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.tileLayer(TILES, { maxNativeZoom: 16, maxZoom: 18, attribution: "© Esri, HERE, Garmin, OpenStreetMap" }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  drawRoutes();
}

function drawRoutes() {
  if (!map || !data) return;
  routeLayer.clearLayers();
  const lines = lineSet(), all = [];
  for (const s of data.shapes) {
    if (!lines.has(s.line.toUpperCase())) continue;
    const c = Object.values(data.routes).find((r) => r[0] === s.line);
    L.polyline(s.pts, { color: "#fff", weight: 8, opacity: 1, interactive: false }).addTo(routeLayer);
    L.polyline(s.pts, { color: c ? "#" + c[1] : "#161616", weight: 4, opacity: 1, interactive: false }).addTo(routeLayer);
    all.push(...s.pts);
  }
  for (const st of [data.dirs[0].from, data.dirs[0].to]) {
    L.marker(st.pos, { icon: L.divIcon({ className: "", html: '<div class="stop"></div>', iconSize: [20, 20] }), interactive: false, zIndexOffset: -100 })
      .bindTooltip(st.label, { permanent: true, direction: "right", offset: [10, 0], className: "stop-label" }).addTo(routeLayer);
    all.push(st.pos);
  }
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [28, 28] });
  fitted = true;
}

function vehHtml(m, kind) {
  const [c, t, name] = color(m.v.route);
  const arrow = m.v.bearing >= 0 ? `<span class="a" style="--b:${m.v.bearing}deg"></span>` : "";
  const tag = kind === "mine" ? '<span class="tag pill">Votre bus</span>' : "";
  return `<div class="veh ${kind}" style="--c:${c};--t:${t}">${arrow}<span class="c">${name}</span>${tag}</div>`;
}

function renderMap(now) {
  if (!map) initMap();
  if (!fitted) drawRoutes();
  const lines = lineSet(), toward = [];
  let mine = null;
  for (const m of marks.values()) {
    const [, , name] = color(m.v.route);
    const stale = m.v.ts && now / 1000 - m.v.ts > 300;
    if (!lines.has(name.toUpperCase()) || stale) { if (m.marker) { m.marker.remove(); m.marker = null; m.key = null; } continue; }
    // Un bus qui a déjà atteint la destination continue sa ligne : il ne compte plus.
    const r = byTrip.get(m.v.trip), done = r && passed(r, now) && r.arr < now - MIN;
    const kind = !r || done ? "other" : best && m.v.trip === best.d.trip ? "mine" : "toward";
    if (kind === "mine") mine = m; else if (kind === "toward") toward.push(m);
    const size = kind === "mine" ? 36 : kind === "toward" ? 30 : 20;
    const key = kind + m.v.bearing + m.v.route;
    if (!m.marker) m.marker = L.marker(pos(m, now), { interactive: false }).addTo(map);
    if (m.key !== key) {
      m.marker.setIcon(L.divIcon({ className: "", html: vehHtml(m, kind), iconSize: [size, size] }));
      m.marker.setZIndexOffset(kind === "mine" ? 1000 : kind === "toward" ? 500 : 0);
      m.key = key;
    }
  }

  const to = data ? cur().to.label : "Briffaut", from = data ? cur().from.label : "Pôle Bus";
  $("toward").textContent = "Vers " + to;
  const age = Math.round((now - vehAt) / 1000);
  $("live").textContent = !vehAt ? "Recherche des bus…" : age > 120 ? "○ Positions indisponibles" : `● En direct · il y a ${age} s`;

  const rows = mine ? [...toward, mine] : toward;
  rows.sort((p, q) => {
    const r = byTrip.get(p.v.trip), s = byTrip.get(q.v.trip), pp = passed(r, now), qq = passed(s, now);
    if (pp !== qq) return pp ? 1 : -1;
    return (pp ? r.arr : r.real) - (qq ? s.arr : s.real);
  });
  $("rows").replaceChildren(...rows.map((m) => {
    const r = byTrip.get(m.v.trip), [c, t, name] = color(m.v.route);
    let l1, l2;
    if (passed(r, now)) { l1 = "Après " + from; l2 = r.arr > now ? `arrivée à ${to} ${hm(r.arr)}` : `arrive à ${to}`; }
    else { const dt = r.real - now; l1 = `${from} ${hm(r.real)}`; l2 = `${dt < MIN ? "à l'approche" : inMin(dt)} · ${to} ${hm(r.arr)}`; }
    const li = document.createElement("li");
    li.innerHTML = `<span class="badge" style="--c:${c};--t:${t}">${name}</span><span class="txt"><b>${l1}</b><small>${l2}</small></span>${m === mine ? '<span class="pill">Votre bus</span>' : ""}`;
    li.onclick = () => map.flyTo(pos(m, Date.now()), 16, { duration: 0.8 });
    return li;
  }));
  if (!rows.length) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="txt"><small>Aucun bus en route vers ${to} pour l'instant</small></span>`;
    $("rows").append(li);
  }
  const note = $("note");
  note.hidden = !(best && !mine && !best.gone);
  if (!note.hidden) note.textContent = `Votre bus ${best.d.line} de ${hm(best.real)} n'est pas encore sur la route.`;

  const names = [...lines].sort();
  $("legend").innerHTML = names.map((n) => {
    const r = data && Object.values(data.routes).find((x) => x[0].toUpperCase() === n);
    return `<span style="--c:${r ? "#" + r[1] : "#161616"}"><i></i>${n}</span>`;
  }).join("") + '<span class="other"><i></i>autre sens</span>';
}

// Animation des bus qui glissent vers leur nouvelle position
function animate() {
  if (view === "map" && map) {
    const now = Date.now();
    for (const m of marks.values()) if (m.marker && now - m.t0 < GLIDE + 100) m.marker.setLatLng(pos(m, now));
  }
  requestAnimationFrame(animate);
}

// ---------- Navigation, réglages, boucle ----------
function show(v) {
  view = v;
  $("v-times").hidden = v !== "times";
  $("v-map").hidden = v !== "map";
  $("t-times").classList.toggle("on", v === "times");
  $("t-map").classList.toggle("on", v === "map");
  $("title").textContent = v === "map" ? "Bus en direct" : "Mon bus";
  try { localStorage.setItem("monbus-view", v); } catch (e) {}
  if (v === "map") { lastVeh = 0; tick(); setTimeout(() => { if (map) { map.invalidateSize(); fitted = false; render(); } }, 50); } else render();
}
$("t-times").onclick = () => show("times");
$("t-map").onclick = () => show("map");

// ---------- Sens aller / retour ----------
function setDir(d) {
  settings.dir = d === 1 ? 1 : 0;
  const c = cur();
  deps = c.deps.map(([trip, service, line, stop, dep, arr, seq, aseq]) => ({ trip, service, line, stop, dep, arr, seq, aseq }));
  depByTrip = new Map(deps.map((x) => [x.trip, x]));
  live = new Map(); liveAt = 0; lastLive = 0;
  for (const m of marks.values()) m.key = null;
  $("dir-from").textContent = c.from.label;
  $("dir-to").textContent = c.to.label;
  $("dir").setAttribute("aria-label", `Sens : ${c.from.label} vers ${c.to.label}. Changer de sens`);
}
$("dir").onclick = () => {
  if (!data) return;
  setDir(1 - settings.dir);
  saveSettings();
  tick();
};

function openSettings() {
  const all = data ? [...new Set(Object.values(data.routes).map((r) => r[0]))].sort() : settings.lines;
  const chosen = lineSet();
  $("set-lines").innerHTML = all.map((n) => {
    const r = data && Object.values(data.routes).find((x) => x[0] === n);
    return `<label><input type="checkbox" value="${n}" ${chosen.has(n.toUpperCase()) ? "checked" : ""}><i style="--c:${r ? "#" + r[1] : "#161616"}"></i>${n}</label>`;
  }).join("");
  $("set-walk").value = settings.walk;
  $("set-walk-back").value = settings.walkBack;
  $("o-walk-back").textContent = settings.walkBack + " min";
  $("set-margin").value = settings.margin;
  $("o-walk").textContent = settings.walk + " min";
  $("o-margin").textContent = settings.margin + " min";
  $("settings").showModal();
}
$("gear").onclick = openSettings;
$("set-walk").oninput = (e) => ($("o-walk").textContent = e.target.value + " min");
$("set-walk-back").oninput = (e) => ($("o-walk-back").textContent = e.target.value + " min");
$("set-margin").oninput = (e) => ($("o-margin").textContent = e.target.value + " min");
$("settings").addEventListener("close", () => {
  const lines = [...$("set-lines").querySelectorAll("input:checked")].map((i) => i.value);
  if (lines.length) settings.lines = lines;
  settings.walk = +$("set-walk").value;
  settings.walkBack = +$("set-walk-back").value;
  settings.margin = +$("set-margin").value;
  saveSettings();
  fitted = false;
  for (const m of marks.values()) m.key = null;
  render();
});

function tick() {
  if (document.hidden) return;
  const now = Date.now();
  if (now - lastLive > LIVE_EVERY) fetchLive();
  if (view === "map" && now - lastVeh > VEH_EVERY) fetchVehicles();
  if (now - lastWeather > WEATHER_EVERY) fetchWeather();
  render();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastLive = 0; lastVeh = 0; tick(); } });

async function start() {
  try {
    data = await (await fetch("data.json")).json();
    setDir(settings.dir);
  } catch (e) {
    $("next-status").textContent = "Impossible de charger les horaires. Vérifie la connexion.";
  }
  let v = "times";
  try { v = localStorage.getItem("monbus-view") || "times"; } catch (e) {}
  if (location.hash === "#carte") v = "map";
  if (location.hash === "#horaires") v = "times";
  show(v === "map" ? "map" : "times");
  tick();
  setInterval(tick, 5000);
  requestAnimationFrame(animate);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
start();
