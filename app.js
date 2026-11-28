"use strict";
// Renders data/site.json: { now, history } from one build. Chart library is vendored under vendor/.

const STATES = ["calm", "elevated", "crisis"];
const STATE_LABEL = { calm: "Calm", elevated: "Elevated", crisis: "Crisis" };
const ZONE_LABEL = { calm: "Calm", watch: "Watch", stress: "Stress", context: "Context" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const VIEWS = ["dash", "history", "methods", "log"];

// kind: level = zone set by fixed levels (charted as the ratio); high / low = zone set by percentile, stressed
// when high / low (charted as the percentile); context = no zone.
const IND = {
  vix_vix3m: {
    name: "VIX / VIX3M", desc: "1M vs 3M implied vol", kind: "level", series: "vix_vix3m",
    lines: [[0.95, "watch"], [1.0, "stress"]], worse: 1,
    rule: "Watch from 0.95, stress from 1.00 (fixed levels).",
    what: "One-month expected volatility divided by three-month expected volatility. Above 1, near-term fear is higher than fear over the next quarter, the term structure is inverted.",
  },
  vvix: {
    name: "VVIX", desc: "Volatility of VIX", kind: "high", series: "pct_vvix",
    lines: [[80, "watch"], [95, "stress"]], worse: 1,
    rule: "Watch from the 80th percentile since 2008, stress from the 95th.",
    what: "How much the VIX itself is expected to move over the next month. High is stressed. Only today's level is published; the chart shows its percentile.",
  },
  vvix_vix: {
    name: "VVIX / VIX", desc: "Cost of VIX tail cover", kind: "high", series: "pct_vvix_vix",
    lines: [[80, "watch"], [95, "stress"]], worse: 1,
    rule: "Watch from the 80th percentile since 2008, stress from the 95th.",
    what: "What protection against a jump in the VIX costs, relative to the VIX. High is stressed: the market is paying up for a volatility spike that has not happened yet.",
  },
  hyg_ief_20d: {
    name: "HYG / IEF", desc: "Credit vs Treasuries, 20d %", kind: "low", series: "pct_hyg_ief_20d",
    lines: [[20, "watch"], [5, "stress"]], worse: -1,
    rule: "Watch at or below the 20th percentile since 2008, stress at or below the 5th.",
    what: "High-yield bonds against intermediate Treasuries, total return over 20 sessions, in percent. Lower is worse: credit is falling behind government bonds.",
  },
  rsp_spy_20d: {
    name: "RSP / SPY", desc: "Breadth: equal vs cap weight, 20d %", kind: "low", series: "pct_rsp_spy_20d",
    lines: [[20, "watch"], [5, "stress"]], worse: -1,
    rule: "Watch at or below the 20th percentile since 2008, stress at or below the 5th.",
    what: "The S&P 500 with every stock at the same weight against the cap-weighted index, total return over 20 sessions, in percent. Lower is worse: gains are narrowing to the largest names.",
  },
  t10y2y: {
    name: "10y − 2y", desc: "Treasury curve, pp", kind: "context", series: "t10y2y",
    lines: [], worse: 0,
    rule: "Context only: no watch or stress level.",
    what: "The 10-year Treasury yield minus the 2-year yield, in percentage points, as published by FRED.",
  },
};

let NOW, H, at, chart, mainSeries;
let view = "spy";
let pinned = "1Y";
let cursor = -1;
let fromKeys = false;
let mainPts = [];
let bandSpans = [];
let lines = [];
let histRange = "1Y";
let selectedInd = null;
const mobileQ = matchMedia("(max-width: 760px)");

const $ = (id) => document.getElementById(id);
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const SVGNS = "http://www.w3.org/2000/svg";

function el(tag, attrs, kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (v != null && v !== false) node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids || []) if (kid != null) node.append(kid);
  return node;
}
function sv(tag, attrs) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  return node;
}

