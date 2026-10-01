'use strict';

// 年表发布求解器。
//
// 输入：
//   events: [{ id, title }]
//   selected: Map(eventId -> { claimId, precision, startOrd, endOrd, source })
//   relations: [{ id, earlierId, laterId, source }]                 —— 严格「先于」
//   sameDayRelations: [{ id, eventAId, eventBId, source }]          —— 「同日」（无向）
//
// 每个事件需在其区间 [startOrd, endOrd] 内取一个具体日：
//   每条「先于」关系 later 必须严格晚于 earlier：d(later) >= d(earlier) + 1；
//   「同日」连通组（DSU）内所有事件必须取同一个具体日（该日落在组内每条区间的交集里）；
//   「先于」要求在折叠后的组图上成立，即不同同日组之间至少相差一天。
//
// 输出 { ok, dates: Map(eventId -> ord), groups: [{root, eventIds}], errors: [...] }
// 错误类型：
//   missing            —— 事件缺少被选主张
//   broken_relation    —— 关系指向了不存在的事件（先于 / 同日）
//   same_day_before    —— 同一同日组内存在「先于」关系（含组内先于链）
//   same_day_interval  —— 同日组各事件区间交集为空（无任何共同具体日）
//   cycle              —— 折叠组图上「先于」关系成环（Tarjan SCC，列出涉事事件与边）
//   temporal           —— 时间无解（传播后给出一条见证链，列出涉事事件与关系）

const { ordinalFromIso, isoFromOrdinal } = require('./dates');

