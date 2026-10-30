const STATE_KEY = "usageState";
const SAMPLES_KEY = "usageSamples";
const ALERTS_KEY = "alertsEnabled";
const BADGE_KEY = "badgeMode";
const ICON_SHAPE_KEY = "iconShape";
const NUMBER_ALPHA_KEY = "numberAlpha";
const NUMBER_SCALE_KEY = "numberScale";
const NUMBER_DX_KEY = "numberDx";
const NUMBER_DY_KEY = "numberDy";
const BLOCKS_KEY = "usageBlocks";
const WINDOWS_KEY = "usageWindows";
const FLOG_KEY = "usageForecastLog";
const WEEKLY_KEY = "usageWeekly";
const SVG_NS = "http://www.w3.org/2000/svg";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CHART_W = 400;
const CHART_H = 190;

const ui = { tab: "window", view: "chart" };
let model = { state: {}, samples: [], now: Date.now() };

const $ = id => document.getElementById(id);
function svg(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}
function html(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
const linear = (d0, d1, r0, r1) => v => r0 + (v - d0) / (d1 - d0) * (r1 - r0);
// La API sube a saltos (el uso se actualiza al terminar cada respuesta) y graficado lectura a lectura eso se ve como
// escalones. Para el dibujo solo se conservan los puntos donde el uso sube y se unen con rectas, de modo que cada escalón
// queda como una pendiente. Si entre dos subidas pasó mucho tiempo (una pausa de verdad) se mantiene plano y la subida
// ocurre al final, para no inventar consumo gradual donde no lo hubo.
function rampSeries(points, maxRampMin = 15, jumpMin = 3) {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const last = i === points.length - 1;
    if (points[i].value === points[i - 1].value && !last) continue;
    const prev = out[out.length - 1];
    if (points[i].value !== prev.value && (points[i].ts - prev.ts) / MINUTE > maxRampMin) {
      out.push({ ts: Math.max(prev.ts, points[i].ts - jumpMin * MINUTE), value: prev.value });
    }
    out.push(points[i]);
  }
  return out;
}

const num = (n, d = 1) => n.toLocaleString(LOCALE, { minimumFractionDigits: 0, maximumFractionDigits: d });
const hourLabel = ts => `${String(new Date(ts).getHours()).padStart(2, "0")}h`;
const dayLabel = ts => new Date(ts).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" });

