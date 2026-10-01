'use strict';

// 年表发布求解器。
//
// 输入：
//   events: [{ id, title }]
//   selected: Map(eventId -> { claimId, precision, startOrd, endOrd, source, label })
//   relations: [{ id, earlierId, laterId, source }]          —— 严格「先于」
//   sameDayRelations: [{ id, eventAId, eventBId, source }]   —— 「同日」（不分先后）
//
// 每个事件需在其选定主张的区间 [startOrd, endOrd] 内取一个具体日。
// 「同日」关系按连通分量折叠：同一同日连通组的所有事件共享同一个具体日期 d(G)，
// 该日期必须落在组内每个事件区间的交集 [max start, min end] 中（空交集即无解）。
// 「先于」关系先与同日关系一起折叠为组图：
//   - 环上某个多事件同日组若「离开的成员」与「回到的成员」不同（或环内含一条
//     组内不同成员间的先于边），说明该组内存在先于链 → same_day_conflict；
//   - 其余折叠环 → cycle（严格先后成环）；
//   - 无环时跨组边要求 d(H) >= d(G) + 1（组间先于至少相差一天）。
//
// 输出 { ok, dates: Map(eventId -> ord), groups: [[eventId,...]], errors: [...] }
// 错误类型：
//   missing             —— 事件缺少被选主张
//   broken_relation     —— 关系指向不存在的事件
//   same_day_conflict   —— 同一同日组内存在「先于」关系
//   same_day_interval   —— 同日组内各事件区间无公共日期
//   cycle               —— 折叠后的「先于」关系成环（Tarjan SCC，列出涉事事件与边）
//   temporal            —— 时间无解（传播后给出一条见证链，列出涉事事件与关系）

const { ordinalFromIso, isoFromOrdinal } = require('./dates');

// ---------- 同日连通组（并查集） ----------
class UnionFind {
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
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// 由事件 id 集合与同日关系构造连通组。
// 返回：
//   compOf:  Map(eventId -> 组键，组键取组内最小事件 id)
//   members: Map(组键 -> [eventId,...])（按 id 升序；单事件组也包含）
//   groups:  [[eventId,...]] 多事件组按组键升序（供 API 展示）
function buildSameDayGroups(eventIds, sameDayRelations) {
  const uf = new UnionFind(eventIds);
  for (const r of sameDayRelations) {
    if (uf.parent.has(r.eventAId) && uf.parent.has(r.eventBId)) {
      uf.union(r.eventAId, r.eventBId);
    }
  }
  const rootToMembers = new Map();
  for (const id of eventIds) {
    const root = uf.find(id);
    if (!rootToMembers.has(root)) rootToMembers.set(root, []);
    rootToMembers.get(root).push(id);
  }
  const members = new Map();
  const compOf = new Map();
  const groups = [];
  for (const list of rootToMembers.values()) {
    list.sort((a, b) => a - b);
    const key = list[0];
    members.set(key, list);
    for (const id of list) compOf.set(id, key);
    if (list.length > 1) groups.push(list);
  }
  groups.sort((a, b) => a[0] - b[0]);
  return { compOf, members, groups };
}

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
  if (errors.length) return { ok: false, dates: null, groups: [], errors };

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
  for (const r of sameDayRelations) {
    if (!byId.has(r.eventAId) || !byId.has(r.eventBId)) {
      errors.push({
        type: 'broken_relation',
        eventIds: [r.eventAId, r.eventBId].filter((id) => byId.has(id)),
        relationIds: [],
        sameDayRelationIds: [r.id],
        message: '同日关系指向了不存在的事件',
      });
    }
  }
  if (errors.length) return { ok: false, dates: null, groups: [], errors };

  // 3) 同日连通组
  const { compOf, members, groups } = buildSameDayGroups(
    events.map((e) => e.id),
    sameDayRelations
  );

