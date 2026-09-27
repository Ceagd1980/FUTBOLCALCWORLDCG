# Radar Fútbol Mundial

Web de fútbol multiliga con datos de AnnaBet.com: se elige la liga (o se pega el enlace de
cualquier liga de AnnaBet) y aparecen sus partidos por fecha (◀ ▶ saltan entre fechas con
partidos), con buscador de equipos. Por partido: posición, % ganador, PPG, tabla general +
casa (local) / fuera (visita), 1X2 con empate (general y LL/VV), goles totales (cruzado y
suma de anotados, con marcador posible y over/under 2.5) y hándicap A/B.

## Estructura
- `public/index.html` — la página
- `netlify/functions/futbol.mjs` — lee AnnaBet:
  - `/api/futbol?league=serie_1_English_Premier_League` posiciones y partidos
  - `/api/futbol?part=leagues` lista de ligas
  - `/api/futbol?debug=1&league=serie_1_English_Premier_League` diagnóstico
- `netlify.toml` — configuración de Netlify (no cambiar)

## Publicar
1. Repositorio nuevo en GitHub: arrastrar las carpetas `public` y `netlify` más
   `netlify.toml`, `package.json` y `README.md`.
2. Netlify → Add new site → Import from GitHub → Deploy.
