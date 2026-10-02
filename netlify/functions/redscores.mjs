// Radar Fútbol Mundial — fuente RedScores.com. Ver comentarios abajo.
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
async function getHtmlPartial(url, maxMs = 8000, extraHeaders = {}) {
  const ctrl = new AbortController();
  const deadline = Date.now() + maxMs;
  const timer = setTimeout(() => ctrl.abort(), maxMs + 500);
  try {
    // si AnnaBet corta la conexión ("fetch failed") se reintenta mientras quede tiempo
    let r;
    for (let k = 0; ; k++) {
      try { r = await fetch(url, { headers: { ...HEADERS, ...extraHeaders }, signal: ctrl.signal, redirect: "follow" }); break; }
      catch (e) { if (e.name === "AbortError" || k >= 2 || deadline - Date.now() < 2500) throw e; await sleep(400); }
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!r.body || !r.body.getReader) return { html: await r.text(), partial: false, finalUrl: r.url, redirected: r.redirected };
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
    if (html.length < 2000) throw new Error(partial ? "RedScores tardó demasiado en responder" : "RedScores devolvió una página vacía (posible bloqueo)");
    return { html, partial, finalUrl: r.url, redirected: r.redirected };
  } catch (e) {
    throw e.name === "AbortError" ? new Error("RedScores tardó demasiado en responder") : e;
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

const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });

const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// ======================= RedScores =======================
// Radar Fútbol Mundial — fuente RedScores.com (función de Netlify, sin dependencias).
//   /api/redscores?part=leagues                       lista de ligas (país: liga)
//   /api/redscores?league=england/premier-league/8    posiciones + partidos + goleadores
//   /api/redscores?debug=1&league=...                 diagnóstico: cómo viene la página
const RS = "https://redscores.com";
const RS_LANG = "/es";
const RS_DEFAULT = "england/premier-league/8";
const RS_FALLBACK = [
  ["england/premier-league/8", "Inglaterra: Premier League"], ["england/championship/9", "Inglaterra: Championship"],
  ["spain/la-liga/564", "España: La Liga"], ["italy/serie-a/384", "Italia: Serie A"],
  ["germany/bundesliga/82", "Alemania: Bundesliga"], ["germany/2-bundesliga/85", "Alemania: 2. Bundesliga"],
  ["france/ligue-1/301", "Francia: Ligue 1"], ["netherlands/eredivisie/72", "Países Bajos: Eredivisie"],
  ["portugal/primeira-liga/462", "Portugal: Primeira Liga"], ["turkey/super-lig/600", "Turquía: Super Lig"],
  ["belgium/pro-league/208", "Bélgica: Pro League"], ["austria/tipico-bundesliga/181", "Austria: Bundesliga"],
  ["russia/premier-league/486", "Rusia: Premier League"], ["brazil/serie-a/648", "Brasil: Serie A"],
  ["argentina/superliga/636", "Argentina: Superliga"], ["argentina/primera-b-nacional/645", "Argentina: Primera B Nacional"],
  ["usa/major-league-soccer/779", "EE.UU.: MLS"], ["mexico/liga-mx/743", "México: Liga MX"],
  ["japan/j-league/968", "Japón: J-League"], ["china-pr/super-league/989", "China: Super League"],
  ["australia/a-league/1356", "Australia: A-League"], ["europe/champions-league/2", "Europa: Champions League"],
  ["europe/europa-league/5", "Europa: Europa League"], ["europe/uefa-europa-conference-league/2286", "Europa: Conference League"],
];
const cleanRsLeague = (s) => (s && /^[a-z0-9-]+\/[a-z0-9-]+\/\d+$/i.test(s) ? s : null);
const countryName = (slug) => {
  const t = String(slug || "").replace(/-/g, " ").toLowerCase();
  return COUNTRY_ES[t] || COUNTRY_ES[t.replace(/ pr$/, "")] || t.replace(/\b\w/g, (c) => c.toUpperCase());
};

