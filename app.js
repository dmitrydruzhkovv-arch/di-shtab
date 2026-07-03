// ШТАБ · МОСТИК — живой граф-мир из shtab.json (fetch → Cytoscape)
// Источник правды — shtab.json (редактируемый: каждый агент правит свой блок на /statusup).
// Жизнь = дыхание узлов + свет, бегущий по связям (ТЗ едет от Илона к исполнителю).
// Метрика агента = ВКЛАД В ВОРОНКУ (impact, funnel:true — главное число), файлы = черновой счётчик (output).

const SC = { core: '#8ea2c9', 'трафик': '#21e6c1', 'продукт': '#8b7dff', 'контент': '#ff5b86', 'личный': '#7a84a6' };
const STREAM_LABEL = { core: 'ядро', 'трафик': 'трафик', 'продукт': 'продукт', 'контент': 'контент', 'личный': 'личные' };
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const sv = s => `var(--s-${s})`;
const ru = v => (v == null ? '—' : Number(v).toLocaleString('ru-RU'));
const primImpact = a => (a.impact || []).find(x => x.funnel) || (a.impact || [])[0] || null;

let D = {};              // все данные в памяти
let detailEl, cy;
let breatheEls = null, flowEls = null;   // живые коллекции для анимации (по текущей линзе)
let lensIdx = 0, rafOn = false;

// ── Линзы (уровни архитектуры, переключаются ← → / 1-5) ────────
const isPart = t => t === 'part';
const LENSES = [
  {
    name: 'Живой штаб', kb: '1', cap: '<b>всё разом</b> — узлы дышат, по командным связям бежит свет активных ТЗ',
    role: () => 'focus',
    flow: e => ['orch', 'flow'].includes(e.data('etype')),
    breathe: n => n.data('kind') === 'agent'
  },
  {
    name: 'Командование', kb: '2', cap: '<b>кто кому ставит задачу</b> — Илон в центре, приказы к агентам; личные — спутники read-only',
    role: el => el.isNode() ? (el.data('kind') === 'agent' ? 'focus' : 'hide')
      : (['orch', 'ro', 'flow'].includes(el.data('etype')) ? 'focus' : 'hide'),
    flow: e => ['orch', 'flow'].includes(e.data('etype')),
    breathe: n => n.data('kind') === 'agent'
  },
  {
    name: 'Стримы', kb: '3', cap: '<b>русла потоков</b> — трафик · продукт · контент; на что делится каждый агент',
    role: el => el.isNode() ? (el.data('kind') === 'pipe' ? 'hide' : 'focus')
      : (el.data('etype') === 'sub' ? 'focus' : (['orch', 'ro'].includes(el.data('etype')) ? 'dim' : 'hide')),
    flow: () => false,
    breathe: n => n.data('kind') === 'agent'
  },
  {
    name: 'Конвейеры', kb: '4', cap: '<b>цеха производства</b> — как рождается продукт: этап → из кого → что; свет = поток по цеху',
    role: el => el.isNode() ? (['pipe', 'agent'].includes(el.data('kind')) ? 'focus' : 'hide')
      : (isPart(el.data('etype')) ? 'focus' : 'hide'),
    flow: e => isPart(e.data('etype')),
    breathe: n => n.data('kind') === 'pipe'
  },
  {
    name: 'Вклад', kb: '5', cap: '<b>вклад в воронку</b> — размер узла ∝ что двигает набор (лиды · веб на проде · уроки); клик — детали',
    role: el => el.isNode() ? (el.data('kind') === 'agent' ? 'focus' : 'hide') : 'hide',
    flow: () => false,
    breathe: () => false,
    sizeByImpact: true
  },
];

