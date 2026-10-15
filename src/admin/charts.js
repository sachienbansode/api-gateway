'use strict';

const { esc, fmtNum } = require('./ui');

/**
 * Charts, as server-rendered inline SVG.
 *
 * No charting library and no client-side rendering. The data is already on the
 * server when the page is built, so shipping a library to redraw it in the
 * browser would add weight, a CDN dependency and a flash of empty chart for
 * nothing. Inline SVG also inherits the console's colour variables, so light
 * and dark follow without a second palette.
 *
 * COLOUR
 *
 * Two data colours, validated against both surfaces (OKLab ΔE: 30.6 normal,
 * 19.9 protan on white; 24.9 / 17.9 on the dark surface):
 *
 *     succeeded  #1a4fa0 light · #5b8fd6 dark
 *     failed     #c0392b light · #e0695c dark
 *
 * They are never the only cue. Failures sit above successes in a fixed order,
 * are directly labelled, and appear in a table below — so identity never rests
 * on colour alone.
 *
 * Status colours (good / warning / critical) are reserved for state and never
 * reused as a series, which is why a breaker pill can never be mistaken for a
 * line on a chart.
 */

const PALETTE = `
.chart{--ok:#1a4fa0;--bad:#c0392b;--grid:var(--border);display:block;width:100%;height:auto}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .chart{--ok:#5b8fd6;--bad:#e0695c}}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .axis{font:400 9.5px var(--sans);fill:var(--ink3)}
.chart .lbl{font:500 10.5px var(--sans);fill:var(--ink2)}
.chart .val{font:600 10.5px var(--mono);fill:var(--ink)}
.chart .ok{fill:var(--ok)}
.chart .bad{fill:var(--bad)}
.chart .hit{fill:transparent;cursor:default}
.chart .hit:hover ~ .bar-ok,.chart .hit:hover ~ .bar-bad{opacity:.75}
.chartkey{display:flex;gap:14px;align-items:center;font-size:11px;color:var(--ink2);
  margin:0 0 9px;flex-wrap:wrap}
.chartkey i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;
  vertical-align:-1px}
.chartkey .k-ok i{background:var(--ok)}
.chartkey .k-bad i{background:var(--bad)}
.chartkey .k-ok,.chartkey .k-bad{--ok:#1a4fa0;--bad:#c0392b}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .chartkey .k-ok,
  :root:not([data-theme="light"]) .chartkey .k-bad{--ok:#5b8fd6;--bad:#e0695c}}
.empty-chart{padding:26px 15px;text-align:center;color:var(--ink3);font-size:12px}
`;

const fmtClock = (d) => {
  const x = new Date(d);
  return String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0');
};
const fmtDay = (d) => {
  const x = new Date(d);
  return x.getDate() + ' ' +
    ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][x.getMonth()];
};

/**
 * Calls over time: stacked columns, succeeded below, failed above.
 *
 * Columns rather than a line because the buckets are counts in a period, not
 * samples of a continuous quantity — a line between two hourly totals implies
 * values at 10:30 that were never measured.
 */