// ── Tooltip (un solo elemento; los textos entran por textContent) ───────────
const tip = $("tip");
function showTip(clientX, clientY, title, rows) {
  tip.replaceChildren(html("div", "t", title));
  for (const r of rows) {
    const row = html("div", "row");
    if (r.key) row.append(html("i", `k ${r.key}`));
    row.append(html("b", "", r.value), html("span", "", r.name));
    tip.append(row);
  }
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.max(4, Math.min(clientX + 12, window.innerWidth - w - 4))}px`;
  tip.style.top = `${clientY - h - 10 < 4 ? clientY + 16 : clientY - h - 10}px`;
}
const hideTip = () => { tip.hidden = true; };

// ── Resumen ─────────────────────────────────────────────────────────────────
function renderSummary() {
  const now = model.now;
  const connected = model.state.status === "connected";
  // Sin conexión no se muestran cifras viejas como si fueran actuales.
  const s = connected ? model.state : { status: model.state.status, error: model.state.error };
  $("status").textContent =
    connected ? `Conectada a Claude.ai · ${new Date(s.updatedAt).toLocaleTimeString(LOCALE)}` :
    s.status === "auth" ? "Sesión no disponible" :
    s.status === "error" ? "Error de conexión" : "Consultando…";

  const proj = projection(s, now);
  const level = levelFor(s, proj, now);
  const parts = projectionParts(s, now);
  $("percent").textContent = connected && Number.isFinite(s.utilization) ? fmtPct(s.utilization) : "—%";
  $("v-icon").textContent = parts.icon;
  $("v-text").textContent = parts.headline;
  $("detail").textContent = parts.detail;
  $("why").textContent = parts.why || "";

  const fill = $("meter-fill");
  fill.style.width = `${connected && Number.isFinite(s.utilization) ? s.utilization : 0}%`;
  fill.className = `meter-fill ${level === "danger" ? "danger" : level === "warn" ? "warn" : ""}`;
  const timeMark = $("meter-time");
  if (connected && !s.idle && Number.isFinite(s.resetsAt)) {
    const elapsed = Math.min(1, Math.max(0, 1 - (s.resetsAt - now) / WINDOW_MS));
    timeMark.style.display = "block";
    timeMark.style.left = `${elapsed * 100}%`;
    $("elapsed").textContent = `${Math.round(elapsed * 100)}%`;
  } else {
    timeMark.style.display = "none";
    $("elapsed").textContent = "—";
  }

  const hasReset = connected && Number.isFinite(s.resetsAt);
  $("reset").textContent = hasReset ? fmtClock(s.resetsAt) : "—";
  $("reset-in").textContent = hasReset ? `en ${fmtReset(s.resetsAt)}` : "";
  const f = s.forecast;
  if (f) { // motor probabilístico: probabilidad y rango en lugar de un número único
    const pct = `${Math.round(f.pHit * 100)} %`;
    $("limit").textContent = f.pHit < 0.10 ? "Improbable" : f.hitQ ? fmtClock(f.hitQ[1]) : "—";
    $("limit-in").textContent = `${pct} prob.`;
    $("rate").textContent = Number.isFinite(f.drivers.rate30) ? `${num(f.drivers.rate30)} %/h` : "—";
    $("confidence").textContent = f.drivers.active ? "activo" : Number.isFinite(f.drivers.minsSinceInc) ? `en pausa ${f.drivers.minsSinceInc} min` : "en pausa";
    $("at-reset").textContent = `~${fmtPct(f.finalQ[1], 0)}`;
    $("at-reset-sub").textContent = `${Math.round(f.finalQ[0])}–${Math.round(f.finalQ[2])} %`;
  } else {
    $("limit").textContent = proj.rising ? (proj.willHit ? fmtClock(proj.hitAt) : "No antes") : "—";
    $("limit-in").textContent = proj.rising && proj.willHit ? `en ${fmtDuration(proj.minutesToHit)}` : "";
    $("rate").textContent = Number.isFinite(proj.rate) ? `${num(proj.rate * 60)} %/h` : "—";
    $("confidence").textContent = s.idle ? "" : s.confidence || "";
    $("at-reset").textContent = Number.isFinite(proj.valueAtReset) ? `~${fmtPct(proj.valueAtReset, 0)}` : "—";
    $("at-reset-sub").textContent = "proyección";
  }
  document.querySelector(".hero").dataset.level = level;

  const weekly = $("weekly");
  weekly.replaceChildren();
  for (const w of s.weekly || []) {
    const row = html("div", "weekly-row");
    const meter = html("div", "meter");
    const f = html("div", `meter-fill ${w.utilization >= 90 ? "danger" : w.utilization >= 70 ? "warn" : ""}`);
    f.style.width = `${w.utilization}%`;
    meter.append(f);
    // Marca de tiempo transcurrido de la semana (la ventana semanal dura 7 días desde su inicio).
    if (Number.isFinite(w.resetsAt)) {
      const elapsed = Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / WEEK_MS));
      const mark = html("div", "meter-time");
      mark.style.display = "block";
      mark.style.left = `${elapsed * 100}%`;
      meter.append(mark);
      row.title = `Uso ${fmtPct(w.utilization, 0)} · tiempo transcurrido ${Math.round(elapsed * 100)} % · reinicio en ${fmtReset(w.resetsAt)}`;
      meter.setAttribute("role", "img");
      meter.setAttribute("aria-label", row.title);
    }
    row.append(html("span", "", weeklyLabel(w.key)), meter, html("span", "value", fmtPct(w.utilization, 0)));
    weekly.append(row);
  }
  weekly.hidden = !weekly.childElementCount;

  const error = $("error");
  error.hidden = connected || !s.error;
  error.textContent = s.error || "";
}

// ── Gráficos ────────────────────────────────────────────────────────────────
function emptySpec(message) {
  return { draw: host => host.append(html("div", "empty", message)), head: null, rows: [], legend: [], caption: "" };
}

// Ventana de 5 h: uso real, proyección hasta el reinicio y ritmo parejo como referencia.
function windowSpec() {
  const s = model.state, now = model.now;
  if (s.status !== "connected" || s.idle || !Number.isFinite(s.resetsAt)) {
    return emptySpec("Sin ventana activa: aparecerá cuando envíes tu próximo mensaje.");
  }
  const t0 = s.resetsAt - WINDOW_MS, t1 = s.resetsAt;
  const pts = currentWindowSamples(model.samples).filter(p => p.ts >= t0 - 2 * MINUTE);
  if (!pts.length || pts[pts.length - 1].ts < s.updatedAt - 1000) pts.push({ ts: s.updatedAt, value: s.utilization });
  const last = pts[pts.length - 1];
  const proj = projection(s, now);
  let end = null;
  // Motor probabilístico: banda p10–p90 y mediana por bloque de 10 min (calculadas por el service worker).
  const fc = s.forecast && s.forecast.engine === "prob" && s.forecast.band ? s.forecast : null;
  const bandPts = fc ? fc.band.map(([min, lo, mid, hi]) => ({ ts: fc.at + min * MINUTE, lo, mid, hi })) : null;
  if (fc) {
    end = { ts: t1, value: fc.finalQ[1], hit: false, label: `~${Math.round(fc.finalQ[1])} %` };
  } else if (Number.isFinite(s.rate) && Number.isFinite(proj.valueAtReset)) {
    end = proj.rising && proj.willHit
      ? { ts: proj.hitAt, value: 100, hit: true }
      : { ts: t1, value: proj.valueAtReset, hit: false };
  }
  const bandAt = t => {
    let i = 0;
    while (i < bandPts.length - 1 && bandPts[i + 1].ts < t) i++;
    const a = bandPts[i], b = bandPts[Math.min(i + 1, bandPts.length - 1)];
    const f = b.ts === a.ts ? 0 : Math.min(1, Math.max(0, (t - a.ts) / (b.ts - a.ts)));
    return { lo: a.lo + (b.lo - a.lo) * f, mid: a.mid + (b.mid - a.mid) * f, hi: a.hi + (b.hi - a.hi) * f };
  };
  const ref = t => Math.min(100, Math.max(0, (t - t0) / WINDOW_MS * 100));

  const valueAt = t => {
    if (bandPts && t > last.ts) {
      const b = bandAt(t);
      return { t, value: b.mid, lo: b.lo, hi: b.hi, kind: "band" };
    }
    if (end && t > last.ts) {
      const f = Math.min(1, (t - last.ts) / Math.max(1, end.ts - last.ts));
      return { t, value: last.value + (end.value - last.value) * f, kind: "proj" };
    }
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.ts - t) < Math.abs(best.ts - t)) best = p;
    return { t: best.ts, value: best.value, kind: "actual" };
  };

  const rows = [];
  if (bandPts) {
    for (const b of bandPts.slice(1).reverse()) rows.push([`${fmtClock(b.ts)} (proy.)`, `~${fmtPct(b.mid, 0)} (${Math.round(b.lo)}–${Math.round(b.hi)} %)`]);
  } else if (end) rows.push([end.hit ? `Límite · ${fmtClock(end.ts)}` : `Reinicio · ${fmtClock(end.ts)}`, `~${fmtPct(end.value, 0)} (proyección)`]);
  for (const p of pts.slice().reverse().slice(0, 120)) rows.push([new Date(p.ts).toLocaleTimeString(LOCALE), fmtPct(p.value, 1)]);

  return {
    head: ["Hora", "Uso"],
    rows,
    legend: (bandPts
      ? [{ cls: "", text: "Uso" }, { cls: "dashed", text: "Proyección" }, { cls: "band-key", text: "Rango probable" }, { cls: "ref-key", text: "Ritmo parejo" }]
      : [{ cls: "", text: "Uso" }, { cls: "dashed", text: "Proyección" }, { cls: "ref-key", text: "Ritmo parejo" }]
    ),
    caption: "",
    draw(host) {
      const m = { l: 34, r: 12, t: 24, b: 22 };
      const pw = CHART_W - m.l - m.r, ph = CHART_H - m.t - m.b;
      const x = t => Math.max(m.l, Math.min(m.l + pw, linear(t0, t1, m.l, m.l + pw)(t)));
      const y = linear(0, 100, m.t + ph, m.t);
      const root = svg("svg", { viewBox: `0 0 ${CHART_W} ${CHART_H}`, tabindex: 0, role: "img",
        "aria-label": "Uso de la ventana actual con proyección. La vista de tabla tiene los mismos datos." }, host);

      for (const v of [0, 25, 50, 75, 100]) {
        svg("line", { class: v === 0 ? "axis" : "grid", x1: m.l, x2: m.l + pw, y1: y(v), y2: y(v) }, root);
        svg("text", { class: "tick", x: m.l - 6, y: y(v) + 3.5, "text-anchor": "end" }, root).textContent = `${v}%`;
      }
      // Etiquetas de hora: extremos destacados, horas enteras entre medias.
      svg("text", { class: "tick edge", x: m.l, y: CHART_H - 6 }, root).textContent = fmtClock(t0);
      svg("text", { class: "tick edge", x: m.l + pw, y: CHART_H - 6, "text-anchor": "end" }, root).textContent = `reinicio ${fmtClock(t1)}`;
      const d = new Date(t0); d.setMinutes(0, 0, 0);
      for (let tick = d.getTime() < t0 ? d.getTime() + HOUR : d.getTime(); tick < t1; tick += HOUR) {
        const px = x(tick);
        if (px - m.l < 48 || m.l + pw - px < 80) continue;
        svg("text", { class: "tick", x: px, y: CHART_H - 6, "text-anchor": "middle" }, root).textContent = fmtClock(tick);
      }

      svg("line", { class: "ref", x1: x(t0), y1: y(0), x2: x(t1), y2: y(100) }, root);
      const shown = rampSeries(pts);
      const path = shown.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
      if (pts.length > 1) {
        svg("path", { class: "area", d: `${path}L${x(last.ts).toFixed(1)},${y(0)}L${x(pts[0].ts).toFixed(1)},${y(0)}Z` }, root);
        svg("path", { class: "line", d: path }, root);
      }
      if (bandPts) {
        const up = bandPts.map(b => `${x(b.ts).toFixed(1)},${y(b.hi).toFixed(1)}`);
        const down = bandPts.map(b => `${x(b.ts).toFixed(1)},${y(b.lo).toFixed(1)}`).reverse();
        svg("path", { class: "band", d: `M${up.join("L")}L${down.join("L")}Z` }, root);
        svg("path", { class: "proj", d: "M" + [`${x(last.ts).toFixed(1)},${y(last.value).toFixed(1)}`].concat(bandPts.slice(1).map(b => `${x(b.ts).toFixed(1)},${y(b.mid).toFixed(1)}`)).join("L") }, root);
      } else if (end) {
        svg("path", { class: "proj", d: `M${x(last.ts).toFixed(1)},${y(last.value).toFixed(1)}L${x(end.ts).toFixed(1)},${y(end.value).toFixed(1)}` }, root);
      }

      const cross = svg("line", { class: "cross", y1: m.t, y2: m.t + ph, visibility: "hidden" }, root);
      const hoverDot = svg("circle", { class: "dot", r: 4, visibility: "hidden" }, root);
      svg("circle", { class: "dot", r: 4, cx: x(last.ts), cy: y(last.value) }, root);
      if (end) {
        const endDot = svg("circle", { class: `dot ${end.hit ? "critical" : ""}`, r: 4, cx: x(end.ts), cy: y(end.value) }, root);
        const text = end.hit ? `100% · ${fmtClock(end.ts)}` : `~${fmtPct(end.value, 0)}`;
        // Motor probabilístico: punto rojo en la hora más probable de agotarlo (si se agota), solo con la hora.
        if (fc && fc.hitQ && fc.pHit >= 0.25) {
          const hx = x(fc.hitQ[1]), hy = y(100);
          const hitDot = svg("circle", { class: "dot critical", r: 4, cx: hx, cy: hy }, root);
          const hitLabel = svg("text", { class: "label", "text-anchor": "middle", x: Math.min(m.l + pw - 14, Math.max(m.l + 14, hx)), y: hy - 9 }, root); // encima del gráfico, sobre el punto
          hitLabel.textContent = fmtClock(fc.hitQ[1]);
          const why = `Si te quedas sin límite, lo más probable es a las ${fmtClock(fc.hitQ[1])} (probabilidad ${Math.round(fc.pHit * 100)} %)`;
          svg("title", {}, hitDot).textContent = why;
          svg("title", {}, hitLabel).textContent = why;
        }
        if (end.hit) { // etiqueta solo en el motor lineal; en el probabilístico el extremo ya lo dice la loseta "Al reinicio"
          const label = svg("text", { class: "label", "text-anchor": "end" }, root);
          label.textContent = end.label || `⚠ 100% · ${fmtClock(end.ts)}`;
          svg("title", {}, label).textContent = `Hora estimada en que llegarías al 100 %: ${fmtClock(end.ts)}`;
          label.setAttribute("y", y(end.value) + 4);
          label.setAttribute("x", x(end.ts) - 11);
          if (x(end.ts) - 11 - label.getComputedTextLength() < m.l + 2) {
            label.setAttribute("text-anchor", "start");
            label.setAttribute("x", x(end.ts) + 11);
          }
        }
      }

      const show = (t, clientX, clientY) => {
        const v = valueAt(t);
        cross.setAttribute("x1", x(v.t)); cross.setAttribute("x2", x(v.t)); cross.setAttribute("visibility", "visible");
        hoverDot.setAttribute("cx", x(v.t)); hoverDot.setAttribute("cy", y(v.value)); hoverDot.setAttribute("visibility", "visible");
        const rowsTip = v.kind === "band"
          ? [{ key: "dashed", value: `~${fmtPct(v.value, 0)}`, name: "Mediana" },
             { key: "band-key", value: `${Math.round(v.lo)}–${Math.round(v.hi)} %`, name: "Rango 80 %" }]
          : [v.kind === "actual"
            ? { key: "", value: fmtPct(v.value, 1), name: "Uso" }
            : { key: "dashed", value: `~${fmtPct(v.value, 1)}`, name: "Proyección" }];
        showTip(clientX, clientY, fmtClock(v.t), rowsTip.concat({ key: "ref-key", value: fmtPct(ref(v.t), 0), name: "Ritmo parejo" }));
      };
      const hide = () => {
        cross.setAttribute("visibility", "hidden"); hoverDot.setAttribute("visibility", "hidden"); hideTip();
      };
      const toTime = clientX => {
        const r = root.getBoundingClientRect();
        const px = (clientX - r.left) * CHART_W / r.width;
        return t0 + Math.min(1, Math.max(0, (px - m.l) / pw)) * WINDOW_MS;
      };
      root.addEventListener("pointermove", e => show(toTime(e.clientX), e.clientX, e.clientY));
      root.addEventListener("pointerleave", hide);
      // Teclado: mismas lecturas que con el puntero.
      const stops = pts.map(p => p.ts).concat(end ? [end.ts] : []);
      let k = stops.length - 1 - (end ? 1 : 0);
      root.addEventListener("keydown", e => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        k = Math.min(stops.length - 1, Math.max(0, k + (e.key === "ArrowRight" ? 1 : -1)));
        const r = root.getBoundingClientRect();
        show(stops[k], r.left + x(stops[k]) * r.width / CHART_W, r.top + y(valueAt(stops[k]).value) * r.height / CHART_H);
      });
      root.addEventListener("blur", hide);
    }
  };
}

function niceMax(v) {
  const need = Math.max(v, 4);
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100]) {
    if (need <= step * 4) return { max: Math.ceil(need / step) * step, step };
  }
  return { max: 100, step: 25 };
}

// Barras genéricas: una serie, color único, barra ≤ 24 px con extremo redondeado de 4 px.
function drawBars(host, items, { yMax, step, fmtTick, labelAt, seriesName, twoLine }) {
  const m = { l: 34, r: 8, t: 14, b: twoLine ? 34 : 22 };
  const pw = CHART_W - m.l - m.r, ph = CHART_H - m.t - m.b;
  const y = linear(0, yMax, m.t + ph, m.t);
  const band = pw / items.length, bw = Math.min(24, band * 0.62);
  const root = svg("svg", { viewBox: `0 0 ${CHART_W} ${CHART_H}`, role: "img",
    "aria-label": `${seriesName}. La vista de tabla tiene los mismos datos.` }, host);

  for (let v = 0; v <= yMax; v += step) {
    svg("line", { class: v === 0 ? "axis" : "grid", x1: m.l, x2: m.l + pw, y1: y(v), y2: y(v) }, root);
    svg("text", { class: "tick", x: m.l - 6, y: y(v) + 3.5, "text-anchor": "end" }, root).textContent = fmtTick(v);
  }
  items.forEach((item, i) => {
    const cx = m.l + band * (i + 0.5), x0 = cx - bw / 2;
    const top = y(Math.min(item.value, yMax)), base = y(0), h = base - top;
    const g = svg("g", { class: "bar-group" }, root);
    const hit = svg("rect", { class: "bar-hit", x: m.l + band * i, y: m.t, width: band, height: ph, tabindex: 0,
      "aria-label": `${item.title}: ${item.valueText}` }, g);
    if (h >= 1) {
      const r = Math.min(4, bw / 2, h);
      svg("path", { class: "bar", d: `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${base}Z` }, g);
    }
    if (labelAt.has(i) && h >= 1) {
      svg("text", { class: "label", x: cx, y: top - 5, "text-anchor": "middle" }, g).textContent = item.shortValue;
    }
    if (item.xlabel) svg("text", { class: "tick", x: cx, y: CHART_H - (twoLine ? 18 : 6), "text-anchor": "middle" }, g).textContent = item.xlabel;
    if (item.xsub) svg("text", { class: "tick edge", x: cx, y: CHART_H - 5, "text-anchor": "middle" }, g).textContent = item.xsub;
    const show = e => {
      const r = hit.getBoundingClientRect();
      showTip(e.clientX ?? r.left + r.width / 2, e.clientY ?? r.top, item.title, [{ key: "", value: item.valueText, name: seriesName }]);
    };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("pointerleave", hideTip);
    hit.addEventListener("blur", hideTip);
  });
}

// Puntos de uso consumidos cada hora, últimas 24 h.
function hoursSpec() {
  const buckets = hourlyConsumption(model.samples, model.now, 24);
  const total = buckets.reduce((a, b) => a + b.pp, 0);
  if (!model.samples.length || total === 0 && model.samples.length < 3) {
    return emptySpec("Aún no hay consumo registrado. Se irá llenando mientras uses Claude.");
  }
  const peak = buckets.reduce((best, b, i) => (b.pp > buckets[best].pp ? i : best), 0);
  const { max, step } = niceMax(Math.max(...buckets.map(b => b.pp)));
  const items = buckets.map((b, i) => ({
    value: b.pp,
    title: `${fmtClock(b.start)}–${fmtClock(b.start + HOUR)}`,
    valueText: `${num(b.pp)} %`,
    shortValue: num(b.pp, 0),
    xlabel: i % 4 === 0 ? hourLabel(b.start) : ""
  }));
  return {
    head: ["Hora", "Consumo"],
    rows: buckets.slice().reverse().map(b => [`${dayLabel(b.start)} ${fmtClock(b.start)}`, num(b.pp)]),
    legend: [],
    caption: `% de la ventana de 5 h consumido cada hora. Total 24 h: ${num(total)} %.`,
    draw: host => drawBars(host, items, { yMax: max, step, fmtTick: v => num(v, 0), labelAt: new Set(buckets[peak].pp > 0 ? [peak] : []), seriesName: "Consumo" })
  };
}

// Pico alcanzado en cada ventana de 5 h observada.
function windowsSpec() {
  const ws = windowSummaries(model.samples).slice(-14);
  if (!ws.length) return emptySpec("Aún no hay ventanas registradas.");
  const peakIdx = ws.reduce((best, w, i) => (w.peak > ws[best].peak ? i : best), 0);
  let lastDay = "";
  const items = ws.map(w => {
    const day = new Date(w.start).toDateString();
    const item = {
      value: w.peak,
      title: `${dayLabel(w.start)} · ${fmtClock(w.start)}–${fmtClock(w.resetsAt)}`,
      valueText: `pico ${fmtPct(w.peak, 0)}`,
      shortValue: fmtPct(w.peak, 0),
      xlabel: hourLabel(w.start),
      xsub: day !== lastDay ? new Date(w.start).toLocaleDateString(LOCALE, { weekday: "short" }) : ""
    };
    lastDay = day;
    return item;
  });
  return {
    head: ["Inicio", "Fin", "Pico"],
    rows: ws.slice().reverse().map(w => [`${dayLabel(w.start)} ${fmtClock(w.start)}`, fmtClock(w.resetsAt), fmtPct(w.peak, 0)]),
    legend: [],
    caption: "Pico de uso de cada ventana de 5 h (hora de inicio en hora local).",
    draw: host => drawBars(host, items, {
      yMax: 100, step: 25, fmtTick: v => `${v}%`, labelAt: new Set([peakIdx, ws.length - 1]), seriesName: "Uso", twoLine: true
    })
  };
}

function drawTable(host, head, rows) {
  const table = html("table");
  const tr = html("tr");
  head.forEach((h, i) => tr.append(html("th", i === head.length - 1 ? "num" : "", h)));
  const thead = html("thead");
  thead.append(tr);
  table.append(thead);
  const body = html("tbody");
  for (const row of rows) {
    const r = html("tr");
    row.forEach((cell, i) => r.append(html("td", i === row.length - 1 ? "num" : "", cell)));
    body.append(r);
  }
  table.append(body);
  const wrap = html("div", "table-wrap");
  wrap.append(table);
  host.append(wrap);
}

function renderChart() {
  const host = $("chart");
  hideTip();
  host.replaceChildren();
  const spec = ui.tab === "hours" ? hoursSpec() : ui.tab === "windows" ? windowsSpec() : windowSpec();
  if (ui.view === "table" && spec.head) drawTable(host, spec.head, spec.rows);
  else spec.draw(host);

  const legend = $("legend");
  legend.replaceChildren();
  for (const item of ui.view === "chart" ? spec.legend : []) {
    const span = html("span");
    span.append(html("i", item.cls), document.createTextNode(item.text));
    legend.append(span);
  }
  legend.hidden = !legend.childElementCount;
  $("caption").textContent = spec.caption;
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === ui.tab));
  for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === ui.view));
}

// ── Datos y ajustes ─────────────────────────────────────────────────────────
function renderAll() {
  renderSummary();
  renderChart();
}
const fmtDay = ts => new Date(ts).toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
async function load() {
  const data = await chrome.storage.local.get([STATE_KEY, SAMPLES_KEY, ALERTS_KEY, BADGE_KEY, ICON_SHAPE_KEY, NUMBER_ALPHA_KEY, NUMBER_SCALE_KEY, NUMBER_DX_KEY, NUMBER_DY_KEY, BLOCKS_KEY, WINDOWS_KEY, FLOG_KEY, WEEKLY_KEY, "appVersion", "dataSource", "claudeCodeConnected"]);
  model = { state: data[STATE_KEY] || {}, samples: unpackSamples(data[SAMPLES_KEY]), blocks: data[BLOCKS_KEY] || [], weeklyLog: data[WEEKLY_KEY] || [], now: Date.now() };
  $("icon-shape").value = ["rings", "donut", "pie1", "pie2", "pie3"].includes(data[ICON_SHAPE_KEY]) ? data[ICON_SHAPE_KEY] : "donut";
  const alpha = Math.round(Math.min(1, Math.max(0.15, Number(data[NUMBER_ALPHA_KEY]) || 0.48)) * 100);
  $("number-alpha").value = alpha;
  $("alpha-value").textContent = `${alpha} %`;
  const scale = Math.round(Math.min(1.6, Math.max(0.5, Number(data[NUMBER_SCALE_KEY]) || 1)) * 100);
  const dx = Math.round((Number(data[NUMBER_DX_KEY]) || 0) * 100), dy = Math.round((Number(data[NUMBER_DY_KEY]) || 0) * 100);
  $("number-scale").value = scale; $("number-dx").value = dx; $("number-dy").value = dy;
  updateNumberLabels();
  const score = brierScore(data[FLOG_KEY] || [], data[WINDOWS_KEY] || [], Date.now(), model.state.calib);
  $("precision").textContent = score.n >= 5
    ? `Precisión del modelo: Brier ${num(score.brier, 3)} en ${score.windows} ventanas${model.state.calib ? " (recalibrado con tus datos)" : ""}. Menor es mejor; 0,25 equivale a tirar una moneda.`
    : "Precisión del modelo: aún no hay ventanas cerradas suficientes para medirla.";
  $("alerts").checked = data[ALERTS_KEY] !== false;
  $("badge-mode").value = data[BADGE_KEY] || "pace";
  // Con Claude Code como fuente y sin conectar, la tarjeta ofrece conectar desde el propio panel.
  $("connect").hidden = !(data.dataSource === "claude-code" && !data.claudeCodeConnected && model.state.status !== "connected");
  $("app-version").textContent = data.appVersion ? `Usage Monitor v${data.appVersion}` : "";
  renderAll();
  if (!$("connect").hidden) $("error").hidden = true;      // la tarjeta ya explica qué falta
  renderIconPreview();
}
function pollNow() {
  $("chart").classList.add("loading");
  chrome.runtime.sendMessage({ type: "POLL_NOW" }, () => {
    void chrome.runtime.lastError;
    $("chart").classList.remove("loading");
    load();
  });
}

$("refresh").addEventListener("click", pollNow);
for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => { ui.tab = b.dataset.tab; renderChart(); });
for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => { ui.view = b.dataset.view; renderChart(); });
$("alerts").addEventListener("change", e => chrome.storage.local.set({ [ALERTS_KEY]: e.target.checked }));
// Vista previa del ícono con los valores actuales de las barras (sin esperar a guardar).
function updateNumberLabels() {
  $("scale-value").textContent = `${$("number-scale").value} %`;
  $("dx-value").textContent = $("number-dx").value;
  $("dy-value").textContent = $("number-dy").value;
}
function renderIconPreview() {
  const s = model.state, now = Date.now();
  const proj = projection(s, now), level = levelFor(s, proj, now);
  const text = badgeInfo(s, $("badge-mode").value, now).text || "43";    // sin número real se muestra uno de ejemplo
  const num = { scale: Number($("number-scale").value) / 100, dx: Number($("number-dx").value) / 100, dy: Number($("number-dy").value) / 100 };
  const alpha = Number($("number-alpha").value) / 100, shape = $("icon-shape").value;
  for (const [id, ink] of [["pv-light", "31,33,36"], ["pv-dark", "255,255,255"]]) {
    for (const [suffix, size] of [["", 128], ["-s", 32]]) {
      const canvas = $(id + suffix);
      drawIcon(canvas.getContext("2d"), size, iconParams(s, level, now, text, shape, ink, alpha, num));
    }
  }
}
for (const id of ["number-scale", "number-dx", "number-dy"]) {
  $(id).addEventListener("input", () => { updateNumberLabels(); renderIconPreview(); });
}
$("number-scale").addEventListener("change", e => chrome.storage.local.set({ [NUMBER_SCALE_KEY]: Number(e.target.value) / 100 }));
$("number-dx").addEventListener("change", e => chrome.storage.local.set({ [NUMBER_DX_KEY]: Number(e.target.value) / 100 }));
$("number-dy").addEventListener("change", e => chrome.storage.local.set({ [NUMBER_DY_KEY]: Number(e.target.value) / 100 }));
$("number-reset").addEventListener("click", () => {
  $("number-scale").value = 100; $("number-dx").value = 0; $("number-dy").value = 0; updateNumberLabels(); renderIconPreview();
  chrome.storage.local.set({ [NUMBER_SCALE_KEY]: 1, [NUMBER_DX_KEY]: 0, [NUMBER_DY_KEY]: 0 });
});
for (const id of ["icon-shape", "badge-mode", "number-alpha"]) $(id).addEventListener("input", renderIconPreview);
$("icon-shape").addEventListener("change", e => chrome.storage.local.set({ [ICON_SHAPE_KEY]: e.target.value }));
$("number-alpha").addEventListener("input", e => { $("alpha-value").textContent = `${e.target.value} %`; });
$("number-alpha").addEventListener("change", e => chrome.storage.local.set({ [NUMBER_ALPHA_KEY]: Number(e.target.value) / 100 }));
$("badge-mode").addEventListener("change", e => chrome.storage.local.set({ [BADGE_KEY]: e.target.value }));

$("export").addEventListener("click", () => {
  const lines = ["timestamp,uso_pct,reinicio"].concat(model.samples.map(s =>
    `${new Date(s.ts).toISOString()},${s.value},${s.resetsAt ? new Date(s.resetsAt).toISOString() : ""}`));
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = html("a");
  a.href = url;
  a.download = `usage-monitor-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("connect-btn").addEventListener("click", () => chrome.runtime.sendMessage({ type: "CONNECT_CLAUDE_CODE" }, () => { void chrome.runtime.lastError; load(); }));