// Tablas con el HTML de cada fila (para leer el "alt" de los escudos: nombre del equipo del goleador)
function parseTablesRaw(html) {
  const out = [];
  for (const m of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows = [];
    for (const r of m[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [...r[0].matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t\1>/gi)].map((c) => decode(c[2]));
      if (cells.length) rows.push({ cells, html: r[0] });
    }
    out.push({ index: m.index, rows });
  }
  return out;
}

// ---------- lista de ligas ----------
function parseRsLeagues(html) {
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href="(?:https?:\/\/(?:www\.)?redscores\.com)?(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/league\/([a-z0-9-]+)\/([a-z0-9-]+)\/(\d+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const id = `${m[1]}/${m[2]}/${m[3]}`.toLowerCase();
    let name = decode(m[4]).replace(/^\d+\.\s*/, "").trim();
    if (!name || name.length > 60) name = m[2].replace(/-/g, " ");
    if (!out.has(id)) out.set(id, `${countryName(m[1])}: ${name}`);
  }
  return [...out.entries()].sort((a, b) => a[1].localeCompare(b[1], "es"));
}

async function rsLeaguesResponse() {
  try {
    const { html } = await getHtmlPartial(`${RS}${RS_LANG}/leagues`, 8500);
    const list = parseRsLeagues(html);
    if (list.length < 20) throw new Error(`solo ${list.length} ligas en la lista`);
    return json({ ok: true, leagues: list, source: "redscores" }, 200, {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=86400",
      "Netlify-Vary": "query=part|league|debug",
    });
  } catch (e) {
    return json({ ok: true, leagues: RS_FALLBACK, source: "respaldo", warning: e.message }, 200, { "Cache-Control": "no-store" });
  }
}