async function main() {
  let J;
  try {
    const r = await fetch('shtab.json?v=' + Date.now());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    J = await r.json();
  } catch (e) {
    document.getElementById('app').innerHTML =
      `<div class="err">Не удалось прочитать shtab.json: ${esc(e.message)}<br>
       <small>Открой через локальный сервер (Live Preview), не как file://</small></div>`;
    return;
  }

  D.meta = { updated: J.updated, phase: J.phase, week: J.week,
    mission_label: J.mission.label, mission_current: J.mission.current, mission_target: J.mission.target };
  D.mission = J.mission;
  D.unit = J.unit;
  D.agents = J.agents;
  D.agentById = Object.fromEntries(J.agents.map(a => [a.id, a]));
  D.subs = J.agents.flatMap(a => (a.subs || []).map(s => ({ ...s, agent_id: a.id })));
  D.pipes = J.pipelines;
  D.stages = J.pipelines.flatMap(p => (p.stages || []).map(s => ({ ...s, pipeline_id: p.id })));
  D.tasks = J.tasks;
  D.funnel = J.funnel;
  D.prod = J.agents.flatMap(a => (a.output || []).map(o => ({ agent_id: a.id, category: o.label, cnt: o.cnt, note: o.note || '' })));
  D.prodSum = {}; D.prod.forEach(p => D.prodSum[p.agent_id] = (D.prodSum[p.agent_id] || 0) + p.cnt);

  document.getElementById('topmeta').innerHTML =
    `<b>${esc(D.meta.phase)}</b> · нед ${esc(D.meta.week)} · обновлено ${esc(D.meta.updated)}`;

  const lensBtns = LENSES.map((l, i) =>
    `<button class="lensbtn${i === 0 ? ' on' : ''}" data-lens="${i}">${esc(l.name)}<span class="kb">${l.kb}</span></button>`).join('');

  document.getElementById('app').innerHTML = [
    hero(),
    `<section class="card graph-card"><h2>Мир штаба
       <span class="hint">← → или 1–5 · тяни · колесо — зум · клик по узлу — досье</span></h2>
       <div class="lensbar" id="lensbar">${lensBtns}</div>
       <div class="lenscap" id="lenscap">${LENSES[0].cap}</div>
       <div class="graph-layout"><div id="cy"></div><aside class="detail" id="detail"></aside></div>
     </section>`,
    `<div class="two">${card('Воронка набора', '', funnel())}${card('Доска задач', 'без имён учеников (152-ФЗ)', board())}</div>`
  ].join('');

  detailEl = document.getElementById('detail');
  animateBars();
  initGraph();
  detailAgent(D.agentById.ilon);   // по умолчанию — досье босса
}

const card = (t, h, inner) => `<section class="card"><h2>${esc(t)}${h ? `<span class="hint">${esc(h)}</span>` : ''}</h2>${inner}</section>`;

// ── Мостик-рама: миссия + KPI ─────────────────────────────────
function hero() {
  const tileHtml = D.unit.tiles.map(r => {
    const star = r.northstar ? ' <span class="star" title="North Star">★</span>' : '';
    const tgt = r.target != null ? `<div class="t">цель ${r.target}</div>` : '';
    return `<div class="tile${r.northstar ? ' ns' : ''}"><div class="k">${esc(r.label)}${star}</div>
      <div class="v"><span class="num" data-count="${r.value}">0</span>${r.unit ? `<span class="u">${esc(r.unit)}</span>` : ''}</div>${tgt}</div>`;
  }).join('');
  const prices = D.unit.prices.map(r => `${esc(r.label)} <b class="num">${ru(r.value)} ${esc(r.unit || '')}</b>`).join(' &nbsp;·&nbsp; ');
  const trend = D.mission.trend || [];
  const tmax = Math.max(...trend, 1);
  const spark = trend.map(v => `<i style="height:${Math.max(v / tmax * 100, 8)}%"></i>`).join('');
  return `<div class="hero">
    <div class="mission"><div class="mission-label">${esc(D.meta.mission_label)}</div>
      <div class="mission-num"><span class="cur num">${esc(D.meta.mission_current)}</span> → <span class="tgt num">${esc(D.meta.mission_target)}</span></div>
      <div class="mission-spark">${spark}</div>
      <div class="mission-sub">цель фазы «${esc(D.meta.phase)}» · деньги нужны сейчас</div></div>
    <div><div class="kpis">${tileHtml}</div><div class="prices">💰 ${prices}</div></div></div>`;
}