// ------------------------------------------------------------------ formatting
const isNum = (v) => typeof v === "number" && isFinite(v);
function ordinal(n) {
  const v = n % 100;
  const suf = ["th", "st", "nd", "rd"];
  return n + (suf[(v - 20) % 10] || suf[v] || suf[0]);
}
function fixed(v, d) { return isNum(v) ? v.toFixed(d) : "—"; }
function minus(s) { return s.replace(/^-/, "−"); }
function signed(v, d, unit) {
  if (!isNum(v)) return "—";
  const r = Number(v.toFixed(d));
  const s = r > 0 ? "+" + r.toFixed(d) : r < 0 ? "−" + Math.abs(r).toFixed(d) : r.toFixed(d);
  return s + (unit || "");
}
function retPct(a, b) { return isNum(a) && isNum(b) && b !== 0 ? (a / b - 1) * 100 : null; }
function pretty(iso) {
  const [y, m, d] = iso.split("-");
  return `${+d} ${MONTHS[+m - 1]} ${y}`;
}
function shortDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${+d} ${MONTHS[+m - 1]} ${y.slice(2)}`;
}
function withDow(iso) {
  return DOW[new Date(iso + "T12:00:00Z").getUTCDay()] + " " + pretty(iso);
}
function timeStr(t) {
  if (t == null) return "";
  if (typeof t === "string") return t.slice(0, 10);
  if (typeof t === "number") return new Date(t * 1000).toISOString().slice(0, 10);
  if (typeof t === "object" && t.year) {
    return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
  }
  return "";
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}
function tone(v, worse) {
  if (!isNum(v) || !worse || Math.abs(v) < 1e-9) return "flat";
  return v * worse > 0 ? "down" : "up";        // "down" = worse (red), "up" = better (green)
}

// ------------------------------------------------------------------ data helpers
const last = () => H.date.length - 1;
function cardOf(key) { return NOW.cards.find((c) => c.key === key); }
function runsOf(values, f) {
  const out = [];
  let i = 0;
  while (i < values.length) {
    const v = f(values[i]);
    let j = i + 1;
    while (j < values.length && f(values[j]) === v) j++;
    out.push({ v, i0: i, i1: j });
    i = j;
  }
  return out;
}
function oosIndex() {
  const s = NOW.oos_start || "2011-01-03";
  const i = H.date.findIndex((d) => d >= s);
  return i < 0 ? 0 : i;
}
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function nBack(n) { return Math.max(0, last() - n); }
function presetStart(key) {
  const end = H.date[last()];
  if (key === "YTD") return end.slice(0, 4) + "-01-01";
  const n = { "1M": 1, "3M": 3, "6M": 6, "1Y": 1, "3Y": 3, "5Y": 5 }[key];
  const d = new Date(end + "T00:00:00Z");
  if (key.endsWith("M")) d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  const iso = d.toISOString().slice(0, 10);
  return iso < H.date[0] ? H.date[0] : iso;
}
function startIndex(iso) {
  let i = 0;
  while (i < last() && H.date[i] < iso) i++;
  return i;
}

// ------------------------------------------------------------------ load
function fail(msg) {
  const box = $("error");
  box.hidden = false;
  box.textContent = msg;
}

async function load() {
  // One file per build, revalidated on every visit, so the header, the cards and the charts can't come from
  // two different builds. Older builds without site.json: the two files, checked against each other.
  const get = (p) => fetch(p, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(p + " " + r.status);
    return r.json();
  });
  try {
    const s = await get("data/site.json");
    return [s.now, s.history];
  } catch (e) {
    const [n, h] = await Promise.all([get("data/now.json"), get("data/history.json")]);
    return [n, h];
  }
}

function checkSnapshot() {
  const lastDate = H.date[last()];
  if (NOW.build && H.build && NOW.build !== H.build) {
    fail(`The data files come from two different builds (${NOW.build} and ${H.build}). Reload the page.`);
  } else if (lastDate !== NOW.model_date) {
    fail(`The data files disagree: the summary is for ${pretty(NOW.model_date)} but the history ends ${pretty(lastDate)}. Reload the page.`);
  }
}

// ------------------------------------------------------------------ header stamp
function renderStamp() {
  const asof = NOW.as_of;
  const today = new Date();
  // business days between the close and today, ignoring holidays: more than 2 means the build is behind
  let bd = 0;
  const d = new Date(asof + "T12:00:00Z");
  while (d.toISOString().slice(0, 10) < today.toISOString().slice(0, 10)) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) bd++;
  }
  const old = bd > 2;
  const built = NOW.generated ? NOW.generated.replace("T", " ").replace("Z", " UTC") : "";
  $("stamp").replaceChildren(
    el("span", {}, [
      el("i", { class: "dot" + (old ? " old" : ""), "aria-hidden": "true" }),
      el("span", { class: "k", text: "Close" }),
      el("span", { class: "num" + (old ? " old" : ""), text: withDow(asof) }),
    ]),
    built ? el("span", { class: "built" }, [el("span", { class: "k", text: "Built" }), el("span", { class: "num", text: built })]) : null,
  );
  if (old) $("stamp").title = `This build is ${bd} weekdays behind today. The site keeps the last good build when a run fails.`;
}

// ------------------------------------------------------------------ KPI strip
function kpi(label, cls, kids) {
  return el("section", { class: "panel kpi " + (cls || "") }, [el("p", { class: "label", text: label }), ...kids]);
}
function line(...kids) { return el("p", { class: "line" }, kids); }
function n(text) { return el("span", { class: "num", text }); }
function m(text) { return el("b", { text }); }
function p(kids) { return el("p", { class: "value" }, kids); }

function renderKpis() {
  const L = last();
  const st = NOW.state;
  const runs = runsOf(H.state, (s) => s);
  const cur = runs[runs.length - 1];
  const prev = runs.length > 1 ? runs[runs.length - 2] : null;
  const w = NOW.weights || {};

  const regime = kpi("Regime", "state-" + st, [
    p([el("span", { class: "big" }, [el("i", { class: "dot " + st, "aria-hidden": "true" }), STATE_LABEL[st]])]),
    line(n(String(NOW.days_in_state)), ` session${NOW.days_in_state === 1 ? "" : "s"}, since `, n(shortDate(H.date[cur.i0]))),
    prev ? line(m("Before: "), `${STATE_LABEL[STATES[prev.v]]}, `, n(String(prev.i1 - prev.i0)), ` session${prev.i1 - prev.i0 === 1 ? "" : "s"}`) : null,
    el("div", { class: "mix", title: "The filter's mix of the three states, on a 0.05 grid. Not a probability." },
      STATES.map((k) => el("span", {}, [m({ calm: "Calm ", elevated: "Elev ", crisis: "Crisis " }[k]), n(fixed(w[k], 2))]))),
  ]);

  // off-calm (or calm) stretch and how it compares with completed out-of-sample stretches
  const two = runsOf(H.state, (s) => (s === 0 ? 0 : 1));
  const now2 = two[two.length - 1];
  const age = now2.i1 - now2.i0;
  const o = oosIndex();
  const past = two.slice(0, -1).filter((r) => r.v === now2.v && r.i0 >= o).map((r) => r.i1 - r.i0);
  const shorter = past.filter((x) => x < age).length;
  const offLabel = now2.v === 1 ? "Off calm" : "Calm stretch";
  const stretch = kpi(offLabel, "", [
    p([el("span", { class: "big num", text: String(age) }), el("span", { class: "unit", text: `session${age === 1 ? "" : "s"}` })]),
    line("Since ", n(shortDate(H.date[now2.i0])), now2.v === 1 ? ", elevated or crisis" : ""),
    past.length ? line("Longer than ", n(Math.round((shorter / past.length) * 100) + "%"), " of ", n(String(past.length)), " past stretches") : null,
    past.length ? line("Median ", n(String(median(past))), ` sessions, since ${H.date[o].slice(0, 4)}`) : null,
  ]);

  const spy = H.spy;
  const r1 = retPct(spy[L], spy[nBack(1)]);
  const r5 = retPct(spy[L], spy[nBack(5)]);
  const r20 = retPct(spy[L], spy[nBack(20)]);
  let hi = -Infinity;
  for (let i = nBack(251); i <= L; i++) if (isNum(spy[i]) && spy[i] > hi) hi = spy[i];
  const dd = retPct(spy[L], hi);
  const cls = (v) => "num " + (!isNum(v) || Math.abs(v) < 0.005 ? "flat" : v > 0 ? "up" : "down");
  const spyK = kpi("SPY total return", "", [
    p([el("span", { class: "big " + cls(r1), text: signed(r1, 2, "%") }), el("span", { class: "unit", text: "1 session" })]),
    line(m("5d "), el("span", { class: cls(r5), text: signed(r5, 2, "%") }), m("   20d "), el("span", { class: cls(r20), text: signed(r20, 2, "%") })),
    line(n(signed(dd, 1, "%")), " from its 52-week high"),
  ]);

  const counts = { stress: [], watch: [], calm: [] };
  for (const c of NOW.cards) if (counts[c.zone]) counts[c.zone].push(IND[c.key] ? IND[c.key].name : c.label);
  const indK = kpi("Indicators", "", [
    p([
      el("span", { class: "big num", text: String(counts.stress.length) }), el("span", { class: "unit" }, [el("i", { class: "dot stress", "aria-hidden": "true" }), "stress"]),
      el("span", { class: "big num", text: String(counts.watch.length) }), el("span", { class: "unit" }, [el("i", { class: "dot watch", "aria-hidden": "true" }), "watch"]),
      el("span", { class: "big num", text: String(counts.calm.length) }), el("span", { class: "unit" }, [el("i", { class: "dot calm", "aria-hidden": "true" }), "calm"]),
    ]),
    counts.stress.length ? line(m("Stress: "), counts.stress.join(", ")) : null,
    counts.watch.length ? line(m("Watch: "), counts.watch.join(", ")) : null,
  ]);
  $("kpis").replaceChildren(regime, stretch, spyK, indK);
}

// ------------------------------------------------------------------ indicator table
function spark(values, meta, w, hgt) {
  const svg = sv("svg", { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, class: "spark", "aria-hidden": "true" });
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => isNum(v));
  if (pts.length < 2) return svg;
  let lo, hi;
  if (meta.kind === "high" || meta.kind === "low") { lo = 0; hi = 100; }
  else {
    lo = Math.min(...pts.map((q) => q[1])); hi = Math.max(...pts.map((q) => q[1]));
    for (const [lv] of meta.lines) { lo = Math.min(lo, lv); hi = Math.max(hi, lv); }
    const pad = (hi - lo) * 0.08 || 0.01;
    lo -= pad; hi += pad;
  }
  const X = (i) => 1 + (i / (values.length - 1)) * (w - 4);
  const Y = (v) => 1.5 + (1 - (v - lo) / (hi - lo || 1)) * (hgt - 3);
  for (const [lv, z] of meta.lines) {
    svg.append(sv("line", { x1: 0, x2: w, y1: Y(lv), y2: Y(lv), stroke: token(z === "stress" ? "--stress" : "--watch"),
      "stroke-width": 1, "stroke-dasharray": "2 2", opacity: 0.7 }));
  }
  let d = "", pen = false;
  for (let i = 0; i < values.length; i++) {
    if (!isNum(values[i])) { pen = false; continue; }
    d += (pen ? "L" : "M") + X(i).toFixed(1) + " " + Y(values[i]).toFixed(1);
    pen = true;
  }
  svg.append(sv("path", { d, fill: "none", stroke: "currentColor", "stroke-width": 1.25, "stroke-linejoin": "round" }));
  const [li, lv] = pts[pts.length - 1];
  svg.append(sv("circle", { cx: X(li), cy: Y(lv), r: 2, fill: "currentColor" }));
  return svg;
}

function pbar(meta, now, then) {
  const bar = el("div", { class: "pbar", "aria-hidden": "true" });
  if (meta.kind === "high") {
    bar.append(el("span", { class: "z w", style: "left:80%;width:15%" }), el("span", { class: "z s", style: "left:95%;width:5%" }));
  } else if (meta.kind === "low") {
    bar.append(el("span", { class: "z s", style: "left:0;width:5%" }), el("span", { class: "z w", style: "left:5%;width:15%" }));
  }
  if (isNum(then)) bar.append(el("span", { class: "then", style: `left:${then}%` }));
  if (isNum(now)) bar.append(el("span", { class: "now", style: `left:${now}%` }));
  return bar;
}

function indRows() {
  const L = last();
  const i0 = startIndex(presetStart("6M"));
  return NOW.cards.filter((c) => IND[c.key]).map((c) => {
    const meta = IND[c.key];
    const pk = "pct_" + c.key;
    const ph = H[pk] || [];
    const pNow = isNum(ph[L]) ? ph[L] : c.pct;
    const p5 = isNum(ph[nBack(5)]) ? ph[nBack(5)] : null;
    return { c, meta, pNow, p5, spark: (H[meta.series] || []).slice(i0, L + 1) };
  });
}

function renderIndicators() {
  const table = $("ind");
  const head = el("thead", {}, [
    el("tr", { class: "group" }, [
      el("th", { rowspan: 2, scope: "col", text: "Indicator" }),
      el("th", { rowspan: 2, scope: "col", class: "num", text: "Last" }),
      el("th", { colspan: 3, scope: "colgroup", class: "span", text: "Change" }),
      el("th", { colspan: 3, scope: "colgroup", class: "span", text: "Percentile since 2008" }),
      el("th", { rowspan: 2, scope: "col", text: "Zone" }),
      el("th", { rowspan: 2, scope: "col", text: "6 months" }),
      el("th", { colspan: 2, scope: "colgroup", class: "span", text: "SPY next 15 sessions" }),
    ]),
    el("tr", {}, [
      el("th", { scope: "col", class: "num", text: "1d" }),
      el("th", { scope: "col", class: "num", text: "5d" }),
      el("th", { scope: "col", class: "num", text: "20d" }),
      el("th", { scope: "col", class: "num", text: "Today" }),
      el("th", { scope: "col", class: "num", text: "5d chg" }),
      el("th", { scope: "col", text: "0 – 100" }),
      el("th", { scope: "col", class: "num", title: "Median largest fall from peak over the next 15 sessions, on past sessions within 5 percentile points of today", text: "Med. DD" }),
      el("th", { scope: "col", class: "num", title: "Worst 10% of the same", text: "Worst 10%" }),
    ]),
  ]);
  const body = el("tbody");
  for (const r of indRows()) {
    const { c, meta } = r;
    const zone = ZONE_LABEL[c.zone] ? c.zone : "context";
    const dec = c.decimals;
    const pchg = isNum(r.pNow) && isNum(r.p5) ? r.pNow - r.p5 : null;
    const nx = c.next;
    const tr = el("tr", { class: "irow", "data-key": c.key, tabindex: 0, "aria-selected": String(selectedInd === c.key) }, [
      el("th", { scope: "row" }, [el("span", { class: "name", text: meta.name }), el("span", { class: "desc", text: meta.desc })]),
      el("td", { class: "num val", text: minus(fixed(c.value, dec)) }),
      el("td", { class: "num " + tone(c.chg1, meta.worse), text: signed(c.chg1, dec) }),
      el("td", { class: "num " + tone(c.chg5, meta.worse), text: signed(c.chg5, dec) }),
      el("td", { class: "num " + tone(c.chg20, meta.worse), text: signed(c.chg20, dec) }),
      el("td", { class: "num val", text: fixed(r.pNow, 1) }),
      el("td", { class: "num " + tone(pchg, meta.worse), text: signed(pchg, 1) }),
      el("td", {}, [pbar(meta, r.pNow, r.p5)]),
      el("td", { class: "zone" }, [el("i", { class: "dot " + zone, "aria-hidden": "true" }), ZONE_LABEL[zone]]),
      el("td", {}, [spark(r.spark, meta, 112, 26)]),
      el("td", { class: "num", text: nx && nx.mdd15 ? minus(fixed(nx.mdd15[0], 1)) + "%" : "—" }),
      el("td", { class: "num", text: nx && nx.mdd15 ? minus(fixed(nx.mdd15[1], 1)) + "%" : "—" }),
    ]);
    tr.addEventListener("click", () => toggleInd(c.key));
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleInd(c.key); }
    });
    body.append(tr);
    if (selectedInd === c.key) body.append(detailRow(r));
  }
  table.replaceChildren(head, body);
}

function detailRow(r) {
  const { c, meta } = r;
  const nx = c.next, base = NOW.baseline_next;
  const kv = (pairs) => el("dl", { class: "kv" }, pairs.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
  const pctLine = meta.kind === "level" || meta.kind === "context" ? "Percentile today" : "Percentile today (sets the zone)";
  const reading = kv([
    ["Last", minus(fixed(c.value, c.decimals))],
    [pctLine, isNum(r.pNow) ? fixed(r.pNow, 1) : "—"],
    ["Percentile 5 sessions ago", isNum(r.p5) ? fixed(r.p5, 1) : "—"],
    ["Change 20 sessions", signed(c.chg20, c.decimals)],
    ["History from", c.since || "2008-01"],
  ]);
  const fmt = (pair) => pair ? `${minus(fixed(pair[0], 1))}% / ${minus(fixed(pair[1], 1))}%` : "—";
  const next = nx ? kv([
    ["Comparable sessions", `${nx.n.toLocaleString("en-US")} (${nx.n_ind} independent)`],
    ["Max drawdown, 15 sessions", fmt(nx.mdd15)],
    ["Max drawdown, 30 sessions", fmt(nx.mdd30)],
    ["Realized vol, 15 sessions", nx.rv15 ? `${fixed(nx.rv15[0], 1)}% / ${fixed(nx.rv15[1], 1)}%` : "—"],
    ["All sessions since 2008, 15-session DD", base ? fmt(base.mdd15) : "—"],
  ]) : el("p", { text: "No comparison: this indicator is context only." });
  return el("tr", { class: "detail" }, [el("td", { colspan: 12 }, [
    el("div", { class: "detail-grid" }, [
      el("div", {}, [el("h3", { class: "sub-h", text: "What it is" }), el("p", { text: meta.what }), el("p", { class: "muted", text: meta.rule })]),
      el("div", {}, [el("h3", { class: "sub-h", text: "Reading" }), reading]),
      el("div", {}, [el("h3", { class: "sub-h", text: "SPY afterwards, median / worst 10%" }), next]),
    ]),
  ])]);
}

function toggleInd(key) {
  selectedInd = selectedInd === key ? null : key;
  renderIndicators();
  if (selectedInd) setView(key);
  const row = document.querySelector(`#ind tr.irow[data-key="${key}"]`);
  if (row) row.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ regime tape