// ---------- posiciones ----------
// Cabecera tipo "# | Equipo | PJ | V | E | L | G | Pts | Forma | PPG | BTTS ..." (G = "13:5")
const RH = {
  team: /^(equipo|team|club)$/i,
  gp: /^(pj|mp|gp|p|played|partidos)$/i,
  w: /^(v|w|g|pg|won|wins|ganados)$/i,
  d: /^(e|d|x|draws?|empates?)$/i,
  l: /^(l|d|p|pp|lost|losses|derrotas?|perdidos)$/i,
  goals: /^(g|goles|goals|gf\s*:\s*gc|gf\s*:\s*ga|dg)$/i,
  pts: /^(pts|puntos|points|p)$/i,
};
function rsStandingsTable(t) {
  const hi = t.rows.findIndex((r) => r.cells.some((c) => RH.team.test(c)) && r.cells.some((c) => /^(pj|mp|gp)$/i.test(c)));
  if (hi < 0) return null;
  const h = t.rows[hi].cells;
  const used = new Set();
  const ix = (re) => { const i = h.findIndex((c, k) => re.test(c) && !used.has(k)); if (i >= 0) used.add(i); return i; };
  const iT = ix(RH.team), iGP = ix(RH.gp), iW = ix(RH.w), iD = ix(RH.d), iL = ix(RH.l);
  // la columna de goles es la que trae "13:5"
  const iG = h.findIndex((c, k) => !used.has(k) && RH.goals.test(c));
  const map = {};
  let pos = 0;
  for (const r of t.rows.slice(hi + 1)) {
    const c = r.cells;
    // el nombre puede venir junto a la posición ("1. Manchester City") o en su celda
    let name = (c[iT] || "").replace(/^\d+\.\s*/, "").trim();
    if (!name || /^\d+$/.test(name)) continue;
    const gp = num(c[iGP]), w = num(c[iW]), d = num(c[iD]), l = num(c[iL]);
    if (gp == null || w == null || l == null) continue;
    let gf = null, ga = null;
    const gm = /(\d+)\s*[:\-–]\s*(\d+)/.exec(c[iG] || c.find((x) => /^\s*\d+\s*:\s*\d+\s*$/.test(x)) || "");
    if (gm) { gf = +gm[1]; ga = +gm[2]; }
    pos++;
    map[tkey(name)] = { team: name, pos, gp, w, d: d || 0, l,
      gf: gp > 0 && gf != null ? gf / gp : null, ga: gp > 0 && ga != null ? ga / gp : null };
  }
  return Object.keys(map).length >= 3 ? map : null;
}
function rsStandings(tables) {
  const maps = tables.map(rsStandingsTable).filter(Boolean);
  const out = { all: null, home: null, away: null };
  if (!maps.length) return out;
  const med = (m) => { const a = Object.values(m).map((x) => x.gp).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  const fits = (A, H, W) => { const ks = Object.keys(A); return ks.filter((k) => H[k] && W[k] && Math.abs(H[k].gp + W[k].gp - A[k].gp) < 0.5).length >= ks.length * 0.6; };
  // general = la de más partidos; casa/fuera = el par que suma la general
  const order = maps.map((m, i) => i).sort((a, b) => med(maps[b]) - med(maps[a]) || a - b);
  const ai = order[0];
  out.all = maps[ai];
  outer: for (let i = 0; i < maps.length; i++) for (let j = i + 1; j < maps.length; j++) {
    if (i === ai || j === ai) continue;
    if (fits(out.all, maps[i], maps[j])) { out.home = maps[i]; out.away = maps[j]; break outer; }
  }
  return out;
}

// ---------- partidos (resultados y próximos) ----------
// Se lee el texto de la página línea por línea: una fecha "09/19/26" (mes/día/año) abre un partido;
// luego vienen hora, equipo local, marcador y equipo visitante (en tabla o en bloques).
function rsGames(html, keyOf, nameOf) {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, "\n$1\n")
    .replace(/<[^>]+>/g, "\n");
  const lines = text.split("\n").map((x) => decode(x)).filter(Boolean);
  const games = [], seen = new Set();
  let cur = null;
  const flush = () => {
    if (cur && cur.teams.length === 2 && cur.date) {
      const [hk, ak] = cur.teams;
      const id = `${cur.date}|${hk}|${ak}`;
      if (!seen.has(id) && hk !== ak) {
        seen.add(id);
        const sc = cur.nums.length >= 2 ? [cur.nums[0], cur.nums[1]] : cur.score;
        games.push({ date: cur.date, time: cur.time || "", home: nameOf(hk), away: nameOf(ak), homeKey: hk, awayKey: ak,
          score: sc || null, odds: null, hc: null });
      }
    }
    cur = null;
  };
  for (const ln of lines) {
    const dm = /^(?:[A-Za-zÀ-ÿ]+\.?,?\s*)?(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}:\d{2}))?$/.exec(ln);
    if (dm) {
      flush();
      const y = +dm[3] < 100 ? 2000 + +dm[3] : +dm[3];
      cur = { date: iso(y, +dm[1], +dm[2]), time: dm[4] || "", teams: [], nums: [], score: null };
      continue;
    }
    if (!cur) continue;
    if (/^\d{1,2}:\d{2}$/.test(ln) && !cur.time && !cur.teams.length) { cur.time = ln; continue; }
    const sm = /^(\d{1,2})\s*[-–:]\s*(\d{1,2})$/.exec(ln);
    if (sm && cur.teams.length >= 1 && !cur.score) { cur.score = [+sm[1], +sm[2]]; continue; }
    if (/^\d{1,2}$/.test(ln) && cur.teams.length >= 1 && cur.nums.length < 2) { cur.nums.push(+ln); continue; }
    const k = ln.length <= 45 ? keyOf(ln) : null;
    if (k) {
      if (cur.teams.length < 2) { if (cur.teams[0] !== k) cur.teams.push(k); }
      else flush();
      continue;
    }
    if (cur.teams.length === 2 && ln.length > 60) flush(); // texto largo: terminó el bloque del partido
  }
  flush();
  return games;
}