function solve(events, selected, relations, sameDayRelations = []) {
  const errors = [];

  // 1) 缺少主张
  for (const ev of events) {
    if (!selected.has(ev.id)) {
      errors.push({
        type: 'missing',
        eventIds: [ev.id],
        relationIds: [],
        sameDayRelationIds: [],
        message: `事件「${ev.title}」缺少被选定的时间主张`,
      });
    }
  }
  if (errors.length) return { ok: false, dates: null, groups: null, errors };

  const byId = new Map(events.map((e) => [e.id, e]));

  // 2) 关系合法性（指向不存在事件）
  for (const r of relations) {
    if (!byId.has(r.earlierId) || !byId.has(r.laterId)) {
      errors.push({
        type: 'broken_relation',
        eventIds: [r.earlierId, r.laterId].filter((id) => byId.has(id)),
        relationIds: [r.id],
        sameDayRelationIds: [],
        message: '先于关系指向了不存在的事件',
      });
    }
  }
  for (const s of sameDayRelations) {
    if (!byId.has(s.eventAId) || !byId.has(s.eventBId)) {
      errors.push({
        type: 'broken_relation',
        eventIds: [s.eventAId, s.eventBId].filter((id) => byId.has(id)),
        relationIds: [],
        sameDayRelationIds: [s.id],
        message: '同日关系指向了不存在的事件',
      });
    }
  }
  if (errors.length) return { ok: false, dates: null, groups: null, errors };

  // 3) 「同日」连通组（并查集）
  const dsu = new DSU(events.map((e) => e.id));
  for (const s of sameDayRelations) {
    dsu.union(s.eventAId, s.eventBId);
  }
  const groups = buildGroups(events, dsu);
  const rootOfEvent = new Map();
  for (const g of groups) for (const id of g.eventIds) rootOfEvent.set(id, g.root);

  // 4) 同一同日组内两个不同成员之间存在「先于」路径（路径可经过组外事件）：
  //    同日要求 d(u)=d(v)，先于路径要求 d(u)<d(v)，直接矛盾。
  //    典型：组内一条边 u->v；或 A 同日 C 而 A->B->C（B 在组外，折叠后成环）。
  //    仅当路径到达组内「另一个」成员时报此错；环只回到成员自身（u->x->u）
  //    的情形交给后面的组图 SCC 报「折叠后成环」。单事件组自环同理由 SCC 处理。
  const eventAdj = new Map(events.map((e) => [e.id, []]));
  for (const r of relations) eventAdj.get(r.earlierId).push({ to: r.laterId, rel: r });

  const beforeConflicts = [];
  for (const g of groups) {
    if (g.eventIds.length < 2) continue;
    const members = new Set(g.eventIds);
    let found = null;
    let prev = null;
    for (const start of g.eventIds) {
      prev = new Map(); // to -> { from, rel }
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop();
        for (const { to, rel } of eventAdj.get(cur)) {
          if (seen.has(to)) continue;
          seen.add(to);
          prev.set(to, { from: cur, rel });
          if (members.has(to) && to !== start) {
            found = { start, end: to };
            break;
          }
          stack.push(to);
        }
        if (found) break;
      }
      if (found) break;
    }
    if (found) {
      // 回溯见证链
      const chainRels = [];
      let cur = found.end;
      while (cur !== found.start) {
        const p = prev.get(cur);
        chainRels.push(p.rel);
        cur = p.from;
      }
      chainRels.reverse();
      const sdrs = sameDayRelations.filter((s) => rootOfEvent.get(s.eventAId) === g.root);
      beforeConflicts.push({ group: g, chainRels, sdrs });
    }
  }
  if (beforeConflicts.length) {
    for (const { group: g, chainRels, sdrs } of beforeConflicts) {
      errors.push({
        type: 'same_day_before',
        eventIds: g.eventIds,
        relationIds: chainRels.map((r) => r.id),
        sameDayRelationIds: sdrs.map((s) => s.id),
        message: `「同日」组内存在「先于」链：${g.eventIds.map((id) => `「${byId.get(id).title}」`).join('、')}既被要求同日，组内两个事件之间又有严格先后链，二者矛盾`,
        detail: chainRels
          .map((r) => `${byId.get(r.earlierId).title} 先于 ${byId.get(r.laterId).title}${r.source ? `（出处：${r.source}）` : ''}`)
          .join('；'),
      });
    }
    return { ok: false, dates: null, groups, errors };
  }

  // 5) 组内日期区间必须有交集：所有成员要能共享同一个具体日。
  //    组区间 = 各成员选定区间交集；下界大于上界即拒绝，
  //    并给出一对导致交集为空的见证事件。
  for (const g of groups) {
    let lo = -Infinity;
    let hi = Infinity;
    let loEvent = null;
    let hiEvent = null;
    for (const id of g.eventIds) {
      const sel = selected.get(id);
      if (sel.startOrd > lo) { lo = sel.startOrd; loEvent = id; }
      if (sel.endOrd < hi) { hi = sel.endOrd; hiEvent = id; }
    }
    if (lo > hi) {
      const sdrs = sameDayRelations.filter((s) => rootOfEvent.get(s.eventAId) === g.root);
      const selLo = selected.get(loEvent);
      const selHi = selected.get(hiEvent);
      errors.push({
        type: 'same_day_interval',
        eventIds: g.eventIds,
        relationIds: [],
        sameDayRelationIds: sdrs.map((s) => s.id),
        witnessEventIds: [loEvent, hiEvent],
        message:
          `「同日」组 ${g.eventIds.map((id) => `「${byId.get(id).title}」`).join('、')}的选定主张日期区间没有共同交集：` +
          `「${byId.get(loEvent).title}」最早只能是 ${isoFromOrdinal(lo)}（主张「${selLo.label}」止于 ${isoFromOrdinal(selLo.endOrd)}），` +
          `而「${byId.get(hiEvent).title}」最晚只能是 ${isoFromOrdinal(hi)}（主张「${selHi.label}」起于 ${isoFromOrdinal(selHi.startOrd)}），无法取同一个具体日`,
      });
    }
  }
  if (errors.length) return { ok: false, dates: null, groups, errors };

  // ---- 以下在折叠后的「同日组图」上求解 ----
  const groupById = new Map(groups.map((g) => [g.root, g]));
  const groupIds = groups.map((g) => g.root);

  // 组区间（已保证非空）
  const gStart = new Map();
  const gEnd = new Map();
  for (const g of groups) {
    let lo = -Infinity;
    let hi = Infinity;
    for (const id of g.eventIds) {
      const sel = selected.get(id);
      if (sel.startOrd > lo) lo = sel.startOrd;
      if (sel.endOrd < hi) hi = sel.endOrd;
    }
    gStart.set(g.root, lo);
    gEnd.set(g.root, hi);
  }

  // 折叠：u(earlier组) -> v(later组)。
  // 多成员同日组内边已在第 4 步拒绝；单事件组上的自环保留（交给 SCC 报「成环」）。
  const adjG = new Map(groupIds.map((r) => [r, []]));
  const incomingG = new Map(groupIds.map((r) => [r, []]));
  const indegG = new Map(groupIds.map((r) => [r, 0]));
  for (const r of relations) {
    const ga = rootOfEvent.get(r.earlierId);
    const gb = rootOfEvent.get(r.laterId);
    if (ga === gb && groupById.get(ga).eventIds.length > 1) continue;
    adjG.get(ga).push({ to: gb, rel: r });
    incomingG.get(gb).push({ from: ga, rel: r });
    indegG.set(gb, indegG.get(gb) + 1);
  }

  // 6) 折叠后成环检测
  const cycle = findCycleSCC(groupIds, adjG);
  if (cycle) {
    const { nodeIds: cycleRoots } = cycle;
    const rootSet = new Set(cycleRoots);
    const edgeRels = relations.filter((r) => {
      const ga = rootOfEvent.get(r.earlierId);
      const gb = rootOfEvent.get(r.laterId);
      if (!rootSet.has(ga) || !rootSet.has(gb)) return false;
      // 多成员组的组内边不会进入组图（已在第 4 步拒绝）；自环组边保留
      return ga !== gb || groupById.get(ga).eventIds.length === 1;
    });
    const nodeEvents = [];
    for (const rt of cycleRoots) nodeEvents.push(...groupById.get(rt).eventIds);
    const groupName = (rt) => {
      const g = groupById.get(rt);
      return g.eventIds.length === 1
        ? byId.get(rt).title
        : `同日组（${g.eventIds.map((id) => byId.get(id).title).join('＝')}）`;
    };
    errors.push({
      type: 'cycle',
      eventIds: nodeEvents,
      relationIds: edgeRels.map((r) => r.id),
      sameDayRelationIds: cycleRoots.flatMap((rt) =>
        sameDayRelations.filter((s) => rootOfEvent.get(s.eventAId) === rt).map((s) => s.id)),
      message: `「先于」关系在同日组折叠后成环：${cycleRoots.map(groupName).join(' → ')}`,
      detail: edgeRels
        .map((r) => `${byId.get(r.earlierId).title} 先于 ${byId.get(r.laterId).title}${r.source ? `（出处：${r.source}）` : ''}`)
        .join('；'),
    });
    return { ok: false, dates: null, groups, errors };
  }

  // 7) 组图上时间传播（DAG 已保证）：
  //    lower[G] = max(组区间起G, 对每条 H->G: lower[H] + 1)
  //    超过组区间终点则无解。
  const queue = groupIds.filter((r) => indegG.get(r) === 0);
  const orderG = [];
  while (queue.length) {
    const root = queue.shift();
    orderG.push(root);
    for (const { to } of adjG.get(root)) {
      indegG.set(to, indegG.get(to) - 1);
      if (indegG.get(to) === 0) queue.push(to);
    }
  }

  const lowerG = new Map();
  const parentG = new Map(); // root -> { fromRoot, relationId }
  for (const root of orderG) {
    let lo = gStart.get(root);
    let via = null;
    for (const { from, rel } of incomingG.get(root)) {
      const candidate = lowerG.get(from) + 1;
      if (candidate > lo) {
        lo = candidate;
        via = { fromRoot: from, relationId: rel.id };
      }
    }
    lowerG.set(root, lo);
    if (via) parentG.set(root, via);
    if (lo > gEnd.get(root)) {
      // 回溯见证链（以组为节点）
      const chainRoots = [root];
      const chainRels = [];
      let cur = root;
      while (parentG.has(cur)) {
        const p = parentG.get(cur);
        chainRels.push(p.relationId);
        chainRoots.push(p.fromRoot);
        cur = p.fromRoot;
      }
      chainRoots.reverse();
      chainRels.reverse();
      const relSet = new Map(relations.map((r) => [r.id, r]));

      // 见证链展平到事件：每组取该组与相邻先于边相连的端点事件，使阅读连续
      const chainEvents = [];
      for (let i = 0; i < chainRoots.length; i++) {
        const rt = chainRoots[i];
        let pick = rt;
        if (i < chainRoots.length - 1) {
          const r = relSet.get(chainRels[i]);
          pick = rootOfEvent.get(r.earlierId) === rt ? r.earlierId : r.laterId;
        } else {
          const r = relSet.get(chainRels[i - 1]);
          pick = rootOfEvent.get(r.laterId) === rt ? r.laterId : r.earlierId;
        }
        chainEvents.push(pick);
      }

      const names = chainEvents.map((eid) => byId.get(eid).title).join(' 先于 ');
      // 以该组内下界最紧的事件主张描述超出的覆盖区间
      const witnessEvent = gEndWitnessEvent(groupById.get(root), selected, gEnd);
      const selWitness = selected.get(witnessEvent);
      errors.push({
        type: 'temporal',
        eventIds: chainEvents,
        relationIds: chainRels,
        sameDayRelationIds: chainRoots.flatMap((rt) =>
          sameDayRelations.filter((s) => rootOfEvent.get(s.eventAId) === rt).map((s) => s.id)),
        message:
          `时间无解：按「${names}」的先后要求，同日组 ${groupById.get(root).eventIds.map((id) => `「${byId.get(id).title}」`).join('、')}` +
          `最早只能是 ${isoFromOrdinal(lo)}，已超出该组共同可取日期区间（止于 ${isoFromOrdinal(gEnd.get(root))}；` +
          `如「${byId.get(witnessEvent).title}」选定主张「${selWitness.label}」）`,
        detail: chainRels
          .map((rid) => {
            const r = relSet.get(rid);
            return `${byId.get(r.earlierId).title} 先于 ${byId.get(r.laterId).title}${r.source ? `（出处：${r.source}）` : ''}`;
          })
          .join('；'),
      });
      return { ok: false, dates: null, groups, errors };
    }
  }

  // 8) 组成员共享组日期
  const dates = new Map();
  for (const g of groups) {
    for (const id of g.eventIds) dates.set(id, lowerG.get(g.root));
  }
  return { ok: true, dates, groups, errors: [] };
}