function callsOverTime(rows, { since = '24h' } = {}) {
  if (!rows.length || !rows.some((r) => r.ok + r.failed > 0)) {
    return `<p class="empty-chart">No calls in this window yet.</p>`;
  }
  const W = 980, H = 190, L = 44, R = 10, T = 12, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const peak = Math.max(1, ...rows.map((r) => r.ok + r.failed));
  // A round ceiling so the gridline labels are numbers people recognise.
  const step = Math.max(1, Math.pow(10, Math.floor(Math.log10(peak))) / 2);
  const top = Math.ceil(peak / step) * step;
  const bw = iw / rows.length;
  // 2px of surface between bars, per the mark spec — adjacent fills need a gap
  // or two columns read as one wide one.
  const w = Math.max(1, bw - 2);
  const y = (v) => T + ih - (v / top) * ih;
  const multiDay = since === '7d' || since === '30d';
  const label = multiDay ? fmtDay : fmtClock;
  const every = Math.ceil(rows.length / 10);

  const grid = [0, 0.5, 1].map((f) => {
    const v = top * f;
    return `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="axis" x="${L - 7}" y="${y(v) + 3.5}" text-anchor="end">${fmtNum(Math.round(v))}</text>`;
  }).join('');

  const bars = rows.map((r, i) => {
    const x = L + i * bw + 1;
    const hOk = r.ok ? Math.max(1, (r.ok / top) * ih) : 0;
    const hBad = r.failed ? Math.max(1, (r.failed / top) * ih) : 0;
    const yBad = T + ih - hOk - hBad;
    const tip = `${label(r.bucket)} · ${fmtNum(r.ok)} ok` +
      (r.failed ? `, ${fmtNum(r.failed)} failed` : '');
    return `<g>
      <title>${esc(tip)}</title>
      ${hOk ? `<rect class="ok" x="${x}" y="${T + ih - hOk}" width="${w}" height="${hOk}" rx="1.5"/>` : ''}
      ${hBad ? `<rect class="bad" x="${x}" y="${yBad}" width="${w}" height="${Math.max(1, hBad - (hOk ? 2 : 0))}" rx="1.5"/>` : ''}
      <rect class="hit" x="${x}" y="${T}" width="${w}" height="${ih}"/>
    </g>`;
  }).join('');

  // On a multi-day window the buckets are hours, so a day label would repeat
  // four times in a row — which reads as four separate days.
  let lastDay = null;
  const ticks = rows.map((r, i) => {
    const text = label(r.bucket);
    const show = multiDay ? (text !== lastDay) : (i % every === 0);
    if (multiDay) lastDay = text;
    return show
      ? `<text class="axis" x="${L + i * bw + w / 2}" y="${H - 8}" text-anchor="middle">${esc(text)}</text>`
      : '';
  }).join('');

  return `
<p class="chartkey">
  <span class="k-ok"><i></i>Succeeded</span>
  <span class="k-bad"><i></i>Failed</span>
  <span class="t2">Hover a column for its numbers.</span>
</p>
<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
     aria-label="Calls per period, succeeded and failed, over the selected window.">
  ${grid}${bars}${ticks}
</svg>`;
}

/**
 * Ranked horizontal bars.
 *
 * Horizontal because the labels are endpoint names: rotated text under vertical
 * columns is the single most common way a readable chart becomes unreadable.
 */
function rankedBars(rows, {
  labelKey, valueKey, secondary = null, unit = '', tone = 'ok', width = 560,
} = {}) {
  if (!rows.length) return `<p class="empty-chart">Nothing to show for this window.</p>`;
  // The viewBox has to match the width the panel actually gives it. An SVG
  // authored at 980 inside a 570px column scales to 58%, and 10px labels
  // become 6px — legible in the source and not on the screen.
  const hasSub = Boolean(secondary) && rows.some((r) => secondary(r));
  // Taller rows when there is a second line, so the two never sit on top of
  // each other at any width.
  const rowH = hasSub ? 38 : 30;
  const W = width, L = Math.round(width * 0.34);
  // Room on the right for the longest value label this chart will print —
  // measured from the data, not guessed. The first version reserved a fixed
  // 17% and the value collided with the secondary text on the very first row,
  // because the longest bar leaves the least space.
  const widest = Math.max(...rows.map((r) => `${fmtNum(Number(r[valueKey]) || 0)}${unit}`.length));
  const R = Math.max(42, widest * 6.6 + 14);
  const H = rows.length * rowH + 8;
  const iw = W - L - R;
  const peak = Math.max(1, ...rows.map((r) => Number(r[valueKey]) || 0));

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
     aria-label="${esc(rows.map((r) => `${r[labelKey]} ${r[valueKey]}${unit}`).join('; '))}">
  ${rows.map((r, i) => {
    const v = Number(r[valueKey]) || 0;
    const y = i * rowH + 4;
    const w = Math.max(2, (v / peak) * iw);
    const sub = secondary ? secondary(r) : '';
    const mid = y + (rowH - 8) / 2;
    return `<g>
      <title>${esc(`${r[labelKey]} — ${fmtNum(v)}${unit}${sub ? ' · ' + sub : ''}`)}</title>
      <text class="lbl" x="${L - 10}" y="${hasSub ? y + 13 : mid + 4}" text-anchor="end">${esc(r[labelKey])}</text>
      ${sub ? `<text class="axis" x="${L - 10}" y="${y + 26}" text-anchor="end">${esc(sub)}</text>` : ''}
      <rect class="${tone}" x="${L}" y="${mid - 6.5}" width="${w}" height="13" rx="4"/>
      <text class="val" x="${L + w + 8}" y="${mid + 4}">${fmtNum(v)}${esc(unit)}</text>
    </g>`;
  }).join('')}
</svg>`;
}

module.exports = { PALETTE, callsOverTime, rankedBars };