// ---------- goleadores ----------
// "Máximos goleadores": jugador | goles del jugador y del equipo | contribución %. El equipo sale en el
// escudo (alt) o en una celda. Promedio = goles del jugador ÷ partidos jugados de su equipo.
function rsScorers(tables, keyOf, nameOf, standings) {
  const out = [];
  for (const t of tables) {
    const hi = t.rows.findIndex((r) => r.cells.some((c) => /^(jugador|player)$/i.test(c)));
    if (hi < 0) continue;
    for (const r of t.rows.slice(hi + 1)) {
      const c = r.cells;
      const nums = c.join(" ").replace(/\d+\s*%/g, " ").match(/\b\d{1,3}\b/g)?.map(Number) || [];
      const pct = num((c.find((x) => /%/.test(x)) || "").replace("%", ""));
      const name = c.map((x) => x.replace(/^\d+\.\s*/, "").trim()).find((x) => /[A-Za-zÀ-ÿ]{2}/.test(x) && !/%/.test(x));
      if (!name) continue;
      // equipo: alt/title de las imágenes o celdas con nombre de equipo conocido
      const alts = [...r.html.matchAll(/\b(?:alt|title)="([^"]+)"/gi)].map((m) => decode(m[1]));
      let tk = null;
      for (const a of [...alts, ...c]) { const k = keyOf(a); if (k) { tk = k; break; } }
      // goles del jugador: el número menor de la pareja (el otro es el total del equipo); se confirma con el %
      const two = nums.slice(-2);
      let goals = two.length === 2 ? Math.min(...two) : two[0];
      if (two.length === 2 && pct) {
        const big = Math.max(...two);
        const guess = Math.round((pct / 100) * big);
        if (two.includes(guess)) goals = guess;
      }
      if (goals == null) continue;
      const gp = tk && standings.all?.[tk] ? standings.all[tk].gp : null;
      out.push({ player: name, team: tk ? nameOf(tk) : (alts[0] || ""), teamKey: tk, goals, gp, avg: gp ? goals / gp : null });
    }
    if (out.length) break;
  }
  return out;
}

function rsKeyIndex(standings) {
  const names = {};
  for (const m of [standings.all, standings.home, standings.away]) for (const [k, v] of Object.entries(m || {})) names[k] ||= v.team;
  const keys = Object.keys(names);
  const cache = new Map();
  const keyOf = (s) => {
    const k = tkey(s);
    if (!k || k.length < 3) return null;
    if (names[k]) return k;
    if (cache.has(k)) return cache.get(k);
    let res = null;
    if (k.length >= 5) {
      const hits = keys.filter((x) => x.length >= 5 && (x.includes(k) || k.includes(x)));
      if (hits.length === 1) {
        const extra = k.length > hits[0].length ? k.replace(hits[0], "") : hits[0].replace(k, "");
        if (!/^(w|women|ii|iii|b|u\d{2}|res|reserves)$/.test(extra)) res = hits[0];
      }
    }
    cache.set(k, res);
    return res;
  };
  return { keyOf, nameOf: (k) => names[k] };
}

