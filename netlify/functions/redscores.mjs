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
// Lista de ligas del usuario (sus nombres), usada como menú principal de RedScores
const RS_MY_LIST = [["africa/caf-champions-league/1107", "AFRICA CAF CHAMPIONS LEAGUE"],
  ["africa/caf-confederations-cup/1108", "AFRICA CAF CONFEDERATIONS CUP"],
  ["africa/africa-cup-of-nations/1117", "AFRICA COPA DE NACIONES"],
  ["africa/wc-qualification-africa/711", "AFRICA MUNDIAL CLASIFICACION"],
  ["albania/superliga/172", "ALBANIA LIGA 1"],
  ["germany/bundesliga/82", "ALEMANIA BUNDESLIGA"],
  ["germany/2-bundesliga/85", "ALEMANIA BUNDESLIGA 2"],
  ["germany/2-bundesliga-women/1879", "ALEMANIA BUNDESLIGA 2 FEMENINA"],
  ["germany/3-liga/88", "ALEMANIA BUNDESLIGA 3"],
  ["germany/bundesliga-women/1740", "ALEMANIA BUNDESLIGA FEMENINA"],
  ["germany/junioren-bundesliga/1422", "ALEMANIA BUNDESLIGA JR"],
  ["germany/oberliga-baden-wurttemberg/112", "ALEMANIA OBERLIGA BADEN"],
  ["germany/oberliga-bayern-nord/115", "ALEMANIA OBERLIGA BAYER NORD"],
  ["germany/oberliga-bremen/124", "ALEMANIA OBERLIGA BREMEN"],
  ["germany/oberliga-hamburg/127", "ALEMANIA OBERLIGA HAMBURGO"],
  ["germany/oberliga-rheinland-pfalzsaar/151", "ALEMANIA OBERLIGA HEIN LAND"],
  ["germany/oberliga-hessen/130", "ALEMANIA OBERLIGA HESSEN"],
  ["germany/oberliga-mittelrhein/133", "ALEMANIA OBERLIGA MITTELRHEIN"],
  ["germany/oberliga-niederrhein/136", "ALEMANIA OBERLIGA NIEDERHEIM"],
  ["germany/oberliga-niedersachsen/139", "ALEMANIA OBERLIGA NIEDERSACHSEN"],
  ["germany/oberliga-nordost-nord/142", "ALEMANIA OBERLIGA NOFV NORTH"],
  ["germany/oberliga-nordost-sud/145", "ALEMANIA OBERLIGA NOFV SOUTH"],
  ["germany/oberliga-schleswig-holstein/154", "ALEMANIA OBERLIGA SCHESWIG-HOLSTEIN"],
  ["germany/oberliga-bayern-sud/118", "ALEMANIA OBERLIGA SUD"],
  ["germany/oberliga-westfalen/160", "ALEMANIA OBERLIGA WESTFALEN"],
  ["germany/regionalliga-bayern/94", "ALEMANIA REGIONALIGA BAYERN"],
  ["germany/regionalliga-nord/91", "ALEMANIA REGIONALIGA NORD"],
  ["germany/regionalliga-nordost/97", "ALEMANIA REGIONALIGA NORDOST"],
  ["germany/regionalliga-sudwest/103", "ALEMANIA REGIONALIGA SUDWEST"],
  ["germany/regionalliga-west/106", "ALEMANIA REGIONALIGA WEST"],
  ["andorra/primera-division/893", "ANDORRA LIGA 1"],
  ["angola/girabola/815", "ANGOLA LIGA 1"],
  ["antigua-and-barbuda/premier-division/1649", "ANTIGUA Y BARBUDA LIGA 1"],
  ["saudi-arabia/division-1/947", "ARABIA SAUDITA 2"],
  ["saudi-arabia/pro-league/944", "ARABIA SAUDITA LIGA PRO"],
  ["algeria/ligue-1/809", "ARGELIA LIGA 1"],
  ["algeria/ligue-2/812", "ARGELIA LIGA 2"],
  ["algeria/algeria-youth-league/1597", "ARGELIA U21"],
  ["argentina/primera-c/1093", "ARGENTINA C APERTURA 1/2 / ARGENTINA C CLAUSURA 1/2"],
  ["argentina/primera-d-metropolitana/1094", "ARGENTINA D MET APER1/2 / ARGENTINA D MET CLAU 1/2"],
  ["argentina/superliga/636", "ARGENTINA LIGA PROFESIONAL APER 2 / ARGENTINA LIGA PROFESIONAL CLAU 3"],
  ["argentina/primera-b-nacional/645", "ARGENTINA NACIONAL UNA SOLA"],
  ["argentina/primera-b-metropolitana/1330", "ARGENTINA PRIMERA B METROP APER / ARGENTINA PRIMERA B METROP CLAUS"],
  ["argentina/reserve-league/1642", "ARGENTINA RESERVAS"],
  ["argentina/torneo-federal-a/1333", "ARGENTINA TORNEO FEDERAL A 1/2"],
  ["argentina/torneo-federal-b/639", "ARGENTINA TORNEO FEDERAL B"],
  ["armenia/first-league/178", "ARMENIA FIRST LIGA"],
  ["armenia/premier-league/175", "ARMENIA LIGA 1"],
  ["aruba/division-de-honor/1335", "ARUBA LIGA DE HONOR"],
  ["asia/afc-champions-league/1085", "ASIA AFC CHAMPIONS LEAGUE"],
  ["asia/afc-cup/1088", "ASIA AFC CUP"],
  ["world/wc-qualification-asia/714", "ASIA MUNDIAL CLASIFICACION"],
  ["australia/a-league/1356", "AUSTRALIA A LIGUE"],
  ["australia/capital-territory/1382", "AUSTRALIA CAPITAL TERRITORY ACT"],
  ["australia/northern-nsw/1514", "AUSTRALIA NOTHERN NSW"],
  ["australia/new-south-wales/1383", "AUSTRALIA NPL NSW"],
  ["australia/npl-queensland/1409", "AUSTRALIA NPL QUEENSLAND"],
  ["australia/npl-tasmania/1408", "AUSTRALIA NPL TAZMANIA"],
  ["australia/npl-victoria/1490", "AUSTRALIA NPL VICTORIA"],
  ["australia/npl-south-australian/1485", "AUSTRALIA SOUTH"],
  ["australia/w-league/1583", "AUSTRALIA W LIGUE F"],
  ["australia/npl-western-australia/1407", "AUSTRALIA WESTERN"],
  ["austria/erste-liga/184", "AUSTRIA 2"],
  ["austria/tipico-bundesliga/181", "AUSTRIA BUNDESLIGA"],
  ["austria/landesliga-burgenland/1817", "AUSTRIA LANDESLIGA BURGENLAND"],
  ["austria/landesliga-karnten/1823", "AUSTRIA LANDESLIGA KANTERN"],
  ["austria/landesliga-niederosterreich/1818", "AUSTRIA LANDESLIGA NIEDEROSTERREICH"],
  ["austria/landesliga-oberosterreich/1819", "AUSTRIA LANDESLIGA OBEROSTERREICH"],
  ["austria/landesliga-salzburg/1822", "AUSTRIA LANDESLIGA SALZBURG"],
  ["austria/landesliga-steiermark/1820", "AUSTRIA LANDESLIGA STEIMARK"],
  ["austria/landesliga-tirol/1821", "AUSTRIA LANDESLIGA TIROL"],
  ["austria/landesliga-vorarlberg/1695", "AUSTRIA LANDESLIGA VORALBERG"],
  ["austria/landesliga-wien/1816", "AUSTRIA LANDESLIGA WEIN"],
  ["austria/regionalliga-mitte/1510", "AUSTRIA REGIONALIGA CENTRAL"],
  ["austria/regionalliga-ost/1511", "AUSTRIA REGIONALIGA OST"],
  ["austria/regionalliga-salzburg/1925", "AUSTRIA REGIONALIGA SALZBURG"],
  ["austria/regionalliga-tirol/1923", "AUSTRIA REGIONALIGA TIROL"],
  ["austria/regionalliga-vorarlberg/1924", "AUSTRIA REGIONALIGA VORARLBERG"],
  ["austria/regionalliga-west/1512", "AUSTRIA REGIONALIGA WEST"],
  ["azerbaijan/birinci-dasta/196", "AZERBAYAN LIGA 2"],
  ["azerbaijan/premier-league/190", "AZERBAYAN PREMIER LEAGUE"],
  ["bangladesh/premier-league/974", "BANGLADESH LIGA 1"],
  ["bahrain/premier-league/971", "BAREIN LIGA 1"],
  ["belgium/first-amateur-division/1418", "BELGICA DIVISION NACIONAL"],
  ["belgium/pro-league/208", "BELGICA JUPITER PRO"],
  ["belgium/first-division-b/211", "BELGICA LIGA 2"],
  ["belgium/reserve-pro-league-2/1757", "BELGICA LIGA PRO 2 U21"],
  ["belgium/reserve-pro-league/1608", "BELGICA LIGA PRO U21"],
  ["belarus/vysshaya-liga/199", "BIELORRUSIA LIGA 1"],
  ["belarus/vysshaya-liga-women/1869", "BIELORUSIA LIGA FEMENINA"],
  ["belarus/pershaya-liga/202", "BIELORUSIA PERSHAYA LIGA 2"],
  ["bolivia/liga-de-futbol-prof/1098", "BOLIVIA 1 1/2"],
  ["bosnia-and-herzegovina/premier-liga/220", "BOSNIA 1"],
  ["bosnia-and-herzegovina/first-league-fbih/226", "BOSNIA LIGA 2 FBHI"],
  ["bosnia-and-herzegovina/first-league-rs/232", "BOSNIA LIGA 2 RS"],
  ["botswana/premier-league/1517", "BOTSWANA PREMIER LIGA"],
  ["brazil/acreano/1288", "BRASIL ACREANO"],
  ["brazil/alagoano/1289", "BRASIL ALAGOANO"],
  ["brazil/amapaense/1324", "BRASIL AMAPAENSE"],
  ["brazil/amazonense/1290", "BRASIL AMAZONENSE"],
  ["brazil/baiano-1/1291", "BRASIL BAIANO 1"],
  ["brazil/brasileiro-women/1631", "BRASIL BRASILEIRO WOMAN"],
  ["brazil/brasileiro-feminino-a2/2294", "BRASIL BRASILEIRO WOMAN 2"],
  ["brazil/brasiliense/1293", "BRASIL BRASILIENSE"],
  ["brazil/cearense-1/1300", "BRASIL CAESARENSE"],
  ["brazil/carioca-1/1296", "BRASIL CARIOCA 1"],
  ["brazil/gaucho-1/1302", "BRASIL GAUCHO 1"],
  ["brazil/goiano-1/1304", "BRASIL GOIANO 1"],
  ["brazil/mineiro-1/1307", "BRASIL MINEIRO 1"],
  ["brazil/paraense/1309", "BRASIL PARAENSE"],
  ["brazil/paulista-a1/1313", "BRASIL PAULISTA A1"],
  ["brazil/sergipano/1321", "BRASIL SERGIPANO"],
  ["brazil/serie-a/648", "BRASIL SERIE A"],
  ["brazil/serie-b/651", "BRASIL SERIE B"],
  ["brazil/serie-c/657", "BRASIL SERIE C 1/2"],
  ["brazil/brasileiro-u20/1385", "BRASIL SUB 20"],
  ["bulgaria/vtora-liga/235", "BULGARIA LIGA 2"],
  ["bulgaria/parva-liga/229", "BULGARIA LIGA PROFESIONAL"],
  ["burkina-faso/premier-league/821", "BURKINA FASO LIGA 1"],
  ["burundi/ligue-a/1811", "BURUNDI LIGA 1"],
  ["bhutan/bhutan-premier-league/1988", "BUTAN PREMIER LIGA"],
  ["bhutan/super-league/1338", "BUTAN SUPER LIGA"],
  ["cambodia/c-league/1339", "CAMBOYA CLIGA"],
  ["cameroon/elite-one/818", "CAMERON LIGA 1 1/2"],
  ["canada/premier-league/1689", "CANADA PREMIER LEAGUE"],
  ["chile/primera-b/666", "CHILE B"],
  ["chile/primera-division/663", "CHILE LIGA 1"],
  ["chile/segunda-division/1699", "CHILE SEGUNDA DIVISION"],
  ["china-pr/league-one/992", "CHINA LIGA 2"],
  ["china-pr/yi-league/1414", "CHINA LIGA YI"],
  ["china-pr/super-league/989", "CHINA SUPERLIGA"],
  ["cyprus/1-division/253", "CHIPRE LIGA 1"],
  ["cyprus/2-division/256", "CHIPRE LIGA 2"],
  ["cyprus/3-division/1155", "CHIPRE LIGA 3"],
  ["colombia/liga-betplay/672", "COLOMBIA SERIE A APERTURA 1/2 / COLOMBIA SERIA A CLASURA 1/2"],
  ["colombia/torneo-betplay/678", "COLOMBIA SERIE B 1/2"],
  ["world/concacaf-gold-cup/1112", "CONCACAF COPA DE ORO 2023"],
  ["world/wc-qualification-concacaf/717", "CONCACAF ELIMINATORIAS"],
  ["congo/ligue-1/1544", "CONGO"],
  ["congo-dr/super-ligue/824", "CONGO DR"],
  ["cote-d-ivoire/ligue-1/827", "COSTA DE MARFIL LIGA 1"],
  ["costa-rica/primera-division/687", "COSTA RICA LIGA 1 APER / COSTARICA LIGA 1 CLAU"],
  ["croatia/1-hnl/244", "CROACIA HNL 1"],
  ["croatia/2-hnl/247", "CROACIA HNL 2"],
  ["cuba/primera-division/1616", "CUBA LIGA NACIONAL"],
  ["denmark/first-division/274", "DINAMARCA 1ERA DIVISION (2)"],
  ["denmark/2nd-division/2319", "DINAMARCA 2DA DIVISION"],
  ["denmark/denmark-series-group-2/1169", "DINAMARCA SERIES GRP 2"],
  ["denmark/denmark-series-group-3/1170", "DINAMARCA SERIES GRP 3"],
  ["denmark/denmark-series-group-4/1171", "DINAMARCA SERIES GRP 4"],
  ["denmark/denmark-series-group-1/1168", "DINAMARCA SERIESGRP 1"],
  ["denmark/superliga/271", "DINAMARCA SUPERLIGA"],
  ["ecuador/liga-pro/696", "ECUADOR SERIE A 1/2 / ECUADOR SERIA A 2DA FASE 1/2"],
  ["ecuador/primera-b/699", "ECUADOR SERIE B"],
  ["north-central-america/leagues-cup/3211", "EEUU LEAGUE CUP"],
  ["usa/npsl/1804", "EEUU LEAGUE NPSL"],
  ["usa/nwsl/2328", "EEUU LEAGUE NWSL"],
  ["usa/usl-league-one/1607", "EEUU LEAGUE ONE"],
  ["usa/usl-league-two/797", "EEUU LEAGUE TWO"],
  ["usa/major-league-soccer/779", "EEUU MLS"],
  ["usa/mls-next-pro/2545", "EEUU MLS NEXT PRO"],
  ["usa/usl-championship/791", "EEUU USL CHAMPIONSHIP"],
  ["usa/nisa/1803", "EEUULEAGUE NISA"],
  ["egypt/second-league-group-a/1964", "EGIPTO DIV 2 GRUPO A"],
  ["egypt/second-league-group-b/1965", "EGIPTO DIV 2 GRUPO B"],
  ["egypt/second-league-group-c/1966", "EGIPTO DIV 2 GRUPO C"],
  ["egypt/premier-league/830", "EGIPTO PREMIER LEAGUE"],
  ["el-salvador/primera-division/702", "EL SALVADOR LIGA 1"],
  ["united-arab-emirates/uae-league/959", "EMIRATOS ARABES UNIDOS"],
  ["united-arab-emirates/division-1/962", "EMIRATOS ARABES UNIDOS 2"],
  ["scotland/championship/504", "ESCOCIA CHAMPIONSHIP"],
  ["scotland/football-league---highland-league/2463", "ESCOCIA HIGHLAND LIGA"],
  ["scotland/league-one/516", "ESCOCIA LEAGUE ONE"],
  ["scotland/league-two/519", "ESCOCIA LEAGUE TWO"],
  ["scotland/lowland-league-cup/3115", "ESCOCIA LOWLAND LEAGUE"],
  ["scotland/premiership/501", "ESCOCIA PREMIER LEAGUE"],
  ["slovakia/fortuna-liga/540", "ESLOVAKIA LIGA 1"],
  ["slovakia/2-liga/543", "ESLOVAKIA LIGA 2"],
  ["slovenia/1-snl/555", "ESLOVENIA LIGA 1"],
  ["slovenia/2-snl/558", "ESLOVENIA LIGA 2"],
  ["slovenia/3-snl/1944", "ESLOVENIA LIGA 3 1/2"],
  ["slovenia/1-junior-league/1940", "ESLOVENIA LIGA JUNIOR U19"],
  ["spain/primera-division-rfef-group-1/2333", "ESPAÑA 3 PRIMERA DIV FFEF GR 1"],
  ["spain/primera-division-rfef-group-2/2334", "ESPAÑA 3 PRIMERA DIV RFEF GR 2"],
  ["spain/segunda-division-rfef-group-1/2336", "ESPAÑA 3 SEGUNDA DIV RFEF GR 1"],
  ["spain/segunda-division-rfef-group-2/2337", "ESPAÑA 3 SEGUNDA DIV RFEF GR 2"],
  ["spain/segunda-division-rfef-group-3/2338", "ESPAÑA 3 SEGUNDA DIV RFEF GR 3"],
  ["spain/segunda-division-rfef-group-4/2339", "ESPAÑA 3 SEGUNDA DIV RFEF GR 4"],
  ["spain/segunda-division-rfef-group-5/2340", "ESPAÑA 3 SEGUNDA DIV RFEF GR 5"],
  ["spain/tercera---group-1/1257", "ESPAÑA 3 TERCERA RFEF GRUPO 1"],
  ["spain/tercera---group-2/1258", "ESPAÑA 3 TERCERA RFEF GRUPO 2"],
  ["spain/tercera---group-3/1260", "ESPAÑA 3 TERCERA RFEF GRUPO 3"],
  ["spain/tercera---group-4/1261", "ESPAÑA 3 TERCERA RFEF GRUPO 4"],
  ["spain/tercera---group-5/1262", "ESPAÑA 3 TERCERA RFEF GRUPO 5"],
  ["spain/tercera---group-6/1263", "ESPAÑA 3 TERCERA RFEF GRUPO 6"],
  ["spain/tercera---group-7/1264", "ESPAÑA 3 TERCERA RFEF GRUPO 7"],
  ["spain/tercera---group-8/1265", "ESPAÑA 3 TERCERA RFEF GRUPO 8"],
  ["spain/la-liga/564", "ESPAÑA LA LIGA EA SPORTS"],
  ["spain/primera-division-women/1568", "ESPAÑA LA LIGA F"],
  ["spain/la-liga-2/567", "ESPAÑA LA LIGA HYPERMOTION"],
  ["estonia/ii-liiga/1876", "ESTONIA 3ERA DIVISION"],
  ["estonia/esiliiga-a/289", "ESTONIA ESIILIGA A"],
  ["estonia/esiliiga-b/1880", "ESTONIA ESIILIGA B"],
  ["estonia/meistriliiga/286", "ESTONIA MEISTRILIGA"],
  ["estonia/meistriliiga-women/2668", "ESTONIA MESITRILIGA WOMEN"],
  ["ethiopia/premier-league/998", "ETIOPIA PREMIER LEAGUE"],
  ["europe/wc-qualification-europe/720", "EURO CLASIFICACION 2025-2026"],
  ["europe/euro-u17-women/1563", "EUROCOPA FEMENINA SUB17"],
  ["europe/euro-u19-women/1424", "EUROCOPA FEMENINA SUB19"],
  ["europe/champions-league/2", "EUROPA CHAMPIONS LEAGUE"],
  ["europe/champions-league-women/1419", "EUROPA CHAMPIONS LEAGUE FEMENINA"],
  ["europe/uefa-youth-league/1329", "EUROPA CHAMPIONS LEAGUE YOUNG"],
  ["europe/uefa-europa-conference-league/2286", "EUROPA CONFERENCE LEAGUE"],
  ["europe/european-championship/1326", "EUROPA COPA"],
  ["europe/europa-league/5", "EUROPA LEAGUE"],
  ["europe/uefa-nations-league/1538", "EUROPA NATIONS LEAGUE"],
  ["finland/kakkonen/1172", "FINLANDIA KAKKONEN A TAB 4 / FINLANDIA KAKKONEN B TAB 2 / FINLANDIA KAKKONEN C TAB 3"],
  ["finland/kolmonen/1728", "FINLANDIA KOLMONEN 1/2"],
  ["finland/veikkausliiga/292", "FINLANDIA LIGA 1 1/3"],
  ["finland/ykkonen/3306", "FINLANDIA LIGA 2 YKKONEN"],
  ["finland/ykkonen/295", "FINLANDIA YKKOSLIGA"],
  ["france/ligue-1/301", "FRANCIA LIGA 1"],
  ["france/ligue-2/304", "FRANCIA LIGA 2"],
  ["france/division-1-women/1575", "FRANCIA LIGA FEMENINA"],
  ["france/national/313", "FRANCIA LIGA NATIONAL"],
  ["wales/premier-league/624", "GALES 1"],
  ["wales/faw-championship/1738", "GALES LIGA 2 NORTH/SOUTH"],
  ["gambia/gfa-league/1644", "GAMBIA PREMIER LEAGUE"],
  ["georgia/crystalbet-erovnuli-liga/319", "GEORGIA PRIMERA LIGA"],
  ["georgia/erovnuli-liga-2/316", "GEORGIA SEGUNDA LIGA"],
  ["ghana/premier-league/836", "GHANA PREMIER LEAGUE"],
  ["gibraltar/premier-division/1709", "GIBRALTAR LIGA 1"],
  ["greece/super-league/325", "GRECIA LIGA 1"],
  ["greece/super-league-2/1759", "GRECIA LIGA 2 GRUPO A"],
  ["greece/super-league-2---group-b/2479", "GRECIA LIGA 2 GRUPO B"],
  ["guatemala/liga-nacional/705", "GUATEMALA LIGA 1"],
  ["guinea/ligue-1/845", "GUINEA LIGA 1"],
  ["netherlands/derde-divisie-zaterdag/1097", "HOLANDA DERSDE DIVISE ZATERDAG"],
  ["netherlands/derde-divisie-zondag/1096", "HOLANDA DERSDE DIVISE ZONDAG"],
  ["netherlands/eredivisie/72", "HOLANDA EREDIVISE"],
  ["netherlands/eredivisie-women/80", "HOLANDA EREDIVISE F"],
  ["netherlands/eerste-divisie/74", "HOLANDA ERSTEDIVISE"],
  ["netherlands/tweede-divisie/77", "HOLANDA TWEDEDIVISIE"],
  ["honduras/liga-nacional/734", "HONDURAS LIGA 1"],
  ["hong-kong/premier-league/1001", "HONG KONG PREMIER LEAGUE"],
  ["hungary/merkantil-bank-liga/343", "HUNGRIA MERKANTIL 2"],
  ["hungary/otp-bank-liga/334", "HUNGRIA NBI"],
  ["india/calcutta-premier-division-a/1416", "INDIA CALCUTA PREMIER LIGA"],
  ["india/i-league/1010", "INDIA I LIGA 1"],
  ["india/i-league-2nd-division/1980", "INDIA I LIGA 2"],
  ["india/indian-super-league/1007", "INDIA SUPER LIGA"],
  ["india/santosh-trophy/1013", "INDIAN SANTOS THOPHY"],
  ["indonesia/liga-1/1019", "INDONESIA LIGA 1"],
  ["indonesia/liga-2/1016", "INDONESIA LIGA 2"],
  ["england/championship/9", "INGLATERRA CHAMPIONSHIP"],
  ["england/professional-development-league/48", "INGLATERRA DEVELOPENT YOUNG"],
  ["england/efl-trophy/39", "INGLATERRA EFL TROPHY"],
  ["england/non-league-premier-isthmian/51", "INGLATERRA ISTMIAN LEAGUE"],
  ["england/league-one/12", "INGLATERRA LEAGUE ONE"],
  ["england/league-two/14", "INGLATERRA LEAGUE TWO"],
  ["england/national-league/17", "INGLATERRA NATIONAL LEAGUE"],
  ["england/vanarama-national-league-north/20", "INGLATERRA NATIONAL NORTH"],
  ["england/vanarama-national-league-south/1092", "INGLATERRA NATIONAL SOUTH"],
  ["england/non-league-premier-northern/68", "INGLATERRA NPL PREMIER"],
  ["england/premier-league/8", "INGLATERRA PREMIER LEAGUE"],
  ["england/premier-league-2-division-one/1560", "INGLATERRA PREMIER LEAGUE 2 GR 1"],
  ["england/premier-league-2-divison-two/1351", "INGLATERRA PREMIER LEAGUE 2 GR 2"],
  ["england/premier-league-u18/42", "INGLATERRA PREMIER LEAGUE U18"],
  ["england/non-league-premier-southern-south/1805", "INGLATERRA SOUTHER SOUTH"],
  ["england/non-league-premier-southern-central/69", "INGLATERRA SOUTHERN CENTRAL"],
  ["iran/azadegan-league/899", "IRAN AZADEGAN 2"],
  ["iran/persian-gulf-pro-league/902", "IRAN PERSIAN GULF"],
  ["iraq/iraqi-league/911", "IRAQ LEAGUE"],
  ["northern-ireland/premiership/438", "IRLANDA DEL NORTE"],
  ["northern-ireland/championship/441", "IRLANDA DEL NORTE CHAMPIONSHIP"],
  ["republic-of-ireland/first-division/363", "IRLANDA LIGA 2"],
  ["republic-of-ireland/premier-division/360", "IRLANDA PREMIER"],
  ["iceland/2-deild/351", "ISLANDIA 2 DEILD"],
  ["iceland/3-deild/1694", "ISLANDIA 3 DEILD"],
  ["iceland/4-deild/1693", "ISLANDIA 4 DEILD 1/5"],
  ["iceland/inkasso-deildin/348", "ISLANDIA INKASO DEILD 1"],
  ["iceland/pepsideild/345", "ISLANDIA PEPSIDEILD PREMIER 1/3"],
  ["iceland/premier-league-women/1710", "ISLANDIA PREMIER LIGA FEMENINO"],
  ["faroe-islands/1-deild/280", "ISLAS FEROE 1DEILD"],
  ["faroe-islands/meistaradeildin/283", "ISLAS FEROE PREMIER LEAGUE"],
  ["israel/liga-alef/1776", "ISRAEL ALEF NORTH"],
  ["israel/liga-alef---sud/2478", "ISRAEL ALEF SUR"],
  ["israel/liga-leumit/375", "ISRAEL LEUMIT 2"],
  ["israel/ligat-ha-al/372", "ISRAEL LIGA HAAL 1"],
  ["italy/primavera-1/1426", "ITALIA PRIMAVERA 1"],
  ["italy/primavera-2/1437", "ITALIA PRIMAVERA 2"],
  ["italy/serie-a/384", "ITALIA SERIE A"],
  ["italy/serie-b/387", "ITALIA SERIE B"],
  ["italy/serie-c-girone-a/1203", "ITALIA SERIE C GR A"],
  ["italy/serie-c-girone-b/1204", "ITALIA SERIE C GR B"],
  ["italy/serie-c-girone-c/1205", "ITALIA SERIE C GR C"],
  ["jamaica/premier-league/737", "JAMAICA LIGA 1"],
  ["japan/we-league/3023", "JAPON F LIGA WE"],
  ["japan/nadeshiko-league-1/1671", "JAPON F NADESHIKO LIGA 1"],
  ["japan/j-league/968", "JAPON LIGA 1"],
  ["japan/j2-league/1022", "JAPON LIGA 2"],
  ["japan/j3-league/1025", "JAPON LIGA 3"],
  ["jordan/premier-league/920", "JORDANIA LIGA 1"],
  ["jordan/shield-cup/1417", "JORDANIA SHIELD CUP"],
  ["kazakhstan/premier-league/393", "KAZAHSTAN LIGA 1"],
  ["kenya/premier-league/848", "KENIA LIGA 1"],
  ["kyrgyzstan/top-liga/929", "KIRGYSTAN LIGA TOP"],
  ["korea-republic/k-league-1/1034", "KOREA LIGA 1 1/2"],
  ["korea-republic/k-league-2/1362", "KOREA LIGA 2"],
  ["korea-republic/k3-league-advanced/1040", "KOREA LIGA 3"],
  ["korea-republic/national-league/1037", "KOREA NATIONAL LEAGUE"],
  ["kosovo/superliga/1488", "KOSOVO LIGA 1"],
  ["kuwait/premier-league/923", "KUWAIT"],
  ["kuwait/division-1/926", "KUWAIT LIGA 2"],
  ["latvia/first-liga/402", "LETONIA LIGA 1"],
  ["latvia/virsliga/399", "LETONIA SUPER LIGA"],
  ["lebanon/premier-league/932", "LIBANO LIGA 1"],
  ["liberia/lfa-first-division/2816", "LIBERIA LIGA 1 LFA"],
  ["lithuania/a-lyga/405", "LITUANIA LIGA 1"],
  ["lithuania/1-lyga/408", "LITUANIA LIGA 2"],
  ["luxembourg/national-division/1504", "LUXEMBURGO LIGA 1"],
  ["macedonia-fyr/first-league/414", "MACEDONIA LIGA 1"],
  ["malaysia/super-league/1052", "MALASYA"],
  ["maldives/male-league/1522", "MALDIVIAS LIGA 1"],
  ["mali/premiere-division/857", "MALI LIGA PREMIER"],
  ["malta/first-division/423", "MALTA FIRST DIVISION"],
  ["malta/premier-league/420", "MALTA PREMIER LEAGUE"],
  ["morocco/botola-pro/860", "MARRUECOS BOTOLA PRO"],
  ["mauritania/super-d1/1524", "MAURITANIA LIGA 1"],
  ["mexico/liga-de-expansion-mx/749", "MEXICO LIGA EXPANSION APERTUR / MEXICO LIGA EXPANSION CLAUSURA"],
  ["mexico/liga-mx-women/1579", "MEXICO LIGA FEMENINA APERTURA 2 / MEXICO LIGA FEMENINA CLASURA 3"],
  ["mexico/liga-premier-serie-a/1779", "MEXICO LIGA PREMIER SERIE A"],
  ["mexico/liga-premier-serie-b/1780", "MEXICO LIGA PREMIER SERIE B"],
  ["mexico/liga-mx/743", "MEXICOLIGA 1 APERTURA / MEXICO LIGA 1 CLAUSURA (3)"],
  ["moldova/national-division/426", "MOLDAVIA LIGA 1"],
  ["mongolia/premier-league/1747", "MONGOLIA LIGA 1"],
  ["montenegro/first-league/432", "MONTENEGRO LIGA 1"],
  ["international/fifa-club-world-cup/3412", "MUNDIAL DE CLUBES FIFA WORLD CUP"],
  ["myanmar/national-league/1737", "MYANMAR LIGA 1"],
  ["namibia/premier-league/869", "NAMIBIA LIGA 1"],
  ["nepal/a-division/1344", "NEPAL LIGA 1"],
  ["new-zealand/regional-leagues/1963", "NEW ZELANDA LIGAS ESTATALES"],
  ["nicaragua/primera-division/752", "NICARAGUA LIGA 1"],
  ["nigeria/npfl/1475", "NIGERIA NPFL"],
  ["norway/2-division/1218", "NORUEGA 2DA DIVISION"],
  ["norway/2-division-group-2/1219", "NORUEGA 2DA DIVISION GRUPO 2"],
  ["norway/3-division/1561", "NORUEGA 3ERA DIVISION"],
  ["norway/3-division---group-2/2518", "NORUEGA 3ERA DIVISION GR 2"],
  ["norway/3-division---group-3/2519", "NORUEGA 3ERA DIVISION GR 3"],
  ["norway/3-division---group-4/2520", "NORUEGA 3ERA DIVISION GR 4"],
  ["norway/3-division---group-5/2521", "NORUEGA 3ERA DIVISION GR 5"],
  ["norway/3-division---group-6/2522", "NORUEGA 3ERA DIVISION GR 6"],
  ["norway/1-division-women/1977", "NORUEGA DIV 1 1/2/3"],
  ["norway/eliteserien/444", "NORUEGA ELITERIESEN"],
  ["norway/toppserien/1758", "NORUEGA F TOPSSERIEN"],
  ["norway/obos-ligaen/447", "NORUEGA OBOS LIGAEN"],
  ["world/wc-qualification-oceania/723", "OCEANIA MUNDIAL CLASIFICACION"],
  ["oman/professional-league/935", "OMAN PROFESIONAL LIGA"],
  ["pakistan/premier-league/1058", "PAKISTAN PREMIER LIGA"],
  ["palestine/west-bank-league/1449", "PALESTINA BANK LIGUE"],
  ["panama/lpf/1477", "PANAMA LIGA 1 1/2"],
  ["paraguay/division-1/755", "PARAGUAY LIGA 1 1/2 / PARAGUAY LIGA 1 CLAU 1/2"],
  ["paraguay/division-intermedia/761", "PARAGUAY LIGA INTERMEDIA 2"],
  ["peru/primera-division/764", "PERU LIGA 1 1/2 / PERU LIGA 1 CLAU 1/2"],
  ["peru/segunda-division/767", "PERU LIGA 2 1/2"],
  ["philippines/pfl/1986", "PHILIPINAS LIGA 1"],
  ["poland/1-liga/456", "POLONIA DIV 1"],
  ["poland/2-liga-east/1222", "POLONIA DIV 2"],
  ["poland/3-liga/1936", "POLONIA DIV 3"],
  ["poland/ekstraklasa/453", "POLONIA EKSTRAKLASA"],
  ["poland/ekstraliga-women/1435", "POLONIA EKSTRAKLASA FEMENINA"],
  ["poland/3-liga---group-2/2471", "POLONIA LIGA 3 GR 2"],
  ["poland/3-liga---group-3/2474", "POLONIA LIGA 3 GR 3"],
  ["poland/3-liga---group-4/2476", "POLONIA LIGA 3 GR 4"],
  ["portugal/segunda-liga/465", "PORTUGAL LIGA 2"],
  ["portugal/liga-3/2348", "PORTUGAL LIGA 3"],
  ["portugal/liga-revelacao-u23/1599", "PORTUGAL LIGA RVELACION U23"],
  ["portugal/primeira-liga/462", "PORTUGAL PRIMERA LIGA"],
  ["qatar/premier-league/938", "QATAR STARS LEAGUE"],
  ["czech-republic/2-liga-fnl/265", "REP CHECA 2 FNL"],
  ["czech-republic/3-liga-cfl/1156", "REP CHECA 3 LIGA CFA A/B"],
  ["czech-republic/fortuna-liga/262", "REP CHECA FORTUNA LEAGUE"],
  ["czech-republic/first-league-women/1444", "REP CHECA LIGA FEMENINA"],
  ["czech-republic/3-liga-msfl/1157", "REP CHECA MSFL"],
  ["czech-republic/u19-league/1443", "REP CHECA U19"],
  ["dominican-republic/liga-mayor/1341", "REPUBLICA DOMINICANA LIGA 1"],
  ["rwanda/national-soccer-league/872", "RUANDA LIGA 1"],
  ["romania/liga-1/474", "RUMANIA LIGA 1"],
  ["romania/liga-2/1636", "RUMANIA LIGA 2"],
  ["romania/3-liga-series-1/1237", "RUMANIA LIGA 3 SERIE 1"],
  ["romania/3-liga-series-10/1960", "RUMANIA LIGA 3 SERIE 10"],
  ["romania/3-liga-series-2/1238", "RUMANIA LIGA 3 SERIE 2"],
  ["romania/3-liga-series-3/1239", "RUMANIA LIGA 3 SERIE 3"],
  ["romania/3-liga-series-4/1240", "RUMANIA LIGA 3 SERIE 4"],
  ["romania/3-liga-series-5/1241", "RUMANIA LIGA 3 SERIE 5"],
  ["romania/3-liga-series-6/1242", "RUMANIA LIGA 3 SERIE 6"],
  ["romania/3-liga-series-7/1957", "RUMANIA LIGA 3 SERIE 7"],
  ["romania/3-liga-series-8/1958", "RUMANIA LIGA 3 SERIE 8"],
  ["romania/3-liga-series-9/1959", "RUMANIA LIGA 3 SERIE 9"],
  ["russia/premier-league/486", "RUSIA PRIMERA LIGA"],
  ["russia/fnl/489", "RUSSIA LIGA 2"],
  ["san-marino/campionato/1346", "SAN MARINO LIGA 1"],
  ["senegal/ligue-1/875", "SENEGAL LIGA 1"],
  ["serbia/prva-liga/534", "SERBIA LIGA 2"],
  ["serbia/super-liga/531", "SERBIA PRIMER LIGA"],
  ["serbia/u19-league/2437", "SERBIA U19"],
  ["sierra-leone/premier-league/1679", "SIERRA LEONA PREMIER LEAGUE"],
  ["singapore/s-league/1357", "SINGAPUR SUPER LIGA"],
  ["syria/premier-league/881", "SIRIA LIGA 1"],
  ["somalia/nation-link-telecom-championship/1392", "SOMALIA LIGA 1"],
  ["south-africa/gladafrica-championship/1455", "SUDAFRICA 2"],
  ["south-africa/premier-league/806", "SUDAFRICA LIGA 1"],
  ["south-america/copa-america/1114", "SUDAMERICA COPA AMERICA"],
  ["south-america/copa-libertadores/1122", "SUDAMERICA COPA LIBERTADORES"],
  ["south-america/copa-libertadores-women/2039", "SUDAMERICA COPA LIBERTADORES F"],
  ["south-america/copa-sudamericana/1116", "SUDAMERICA COPA SUDAMERICANA"],
  ["world/wc-qualification-south-america/726", "SUDAMERICA MUNDIAL CLASIFICACION"],
  ["sudan/sudan-premier-league/878", "SUDAN LIGA 1"],
  ["sweden/allsvenskan/573", "SUECIA ALLSVENKAN"],
  ["sweden/allsvenskan-women/576", "SUECIA ALLSVESKAN WOMEN"],
  ["sweden/ettan-north/585", "SUECIA DIV 1 NORRA ETTAN NORTH"],
  ["sweden/ettan-south/588", "SUECIA DIV 1 SODRA ETTAN SOUTH"],
  ["sweden/division-2-norrland/1278", "SUECIA DIV 2 NORRA"],
  ["sweden/division-2-norra-gotaland/1276", "SUECIA DIV 2 NORRA GOTALAN"],
  ["sweden/division-2-norra-svealand/1277", "SUECIA DIV 2 NORRA SVEALAND"],
  ["sweden/division-2-ostra-gotaland/1279", "SUECIA DIV 2 SODRA OSTRA GOTALAND"],
  ["sweden/division-2-sodra-svealand/1280", "SUECIA DIV 2 SODRA SVEALAND"],
  ["sweden/division-2-vastra-gotaland/1281", "SUECIA DIV 2 VASTRA GOTALAND"],
  ["sweden/elitettan-women/1548", "SUECIA ELITETAN WOMEN"],
  ["sweden/superettan/579", "SUECIA SUPERETTAN"],
  ["switzerland/challenge-league/594", "SUIZA CHALLENGE"],
  ["switzerland/1liga-classic/1497", "SUIZA LIGA CLASSIC"],
  ["switzerland/1liga-promotion/1498", "SUIZA LIGA PROMOCION"],
  ["switzerland/super-league/591", "SUIZA SUPERLIGA"],
  ["tajikistan/vysshaya-liga/1857", "TAJIKISTAN LIGA 1"],
  ["tanzania/ligi-kuu-bara/884", "TANZANIA LIGA 1"],
  ["thailand/thai-premier-league/1064", "THAILANDIA LIGA 1"],
  ["thailand/thai-league-two/1067", "THAILANDIA LIGA 2"],
  ["thailand/thai-league-3/1727", "THAILANDIA LIGA 3"],
  ["togo/championnat-national/1539", "TOGO LIGA 1"],
  ["trinidad-and-tobago/tt-pro-league/1348", "TRINIDAD Y TOBAGO LIGA 1"],
  ["tunisia/ligue-1/956", "TUNEZ LIGA 1"],
  ["tunisia/ligue-2/2026", "TUNEZ LIGA 2"],
  ["turkey/1-lig/603", "TURKIA LIGA 1"],
  ["turkey/2-lig-beyaz/1282", "TURKIA LIGA 2 GRUPO BLANCO"],
  ["turkey/2-lig-kirmizi/1283", "TURKIA LIGA 2 GRUPO ROJO"],
  ["turkey/3-lig-group-1/1285", "TURKIA LIGA 3 GR 1"],
  ["turkey/3-lig-group-2/1286", "TURKIA LIGA 3 GR 2"],
  ["turkey/3-lig-group-3/1287", "TURKIA LIGA 3 GR 3"],
  ["turkey/3-lig-group-4/1938", "TURKIA LIGA 3 GR 4"],
  ["turkey/super-lig/600", "TURKIA SUPERLIGA"],
  ["turkmenistan/yokary-liga/1864", "TURKMENISTAN LIGA 1"],
  ["uganda/premier-league/1423", "UGANDA LIGA 1"],
  ["ukraine/persha-liga/612", "UKRANIA 2"],
  ["ukraine/premier-league/609", "UKRANIA PREMIER LEAGUE"],
  ["uruguay/primera-division/770", "URUGUAY LIGA 1 1/2 / URUGUAY LIGA 1 CLAU 1/2"],
  ["uruguay/segunda-division/776", "URUGUAY LIGA 2"],
  ["uzbekistan/professional-football-league/1349", "UZBEKISTAN LIGA 1"],
  ["venezuela/segunda-division/803", "VENEZUELA LIGA 2 1/2"],
  ["venezuela/primera-division/800", "VENEZUELA1 1/3"],
  ["vietnam/v-league/1073", "VIETNAM 1"],
  ["vietnam/v-league-2/1076", "VIETNAM LIGA 2"],
  ["yemen/yemeni-league/1350", "YEMEN LIGA 1"],
  ["zambia/super-league/890", "ZAMBIA LIGA 1"],
  ["zimbabwe/premier-soccer-league/887", "ZIMBAWE LIGA 1"]];
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
  // Menú = la lista propia (rápida, sin depender de que RedScores responda)
  return json({ ok: true, leagues: RS_MY_LIST, source: "lista" }, 200, {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Netlify-CDN-Cache-Control": "public, durable, s-maxage=86400",
    "Netlify-Vary": "query=part|league|debug",
  });
}
async function rsLeaguesFromSite() {
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

// ---------- casa / fuera calculadas con los resultados ----------
// RedScores carga las pestañas Home/Away aparte (por eso no se pueden leer). Con los partidos jugados
// de la página se arman: local = partidos en casa, visita = partidos fuera (PJ, G, E, P, GF, GC).
function deriveHomeAway(games, all) {
  const H = {}, A = {};
  const add = (m, k, gf, ga) => {
    const x = (m[k] ||= { team: all[k]?.team || k, gp: 0, w: 0, d: 0, l: 0, gfT: 0, gaT: 0 });
    x.gp++; x.gfT += gf; x.gaT += ga;
    if (gf > ga) x.w++; else if (gf === ga) x.d++; else x.l++;
  };
  for (const g of games) {
    if (!g.score || !all[g.homeKey] || !all[g.awayKey]) continue;
    add(H, g.homeKey, g.score[0], g.score[1]);
    add(A, g.awayKey, g.score[1], g.score[0]);
  }
  const fin = (m) => { for (const x of Object.values(m)) { x.gf = x.gp ? x.gfT / x.gp : null; x.ga = x.gp ? x.gaT / x.gp : null; delete x.gfT; delete x.gaT; } return m; };
  for (const k of Object.keys(all)) for (const m of [H, A]) m[k] ||= { team: all[k].team, gp: 0, w: 0, d: 0, l: 0, gfT: 0, gaT: 0 };
  fin(H); fin(A);
  // cobertura: equipos cuyos partidos casa + fuera suman los de la tabla general
  const ks = Object.keys(all);
  const full = ks.filter((k) => (H[k]?.gp || 0) + (A[k]?.gp || 0) === all[k].gp).length;
  return { home: H, away: A, coverage: ks.length ? full / ks.length : 0, used: games.filter((g) => g.score).length };
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
  // Se piden como un navegador normal; se prueba la dirección en español y la normal
  const BROWSER = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    Referer: "https://redscores.com/",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-User": "?1",
  };
  const urls = [`${RS}${RS_LANG}/league/${league}`, `${RS}/league/${league}`];
  let pageUrl = urls[0], html, partial = false, lastErr = null;
  for (const u of urls) {
    try { const r = await getHtmlPartial(u, 4200, BROWSER); html = r.html; partial = r.partial; pageUrl = u; break; }
    catch (e) { lastErr = e; }
  }
  if (!html) {
    const blocked = /HTTP 403|HTTP 429|HTTP 503/.test(lastErr?.message || "");
    return json({ ok: false, blocked, league,
      error: blocked
        ? `RedScores no deja leer sus páginas desde el servidor (${lastErr.message}): bloquea los accesos automáticos, igual que a tu hoja de Google Sheets. Usa AnnaBet para esta liga.`
        : `No se pudo leer la liga en RedScores (${lastErr?.message}). Pulsa Actualizar para reintentar.` }, 502, { "Cache-Control": "no-store" });
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
  const { keyOf, nameOf } = rsKeyIndex(standings);
  const games = rsGames(html, keyOf, nameOf);
  if (!standings.home || !standings.away) {
    const d = deriveHomeAway(games, standings.all);
    if (d.coverage >= 0.6) {
      standings.home = d.home; standings.away = d.away; standings.derivedHA = true;
      warnings.push(`Casa y fuera (LL/VV) calculadas con los ${d.used} resultados de la página: RedScores carga esas pestañas aparte.`);
    } else {
      const hints = rsProbe(html);
      warnings.push(`RedScores no trae casa y fuera, y los resultados de la página no alcanzan para calcularlas (${d.used} partidos, cubren ${Math.round(d.coverage * 100)}% de los equipos): LL/VV usa la tabla general.${hints.length ? " Pistas: " + hints.slice(0, 6).join(" ‖ ") : ""}`);
    }
  }
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