function renderTape() {
  const box = $("tape");
  const W = Math.max(320, box.clientWidth - 24);
  const years = [];
  for (let i = 0; i < H.date.length; i++) {
    const y = +H.date[i].slice(0, 4);
    if (!years.length || years[years.length - 1].y !== y) years.push({ y, i0: i, i1: i + 1 });
    else years[years.length - 1].i1 = i + 1;
  }
  const labW = 34, statW = mobileQ.matches ? 40 : 92, rowH = 13, gap = 4;
  const cols = 253;
  const cw = (W - labW - statW - 8) / cols;
  const Hh = years.length * (rowH + gap) + 16;
  const svg = sv("svg", { viewBox: `0 0 ${W} ${Hh}`, class: "tape", role: "img",
    "aria-label": "Regime label for every session since 2008, one row per year" });
  const col = { 0: token("--calm"), 1: token("--watch"), 2: token("--stress") };
  const o = oosIndex();
  const hd = sv("text", { x: W - 2, y: 9, "text-anchor": "end" });
  hd.textContent = mobileQ.matches ? "off" : "off calm · crisis";
  svg.append(hd);
  years.forEach((yr, k) => {
    const y = 14 + k * (rowH + gap);
    const t = sv("text", { x: 0, y: y + rowH - 2, class: "yr" });
    t.textContent = String(yr.y);
    svg.append(t);
    svg.append(sv("rect", { x: labW, y, width: cols * cw, height: rowH, fill: token("--grid") }));
    for (const r of runsOf(H.state.slice(yr.i0, yr.i1), (s) => s)) {
      const a = yr.i0 + r.i0, b = yr.i0 + r.i1;
      const rect = sv("rect", { x: labW + r.i0 * cw, y, width: Math.max(0.8, (r.i1 - r.i0) * cw - 0.3), height: rowH,
        fill: col[r.v], opacity: r.v === 0 ? (a < o ? 0.16 : 0.32) : (a < o ? 0.5 : 0.95) });
      const tt = sv("title", {});
      tt.textContent = `${STATE_LABEL[STATES[r.v]]}: ${pretty(H.date[a])} to ${pretty(H.date[b - 1])}, ${b - a} session${b - a === 1 ? "" : "s"}${a < o ? " (training window)" : ""}`;
      rect.append(tt);
      svg.append(rect);
    }
    const nS = yr.i1 - yr.i0;
    let off = 0, cr = 0;
    for (let i = yr.i0; i < yr.i1; i++) { if (H.state[i] > 0) off++; if (H.state[i] === 2) cr++; }
    const s = sv("text", { x: W - 2, y: y + rowH - 2, "text-anchor": "end" });
    s.textContent = mobileQ.matches ? `${Math.round((off / nS) * 100)}%` : `${String(Math.round((off / nS) * 100)).padStart(3, " ")}% · ${String(cr).padStart(3, " ")}`;
    s.setAttribute("xml:space", "preserve");
    svg.append(s);
    if (yr.i0 < o && yr.i1 <= o + 1 && k === 0) {
      // training window marker on the first row
    }
  });
  // marker for today
  const ly = years.length - 1;
  const lastYr = years[ly];
  const xl = labW + (last() - lastYr.i0 + 0.5) * cw;
  const yl = 14 + ly * (rowH + gap);
  svg.append(sv("line", { x1: xl, x2: xl, y1: yl - 2, y2: yl + rowH + 2, stroke: token("--text"), "stroke-width": 1.5 }));
  const key = el("div", { class: "tape-key" }, [
    el("span", { class: "key" }, [el("i", { class: "sw calm" }), "Calm"]),
    el("span", { class: "key" }, [el("i", { class: "sw elevated" }), "Elevated"]),
    el("span", { class: "key" }, [el("i", { class: "sw crisis" }), "Crisis"]),
    el("span", { class: "key" }, ["Faded rows: 2008 to 2010 training window"]),
    el("span", { class: "key" }, ["Right: share of sessions off calm · crisis sessions"]),
  ]);
  box.replaceChildren(svg, key);
}