// ── Граф ──────────────────────────────────────────────────────
function initGraph() {
  const els = [];
  const COMMAND = ['atlas', 'lemma', 'metodist', 'koder', 'norma'];
  // агенты — базовый размер по роли; psize = по вкладу в воронку (линза «Вклад»)
  D.agents.forEach(a => {
    let size = 52;
    if (a.id === 'ilon') size = 76;
    else if (a.is_personal) size = 36;
    const prim = primImpact(a);
    const pv = prim ? Number(prim.value) || 0 : 0;
    const psize = Math.min(40 + Math.sqrt(pv) * 8, 92);
    const base = `${a.glyph} ${a.name}`;
    els.push({ data: { id: a.id, kind: 'agent', label: base, base, stream: a.stream, size, psize, personal: a.is_personal, status: a.status } });
  });
  // под-роли + рёбра к агенту
  D.subs.forEach((s, i) => {
    const id = 'su' + i;
    els.push({ data: { id, kind: 'sub', label: s.name, stream: D.agentById[s.agent_id].stream, sub: s } });
    els.push({ data: { id: 'se' + i, source: id, target: s.agent_id, etype: 'sub' } });
  });
  // конвейеры (узлы-ромбы) + участие агентов
  D.pipes.forEach(p => {
    const pid = 'pl_' + p.id;
    els.push({ data: { id: pid, kind: 'pipe', label: p.name, stream: p.stream, pipe: p } });
    const owners = [...new Set(D.stages.filter(s => s.pipeline_id === p.id && s.owner_id).map(s => s.owner_id))];
    owners.forEach(o => els.push({ data: { id: `pe_${o}_${p.id}`, source: o, target: pid, etype: 'part', stream: p.stream } }));
  });
  // оркестрация Илон → командные агенты (по этим связям бежит свет)
  COMMAND.forEach(a => els.push({ data: { id: 'o_' + a, source: 'ilon', target: a, etype: 'orch' } }));
  D.agents.filter(a => a.is_personal).forEach(a => els.push({ data: { id: 'r_' + a.id, source: 'ilon', target: a.id, etype: 'ro' } }));
  // активные ТЗ (status=doing) — яркий поток от Илона к исполнителю («ТЗ едет»)
  D.tasks.filter(t => t.status === 'doing' && t.owner_id && t.owner_id !== 'ilon')
    .forEach(t => els.push({ data: { id: 'tf_' + t.id, source: 'ilon', target: t.owner_id, etype: 'flow', task: t } }));

  cy = cytoscape({
    container: document.getElementById('cy'),
    elements: els,
    minZoom: 0.3, maxZoom: 2.5, wheelSensitivity: 0.2,
    style: [
      { selector: 'node', style: {
        'label': 'data(label)', 'font-size': 12.5, 'font-weight': 700, 'color': '#e9edfb',
        'text-valign': 'bottom', 'text-margin-y': 6,
        'text-outline-color': '#080b16', 'text-outline-width': 3,
        'text-wrap': 'wrap', 'text-max-width': 130
      } },
      { selector: 'node[kind="agent"]', style: {
        'width': 'data(size)', 'height': 'data(size)',
        'background-color': ele => SC[ele.data('stream')],
        'background-opacity': 0.95, 'border-width': 2, 'border-color': '#0a0e1e',
        'overlay-color': ele => SC[ele.data('stream')], 'overlay-opacity': 0, 'overlay-padding': 4,
        'font-size': 13
      } },
      { selector: 'node[id="ilon"]', style: {
        'border-width': 3, 'border-color': '#b7adff', 'font-weight': 800, 'font-size': 15,
        'overlay-color': '#8b7dff'
      } },
      { selector: 'node[?personal]', style: { 'background-opacity': 0.5, 'font-size': 11, 'color': '#9aa6c8' } },
      { selector: 'node[kind="sub"]', style: {
        'width': 18, 'height': 18, 'background-color': '#0d1226',
        'border-width': 2, 'border-color': ele => SC[ele.data('stream')],
        'font-size': 10, 'color': '#9aa6c8', 'text-outline-width': 2
      } },
      { selector: 'node[kind="pipe"]', style: {
        'shape': 'round-diamond', 'width': 54, 'height': 54, 'background-color': '#0d1226',
        'border-width': 2.5, 'border-color': ele => SC[ele.data('stream')],
        'overlay-color': ele => SC[ele.data('stream')], 'overlay-opacity': 0, 'overlay-padding': 4,
        'font-size': 12, 'font-weight': 700
      } },
      // рёбра
      { selector: 'edge', style: {
        'curve-style': 'bezier', 'width': 1.4, 'line-color': '#26305a',
        'target-arrow-color': '#26305a', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.8
      } },
      { selector: 'edge[etype="sub"]', style: { 'width': 1, 'line-color': '#1f2745', 'target-arrow-shape': 'none' } },
      { selector: 'edge[etype="part"]', style: {
        'width': 2, 'line-color': ele => SC[ele.data('stream')], 'line-style': 'dashed', 'line-dash-pattern': [4, 12],
        'target-arrow-color': ele => SC[ele.data('stream')], 'opacity': 0.75, 'line-cap': 'round'
      } },
      { selector: 'edge[etype="orch"]', style: {
        'width': 1.8, 'line-color': '#5b57c9', 'line-style': 'dashed', 'line-dash-pattern': [4, 11],
        'target-arrow-shape': 'none', 'line-cap': 'round', 'opacity': 0.85
      } },
      { selector: 'edge[etype="flow"]', style: {
        'width': 3, 'line-color': '#b7adff', 'line-style': 'dashed', 'line-dash-pattern': [3, 9],
        'target-arrow-color': '#b7adff', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9, 'line-cap': 'round'
      } },
      { selector: 'edge[etype="ro"]', style: {
        'line-style': 'dotted', 'line-color': '#2a3252', 'target-arrow-shape': 'none', 'opacity': 0.6
      } },
      // состояния линз / ховера
      { selector: '.lens-hide', style: { 'display': 'none' } },
      { selector: '.lens-dim', style: { 'opacity': 0.1 } },
      { selector: '.dim', style: { 'opacity': 0.14 } },
      { selector: '.hot', style: { 'opacity': 1 } },
    ],
    layout: { name: 'cose', animate: false, fit: true, padding: 40, nodeDimensionsIncludeLabels: true, idealEdgeLength: 115, nodeRepulsion: 11000, gravity: 0.2, numIter: 1400 }
  });

  // взаимодействие
  cy.on('tap', 'node', e => renderDetail(e.target.data(), e.target));
  cy.on('tap', e => { if (e.target === cy) { cy.elements().removeClass('dim hot'); detailAgent(D.agentById.ilon); } });
  cy.on('mouseover', 'node', e => { cy.elements().addClass('dim'); e.target.closedNeighborhood().removeClass('dim').addClass('hot'); });
  cy.on('mouseout', 'node', () => cy.elements().removeClass('dim hot'));

  // управление
  document.getElementById('lensbar').addEventListener('click', e => {
    const b = e.target.closest('.lensbtn'); if (b) setLens(+b.dataset.lens);
  });
  window.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { setLens((lensIdx + 1) % LENSES.length); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { setLens((lensIdx - 1 + LENSES.length) % LENSES.length); e.preventDefault(); }
    else if (e.key >= '1' && e.key <= String(LENSES.length)) setLens(+e.key - 1);
  });

  applyLens(0);
  startPulse();
}

