// Radar Fútbol Mundial — función de Netlify que lee AnnaBet.com y devuelve JSON.
// Sin dependencias externas: usa fetch nativo (Node 18+) y un lector de tablas HTML propio.
//   /api/futbol?league=serie_1_English_Premier_League   posiciones (general / casa / fuera) + partidos
//   /api/futbol?part=leagues                           lista de ligas de fútbol de AnnaBet
//   /api/futbol?debug=1&league=...                     diagnóstico: cómo viene la página

// ======================= CONFIGURACIÓN =======================
const SITE = "https://annabet.com/en/soccerstats/"; // versión en inglés: fechas "Saturday 26. September 2026"
// Lista de respaldo por si no se puede leer el menú de ligas (el menú real trae muchas más)
const FALLBACK_LEAGUES = [
  ["serie_1_English_Premier_League", "Inglaterra Premier League"],
  ["serie_20_Scottish_Premier_League", "Escocia Premiership"],
  ["serie_54_Russian_Premier_League", "Rusia Premier League"],
  ["serie_220_Swiss_Challenge_League", "Suiza Challenge League"],
];
const MENU_PAGE = "serie_1_English_Premier_League"; // página de la que se lee el menú completo de ligas
// Portadas con "Próximos partidos" de todas las ligas (se usa la primera que responda)
const UPCOMING_PAGES = ["https://annabet.com/es/soccerstats/", "https://annabet.com/en/soccerstats/"];
// =============================================================

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tkey = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(",", ".").replace(/[^\d.\-+]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---------- descarga con reintento y límite de tiempo ----------
// Lee la página por partes y se detiene al llegar al tiempo límite: si AnnaBet es lento,
// se trabaja con lo que alcanzó a llegar (las tablas de posiciones y partidos están arriba)
// en lugar de fallar todo. Netlify corta las funciones a los 10 s.
async function getHtmlPartial(url, maxMs = 8000) {
  const ctrl = new AbortController();
  const deadline = Date.now() + maxMs;
  const timer = setTimeout(() => ctrl.abort(), maxMs + 500);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!r.body || !r.body.getReader) return { html: await r.text(), partial: false };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let html = "", partial = false;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) { partial = true; break; }
      const res = await Promise.race([reader.read(), sleep(left).then(() => ({ timeout: true }))]);
      if (res.timeout) { partial = true; break; }
      if (res.done) break;
      html += dec.decode(res.value, { stream: true });
    }
    if (partial) { try { reader.cancel(); } catch {} }
    if (!/<table/i.test(html)) throw new Error(partial ? "AnnaBet tardó demasiado en responder" : "la página no trae tablas (posible bloqueo o liga sin datos)");
    return { html, partial };
  } catch (e) {
    throw e.name === "AbortError" ? new Error("AnnaBet tardó demasiado en responder") : e;
  } finally {
    clearTimeout(timer);
  }
}

async function getHtml(url, tries = 2, timeoutMs = 4500) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      if (!/<table/i.test(html)) throw new Error("la página no trae tablas (posible bloqueo o liga sin datos)");
      return html;
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error("tiempo de espera agotado") : e;
      if (i < tries - 1) await sleep(400);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr ? lastErr.message : "error desconocido");
}

// ---------- lector de tablas HTML ----------
function decode(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z])(acute|grave|tilde|uml|circ|cedil|ring|slash|caron);/gi, (_, c, t) =>
      (c + ({ acute: "́", grave: "̀", tilde: "̃", uml: "̈", circ: "̂", cedil: "̧", ring: "̊", slash: "", caron: "̌" }[t.toLowerCase()] || "")).normalize("NFC"))
    .replace(/\s+/g, " ")
    .trim();
}

function parseTables(html) {
  const out = [];
  const reTable = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = reTable.exec(html))) {
    const rows = [];
    const reRow = /<tr[\s\S]*?<\/tr>/gi;
    let r;
    while ((r = reRow.exec(m[0]))) {
      const cells = [];
      const reCell = /<t([hd])[^>]*>([\s\S]*?)<\/t\1>/gi;
      let c;
      while ((c = reCell.exec(r[0]))) cells.push(decode(c[2]));
      if (cells.length) rows.push(cells);
    }
    out.push({ index: m.index, end: m.index + m[0].length, rows });
  }
  return out;
}

// ---------- posiciones: General / Casa / Fuera ----------
// Cabecera tipo "# | Team | GP | W | L | W% | ØPF | ØPA | ØDiff" (o en español: Equipo, PJ, PG, PP...)
// Cabecera tipo "# | Team | GP | W | D | L | Goals | Pts" (goles "15:7") o con promedios "ØGF | ØGA"
const H = {
  team: /^(team|equipo|club)$/i,
  gp: /^(gp|pj|mp|games|played|p)$/i,
  w: /^(w|pg|g|won|wins|v)$/i,
  d: /^(d|pe|e|x|draws?|draw|empates?|t|n)$/i,
  l: /^(l|pp|lost|losses|defeats?|derrotas?)$/i,
  goals: /^(goals|goles|g\s*:\s*g|gf\s*:\s*ga|score)$/i,
  gf: /^(ø?\s*gf|ø?\s*f|goals?\s*for|goles\s*a\s*favor|ø?\s*gs|scored|ø?\s*pf)$/i,
  ga: /^(ø?\s*ga|ø?\s*a|goals?\s*against|goles\s*en\s*contra|ø?\s*gc|conceded|ø?\s*pa|ø?\s*pc)$/i,
  pts: /^(pts|points|puntos|p)$/i,
};

