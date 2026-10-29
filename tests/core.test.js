// Lógica pura del motor lineal y del veredicto (core.js). Hereda de la suite antigua; sin extensión ni service worker.
const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./load');
const m = load();
const MIN = 60000;
const S = (minAgo, value, r) => ({ ts: Date.now() - minAgo * MIN + 1000, value, resetsAt: r || null });

test('motor lineal, formatos y consumo por hora', () => {
  // ── Puro ──
  const R1 = Date.now() + 60 * MIN, R2 = R1 + 300 * MIN;
  // reset detectado por caída o por cambio de resetsAt
  assert(m.isReset(S(1, 90, R1), S(0, 2, R1)));
  assert(m.isReset(S(1, 50, R1), S(0, 52, R2)));
  assert(!m.isReset(S(1, 50, R1), S(0, 52, R1 + 5000)));
  // ventana actual tras reset: estimador no ve caída
  const hist = [S(60, 90, R1), S(59, 92, R1), S(58, 94, R1), S(5, 1, R2), S(4, 2, R2), S(3, 3, R2), S(2, 4, R2), S(1, 5, R2)];
  assert.strictEqual(m.currentWindowSamples(hist).length, 5);
  const est = m.estimate(m.currentWindowSamples(hist), Date.now(), 5);
  assert(est.rate > 0.5, JSON.stringify(est));
  // compactación: > 6h se adelgaza y conserva el pico antes del reset
  const old = [];
  for (let i = 0; i < 60; i++) old.push(S(600 - i, i < 40 ? i * 2 : 79 + 0, R1 - 20 * 3600e3));
  const c = m.compactSamples(old, Date.now());
  assert(c.length < 12 && c.length > 3, c.length);
  assert.strictEqual(Math.max(...c.map(s => s.value)), 79);
  // proyección
  const base = { utilization: 60, rate: 1, updatedAt: Date.now(), resetsAt: Date.now() + 100 * MIN };
  let p = m.projection(base); assert(p.willHit && Math.round(p.minutesToHit) === 40 && p.valueAtReset === 100);
  p = m.projection({ ...base, rate: 0.2 }); assert(!p.willHit && Math.round(p.valueAtReset) === 80);
  p = m.projection({ ...base, rate: 0 }); assert(!p.rising && p.valueAtReset === 60);
  // badge
  const b = mode => m.badgeInfo({ status: 'connected', ...base }, mode);
  assert.strictEqual(b('percent').text, '60'); assert.strictEqual(b('limit').text, '40m');
  assert.strictEqual(b('reset').text, '1h40'); assert.strictEqual(b('percent').level, 'danger'); // se queda sin límite 60 min antes del reinicio
  assert.strictEqual(m.badgeInfo({ status: 'auth' }, 'percent').text, '?');
  assert.strictEqual(m.badgeInfo({ status: 'connected', idle: true, utilization: 0 }, 'limit').text, '');
  assert.strictEqual(m.fmtShort(125), '2h05'); assert.strictEqual(m.fmtShort(660), '11h'); assert.strictEqual(m.fmtShort(0.2), '0m');
  assert(m.tooltipText({ status: 'connected', ...base, weekly: [{ key: 'seven_day', utilization: 41 }] }).includes('Semanal: 41%'));
  // consumo por hora y ventanas
  const d = new Date(); d.setMinutes(30, 0, 0); const h0 = d.getTime();
  const hs = [{ ts: h0 - 3600e3, value: 10, resetsAt: R1 }, { ts: h0 - 3000e3, value: 18, resetsAt: R1 }, { ts: h0 - 60e3, value: 30, resetsAt: R1 }];
  const hc = m.hourlyConsumption(hs, h0 + 1000, 24); assert.strictEqual(hc.length, 24);
  assert(Math.abs(hc.reduce((a, x) => a + x.pp, 0) - 20) < 1e-9);
  const ws = m.windowSummaries(hist); assert.strictEqual(ws.length, 2); assert.strictEqual(ws[0].peak, 94); assert.strictEqual(ws[1].peak, 5);
  assert.strictEqual(m.migrateLegacy({ '1700000000000': 5, bad: 3 }).length, 1);
});