// ── Линзы (уровни) ────────────────────────────────────────────
function setLens(i) {
  lensIdx = i;
  document.querySelectorAll('.lensbtn').forEach((b, j) => b.classList.toggle('on', j === i));
  document.getElementById('lenscap').innerHTML = LENSES[i].cap;
  applyLens(i);
}

function applyLens(i) {
  const L = LENSES[i];
  cy.batch(() => {
    cy.elements().removeClass('lens-hide lens-dim dim hot');
    cy.elements().forEach(el => {
      const r = L.role(el);
      if (r === 'hide') el.addClass('lens-hide');
      else if (r === 'dim') el.addClass('lens-dim');
    });
    // размер + подпись агентов: базовые или по вкладу в воронку (линза «Вклад»)
    cy.nodes('[kind="agent"]').forEach(n => {
      if (L.sizeByImpact) {
        n.style('width', n.data('psize')).style('height', n.data('psize'));
        const a = D.agentById[n.id()], prim = primImpact(a);
        n.style('label', prim ? `${n.data('base')}\n${ru(prim.value)}${prim.unit ? ' ' + prim.unit : ''} ${prim.label}` : n.data('base'));
      } else {
        n.style('width', n.data('size')).style('height', n.data('size')).style('label', n.data('base'));
      }
    });
  });
  // коллекции для анимации — только видимые
  breatheEls = cy.nodes(':visible').filter(n => L.breathe(n));
  flowEls = cy.edges(':visible').filter(e => L.flow(e));
  cy.animate({ fit: { eles: cy.elements(':visible'), padding: 42 } }, { duration: 420, easing: 'ease-in-out-cubic' });
}