function isStandingsHdr(r) {
  return r.some((c) => H.team.test(c)) && r.some((c) => H.w.test(c)) && r.some((c) => H.l.test(c));
}
// Tabla de posiciones válida = además trae empates y goles (descarta tablas de apuestas)
function isFullStandingsHdr(r) {
  return isStandingsHdr(r) && r.some((c) => H.d.test(c)) &&
    (r.some((c) => H.goals.test(c)) || (r.some((c) => H.gf.test(c)) && r.some((c) => H.ga.test(c))));
}

function parseStandingsTable(t) {
  const hi = t.rows.findIndex(isStandingsHdr);
  const hdr = t.rows[hi];
  const ix = (re, not = []) => hdr.findIndex((c, i) => re.test(c) && !not.includes(i));
  const iT = ix(H.team), iW = ix(H.w), iD = ix(H.d, [iW]), iL = ix(H.l, [iW, iD]);
  const iGP = ix(H.gp, [iW, iD, iL]), iGoals = ix(H.goals);
  const iGF = ix(H.gf), iGA = ix(H.ga, [iGF]);
  const avgCols = iGF >= 0 && /ø|avg|prom/i.test(hdr[iGF]); // columnas de promedio (ØGF / ØGA)
  const map = {};
  let pos = 0;
  for (const r of t.rows.slice(hi + 1)) {
    if (isStandingsHdr(r) || !r[iT]) continue;
    const W = num(r[iW]), D = iD >= 0 ? num(r[iD]) : 0, L = num(r[iL]);
    if (W == null || L == null) continue;
    pos++;
    const pl = num(r[0]);
    const GP = iGP >= 0 && num(r[iGP]) != null ? num(r[iGP]) : W + (D || 0) + L;
    let gf = null, ga = null;
    if (iGoals >= 0) {
      const m = /(\d+)\s*[:\-–]\s*(\d+)/.exec(r[iGoals] || "");
      if (m) { gf = +m[1]; ga = +m[2]; }
    } else if (iGF >= 0 && iGA >= 0) {
      gf = num(r[iGF]); ga = num(r[iGA]);
      if (avgCols && gf != null && ga != null) { gf *= GP; ga *= GP; } // se guardan totales
    }
    map[tkey(r[iT])] = {
      team: r[iT], pos: pl && pl > 0 && pl < 500 ? pl : pos,
      gp: GP, w: W, d: D || 0, l: L,
      // promedios por partido (sin partidos jugados no hay datos reales)
      gf: GP > 0 && gf != null ? gf / GP : null,
      ga: GP > 0 && ga != null ? ga / GP : null,
    };
  }
  return map;
}

// Toma las tablas de posiciones en orden. Lo normal: 1ª = todos los juegos, 2ª = casa, 3ª = fuera.
// Si el texto previo a la tabla dice "home/casa" o "away/fuera", se usa eso.
function parseStandings(html, tables) {
  let st = tables.filter((t) => t.rows.some(isFullStandingsHdr));
  if (!st.length) st = tables.filter((t) => t.rows.some(isStandingsHdr));
  if (!st.length) throw new Error("tabla de posiciones no encontrada");
  // Solo cuentan las 3 primeras (la de "Forma"/últimos partidos viene después y se ignora)
  const out = { all: null, home: null, away: null, groups: 0 };
  // Por ORDEN: 1ª tabla = todos los juegos, 2ª = en casa, 3ª = fuera.
  // (Las pestañas "All games / At home / At away" se escriben todas antes de la 1ª tabla,
  //  así que el texto previo no sirve para saber cuál es cuál.)
  // Solo cuentan tablas con varios equipos (descarta tablitas de resumen con 1 fila)
  let maps = st.map((t) => parseStandingsTable(t)).filter((m) => Object.keys(m).length >= 3);
  const order = ["all", "home", "away"];
  // Se eligen por PARTIDOS JUGADOS, no solo por orden: la general es la de más partidos y
  // casa + fuera son el par de tablas cuyos partidos suman los de la general.
  // (Algunas ligas traen antes otras tablas —forma, grupos, 1ª vuelta— y el orden falla.)
  const medGp = (m) => { const a = Object.values(m).map((x) => x.gp).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  const fits = (A, H, W) => {
    const ks = Object.keys(A); let ok = 0;
    for (const k of ks) if (H[k] && W[k] && Math.abs(H[k].gp + W[k].gp - A[k].gp) < 0.5) ok++;
    return ok >= ks.length * 0.6;
  };
  let picked = null;
  const cand = maps.slice(0, 8);
  const byGp = cand.map((m, i) => i).sort((a, b) => medGp(cand[b]) - medGp(cand[a]) || a - b);
  outer: for (const ai of byGp) for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
    if (i === ai || j === ai) continue;
    if (fits(cand[ai], cand[i], cand[j])) { picked = [cand[ai], cand[i], cand[j]]; break outer; }
  }
  if (picked) { out.all = picked[0]; out.home = picked[1]; out.away = picked[2]; out.picked = true; }
  else {
    // ¿Hay un par casa/fuera sin general? (la general no se pudo leer)
    maps.slice(0, 3).forEach((m, i) => { out[order[i]] = m; });
    const big = byGp.length ? cand[byGp[0]] : null;
    if (big && big !== out.all) out.all = big; // la de más partidos es la general
  }
  // Tabla general armada desde casa + fuera (si la general no se pudo leer o está incompleta)
  const derive = (H, A) => {
    const all = {};
    for (const k of new Set([...Object.keys(H), ...Object.keys(A)])) {
      const h = H[k] || { gp: 0, w: 0, d: 0, l: 0 }, a = A[k] || { gp: 0, w: 0, d: 0, l: 0 };
      const gp = h.gp + a.gp;
      const tot = (x, f) => (x[f] != null ? x[f] * x.gp : 0);
      all[k] = { team: (H[k] || A[k]).team, gp, w: h.w + a.w, d: h.d + a.d, l: h.l + a.l,
        gf: gp ? (tot(h, "gf") + tot(a, "gf")) / gp : null, ga: gp ? (tot(h, "ga") + tot(a, "ga")) / gp : null };
    }
    Object.values(all).sort((x, y) => (y.w * 3 + y.d) - (x.w * 3 + x.d) || ((y.gf - y.ga) - (x.gf - x.ga)) || y.gf - x.gf)
      .forEach((x, i) => { x.pos = i + 1; });
    return all;
  };
  const size = (m) => (m ? Object.keys(m).length : 0);
  // Caso: solo se leyeron casa y fuera (la general falló) → las 2 tablas son casa/fuera
  if (!picked && maps.length === 2) { out.home = maps[0]; out.away = maps[1]; out.all = derive(out.home, out.away); out.derived = true; }
  else if (!picked && out.home && out.away && size(out.all) < size(out.home)) { out.all = derive(out.home, out.away); out.derived = true; }
  // Coherencia: en casa + fuera no puede tener más partidos que la general; si pasa, se descartan
  if (out.all && out.home && out.away) {
    const bad = Object.keys(out.all).filter((k) => out.home[k] && out.away[k] && out.home[k].gp + out.away[k].gp > out.all[k].gp + 0.5).length;
    if (bad > Object.keys(out.all).length / 2) { out.home = null; out.away = null; out.mismatch = true; }
  }
  if (!out.all) out.all = {};
  return out;
}