test('veredicto del ícono con ritmo lineal', () => {
  const live = (u, rate, resetMin) => ({ status: 'connected', utilization: u, rate, updatedAt: Date.now(), resetsAt: Date.now() + resetMin * MIN, sampleCount: 20 });
  const pace = st => m.badgeInfo(st, 'pace');
  // ── Poco uso: sin alarmas rojas ──
  // 15 % tras 60 min con una ráfaga (1.5 pp/min): ámbar, sin cuenta atrás, texto prudente
  const burst = live(15, 1.5, 240);
  assert.deepStrictEqual(pace(burst), { level: 'warn', text: '15' });
  assert.strictEqual(m.projectionParts(burst).headline, 'Ritmo alto');
  assert(m.projectionParts(burst).detail.includes('Aún es pronto'));
  // el ritmo amortiguado nunca supera al reciente y baja hacia el promedio con poco uso
  const er = m.effectiveRate(burst, burst.updatedAt); assert(er < 1.5 && er > 0.25, er);
  // si dejaste de usar Claude (ritmo reciente 0) la proyección se apaga, aunque el promedio sea alto
  assert.strictEqual(m.effectiveRate(live(20, 0, 240), Date.now()), 0);
  assert.strictEqual(pace(live(20, 0, 240)).text, '');
  // ritmo suave con 15 %: verde
  assert.strictEqual(pace(live(15, 0.1, 240)).text, '');
  // pasado el umbral el mismo ritmo sí es rojo
  assert.strictEqual(pace(live(35, 1.5, 120)).level, 'danger');
  // sin alerta anticipada con poco uso
  // ── Veredicto del ícono ──
  // seguro: 30 % a +0.12 pp/min con 95 min → ~41 %
  assert.deepStrictEqual(pace(live(30, 0.12, 95)), { level: 'ok', text: '' });
  // se queda sin límite: 60 % a 1 pp/min → 100 % en 40 min; reinicio en 100 → 60 min bloqueado
  assert.deepStrictEqual(pace(live(60, 1, 100)), { level: 'danger', text: '-60m' });
  // bloqueado muy poco (≤ 15 min) → justo
  assert.deepStrictEqual(pace(live(60, 1, 50)), { level: 'warn', text: '-10m' });
  // bloqueado horas → formato en horas
  assert.strictEqual(pace(live(50, 5, 300)).text, '-5h');
  // termina por encima de 90 % sin llegar a 100 → justo, muestra el % final
  assert.deepStrictEqual(pace(live(80, 0.2, 60)), { level: 'warn', text: '~92' });
  // sin ritmo calculable → solo porcentaje, color neutro
  assert.deepStrictEqual(pace({ ...live(40, null, 95), rate: null }), { level: 'unknown', text: '40' });
  // ritmo plano y bajo → OK
  assert.strictEqual(pace(live(40, 0, 95)).text, '');
  // ≥ 95 % siempre rojo; 90-95 % nunca verde
  assert.strictEqual(pace(live(96, 0, 95)).level, 'danger'); assert.strictEqual(pace(live(91, 0, 95)).level, 'warn');
  // el mensaje habla del veredicto
  const pt = m.projectionParts(live(60, 1, 100)); assert(pt.headline.startsWith('Sin límite a las') && pt.detail.includes('antes del reinicio') && pt.icon === '⚠');
  assert.strictEqual(m.projectionParts(live(30, 0.12, 95)).headline, 'Vas bien');
  assert.strictEqual(m.verdict(live(30, 0.12, 95)).icon, '✔');
  assert.strictEqual(m.projectionParts({status:'auth'}).headline,'Inicia sesión en Claude.ai');
  assert.strictEqual(m.projectionParts({status:'connected',utilization:5,rate:null,resetsAt:Date.now()+1e6,updatedAt:Date.now()}).headline,'Recopilando datos…');
});