$("use-web").addEventListener("click", () => chrome.runtime.sendMessage({ type: "SET_SOURCE", value: "web" }, () => { void chrome.runtime.lastError; load(); }));
$("import").addEventListener("click", () => {
  const status = $("import-status");
  status.textContent = "Elige uno o más CSV exportados desde Ajustes (lecturas, bloques o semanal)…";
  chrome.runtime.sendMessage({ type: "IMPORT_CSV" }, r => {
    void chrome.runtime.lastError;
    if (!r || r.canceled) { status.textContent = ""; return; }
    if (!r.ok) { status.textContent = `No se pudo importar: ${r.error || "error desconocido"}.`; return; }
    const s = r.summary, parts = [];
    if (s.lecturas) parts.push(`${s.lecturas} lecturas (${fmtDay(s.desde)} – ${fmtDay(s.hasta)})`);
    if (s.bloques && !s.lecturas) parts.push(`${s.bloques} bloques`);
    if (s.semanal) parts.push(`${s.semanal} ciclos semanales`);
    status.textContent = `Importado: ${parts.join(", ")}. El modelo se reajustó con el historial resultante.`;
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STATE_KEY] || changes[SAMPLES_KEY])) load();
});
setInterval(() => { model.now = Date.now(); renderSummary(); }, 15000);

load().then(() => {
  // Al abrir, refrescar si el dato tiene más de 30 s.
  if (!model.state.updatedAt || Date.now() - model.state.updatedAt > 30000) pollNow();
});