// ---------- partidos ----------
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// Reconoce "Thursday 24. September 2026", "24. September 2026", "24.9.2026", "24.09.26", "24.9."
// Fecha de hoy/mañana/ayer según la hora de Europa central (AnnaBet es un sitio europeo)
function relDay(offset) {
  const now = new Date(Date.now() + 2 * 3600 * 1000 + offset * 86400000); // ≈ hora de Europa (CEST)
  return iso(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
}

function nearest(d, mo) {
  if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12)) return null;
  const now = new Date(), y = now.getUTCFullYear();
  return [y - 1, y, y + 1].map((yy) => iso(yy, mo, d)).sort((a, b) => Math.abs(new Date(a) - now) - Math.abs(new Date(b) - now))[0];
}

function findDate(text) {
  const t = String(text || "");
  // AnnaBet puede escribir "Today" / "Hoy" en lugar de la fecha para los partidos del día
  if (/\b(today|hoy|tänään|heute|oggi|aujourd'hui)\b/i.test(t)) return relDay(0);
  if (/\b(tomorrow|mañana|huomenna|morgen|domani|demain)\b/i.test(t)) return relDay(1);
  if (/\b(yesterday|ayer|eilen|gestern|ieri|hier)\b/i.test(t)) return relDay(-1);
  let m = /\b(\d{1,2})\.?\s+([A-Za-zé]+)\s+(\d{4})\b/.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = /\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/.exec(t);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/.exec(t);
  if (m && +m[2] >= 1 && +m[2] <= 12) { let y = +m[3]; if (y < 100) y += 2000; return iso(y, +m[2], +m[1]); }
  // "26. September" / "26 Sep" sin año → el año más cercano a hoy
  m = /\b(\d{1,2})\.?\s+([A-Za-zé]{3,10})\b/.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) return nearest(+m[1], MONTHS[m[2].toLowerCase()]);
  m = /\b([A-Za-z]{3,10})\.?\s+(\d{1,2})\b(?!\s*[:.]\d)/.exec(t);
  if (m && MONTHS[m[1].toLowerCase()]) return nearest(+m[2], MONTHS[m[1].toLowerCase()]);
  // "26/09" o "26/09/2026"
  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] <= 31) { if (m[3]) { let y = +m[3]; if (y < 100) y += 2000; return iso(y, +m[2], +m[1]); } return nearest(+m[1], +m[2]); }
  // "26.9." (con punto final; sin él se confundiría con cuotas como 2.10)
  m = /(?:^|\s)(\d{1,2})\.(\d{1,2})\.(?=\s|$)/.exec(t);
  if (m && +m[2] >= 1 && +m[2] <= 12) {
    // sin año: el más cercano a hoy
    const now = new Date(), y = now.getUTCFullYear();
    const cands = [y - 1, y, y + 1].map((yy) => iso(yy, +m[2], +m[1]));
    return cands.sort((a, b) => Math.abs(new Date(a) - now) - Math.abs(new Date(b) - now))[0];
  }
  return null;
}