  // 4) 折叠为组图，并计算每个同日组的可取值区间
  //    = 组内各事件区间交集 [max start, min end]（空交集即 same_day_interval）。
  //    「先于」边映射到组上；组内边（两端同组）成为组图自环，在第 6 步判定。
  const compIds = [...members.keys()].sort((a, b) => a - b);
  const adjC = new Map(compIds.map((k) => [k, []]));
  const incomingC = new Map(compIds.map((k) => [k, []]));
  const indegC = new Map(compIds.map((k) => [k, 0]));
  for (const r of relations) {
    const ga = compOf.get(r.earlierId);
    const gb = compOf.get(r.laterId);
    adjC.get(ga).push({ to: gb, rel: r });
    incomingC.get(gb).push({ from: ga, rel: r });
    indegC.set(gb, indegC.get(gb) + 1);
  }
  const groupStart = new Map();
  const groupEnd = new Map();
  for (const [key, list] of members) {
    let lo = -Infinity;
    let hi = Infinity;
    for (const id of list) {
      const s = selected.get(id);
      if (s.startOrd > lo) lo = s.startOrd;
      if (s.endOrd < hi) hi = s.endOrd;
    }
    groupStart.set(key, lo);
    groupEnd.set(key, hi);
    if (list.length > 1 && lo > hi) {
      const sdIds = sameDayRelations
        .filter((r) => compOf.get(r.eventAId) === key && compOf.get(r.eventBId) === key)
        .map((r) => r.id);
      // 给出交集两端的见证事件
      const startEv = list.reduce((a, b) => (selected.get(a).startOrd >= selected.get(b).startOrd ? a : b));
      const endEv = list.reduce((a, b) => (selected.get(a).endOrd <= selected.get(b).endOrd ? a : b));
      const names = list.map((id) => `「${byId.get(id).title}」`).join('、');
      errors.push({
        type: 'same_day_interval',
        eventIds: list,
        relationIds: [],
        sameDayRelationIds: sdIds,
        message:
          `同日组 ${names} 的选定主张日期区间没有公共日期：` +
          `「${byId.get(startEv).title}」最早 ${isoFromOrdinal(selected.get(startEv).startOrd)}，` +
          `而「${byId.get(endEv).title}」最晚 ${isoFromOrdinal(selected.get(endEv).endOrd)}，无法落在同一天`,
        detail: list
          .map((id) => {
            const s = selected.get(id);
            return `${byId.get(id).title} 可取 ${isoFromOrdinal(s.startOrd)} ~ ${isoFromOrdinal(s.endOrd)}`;
          })
          .join('；'),
      });
      return { ok: false, dates: null, groups, errors };
    }
  }

  // 5) 每个同日组的可取值区间 = 组内各事件区间交集 [max start, min end]
  // （已在上方第 4 步一并计算 groupStart/groupEnd 并校验空交集）

