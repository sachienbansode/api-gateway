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
 *
 * THE NEUTRAL, AND WHY TURNED-AWAY TRAFFIC IS NOT A THIRD SEGMENT
 *
 * Requests rejected before routing were nearly stacked on top of these two as a
 * third colour. Two things ruled that out.
 *
 * Measured, not guessed: on the dark surface no neutral clears the ΔE 15
 * normal-vision floor against both #5b8fd6 and #e0695c at once — a cool grey
 * collides with the blue, a warm one with the red. More importantly the form
 * was wrong anyway. Stacking asserts the parts belong to one total, and
 * "requests including the ones we refused" is a number nobody acts on. On a
 * public hostname the scanners outnumber the real calls, so the segment that
 * matters would be a sliver under a grey wall.
 *
 * So it gets its own strip under the main chart, sharing the x-axis: small
 * multiples rather than a stack. Alone on its own plot the neutral has no
 * adjacent pair to separate from — only contrast against the surface applies,
 * and #737d88 / #8c96a1 clear 3:1 on both.
 */

const PALETTE = `
.chart{--ok:#1a4fa0;--bad:#c0392b;--neutral:#737d88;--grid:var(--border);
  display:block;width:100%;height:auto}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .chart{
  --ok:#5b8fd6;--bad:#e0695c;--neutral:#8c96a1}}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .axis{font:400 9.5px var(--sans);fill:var(--ink3)}
.chart .lbl{font:500 10.5px var(--sans);fill:var(--ink2)}
.chart .val{font:600 10.5px var(--mono);fill:var(--ink)}
.chart .ok{fill:var(--ok)}
.chart .bad{fill:var(--bad)}
.chart .neutral{fill:var(--neutral)}
.chart .hit{fill:transparent;cursor:default}
.chart .hit:hover ~ .bar-ok,.chart .hit:hover ~ .bar-bad{opacity:.75}
.chartkey{display:flex;gap:14px;align-items:center;font-size:11px;color:var(--ink2);
  margin:0 0 9px;flex-wrap:wrap}
.chartkey i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;
  vertical-align:-1px}
.chartkey .k-ok i{background:var(--ok)}
.chartkey .k-bad i{background:var(--bad)}
.chartkey .k-neutral i{background:var(--neutral)}
.chartkey .k-ok,.chartkey .k-bad,.chartkey .k-neutral{--ok:#1a4fa0;--bad:#c0392b;--neutral:#737d88}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .chartkey .k-ok,
  :root:not([data-theme="light"]) .chartkey .k-bad,
  :root:not([data-theme="light"]) .chartkey .k-neutral{
    --ok:#5b8fd6;--bad:#e0695c;--neutral:#8c96a1}}
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
 * Shared x-geometry. The turned-away strip sits directly under the calls chart
 * and has to line up with it column for column, or two charts of the same
 * window read as two different windows.
 */
const GEO = { W: 980, L: 44, R: 10 };

/**
 * A ceiling for the y-axis that produces gridline labels people recognise.
 *
 * The midpoint matters as much as the top, which is the part the first version
 * got wrong: it ceilinged a peak of 95 to 95, and the middle gridline came out
 * "48" — a number with no meaning that makes a reader stop and work out the
 * scale. Each rung is only accepted if half of it is a whole number too, so
 * the axis always reads 0 / 50 / 100 rather than 0 / 48 / 95.
 */
function niceTop(peak) {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, peak))));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const t = m * mag;
    if (t >= peak && Number.isInteger(t / 2)) return t;
  }
  return 10 * mag;
}

/**
 * Calls over time: stacked columns, succeeded below, failed above.
 *
 * Columns rather than a line because the buckets are counts in a period, not
 * samples of a continuous quantity — a line between two hourly totals implies
 * values at 10:30 that were never measured.
 */
function callsOverTime(rows, { since = '24h', empty = 'No calls in this window yet.' } = {}) {
  if (!rows.length || !rows.some((r) => r.ok + r.failed > 0)) {
    return `<p class="empty-chart">${esc(empty)}</p>`;
  }
  const { W, L, R } = GEO;
  const H = 190, T = 12, B = 26;
  const iw = W - L - R, ih = H - T - B;
  const peak = Math.max(1, ...rows.map((r) => r.ok + r.failed));
  const top = niceTop(peak);
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
 * Turned away over time — the companion strip under the calls chart.
 *
 * Shares the x-geometry above so the columns align, carries no x-axis labels
 * of its own (the chart above already names the hours, and repeating them
 * doubles the ink to say the same thing), and is deliberately short: this is
 * context for the chart above, not a rival to it.
 */
function turnedAwayStrip(rows, { empty = 'Nothing was turned away in this window.' } = {}) {
  if (!rows.length || !rows.some((r) => r.turned_away > 0)) {
    return `<p class="empty-chart">${esc(empty)}</p>`;
  }
  const { W, L, R } = GEO;
  const H = 72, T = 10, B = 6;
  const ih = H - T - B;
  const peak = Math.max(1, ...rows.map((r) => r.turned_away || 0));
  const bw = (W - L - R) / rows.length;
  const w = Math.max(1, bw - 2);
  const multiDay = rows.length > 48;
  const label = multiDay ? fmtDay : fmtClock;

  const bars = rows.map((r, i) => {
    const v = r.turned_away || 0;
    const h = v ? Math.max(1, (v / peak) * ih) : 0;
    const x = L + i * bw + 1;
    return `<g><title>${esc(`${label(r.bucket)} · ${fmtNum(v)} turned away`)}</title>
      ${h ? `<rect class="neutral" x="${x}" y="${T + ih - h}" width="${w}" height="${h}" rx="1.5"/>` : ''}
      <rect class="hit" x="${x}" y="${T}" width="${w}" height="${ih}"/></g>`;
  }).join('');

  return `
<p class="chartkey">
  <span class="k-neutral"><i></i>Turned away</span>
  <span class="t2">Peak ${fmtNum(peak)} in one period.</span>
</p>
<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
     aria-label="Requests turned away before reaching an endpoint, over the same window.">
  <line class="grid" x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}"/>
  ${bars}
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
  // An empty state has to say WHY it is empty. "Nothing to show" over a window
  // holding hundreds of rows reads as "no traffic", which was the opposite of
  // the truth: every one of those requests was turned away before it could be
  // attributed to an endpoint, so a panel grouped by endpoint had nothing.
  empty = 'Nothing to show for this window.',
} = {}) {
  if (!rows.length) return `<p class="empty-chart">${empty}</p>`;
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

module.exports = { PALETTE, callsOverTime, turnedAwayStrip, rankedBars };