// Un partido = una fila de tabla que contiene DOS equipos conocidos (de las posiciones).
// Si trae marcador "98 - 97" es un resultado; si no, es un partido por jugar.
function parseGames(tables, knownKeys, nameOf) {
  const games = [];
  const seen = new Set();
  let curDate = null;
  const misses = [];
  // Nombre parecido: "Siegen" ↔ "Sportfreunde Siegen", "SC Wiedenbrück" ↔ "Wiedenbrück"
  // (una clave contiene a la otra, mínimo 5 letras, y un solo candidato)
  const known = [...knownKeys];
  const fuzzyCache = new Map();
  const fuzzy = (k) => {
    if (!k || k.length < 5 || /^\d+$/.test(k)) return null;
    if (fuzzyCache.has(k)) return fuzzyCache.get(k);
    const hits = known.filter((x) => x.length >= 5 && (x.includes(k) || k.includes(x)));
    const res = hits.length === 1 ? hits[0] : null;
    fuzzyCache.set(k, res);
    return res;
  };
  const teamIn = (cell) => {
    const k = tkey(cell);
    if (knownKeys.has(k)) return k;
    if (/\d{1,2}[:.]\d{2}|^\s*[\d\s.,:%+\-–/]*$/.test(cell) || cell.length > 45) return null; // horas, cuotas, marcadores
    return fuzzy(k);
  };
  const resolve = (s) => { const k = tkey(s); return knownKeys.has(k) ? k : fuzzy(k); };
  for (const t of tables) {
    curDate = null; // la fecha de un encabezado vale solo dentro de su tabla
    for (const r of t.rows) {
      const rowText = r.join(" | ");
      const d = findDate(rowText);
      // fila solo de fecha (cabecera de día)
      const teamsInRow = [];
      for (const c of r) {
        const k = teamIn(c);
        if (k) teamsInRow.push(k);
        else if (/\s[-–]\s/.test(c)) {
          const parts = c.split(/\s[-–]\s/).map((p) => p.trim());
          const a = parts.length === 2 && resolve(parts[0]), b = parts.length === 2 && resolve(parts[1]);
          if (a && b) teamsInRow.push(a, b);
        }
      }
      // Fila que parece partido (fecha/hora + textos) pero con equipos no reconocidos → se reporta
      const intCells = r.filter((c) => /^\s*[+-]?\d+%?\s*$/.test(c)).length; // filas de tablas de posiciones
      if (teamsInRow.length < 2 && intCells < 3 && (d || r.some((c) => /^\s*([01]?\d|2[0-3]):[0-5]\d\s*$/.test(c)))) {
        const words = r.filter((c) => /[A-Za-zÀ-ÿ]{3}/.test(c) && !findDate(c) && c.length <= 45);
        if (teamsInRow.length === 1 || words.length >= 2) misses.push(rowText.slice(0, 140));
      }
      if (d && teamsInRow.length < 2) { curDate = d; continue; }
      if (teamsInRow.length < 2) continue;
      const [hk, ak] = teamsInRow;
      if (hk === ak) continue;
      const date = d || curDate;
      // Marcador: celda "2 - 1" (no confundir con la hora "18:00", que usa dos puntos)
      let score = null;
      for (const c of r) {
        const m = /^\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(?:\(.*\))?\s*$/.exec(c);
        if (m) { score = m; break; }
      }
      const time = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(rowText);
      const odds = r.map((c) => c.trim()).filter((c) => /^\d{1,2}\.\d{2}$/.test(c)).map(Number);
      // Hándicap de la casa de apuestas (columna HC: "0", "+19.5", "-29.5")
      const hcCell = odds.length >= 2 ? r.map((c) => c.trim()).find((c) => /^([+-]\d{1,2}(\.\d{1,2})?|0)$/.test(c)) : null;
      const id = `${date}|${hk}|${ak}`;
      if (seen.has(id)) continue;
      seen.add(id);
      games.push({
        date, time: time ? time[0] : "",
        home: nameOf(hk), away: nameOf(ak), homeKey: hk, awayKey: ak,
        score: score ? [+score[1], +score[2]] : null,
        odds: odds.length >= 2 ? odds.slice(0, 3) : null,
        hc: hcCell ? Number(hcCell) : null,
        ...(date ? {} : { raw: rowText.slice(0, 160) }),
      });
    }
  }
  games.misses = misses;
  return games;
}