  // 6) 折叠组图成环检测（Tarjan SCC + 一条见证环）。
  //    环上某个多事件同日组若「离开组的事件」与「回到组的事件」不是同一成员
  //    （或环内含一条组内不同成员间的先于边），说明该组内存在先于链
  //    ——同组事件互为先后 → same_day_conflict；否则只是组间折叠成环 → cycle。
  const adjSimple = new Map();
  for (const [k, list] of adjC) adjSimple.set(k, list.map((x) => x.to));
  const cycle = findCycleSCC(compIds, adjSimple);
  if (cycle) {
    const nodeComps = cycle;
    const compSet = new Set(nodeComps);
    const nodeIds = nodeComps.flatMap((k) => members.get(k));
    const edgeRels = relations.filter(
      (r) => compSet.has(compOf.get(r.earlierId)) && compSet.has(compOf.get(r.laterId))
    );
    const sdIds = sameDayRelations
      .filter((r) => compSet.has(compOf.get(r.eventAId)) && compSet.has(compOf.get(r.eventBId)))
      .map((r) => r.id);

    const witness = cycleWitness(nodeComps, adjC);
    const witnessRels = witness ? witness.rels : edgeRels;
    const witnessCompChain = witness ? witness.compChain : nodeComps;

    // 在见证环上寻找「组内先于链」所落在的同日组
    let conflictGroupKey = null;
    if (witness) {
      // 情况 a：环上有组内不同成员间的先于边（折叠图自环）
      for (const r of witness.rels) {
        const g = compOf.get(r.earlierId);
        if (g === compOf.get(r.laterId) && r.earlierId !== r.laterId) {
          conflictGroupKey = g;
          break;
        }
      }
      // 情况 b：环从组的某成员离开、回到同组另一个成员
      if (conflictGroupKey === null) {
        for (let i = 0; i < witness.rels.length; i += 1) {
          const leaveRel = witness.rels[i];
          const enterRel = witness.rels[(i - 1 + witness.rels.length) % witness.rels.length];
          const g = compOf.get(leaveRel.earlierId);
          if (members.get(g).length > 1 && leaveRel.earlierId !== enterRel.laterId) {
            conflictGroupKey = g;
            break;
          }
        }
      }
    }

    if (conflictGroupKey !== null) {
      const groupEventIds = members.get(conflictGroupKey);
      errors.push({
        type: 'same_day_conflict',
        eventIds: Array.from(new Set([...groupEventIds, ...nodeIds])),
        relationIds: witnessRels.map((r) => r.id),
        sameDayRelationIds: collectGroupSameDayIds([conflictGroupKey], compOf, sameDayRelations),
        message:
          `同日组（${groupEventIds.map((id) => byId.get(id).title).join('、')}）内存在「先于」链：` +
          '同日事件必须共享同一日期，不能在组内再分先后',
        detail: witnessRels
          .map((r) => `${byId.get(r.earlierId).title} 先于 ${byId.get(r.laterId).title}${r.source ? `（出处：${r.source}）` : ''}`)
          .join('；'),
      });
      return { ok: false, dates: null, groups, errors };
    }

    errors.push({
      type: 'cycle',
      eventIds: nodeIds,
      relationIds: witnessRels.map((r) => r.id),
      sameDayRelationIds: sdIds,
      message: `折叠同日组后的「先于」关系成环：${witnessCompChain
        .map((k) => {
          const list = members.get(k);
          return list.length > 1
            ? `同日组（${list.map((id) => byId.get(id).title).join('、')}）`
            : byId.get(list[0]).title;
        })
        .join(' → ')}`,
      detail: witnessRels
        .map((r) => `${byId.get(r.earlierId).title} 先于 ${byId.get(r.laterId).title}${r.source ? `（出处：${r.source}）` : ''}`)
        .join('；'),
    });
    return { ok: false, dates: null, groups, errors };
  }

  // 7) 组图拓扑（成环已在第 6 步返回，此处必为 DAG）+ 下界传播。
  //    lower[H] = max( 组区间起点H, 对每条 G->H: lower[G] + 1 )
  //    若 lower[H] > 组区间终点H，则无解。
  const queue = compIds.filter((k) => indegC.get(k) === 0);
  const order = [];
  while (queue.length) {
    const k = queue.shift();
    order.push(k);
    for (const { to } of adjC.get(k)) {
      indegC.set(to, indegC.get(to) - 1);
      if (indegC.get(to) === 0) queue.push(to);
    }
  }