// ── Жизнь: дыхание узлов + бегущий свет по связям ─────────────
function startPulse() {
  if (rafOn) return; rafOn = true;
  const loop = now => {
    const t = now / 1000;
    cy.batch(() => {
      if (breatheEls) breatheEls.forEach((n, k) => {
        const ph = 0.5 + 0.5 * Math.sin(t * 1.5 + k * 0.8);
        n.style('overlay-opacity', 0.05 + 0.16 * ph);
        n.style('overlay-padding', 3 + 8 * ph);
      });
      if (flowEls) flowEls.forEach(e => {
        const fast = e.data('etype') === 'flow' ? 2.0 : 1.0;
        e.style('line-dash-offset', -((t * 26 * fast) % 200));
      });
    });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ── Детальная панель (досье) ──────────────────────────────────
function renderDetail(d, node) {
  if (node) { cy.elements().addClass('dim'); node.closedNeighborhood().removeClass('dim'); }
  if (d.kind === 'agent') return detailAgent(D.agentById[d.id]);
  if (d.kind === 'pipe') return detailPipe(d.pipe);
  if (d.kind === 'sub') {
    const s = d.sub, a = D.agentById[s.agent_id];
    detailEl.innerHTML = `<h3>${esc(s.name)}</h3><div class="d-role">под-роль · ${esc(a.glyph)} ${esc(a.name)}</div>
      <div class="d-cap">${esc(s.caption)}</div>`;
  }
}

function detailAgent(a) {
  const imp = a.impact || [];
  const impHtml = imp.map(x => `<div class="d-stat"><b style="color:${x.funnel ? sv(a.stream) : 'var(--ink)'}">${ru(x.value)}${x.unit ? ' ' + esc(x.unit) : ''}</b><span>${esc(x.label)}${x.funnel ? ' <span style="color:' + sv(a.stream) + '">▸ воронка</span>' : ''}</span></div>`).join('');
  const out = a.output || [];
  const outHtml = out.map(o => `<div class="d-kid"><b class="num">${ru(o.cnt)}</b> <span style="color:var(--muted)">${esc(o.category || o.label)}</span>${o.note ? ` <span style="color:var(--faint)">· ${esc(o.note)}</span>` : ''}</div>`).join('');
  const kids = (a.subs || [])
    .map(s => `<div class="d-kid"><b>${esc(s.name)}</b> — ${esc(s.caption)}</div>`).join('');
  const tasks = D.tasks.filter(t => t.owner_id === a.id)
    .map(t => `<div class="d-kid"><b>${esc(t.ext_id)}</b> ${esc(t.title)} <span style="color:var(--faint)">· ${esc(t.status)}</span></div>`).join('');
  detailEl.innerHTML = `
    <h3>${esc(a.glyph)} ${esc(a.name)}</h3>
    <div class="d-role">${esc(a.role)} · стрим ${esc(STREAM_LABEL[a.stream] || a.stream)}${a.is_personal ? ' · 🔒 read-only' : ''}</div>
    <div class="d-cap">${esc(a.caption)}</div>
    ${imp.length ? `<div class="d-sec">вклад в воронку</div><div class="d-stats">${impHtml}</div>` : ''}
    <div class="d-stats"><div class="d-stat"><b style="color:var(--muted)">${a.depth_lines || 0}</b><span>строк CLAUDE.md</span></div></div>
    ${out.length ? `<div class="d-sec">черновой счётчик (файлы)</div>${outHtml}` : ''}
    ${kids ? `<div class="d-sec">на что делится</div>${kids}` : ''}
    ${tasks ? `<div class="d-sec">задачи сейчас</div>${tasks}` : ''}`;
}

function detailPipe(p) {
  const st = D.stages.filter(s => s.pipeline_id === p.id).sort((a, b) => a.ord - b.ord);
  const rows = st.map(s => {
    const o = s.owner_id ? D.agentById[s.owner_id] : null;
    const col = { ok: 'var(--ok)', live: 'var(--live)', wait: 'var(--wait)' }[s.status];
    return `<div class="d-kid"><b>${esc(o ? o.glyph + ' ' : '· ')}${esc(s.name)}</b>
      <span style="color:var(--faint)"> — ${esc(s.output)}</span>
      <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${col};margin-left:4px"></span></div>`;
  }).join('');
  detailEl.innerHTML = `<h3>◆ ${esc(p.name)}</h3><div class="d-role">конвейер · стрим ${esc(STREAM_LABEL[p.stream] || p.stream)}</div>
    <div class="d-cap">${esc(p.caption)}</div><div class="d-sec">этапы (что → из кого → что)</div>${rows}`;
}

// ── Воронка + доска (нижний операционный пояс) ────────────────
function funnel() {
  const max = Math.max(...D.funnel.map(r => r.n), 1);
  return D.funnel.map(r => `<div class="fun-row"><div class="fun-name">${esc(r.name)}</div>
    <div class="fun-track"><div class="pc-bar" data-w="${(r.n / max * 100).toFixed(1)}%" style="color:var(--s-продукт);background:var(--s-продукт)"></div></div>
    <div class="fun-n num" data-count="${r.n}">0</div></div>`).join('')
    + `<div class="fun-note">прогноз: темп появится после первого пробного</div>`;
}
function board() {
  const cols = [{ key: 'К делу', set: ['todo', 'paused'] }, { key: 'В работе', set: ['doing'] }, { key: 'Готово', set: ['done'] }];
  const colHtml = cols.map(c => {
    const list = D.tasks.filter(t => c.set.includes(t.status));
    const cards = list.map(t => {
      const o = D.agentById[t.owner_id] || {}, pause = t.status === 'paused' ? '⏸ ' : '';
      return `<div class="tcard" style="border-left-color:${sv(t.stream)}"><div class="tt">${pause}<span class="eid num">${esc(t.ext_id)}</span>${esc(t.title)}</div>
        <div class="tm"><span>${esc(o.glyph || '')}</span> ${esc(o.name || '')}<span class="dot" style="background:${sv(t.stream)}"></span> ${esc(t.stream)}</div></div>`;
    }).join('') || '<div class="fun-note">пусто</div>';
    return `<div><div class="col-head">${esc(c.key)}<span class="c num">${list.length}</span></div>${cards}</div>`;
  }).join('');
  return `<div class="board">${colHtml}</div>`;
}

// ── анимации счётчиков/баров ───────────────────────────────────
function animateBars() {
  document.querySelectorAll('[data-count]').forEach(el => {
    const to = +el.dataset.count, dur = 750, t0 = performance.now();
    const step = t => { const p = Math.min((t - t0) / dur, 1); el.textContent = ru(Math.round(to * (1 - Math.pow(1 - p, 3)))); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
  requestAnimationFrame(() => document.querySelectorAll('.pc-bar[data-w]').forEach(b => b.style.width = b.dataset.w));
}

main();