// ---------- ligas ----------
// País de cada liga: 1) el título de país del menú de AnnaBet ("Germany", "Soccer England"),
// 2) si no, el gentilicio del enlace ("serie_253_German_Regionalliga_West" → Alemania).
const COUNTRY_ES = {
  england: "Inglaterra", scotland: "Escocia", wales: "Gales", "northern ireland": "Irlanda del Norte", ireland: "Irlanda",
  germany: "Alemania", spain: "España", italy: "Italia", france: "Francia", netherlands: "Países Bajos", holland: "Países Bajos",
  belgium: "Bélgica", portugal: "Portugal", turkey: "Turquía", "türkiye": "Turquía", greece: "Grecia", russia: "Rusia",
  ukraine: "Ucrania", poland: "Polonia", "czech republic": "Rep. Checa", czechia: "Rep. Checa", slovakia: "Eslovaquia",
  austria: "Austria", switzerland: "Suiza", denmark: "Dinamarca", sweden: "Suecia", norway: "Noruega", finland: "Finlandia",
  iceland: "Islandia", croatia: "Croacia", serbia: "Serbia", slovenia: "Eslovenia", bosnia: "Bosnia", "bosnia and herzegovina": "Bosnia",
  romania: "Rumania", bulgaria: "Bulgaria", hungary: "Hungría", cyprus: "Chipre", israel: "Israel", latvia: "Letonia",
  lithuania: "Lituania", estonia: "Estonia", belarus: "Bielorrusia", albania: "Albania", montenegro: "Montenegro",
  "north macedonia": "Macedonia del Norte", macedonia: "Macedonia del Norte", georgia: "Georgia", armenia: "Armenia",
  azerbaijan: "Azerbaiyán", kazakhstan: "Kazajistán", moldova: "Moldavia", malta: "Malta", luxembourg: "Luxemburgo",
  "faroe islands": "Islas Feroe", andorra: "Andorra", "san marino": "San Marino", gibraltar: "Gibraltar",
  brazil: "Brasil", argentina: "Argentina", chile: "Chile", colombia: "Colombia", mexico: "México", uruguay: "Uruguay",
  paraguay: "Paraguay", peru: "Perú", ecuador: "Ecuador", bolivia: "Bolivia", venezuela: "Venezuela", usa: "EE.UU.",
  "united states": "EE.UU.", canada: "Canadá", "costa rica": "Costa Rica", honduras: "Honduras", guatemala: "Guatemala",
  "el salvador": "El Salvador", panama: "Panamá", nicaragua: "Nicaragua", jamaica: "Jamaica",
  japan: "Japón", "south korea": "Corea del Sur", korea: "Corea del Sur", china: "China", australia: "Australia",
  "saudi arabia": "Arabia Saudita", qatar: "Catar", "united arab emirates": "Emiratos Árabes", uae: "Emiratos Árabes",
  iran: "Irán", india: "India", thailand: "Tailandia", vietnam: "Vietnam", indonesia: "Indonesia", malaysia: "Malasia",
  singapore: "Singapur", egypt: "Egipto", morocco: "Marruecos", algeria: "Argelia", tunisia: "Túnez",
  "south africa": "Sudáfrica", nigeria: "Nigeria", ghana: "Ghana", "new zealand": "Nueva Zelanda",
  europe: "Europa", "north america": "Norteamérica", asia: "Asia", africa: "África", oceania: "Oceanía",
  philippines: "Filipinas", taiwan: "Taiwán", lebanon: "Líbano", jordan: "Jordania", "puerto rico": "Puerto Rico",
  "dominican republic": "Rep. Dominicana", cuba: "Cuba", international: "Internacional", world: "Mundial", "south america": "Sudamérica",
};
const DEMONYM_ES = {
  english: "Inglaterra", scottish: "Escocia", welsh: "Gales", northern: "Irlanda del Norte", irish: "Irlanda",
  german: "Alemania", spanish: "España", italian: "Italia", french: "Francia", dutch: "Países Bajos", belgian: "Bélgica",
  portuguese: "Portugal", turkish: "Turquía", greek: "Grecia", russian: "Rusia", ukrainian: "Ucrania", polish: "Polonia",
  czech: "Rep. Checa", slovak: "Eslovaquia", slovakian: "Eslovaquia", austrian: "Austria", swiss: "Suiza", danish: "Dinamarca",
  swedish: "Suecia", norwegian: "Noruega", finnish: "Finlandia", icelandic: "Islandia", croatian: "Croacia", serbian: "Serbia",
  slovenian: "Eslovenia", bosnian: "Bosnia", romanian: "Rumania", bulgarian: "Bulgaria", hungarian: "Hungría",
  cypriot: "Chipre", cyprus: "Chipre", israeli: "Israel", latvian: "Letonia", lithuanian: "Lituania", estonian: "Estonia",
  belarusian: "Bielorrusia", albanian: "Albania", montenegrin: "Montenegro", macedonian: "Macedonia del Norte",
  georgian: "Georgia", armenian: "Armenia", azerbaijani: "Azerbaiyán", kazakh: "Kazajistán", moldovan: "Moldavia",
  maltese: "Malta", luxembourg: "Luxemburgo", faroese: "Islas Feroe", brazilian: "Brasil", argentinian: "Argentina",
  argentine: "Argentina", argentina: "Argentina", chilean: "Chile", colombian: "Colombia", mexican: "México",
  uruguayan: "Uruguay", paraguayan: "Paraguay", peruvian: "Perú", ecuadorian: "Ecuador", bolivian: "Bolivia",
  venezuelan: "Venezuela", american: "EE.UU.", us: "EE.UU.", usa: "EE.UU.", canadian: "Canadá", japanese: "Japón",
  korean: "Corea del Sur", chinese: "China", australian: "Australia", saudi: "Arabia Saudita", qatari: "Catar",
  egyptian: "Egipto", moroccan: "Marruecos", algerian: "Argelia", tunisian: "Túnez", "south": null,
};
function countryOfHeading(t) {
  const k = String(t || "").replace(/^(soccer|football|basketball|ice hockey|hockey)\s+/i, "").trim().toLowerCase();
  return COUNTRY_ES[k] || null;
}
function countryOfSlug(slug) {
  const w = String(slug || "").split("_");
  return DEMONYM_ES[(w[0] || "").toLowerCase()] || null;
}
function parseLeagues(html) {
  // Solo enlaces <a> reales (no <link hreflang> de la cabecera), con texto corto
  const re = /<a\b[^>]*?href="[^"]*?(serie_(\d+)_([^"\/]+?))\.html"[^>]*>((?:(?!<\/a>)[\s\S]){0,300}?)<\/a>/gi;
  const out = new Map();
  let m, last = 0, heading = null;
  while ((m = re.exec(html))) {
    // texto entre el enlace anterior y este = posible título de país del menú
    const aStart = Math.max(last, html.lastIndexOf("<a", m.index));
    const between = decode(html.slice(last, aStart).replace(/<a\b[\s\S]*?<\/a>/gi, " "));
    last = m.index + m[0].length;
    if (between) heading = between.length <= 40 && !/\d/.test(between) ? between : null;
    if (/,/.test(m[1])) continue; // enlaces de temporadas anteriores
    let id = decode(m[1]);
    try { id = decodeURIComponent(id); } catch {}
    let txt = decode(m[4]);
    if (!txt || txt.length > 60 || /[#{};]/.test(txt)) txt = m[3].replace(/_/g, " ");
    const country = countryOfHeading(heading) || countryOfSlug(m[3]);
    // "Alemania: Regionalliga West" (sin repetir el país si el nombre ya lo trae)
    const label = country && !tkey(txt).includes(tkey(country)) ? `${country}: ${txt.replace(/^(English|German|Spanish|Italian|French|Finnish|Swedish|Norwegian|Danish|Dutch|Belgian|Portuguese|Turkish|Greek|Russian|Polish|Czech|Swiss|Austrian|Scottish|Irish|Brazilian|Argentinian|Mexican|American|Japanese|Korean|Chinese|Australian)\s+/i, "")}` : txt;
    if (!out.has(id)) out.set(id, label);
  }
  // Orden alfabético por país: en la lista se escribe "Ale…" y salta a Alemania
  return [...out.entries()].sort((x, y) => x[1].localeCompare(y[1], "es"));
}

const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });

// Acepta cualquier nombre de liga del menú (con acentos, &, etc.), sin barras ni saltos
const cleanLeague = (s) => (s && /^serie_\d+_[^\/?#\s"<>]+$/.test(s) ? s : null);

async function leaguesResponse() {
  try {
    const html = await getHtml(`${SITE}${MENU_PAGE}.html`);
    const list = parseLeagues(html);
    if (list.length < 5) throw new Error("menú de ligas no encontrado");
    return json({ ok: true, leagues: list, source: "annabet" }, 200, {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=86400",
      "Netlify-Vary": "query=part",
    });
  } catch (e) {
    return json({ ok: true, leagues: FALLBACK_LEAGUES, source: "respaldo", warning: e.message }, 200, { "Cache-Control": "no-store" });
  }
}

async function debugUpcoming() {
  const out = [];
  for (const u of UPCOMING_PAGES) {
    try {
      const r = await fetch(u, { headers: HEADERS });
      const html = await r.text();
      const tables = parseTables(html);
      out.push({ url: u, status: r.status, final: r.url, bytes: html.length, tablas: tables.length,
        muestra: tables.slice(0, 6).map((t, i) => ({ n: i, filas: t.rows.length, primeras: t.rows.slice(0, 5) })) });
    } catch (e) { out.push({ url: u, error: e.message }); }
  }
  return out;
}

async function debugResponse(league) {
  const u = `${SITE}${encodeURI(league)}.html`;
  try {
    const r = await fetch(u, { headers: HEADERS });
    const html = await r.text();
    const tables = parseTables(html);
    return json({
      url: u, status: r.status, bytes: html.length, tablas: tables.length,
      muestra: tables.slice(0, 30).map((t, i) => ({
        n: i, filas: t.rows.length,
        antes: decode(html.slice(Math.max(0, t.index - 300), t.index)).slice(-120),
        primeras: t.rows.slice(0, 4),
      })),
      fechasEncontradas: [...new Set((decode(html).match(/\b\d{1,2}\.\s+[A-Z][a-z]+\s+\d{4}\b/g) || []))].slice(0, 10),
      ligasEnMenu: parseLeagues(html).length,
      partidos: (() => {
        try {
          const stn = parseStandings(html, tables);
          const nm = {}; for (const m of [stn.all, stn.home, stn.away]) for (const [k, v] of Object.entries(m || {})) nm[k] ||= v.team;
          const g = parseGames(tables, new Set(Object.keys(nm)), (k) => nm[k]);
          return { total: g.length, porFecha: g.reduce((a, x) => ((a[x.date || "SIN FECHA"] = (a[x.date || "SIN FECHA"] || 0) + 1), a), {}),
            sinFecha: g.filter((x) => !x.date).slice(0, 8).map((x) => x.raw),
            equiposNoReconocidos: [...new Set(g.misses || [])].slice(0, 12),
            tablasPosiciones: { general: Object.keys(stn.all || {}).length, casa: Object.keys(stn.home || {}).length, fuera: Object.keys(stn.away || {}).length, elegidasPorPartidos: !!stn.picked },
            proximos: g.filter((x) => !x.score).slice(0, 10).map((x) => `${x.date} ${x.time} ${x.home} - ${x.away}`) };
        } catch (e) { return { error: e.message }; }
      })(),
      pestanaProximos: probeUpcoming(html),
      candidatosProximos: upcomingCandidates(html, league),
    }, 200, { "Cache-Control": "no-store" });
  } catch (e) {
    return json({ url: u, error: e.message }, 200, { "Cache-Control": "no-store" });
  }
}


// ---------- partidos próximos ----------
// La página de la liga de AnnaBet trae resultados, pero la pestaña "Upcoming Games" se carga aparte.
// 1) Se buscan en el HTML de la liga los enlaces/direcciones que parezcan de próximos partidos.
// 2) Además se usa la página del día de AnnaBet (results_0 = hoy, results_1 = mañana si existe).
// La página pide cada fuente con ?part=rows&path=... y une los partidos de sus equipos.
const ORIGIN = "https://annabet.com";
function upcomingCandidates(html, league) {
  const sid = (/^serie_(\d+)_/.exec(league) || [])[1] || "";
  const found = new Set();
  const re = /["'(=\s]((?:https?:\/\/(?:www\.)?annabet\.com)?\/?[\w\/.\-]*?(?:upcoming|coming|next_?games?|fixtures?|schedule|program)[\w\/.\-]*(?:\.php|\.html|\/)?(?:\?[\w=&%.,\-]*)?)["')\s]/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[1].replace(/^https?:\/\/(?:www\.)?annabet\.com/i, "");
    if (u.length < 6 || /\.(js|css|png|jpg|gif|svg)(\?|$)/i.test(u)) continue;
    if (!/\.(php|html?)\b|\?/i.test(u)) continue; // solo páginas reales (no nombres de pestañas)
    if (!u.startsWith("/")) u = new URL(u, SITE).pathname + (u.includes("?") ? u.slice(u.indexOf("?")) : "");
    if (sid && /serie=|serie_|id=/.test(u) && !u.includes(sid)) continue; // de otra liga
    found.add(u);
  }
  const base = new URL(SITE).pathname; // "/en/soccerstats/"
  return [...found].slice(0, 4).concat([`${base}results_0.html`, `${base}results_1.html`]);
}
const cleanPath = (p) => (p && /^\/[\w\/.,?=&%\-]+$/.test(p) && !p.includes("..") ? p : null);

// Filas genéricas de partido: dos equipos (texto) + hora o marcador
function genericRows(html, dayOffset) {
  const rows = [];
  const tables = parseTables(html);
  const baseDate = dayOffset != null ? relDay(dayOffset) : null;
  for (const t of tables) {
    let curDate = null, league = "";
    for (const r of t.rows) {
      const rowText = r.join(" | ");
      if (/odds:|season|average|total|%/i.test(rowText) && !/\b\d{1,2}:\d{2}\b/.test(rowText)) continue;
      const d = findDate(rowText);
      const time = r.map((c) => /^\s*(?:\d{1,2}\.\d{1,2}\.?\s*)?(([01]?\d|2[0-3]):[0-5]\d)\s*$/.exec(c)).find(Boolean);
      let score = null, ot = "";
      for (const c of r) {
        const sm = /^\s*(\d{1,3})\s*[-–]\s*(\d{1,3})\s*(ot|so|pen|ps|ap|et|aet)?\.?\s*(?:\(.*\))?\s*$/i.exec(c);
        if (sm) { score = [+sm[1], +sm[2]]; ot = (sm[3] || "").toLowerCase(); break; }
      }
      const texts = r.map((c) => c.trim()).filter((c) => c.length >= 2 && c.length <= 45 && /[A-Za-zÀ-ÿ]{2}/.test(c) &&
        !findDate(c) && !/^(ot|so|pen|ap|et|aet|ft|fin|final|live|postp\.?|canc\.?|\d+\.\s*)$/i.test(c));
      let a = null, b = null;
      if (texts.length >= 2) { [a, b] = texts; }
      else if (texts.length === 1 && /\s[-–]\s/.test(texts[0])) { const p = texts[0].split(/\s[-–]\s/); if (p.length === 2) { a = p[0].trim(); b = p[1].trim(); } }
      if (!a || !b) {
        if (d) curDate = d;
        else if (texts.length === 1 && !time && !score) league = texts[0];
        continue;
      }
      if (!time && !score) continue;
      let odds = r.map((c) => c.trim()).filter((c) => /^\d{1,2}\.\d{2}$/.test(c)).map(Number);
      if (odds.length < 2) {
        const oc = r.find((c) => /^\s*\d{1,2}\.\d{2}(\s*[\/|]\s*\d{1,2}\.\d{2}){1,2}\s*$/.test(c));
        odds = oc ? oc.split(/[\/|]/).map((x) => Number(x.trim())) : [];
      }
      rows.push({
        date: d || curDate || baseDate, time: time ? time[1] : "", a, b, score,
        ...(ot ? { ot: /so|pen|ps/.test(ot) ? "SO" : "OT" } : {}),
        odds: odds.length >= 2 ? odds.slice(0, 3) : null, league,
      });
    }
  }
  return rows;
}

async function rowsResponse(path) {
  const p = cleanPath(path);
  if (!p) return json({ ok: false, error: "ruta no válida" }, 400, { "Cache-Control": "no-store" });
  const off = /results_(-?\d+)\.html/.exec(p);
  try {
    const r = await getHtmlPartial(ORIGIN + p, 8500);
    const rows = genericRows(r.html, off ? +off[1] : null);
    return json({ ok: true, path: p, rows, partial: r.partial }, 200, {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=600, stale-while-revalidate=1800",
      "Netlify-Vary": "query=part|path",
    });
  } catch (e) {
    return json({ ok: false, path: p, error: e.message, rows: [] }, 200, { "Cache-Control": "no-store" });
  }
}

// Diagnóstico de la pestaña "Upcoming Games": scripts y textos que la cargan
function probeUpcoming(html) {
  const out = { scripts: [], snippets: [], ids: [] };
  for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/gi)) out.scripts.push(m[1]);
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const s = m[1];
    for (const k of s.matchAll(/(upcoming|ajax|\.php|load\(|fetch\(|XMLHttp|\$\.get|\$\.post|getJSON)/gi)) {
      out.snippets.push(s.slice(Math.max(0, k.index - 150), k.index + 200).replace(/\s+/g, " "));
      if (out.snippets.length >= 12) break;
    }
    if (out.snippets.length >= 12) break;
  }
  for (const m of html.matchAll(/<[^>]+(?:upcoming|coming|next)[^>]*>/gi)) { out.ids.push(m[0].slice(0, 250)); if (out.ids.length >= 12) break; }
  return out;
}

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("part") === "rows") return rowsResponse(url.searchParams.get("path"));
  if (url.searchParams.get("part") === "leagues") return leaguesResponse();
  const askedLeague = url.searchParams.get("league");
  const league = cleanLeague(askedLeague) || "serie_1_English_Premier_League";
  if (askedLeague && !cleanLeague(askedLeague))
    return json({ ok: false, error: `Nombre de liga no válido: ${askedLeague}`, league: askedLeague }, 400, { "Cache-Control": "no-store" });
  if (url.searchParams.get("debug")) return debugResponse(league);

  // La página de la liga y la portada de próximos partidos se piden a la vez
  let html, partialPage = false;
  try {
    const r = await getHtmlPartial(`${SITE}${encodeURI(league)}.html`, 8000);
    html = r.html; partialPage = r.partial;
  } catch (e) {
    return json({ ok: false, error: `No se pudo leer la liga en AnnaBet (${e.message}). Pulsa Actualizar para reintentar.`, league }, 502, { "Cache-Control": "no-store" });
  }
  const upcomingHtml = null, upcomingFail = null;

  const warnings = [];
  if (partialPage) warnings.push("AnnaBet respondió lento: se usó la parte de la página que alcanzó a llegar (posiciones y partidos más recientes).");
  const tables = parseTables(html);
  let standings;
  try {
    standings = parseStandings(html, tables);
  } catch (e) {
    return json({ ok: false, error: `La liga no tiene tabla de posiciones en AnnaBet (${e.message}).`, league }, 502, { "Cache-Control": "no-store" });
  }
  if (standings.derived) warnings.push("La tabla general se calculó sumando las tablas de casa y fuera.");
  if (standings.mismatch) warnings.push("Las tablas de casa/fuera no cuadran con la general: se usa la general para todo.");
  else if (!standings.home || !standings.away) warnings.push("Esta liga no trae tablas de casa y fuera: se usa la general para todo.");

  const names = {};
  for (const m of [standings.all, standings.home, standings.away]) for (const [k, v] of Object.entries(m || {})) names[k] ||= v.team;
  const known = new Set(Object.keys(names));
  const nameOf = (k) => names[k];

  // a) partidos de la página de la liga (resultados y, si los trae, próximos)
  const games = parseGames(tables, known, nameOf);
  // b) próximos partidos de la portada: se quedan los que tienen a DOS equipos de esta liga
  let upcomingErr = null, upcomingCount = 0;
  if (upcomingHtml) {
    const up = parseGames(parseTables(upcomingHtml), known, nameOf);
    const idx = new Map(games.map((g, i) => [`${g.date}|${g.homeKey}|${g.awayKey}`, i]));
    for (const g of up) {
      const id = `${g.date}|${g.homeKey}|${g.awayKey}`;
      if (idx.has(id)) {
        const old = games[idx.get(id)];
        old.odds ||= g.odds; if (old.hc == null) old.hc = g.hc; old.time ||= g.time;
      } else { games.push(g); upcomingCount++; }
    }
  } else upcomingErr = upcomingFail;
  // Si la portada simplemente no trae tabla de próximos partidos no es un error: se usan los de la liga
  if (upcomingErr && !/no trae tablas/.test(upcomingErr)) warnings.push(`Próximos partidos (portada de AnnaBet): ${upcomingErr}`);
  if (!games.length) warnings.push("No se encontraron partidos de esta liga (ni resultados ni próximos).");
  const misses = [...new Set(games.misses || [])];
  if (misses.length) warnings.push(`${misses.length} fila(s) con fecha u hora cuyos equipos no están en la tabla de posiciones (no se muestran). Ejemplo: ${misses.slice(0, 3).map((x) => `"${x}"`).join(" / ")}`);
  const noDate = games.filter((g) => !g.date).length;
  if (noDate) warnings.push(`${noDate} partido(s) sin fecha reconocida (no se muestran). Ejemplo: ${games.filter((g) => !g.date).slice(0, 2).map((g) => `"${g.raw}"`).join(" / ")}`);
  for (let i = games.length - 1; i >= 0; i--) if (!games[i].date) games.splice(i, 1);

  const title = decode((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1] || "") || league.replace(/^serie_\d+_/, "").replace(/_/g, " ");

  return json(
    { ok: true, league, title, updated: new Date().toISOString(), standings, games, warnings, upcomingUrls: upcomingCandidates(html, league) },
    200,
    {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=900, stale-while-revalidate=3600",
      "Netlify-Vary": "query=league",
    }
  );
};

export const config = { path: "/api/futbol" };