  const lower = new Map();
  // parent[k] = { fromComp, relationId } 记录是谁把下界推上来的
  const parent = new Map();
  for (const k of order) {
    let lo = groupStart.get(k);
    let via = null;
    for (const { from, rel } of incomingC.get(k)) {
      const candidate = lower.get(from) + 1;
      if (candidate > lo) {
        lo = candidate;
        via = { fromComp: from, relationId: rel.id };
      }
    }
    lower.set(k, lo);
    if (via) parent.set(k, via);
    if (lo > groupEnd.get(k)) {
      // 回溯见证链（组件链）
      const chainComps = [k];
      const chainRels = [];
      let cur = k;
      while (parent.has(cur)) {
        const p = parent.get(cur);
        chainRels.push(p.relationId);
        chainComps.push(p.fromComp);
        cur = p.fromComp;
      }
      chainComps.reverse();
      chainRels.reverse();

      const relSet = new Map(relations.map((r) => [r.id, r]));
      const allSingleton = chainComps.every((c) => members.get(c).length === 1);

      let message;
      let detail;
      if (allSingleton) {
        const names = chainComps.map((c) => byId.get(members.get(c)[0]).title).join(' 先于 ');
        message = `时间无解：按「${names}」的先后要求，「${byId.get(members.get(k)[0]).title}」最早只能是 ${isoFromOrdinal(lo)}，已超出其选定主张「${selected.get(members.get(k)[0]).label}」的覆盖区间（止于 ${isoFromOrdinal(groupEnd.get(k))}）`;
        detail = chainRels
          .map((rid) => {
            const r = relSet.get(rid);
            return `${byId.get(r.earlierId).title} 先于 ${byId.get(r.laterId).title}${r.source ? `（出处：${r.source}）` : ''}`;
          })
          .join('；');
      } else {
        const labelOf = (c) => {
          const list = members.get(c);
          return list.length > 1
            ? `同日组（${list.map((id) => `「${byId.get(id).title}」`).join('、')}）`
            : `「${byId.get(list[0]).title}」`;
        };
        const names = chainComps.map(labelOf).join(' 先于 ');
        const targetList = members.get(k);
        const endEv = targetList.reduce((a, b) => (selected.get(a).endOrd <= selected.get(b).endOrd ? a : b));
        message = `时间无解：按「${names}」的先后要求，${labelOf(k)}最早只能是 ${isoFromOrdinal(lo)}，但其中「${byId.get(endEv).title}」选定主张最晚只到 ${isoFromOrdinal(groupEnd.get(k))}`;
        detail = chainRels
          .map((rid) => {
            const r = relSet.get(rid);
            return `${byId.get(r.earlierId).title} 先于 ${byId.get(r.laterId).title}${r.source ? `（出处：${r.source}）` : ''}`;
          })
          .join('；');
      }

      errors.push({
        type: 'temporal',
        eventIds: chainComps.flatMap((c) => members.get(c)),
        relationIds: chainRels,
        sameDayRelationIds: collectGroupSameDayIds(chainComps, compOf, sameDayRelations),
        message,
        detail,
      });
      return { ok: false, dates: null, groups, errors };
    }
  }

  // 8) 组日期展开到事件
  const dates = new Map();
  for (const [k, list] of members) {
    for (const id of list) dates.set(id, lower.get(k));
  }
  return { ok: true, dates, groups, errors: [] };
}

function collectGroupSameDayIds(compKeys, compOf, sameDayRelations) {
  const set = new Set(compKeys);
  const ids = [];
  for (const r of sameDayRelations) {
    if (set.has(compOf.get(r.eventAId)) && set.has(compOf.get(r.eventBId))) ids.push(r.id);
  }
  return ids;
}

// 在成环 SCC 的折叠组图上求一条见证环：
// 从某个组件出发沿「SCC 内部」的边回到该组件，
// 返回 { compChain: [起点,...,起点], rels:[...] }，rels[i] 对应 compChain[i] -> compChain[i+1]。
function cycleWitness(compKeys, adjC) {
  const inside = new Set(compKeys);
  for (const start of compKeys) {
    // parent 树（BFS）；只沿 SCC 内部边走，记录第一次到达每个组件所经的边
    const parent = new Map([[start, null]]);
    const queue = [start];
    let back = null; // 回到起点的闭边 { at, rel }
    while (queue.length && back === null) {
      const cur = queue.shift();
      for (const { to, rel } of adjC.get(cur)) {
        if (!inside.has(to)) continue;
        if (to === start) { back = { at: cur, rel }; break; }
        if (!parent.has(to)) {
          parent.set(to, { from: cur, rel });
          queue.push(to);
        }
      }
    }
    if (back) {
      const rels = [back.rel];
      const comps = [];
      let cur = back.at;
      while (cur !== start) {
        const p = parent.get(cur);
        rels.push(p.rel);
        comps.push(cur);
        cur = p.from;
      }
      rels.reverse();
      comps.reverse();
      return { compChain: [start, ...comps, start], rels };
    }
  }
  return null;
}

// Tarjan 强连通分量：返回包含有向环的 SCC（含自环），返回其节点键数组。
function findCycleSCC(ids, adj) {  let index = 0;
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

    for (const to of adj.get(v)) {
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
      if (comp.length > 1 || adj.get(v).some((to) => to === v)) {
        found = comp;
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

module.exports = { solve, claimToInterval, buildSameDayGroups, UnionFind };