function rsTableHeads(tables) {
  return tables.filter((t) => t.rows.length >= 3).slice(0, 8)
    .map((t, i) => `#${i + 1} (${t.rows.length} filas) ${t.rows.slice(0, 2).map((r) => r.cells.join(" ").slice(0, 70)).join(" / ")}`).join(" ‖ ");
}
// Pistas de cómo se cargan las pestañas Casa/Fuera (si no vienen en la página)
function rsProbe(html) {
  const hints = [];
  for (const m of html.matchAll(/(?:data-[\w-]+|href|onclick)="([^"]*(?:home|away|casa|fuera|standing|table|clasif)[^"]*)"/gi)) { hints.push(m[0].slice(0, 160)); if (hints.length >= 8) break; }
  for (const m of html.matchAll(/(fetch|ajax|\.load|axios|XMLHttpRequest)\s*\(?\s*['"`]([^'"`]+)['"`]/gi)) { hints.push(`${m[1]} ${m[2]}`.slice(0, 160)); if (hints.length >= 14) break; }
  return hints;
}

export default async (req) => {
  const url = new URL(req.url);
  const part = url.searchParams.get("part");
  if (part === "leagues") return rsLeaguesResponse();
  const asked = url.searchParams.get("league");
  const league = cleanRsLeague(asked) || RS_DEFAULT;
  if (asked && !cleanRsLeague(asked)) return json({ ok: false, error: `Liga no válida: ${asked}` }, 400, { "Cache-Control": "no-store" });
  const pageUrl = `${RS}${RS_LANG}/league/${league}`;

  let html, partial = false;
  try {
    const r = await getHtmlPartial(pageUrl, 8500);
    html = r.html; partial = r.partial;
  } catch (e) {
    return json({ ok: false, error: `No se pudo leer la liga en RedScores (${e.message}). Pulsa Actualizar para reintentar.`, league }, 502, { "Cache-Control": "no-store" });
  }
  const tables = parseTablesRaw(html);
  const standings = rsStandings(tables);

  if (url.searchParams.get("debug")) {
    return json({ url: pageUrl, bytes: html.length, partial, tablas: tables.length,
      muestra: tables.slice(0, 12).map((t, i) => ({ n: i, filas: t.rows.length, primeras: t.rows.slice(0, 3).map((r) => r.cells) })),
      equipos: { general: Object.keys(standings.all || {}).length, casa: Object.keys(standings.home || {}).length, fuera: Object.keys(standings.away || {}).length },
      pistasCasaFuera: rsProbe(html),
      textoConFechas: (html.replace(/<[^>]+>/g, "\n").split("\n").map((x) => decode(x)).filter(Boolean)
        .map((x, i, a) => (/\d{1,2}\/\d{1,2}\/\d{2}/.test(x) ? a.slice(i, i + 7).join(" | ") : null)).filter(Boolean).slice(0, 10)),
    }, 200, { "Cache-Control": "no-store" });
  }

  const warnings = [];
  if (partial) warnings.push("RedScores respondió lento: se usó la parte de la página que alcanzó a llegar.");
  if (!standings.all) {
    return json({ ok: false, error: `No se encontró la tabla de posiciones en RedScores. Tablas vistas: ${rsTableHeads(tables)}`, league }, 502, { "Cache-Control": "no-store" });
  }
  if (!standings.home || !standings.away) {
    const hints = rsProbe(html);
    warnings.push(`RedScores no trae las tablas de casa y fuera dentro de la página: LL/VV usa la tabla general.${hints.length ? " Pistas: " + hints.slice(0, 6).join(" ‖ ") : ""}`);
  }
  const { keyOf, nameOf } = rsKeyIndex(standings);
  const games = rsGames(html, keyOf, nameOf);
  if (!games.length) warnings.push("No se encontraron partidos de esta liga en RedScores (ni resultados ni próximos).");
  const scorers = rsScorers(tables, keyOf, nameOf, standings);

  const h1 = decode((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1] || "");
  const [cty, slug] = league.split("/");
  const title = `${countryName(cty)}: ${h1 || slug.replace(/-/g, " ")}`.replace(/\s+ESTAD[ÍI]STICAS.*$/i, "");

  return json({ ok: true, source: "redscores", league, title, updated: new Date().toISOString(), standings, games, scorers, warnings,
    timeNote: "Horas según RedScores" },
  200, partial || !games.length ? { "Cache-Control": "no-store" } : {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Netlify-CDN-Cache-Control": "public, durable, s-maxage=900, stale-while-revalidate=1800",
    "Netlify-Vary": "query=league|part|debug",
  });
};

export const config = { path: "/api/redscores" };