// ------------------------------------------------------------------ cross-asset turbulence
// The page's one next-state forecast: a two-state model fitted to weekly turbulence (pipeline/turbulence.py).
function renderTurb() {
  const t = NOW.turbulence;
  const panel = $("turb-panel");
  if (!t) { panel.hidden = true; return; }
  panel.hidden = false;
  const box = $("turb");
  if (t.error) {
    box.replaceChildren(el("p", { class: "line muted turb-note", text: `Not available in this build (${t.error}). The rest of the page is unaffected.` }));
    return;
  }
  const pc = (v) => (isNum(v) ? Math.round(v * 100) + "%" : "—");
  const th = (v) => (isNum(v) ? ordinal(Math.round(v)) : "—");
  const turb = isNum(t.p_turb) && t.p_turb > 0.5;
  const hist = t.hist || { pct: [], p: [] };

  const weekly = el("div", { class: "kpi tb" }, [
    el("p", { class: "label", text: "Week to " + withDow(t.week_last_session || t.week_end) }),
    p([el("span", { class: "big num", text: fixed(t.weekly, 1) }), el("span", { class: "unit", text: th(t.weekly_pct) + " percentile" })]),
    line(m("Week before: "), n(fixed(t.weekly_prev, 1)), ", ", n(th(pctOfPrev(t))), " percentile"),
    line(m("Top 10% of weeks: "), "above ", n(fixed(t.q90, 1)), ", ", m("top 1%: "), "above ", n(fixed(t.q99, 1))),
    spark(hist.pct, { kind: "high", lines: [[90, "watch"], [99, "stress"]] }, 220, 34),
    el("p", { class: "line muted", text: "Weekly percentile, last 2 years" }),
  ]);
  const daily = el("div", { class: "kpi tb" }, [
    el("p", { class: "label", text: "Daily, 5-session average" }),
    p([el("span", { class: "big num", text: fixed(t.daily5, 1) }), el("span", { class: "unit", text: th(t.daily5_pct) + " percentile" })]),
    line(m("Last session, " + shortDate(t.day) + ": "), n(fixed(t.daily, 1)), ", ", n(th(t.daily_pct)), " percentile"),
  ]);
  const model = el("div", { class: "kpi tb " + (turb ? "state-crisis" : "state-calm") }, [
    el("p", { class: "label", text: "Turbulence regime" }),
    p([el("span", { class: "big" }, [el("i", { class: "dot " + (turb ? "stress" : "calm"), "aria-hidden": "true" }), turb ? "Turbulent" : "Normal"]),
      el("span", { class: "unit", text: pc(t.p_turb) + " chance now" })]),
    turb && t.since ? line("Turbulent since the week to ", n(shortDate(t.since))) : line("Turbulent spells last about ", n(fixed(t.spell_weeks, 1)), " weeks"),
    spark((hist.p || []).map((v) => (isNum(v) ? v * 100 : v)), { kind: "high", lines: [[50, "watch"]] }, 220, 34),
    el("p", { class: "line muted", text: "Chance of the turbulent state, last 2 years" }),
  ]);

  const a = t.ahead || {};
  const odds = el("table", { class: "next turb-odds" }, [
    el("thead", {}, [el("tr", {}, [
      el("th", { scope: "col", text: "Chance of the turbulent state" }),
      el("th", { scope: "col", class: "num", text: "Now" }),
      el("th", { scope: "col", class: "num", text: "Next week" }),
      el("th", { scope: "col", class: "num", text: "In 4 weeks" }),
      el("th", { scope: "col", class: "num", text: "In 13 weeks" }),
    ])]),
    el("tbody", {}, [el("tr", {}, [
      el("td", { text: "Two-state model on weekly turbulence" }),
      el("td", { class: "num", text: pc(t.p_turb) }),
      el("td", { class: "num", text: pc(a["1"]) }),
      el("td", { class: "num", text: pc(a["4"]) }),
      el("td", { class: "num", text: pc(a["13"]) }),
    ])]),
  ]);
  const notes = [
    el("p", { class: "line muted turb-note" }, [
      `Fitted on ${t.n_weeks.toLocaleString("en-US")} weeks since ${pretty(t.first_week)}: a turbulent spell lasts about `, n(fixed(t.spell_weeks, 1)),
      " weeks on average and ", n(pc(t.share_turb)), " of weeks were turbulent. The odds come only from the fitted switching rates, so they know nothing about news or the calendar.",
    ]),
    el("p", { class: "line muted turb-note", text: `Turbulence measures how big and how unusual moves are across ${(t.assets || []).join(", ")} (total return), not their direction. A week counts once its Friday close is in. See Methods.` }),
  ];
  box.replaceChildren(el("div", { class: "turb-grid" }, [weekly, daily, model]), el("div", { class: "tablewrap turb-table" }, [odds]), ...notes);
}
// the previous week's percentile is the second-to-last point of the weekly history
function pctOfPrev(t) {
  const h = (t.hist && t.hist.pct) || [];
  return h.length > 1 ? h[h.length - 2] : null;
}