// 组内区间终点最小（决定组共同区间上界）的事件，用于错误信息举例
function gEndWitnessEvent(group, selected, gEnd) {
  let pick = group.eventIds[0];
  for (const id of group.eventIds) {
    if (selected.get(id).endOrd === gEnd.get(group.root)) { pick = id; break; }
  }
  return pick;
}

// ---------- 并查集与组 ----------
class DSU {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }
  find(x) {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // 以较小 id 为根，保证稳定
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

function buildGroups(events, dsu) {
  const map = new Map();
  for (const ev of events) {
    const root = dsu.find(ev.id);
    if (!map.has(root)) map.set(root, []);
    map.get(root).push(ev.id);
  }
  // 组按根（即最小事件 id）升序；组内事件 id 升序
  return [...map.entries()]
    .map(([root, ids]) => ({ root, eventIds: ids.slice().sort((a, b) => a - b) }))
    .sort((a, b) => a.root - b.root);
}

// Tarjan 强连通分量：返回包含有向环的 SCC（含自环）。
function findCycleSCC(ids, adj) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  let found = null;

  const strongConnect = (v) => {
    if (found) return;
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const { to } of adj.get(v)) {
      if (!idx.has(to)) {
        strongConnect(to);
        if (found) return;
        low.set(v, Math.min(low.get(v), low.get(to)));
      } else if (onStack.has(to)) {
        low.set(v, Math.min(low.get(v), idx.get(to)));
      }
    }

    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      // SCC 内多于 1 个节点即有环；单节点检查自环
      if (comp.length > 1 || adj.get(v).some((e) => e.to === v)) {
        found = { nodeIds: comp };
      }
    }
  };

  for (const id of ids) {
    if (!idx.has(id)) {
      strongConnect(id);
      if (found) break;
    }
  }
  return found;
}

// 由数据库主张行构造求解器输入项
function claimToInterval(claim) {
  const start = ordinalFromIso(claim.interval_start);
  const end = ordinalFromIso(claim.interval_end);
  return {
    claimId: claim.id,
    startOrd: start,
    endOrd: end,
    source: claim.source || '',
    label: claim.date_label,
  };
}

module.exports = { solve, claimToInterval, DSU, buildGroups };