// ------------------------------------------------------------------ what came next + spells
function renderNext() {
  const rows = NOW.state_next || [];
  const box = $("next");
  if (!rows.length) { box.replaceChildren(); return; }
  const fmt = (v) => (isNum(v) ? minus(v.toFixed(1)) + "%" : "—");
  const table = el("table", { class: "next" }, [
    el("thead", {}, [el("tr", {}, [
      el("th", { scope: "col", text: "Sessions labelled" }),
      el("th", { scope: "col", class: "num", text: "Days" }),
      el("th", { scope: "col", class: "num", title: "Median largest fall from peak over the next 15 sessions", text: "Med. DD" }),
      el("th", { scope: "col", class: "num", title: "Worst 10% of the same", text: "Worst 10%" }),
      el("th", { scope: "col", class: "num", title: "Median realized volatility over the next 15 sessions, annualized", text: "Vol" }),
    ])]),
    el("tbody", {}, rows.map((r) => {
      const cur = r.label === NOW.state;
      const name = STATE_LABEL[r.label] || (r.label.charAt(0).toUpperCase() + r.label.slice(1));
      return el("tr", { class: cur ? "cur" : "" }, [
        el("td", {}, [STATES.includes(r.label) ? el("i", { class: "dot " + r.label, "aria-hidden": "true" }) : null, name, cur ? el("span", { class: "muted", text: "  today" }) : null]),
        el("td", { class: "num", text: r.n.toLocaleString("en-US") }),
        el("td", { class: "num", text: fmt(r.mdd15 && r.mdd15[0]) }),
        el("td", { class: "num", text: fmt(r.mdd15 && r.mdd15[1]) }),
        el("td", { class: "num", text: r.rv15 && isNum(r.rv15[0]) ? r.rv15[0].toFixed(1) + "%" : "—" }),
      ]);
    })),
  ]);
  box.replaceChildren(el("div", { class: "tablewrap" }, [table]));
}

function renderSpells() {
  const runs = runsOf(H.state, (s) => s);
  const recent = runs.slice(-8).reverse();
  const st = NOW.state;
  const summary = NOW.past_spells
    ? el("p", { class: "line muted" }, [`${STATE_LABEL[st]} stretches since 2011: `, n(String(NOW.past_spells)), ", averaging ", n(fixed(NOW.past_avg_spell, 1)), " sessions."])
    : null;
  const table = el("table", {}, [el("tbody", {}, recent.map((r, k) => el("tr", {}, [
    el("td", {}, [el("i", { class: "dot " + STATES[r.v], "aria-hidden": "true" }), STATE_LABEL[STATES[r.v]]]),
    el("td", { class: "num muted", text: `${shortDate(H.date[r.i0])} – ${k === 0 ? "today" : shortDate(H.date[r.i1 - 1])}` }),
    el("td", { class: "num", text: `${r.i1 - r.i0}` }),
  ])))]);
  $("spells").replaceChildren(el("h3", { class: "sub-h", text: "Recent stretches" }), table, summary);
}

// ------------------------------------------------------------------ chart
function coord(ts, time, index, width) {
  if (time) {
    const x = ts.timeToCoordinate(time);
    if (x != null) return x;
  }
  const range = ts.getVisibleLogicalRange();
  if (!range || index == null || range.to === range.from) return null;
  return ((index - range.from) / (range.to - range.from)) * width;
}

function makeBands() {
  // regime shading: a light wash over the whole pane and a solid strip along the bottom
  let api = null;
  const renderer = {
    draw() {},
    drawBackground(target) {
      if (!api) return;
      const ts = api.timeScale();
      target.useBitmapCoordinateSpace((scope) => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio || 1;
        const vr = scope.verticalPixelRatio || 1;
        const mediaW = scope.bitmapSize.width / hr;
        const height = scope.bitmapSize.height;
        const spacing = ts.options().barSpacing || 6;
        const strip = Math.round(4 * vr);
        ctx.save();
        for (const span of bandSpans) {
          const x0 = coord(ts, span.from, span.i0, mediaW);
          if (x0 == null) continue;
          let x1 = span.to ? coord(ts, span.to, span.i1, mediaW) : null;
          if (x1 == null) x1 = x0 + spacing;
          let left = Math.round(Math.min(x0, x1) * hr);
          let right = Math.round(Math.max(x0, x1) * hr);
          if (right - left < 2 * hr) { const mid = (left + right) / 2; left = mid - hr; right = mid + hr; }
          if (right < 0 || left > scope.bitmapSize.width) continue;
          ctx.fillStyle = span.wash;
          ctx.fillRect(left, 0, right - left, height);
          if (span.strip) {
            ctx.fillStyle = span.strip;
            ctx.fillRect(left, height - strip, right - left, strip);
          }
        }
        ctx.restore();
      });
    },
  };
  const views = [{ zOrder: () => "bottom", renderer: () => renderer }];
  return {
    attached(param) { api = param.chart; },
    detached() { api = null; },
    updateAllViews() {},
    paneViews() { return views; },
  };
}

function makeSegments(getPts, getStyle) {
  let series = null, chartApi = null;
  const renderer = {
    draw(target) {
      if (!series || !chartApi) return;
      const pts = getPts();
      if (!pts.length) return;
      const st = getStyle();
      target.useMediaCoordinateSpace((scope) => {
        const ctx = scope.context;
        const width = scope.mediaSize.width;
        const ts = chartApi.timeScale();
        const vis = ts.getVisibleLogicalRange();
        const a = vis ? Math.max(0, Math.floor(vis.from) - 2) : 0;
        const b = vis ? Math.min(pts.length - 1, Math.ceil(vis.to) + 2) : pts.length - 1;
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = st.color;
        ctx.lineWidth = st.width;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        if (st.dash) ctx.setLineDash(st.dash);
        let pen = false;
        for (let i = a; i <= b; i++) {
          const p = pts[i];
          if (p.value == null) { pen = false; continue; }
          const x = coord(ts, p.time, i, width);
          const y = series.priceToCoordinate(p.value);
          if (x == null || y == null) { pen = false; continue; }
          if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      });
    },
  };
  const views = [{ zOrder: () => "normal", renderer: () => renderer }];
  return {
    attached(param) { chartApi = param.chart; series = param.series; },
    detached() { chartApi = null; series = null; },
    updateAllViews() {},
    paneViews() { return views; },
  };
}

function spansOf(pred, wash, strip) {
  return runsOf(H.state, (s) => (pred(s) ? 1 : 0)).filter((r) => r.v === 1).map((r) => ({
    from: H.date[r.i0], to: r.i1 < H.date.length ? H.date[r.i1] : null, i0: r.i0, i1: r.i1, wash, strip,
  }));
}

function viewSpec(key) {
  const pctFmt = { type: "custom", minMove: 0.1, formatter: (v) => String(Math.round(v)) };
  if (key === "spy") {
    return {
      tab: "SPY + regime", title: "SPY total return",
      sub: "Index, 2 Jan 2008 = 100, log scale. Shading marks elevated and crisis days.",
      data: H.spy, scale: 1, log: true, fmt: { type: "price", precision: 0, minMove: 1 }, lines: [],
    };
  }
  const meta = IND[key];
  const card = cardOf(key);
  const pctKind = meta.kind === "high" || meta.kind === "low";
  return {
    tab: meta.name, title: meta.name + (pctKind ? " percentile" : ""),
    sub: (pctKind ? "Point-in-time percentile since 2008. " : "") + meta.rule,
    data: H[meta.series] || [], scale: 1, log: false,
    fmt: pctKind ? pctFmt : { type: "price", precision: card.decimals, minMove: 10 ** -card.decimals },
    lines: meta.lines, fixedRange: pctKind ? [0, 100] : null, zone: card.zone,
  };
}

function renderTabs() {
  const keys = ["spy", ...NOW.cards.map((c) => c.key).filter((k) => IND[k])];
  const box = $("series-tabs");
  box.replaceChildren(...keys.map((k) => {
    const card = IND[k] ? cardOf(k) : null;
    const b = el("button", { type: "button", role: "tab", "data-key": k, "aria-selected": String(k === view), tabindex: k === view ? 0 : -1 }, [
      card ? el("i", { class: "dot " + (ZONE_LABEL[card.zone] ? card.zone : "context"), "aria-hidden": "true" }) : null,
      k === "spy" ? "SPY + regime" : IND[k].name,
    ]);
    b.addEventListener("click", () => setView(k));
    return b;
  }));
  box.onkeydown = (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const i = keys.indexOf(view);
    const j = (i + (e.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length;
    e.preventDefault();
    setView(keys[j]);
    box.querySelector(`[data-key="${keys[j]}"]`).focus();
  };
}

function setView(key) {
  view = key;
  for (const b of document.querySelectorAll("#series-tabs button")) {
    const on = b.dataset.key === key;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  if (!chart) return;
  const spec = viewSpec(key);
  $("chart-title").textContent = spec.title;
  $("chart-sub").textContent = spec.sub;
  for (const pl of lines) mainSeries.removePriceLine(pl);
  lines = [];
  mainPts = H.date.map((t, i) => (isNum(spec.data[i]) ? { time: t, value: spec.data[i] * spec.scale } : { time: t }));
  const L = LightweightCharts;
  mainSeries.applyOptions({
    priceFormat: spec.fmt,
    autoscaleInfoProvider: (original) => {
      const res = original();
      if (!res || !res.priceRange) return res;
      if (spec.fixedRange) {
        res.priceRange.minValue = Math.min(res.priceRange.minValue, spec.fixedRange[0]);
        res.priceRange.maxValue = Math.max(res.priceRange.maxValue, spec.fixedRange[1]);
      }
      for (const [lv] of spec.lines) {
        res.priceRange.minValue = Math.min(res.priceRange.minValue, lv);
        res.priceRange.maxValue = Math.max(res.priceRange.maxValue, lv);
      }
      return res;
    },
  });
  mainSeries.setData(mainPts);
  mainSeries.priceScale().applyOptions({ mode: spec.log ? L.PriceScaleMode.Logarithmic : L.PriceScaleMode.Normal });
  for (const [lv, z] of spec.lines) {
    lines.push(mainSeries.createPriceLine({
      price: lv, title: z === "stress" ? "Stress" : "Watch", color: token(z === "stress" ? "--stress" : "--watch"),
      lineWidth: 1, lineStyle: L.LineStyle.Dashed, lineVisible: true, axisLabelVisible: true,
    }));
  }
  renderKey(spec);
  readout(cursor >= 0 ? cursor : last());
  $("chart-live").textContent = "Chart: " + spec.title;
}

function renderKey(spec) {
  const items = [
    el("span", { class: "key" }, [el("i", { class: "sw line" }), spec.title]),
  ];
  if (spec.lines.length) {
    items.push(el("span", { class: "key" }, [el("i", { class: "sw watchline" }), "Watch"]));
    items.push(el("span", { class: "key" }, [el("i", { class: "sw stressline" }), "Stress"]));
  }
  items.push(el("span", { class: "key" }, [el("i", { class: "sw elevated" }), "Elevated"]));
  items.push(el("span", { class: "key" }, [el("i", { class: "sw crisis" }), "Crisis"]));
  $("chart-key").replaceChildren(...items);
}

function readout(i) {
  if (i < 0 || i > last()) return;
  const st = STATES[H.state[i]];
  const spec = viewSpec(view);
  const kids = [el("span", { class: "when", text: withDow(H.date[i]) })];
  kids.push(el("span", {}, [el("i", { class: "dot " + st, "aria-hidden": "true" }), STATE_LABEL[st]]));
  const r1 = i > 0 ? retPct(H.spy[i], H.spy[i - 1]) : null;
  kids.push(el("span", {}, ["SPY ", n(fixed(H.spy[i], 2)), " ", el("span", { class: "num " + (isNum(r1) ? (r1 >= 0 ? "up" : "down") : ""), text: signed(r1, 2, "%") })]));
  if (IND[view]) {
    const meta = IND[view];
    const v = (H[meta.series] || [])[i];
    const pctKind = meta.kind === "high" || meta.kind === "low";
    kids.push(el("span", {}, [meta.name + (pctKind ? " pctl " : " "), n(pctKind ? fixed(v, 1) : fixed(v, cardOf(view).decimals))]));
    const pv = (H["pct_" + view] || [])[i];
    if (!pctKind && isNum(pv)) kids.push(el("span", {}, ["pctl ", n(fixed(pv, 1))]));
  }
  $("readout").replaceChildren(...kids);
  if (fromKeys) {
    $("chart-live").textContent = H.date[i] + ": " + $("readout").textContent;
    fromKeys = false;
  }
}

function applyRange(key) {
  pinned = key;
  if (key === "All") chart.timeScale().fitContent();
  else chart.timeScale().setVisibleLogicalRange({ from: startIndex(presetStart(key)), to: last() + 2 });
  markRanges();
}
function markRanges() {
  const r = chart.timeScale().getVisibleRange();
  const from = r ? timeStr(r.from) : "", to = r ? timeStr(r.to) : "";
  for (const btn of document.querySelectorAll(".ranges button")) {
    const key = btn.dataset.range;
    let on = false;
    if (from && to) {
      const endOk = Math.abs(daysBetween(H.date[last()], to)) <= 21;
      const start = key === "All" ? H.date[0] : presetStart(key);
      on = Math.abs(daysBetween(start, from)) <= 10 && endOk;
    }
    btn.setAttribute("aria-pressed", String(on));
  }
}
function zoomLogical(f) {
  const range = chart.timeScale().getVisibleLogicalRange();
  if (!range) return;
  const mid = (range.from + range.to) / 2, half = ((range.to - range.from) * f) / 2;
  chart.timeScale().setVisibleLogicalRange({ from: mid - half, to: mid + half });
}

function buildChart() {
  const L = LightweightCharts;
  const box = $("chart");
  chart = L.createChart(box, {
    autoSize: true,
    layout: {
      background: { type: L.ColorType.Solid, color: token("--panel") },
      textColor: token("--muted"),
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 11,
      attributionLogo: true,
    },
    grid: { vertLines: { color: token("--grid") }, horzLines: { color: token("--grid") } },
    crosshair: {
      mode: L.CrosshairMode.Magnet,
      vertLine: { color: token("--line-2"), labelBackgroundColor: token("--select"), width: 1, style: L.LineStyle.Solid },
      horzLine: { color: token("--line-2"), labelBackgroundColor: token("--select"), width: 1, style: L.LineStyle.Solid },
    },
    rightPriceScale: { borderColor: token("--line"), minimumWidth: 64, scaleMargins: { top: 0.06, bottom: 0.06 } },
    timeScale: { borderColor: token("--line"), rightOffset: 2, fixLeftEdge: false, fixRightEdge: false },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    localization: { locale: "en-US", timeFormatter: (t) => pretty(timeStr(t)) },
  });
  mainSeries = chart.addSeries(L.LineSeries, {
    color: token("--series"), lineWidth: 2, lineVisible: false, lastValueVisible: true, priceLineVisible: false,
    crosshairMarkerRadius: 3, crosshairMarkerBorderColor: token("--panel"), crosshairMarkerBackgroundColor: token("--series"),
  });
  bandSpans = spansOf((s) => s === 1, token("--band-watch"), token("--watch"))
    .concat(spansOf((s) => s === 2, token("--band-stress"), token("--stress")));
  mainSeries.attachPrimitive(makeBands());
  mainSeries.attachPrimitive(makeSegments(() => mainPts, () => ({ color: token("--series"), width: 1.75 })));

  chart.subscribeCrosshairMove((param) => {
    if (param.time == null) { readout(last()); return; }
    const i = H.date.indexOf(timeStr(param.time));
    if (i >= 0) { cursor = i; readout(i); }
  });
  chart.subscribeDblClick(() => applyRange(pinned));
  chart.timeScale().subscribeVisibleTimeRangeChange(() => markRanges());
  box.addEventListener("keydown", (e) => {
    const N = H.date.length;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      cursor = Math.max(0, Math.min(N - 1, (cursor < 0 ? N - 1 : cursor) + (e.key === "ArrowRight" ? 1 : -1)));
      fromKeys = true;
      const v = mainPts[cursor] && mainPts[cursor].value;
      if (v != null) chart.setCrosshairPosition(v, H.date[cursor], mainSeries);
      readout(cursor);
    } else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomLogical(0.75); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomLogical(1.35); }
    else if (e.key === "0") { e.preventDefault(); applyRange(pinned); }
  });
  setView(view);
  const pin = () => applyRange(pinned);
  pin();
  requestAnimationFrame(pin);
  let seenW = 0;
  new ResizeObserver(() => {
    const w = box.clientWidth;
    if (!w || w === seenW) return;
    seenW = w;
    pin();
  }).observe(box);
}

// ------------------------------------------------------------------ history view
function histCols() {
  const cols = [
    ["date", "Date"], ["state", "State"], ["spy", "SPY index"], ["spy1", "SPY 1d"],
  ];
  if (H.vix_vix3m) cols.push(["vix_vix3m", "VIX / VIX3M"]);
  for (const c of NOW.cards) if (H["pct_" + c.key] && IND[c.key]) cols.push(["pct_" + c.key, IND[c.key].name + " pctl"]);
  if (H.t10y2y) cols.push(["t10y2y", "10y − 2y"]);
  return cols;
}
function histValue(key, i) {
  switch (key) {
    case "date": return H.date[i];
    case "state": return STATE_LABEL[STATES[H.state[i]]];
    case "spy1": return i > 0 ? retPct(H.spy[i], H.spy[i - 1]) : null;
    default: return (H[key] || [])[i];
  }
}
function histText(key, v, i) {
  if (key === "date") return pretty(v);
  if (key === "state") return v;
  if (key === "spy") return fixed(v, 2);
  if (key === "spy1") return signed(v, 2, "%");
  if (key === "vix_vix3m") return fixed(v, 3);
  if (key === "t10y2y") return minus(fixed(v, 2));
  return fixed(v, 1);
}
function renderHistory() {
  const cols = histCols();
  const a = histRange === "All" ? 0 : startIndex(presetStart(histRange));
  const thead = el("thead", {}, [el("tr", {}, cols.map(([k, label]) => el("th", { scope: "col", class: k === "date" || k === "state" ? "" : "num", text: label })))]);
  const body = document.createDocumentFragment();
  for (let i = last(); i >= a; i--) {
    const st = STATES[H.state[i]];
    body.append(el("tr", { class: "st-" + st }, cols.map(([k]) => {
      const v = histValue(k, i);
      if (k === "state") return el("td", {}, [el("i", { class: "dot " + st, "aria-hidden": "true" }), v]);
      const cls = k === "date" ? "num" : "num" + (k === "spy1" && isNum(v) ? (v >= 0 ? " up" : " down") : "");
      return el("td", { class: cls, text: histText(k, v, i) });
    })));
  }
  const tb = el("tbody");
  tb.append(body);
  $("hist").replaceChildren(thead, tb);
  $("hist-cap").textContent = `${(last() - a + 1).toLocaleString("en-US")} sessions, newest first, each row shaded by its regime: green calm, amber elevated, red crisis. Percentiles are point-in-time since 2008.`;
  for (const b of document.querySelectorAll("#hist-ranges button")) b.setAttribute("aria-pressed", String(b.dataset.hrange === histRange));
}
function downloadCsv() {
  const cols = histCols();
  const rows = [cols.map(([k]) => k).join(",")];
  for (let i = 0; i <= last(); i++) {
    rows.push(cols.map(([k]) => {
      const v = histValue(k, i);
      return v == null ? "" : typeof v === "number" ? String(Number(v.toFixed(6))) : String(v);
    }).join(","));
  }
  const blob = new Blob([rows.join("\n") + "\n"], { type: "text/csv" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `regime-history-${NOW.as_of}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

// ------------------------------------------------------------------ build log
function renderLog() {
  const x = NOW;
  const rows = [
    ["Data date (last close)", withDow(x.as_of)],
    ["Built", x.generated.replace("T", " ").replace("Z", " UTC")],
    ["Build id", x.build || "—"],
    ["State", STATE_LABEL[x.state]],
    ["Days off calm", x.noncalm_days == null ? "0, the market is calm" : String(x.noncalm_days)],
    ["Sessions in the current state", String(x.days_in_state)],
    ["Earlier spells of this state since 2011", x.past_spells ? `${x.past_spells}, averaging ${Number(x.past_avg_spell).toFixed(1)} sessions` : "none"],
    ["Regime model fit through", x.fit_end],
    ["First training window ends", x.train0_end],
    ["Jump penalty", String(x.lambda)],
  ];
  if (x.model_date !== x.as_of) rows.splice(1, 0, ["Model date", pretty(x.model_date)]);
  $("log-facts").replaceChildren(
    el("h2", { text: "This build" }),
    el("dl", {}, rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])),
  );
  $("log-notes").replaceChildren(...(x.notes || []).map((t) => el("li", { text: t })));
}

// ------------------------------------------------------------------ views and wiring
function showView(id, push) {
  for (const name of VIEWS) {
    const on = name === id;
    const btn = $("tab-" + name);
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    $("view-" + name).hidden = !on;
  }
  if (id === "history" && H) renderHistory();
  if (id === "dash" && chart) requestAnimationFrame(() => applyRange(pinned));
  const hash = id === "dash" ? "" : "#" + id;
  if (push && location.hash !== hash) history.replaceState(null, "", hash || location.pathname);
}

function bindChrome() {
  for (const btn of document.querySelectorAll(".ranges button")) btn.addEventListener("click", () => applyRange(btn.dataset.range));
  for (const name of VIEWS) $("tab-" + name).addEventListener("click", () => showView(name, true));
  document.querySelector(".views").addEventListener("keydown", (e) => {
    const i = VIEWS.indexOf(document.activeElement && document.activeElement.dataset.view);
    if (i < 0) return;
    let j = i;
    if (e.key === "ArrowRight") j = (i + 1) % VIEWS.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + VIEWS.length) % VIEWS.length;
    else return;
    e.preventDefault();
    showView(VIEWS[j], true);
    $("tab-" + VIEWS[j]).focus();
  });
  for (const b of document.querySelectorAll("#hist-ranges button")) {
    b.addEventListener("click", () => { histRange = b.dataset.hrange; renderHistory(); });
  }
  $("csv").addEventListener("click", downloadCsv);
}

async function main() {
  bindChrome();
  try {
    [NOW, H] = await load();
  } catch (err) {
    fail("Could not load the data files (" + err.message + ").");
    return;
  }
  at = new Map(H.date.map((d, i) => [d, i]));
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  checkSnapshot();
  const hash = location.hash.replace("#", "");
  const start = VIEWS.includes(hash) ? hash : "dash";
  renderStamp();
  renderKpis();
  renderIndicators();
  renderTurb();
  renderTape();
  renderNext();
  renderSpells();
  renderLog();
  renderTabs();
  if (!window.LightweightCharts) fail("The chart library did not load.");
  else {
    try { buildChart(); } catch (err) { fail("The chart could not be drawn (" + err.message + ")."); console.error(err); }
  }
  showView(start, false);
  let lastW = innerWidth;
  addEventListener("resize", () => {
    if (innerWidth === lastW) return;
    lastW = innerWidth;
    clearTimeout(main.t);
    main.t = setTimeout(() => { renderTape(); }, 120);
  });
}
main();
