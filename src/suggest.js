'use strict';

// 改选建议（只读）。
//
// 当发布预检出现「时间无解」时，在
//   - 不改变任何「先于」关系与「同日」关系；
//   - 不改变主张的覆盖区间（只能在各事件的现有主张里另选一条）
// 的前提下，求一个可行组合，并满足：
//   1. 改选事件数最少；
//   2. 平手时取「按事件 ID 排序后的主张 ID 序列」字典序最小。
//
// 「同日」连通组内每个事件仍各选一条主张，但全组必须共享同一个具体日：
// 组的可行候选是各成员候选主张的笛卡尔积中、区间交集非空者；
// 「先于」关系在折叠后的组图上按严格相差至少一天传播。
//
// 无法靠改选解决的情形（HTTP 422 UNRESOLVABLE_BY_RESELECTION）：
//   cycle / same_day_before —— 先于成环 / 同日组内先于（换主张不能消除）
//   event_without_claims    —— 有事件一条主张都没有
//   no_feasible_combination —— 现有主张的全部组合都不满足关系
//
// 请求本身不合法（HTTP 400 SELECTION_INVALID）：选择缺失、事件重复、
// 主张不存在或不属于该事件、事件 id 不存在。
//
// 草稿修订号对不上（HTTP 409 DRAFT_REVISION_STALE）：不返回建议，重新预检。
//
// 本模块不执行任何写库操作，不推进草稿修订号，不触碰发布版本。

const { getDb } = require('./db');
const { solve, claimToInterval, DSU, buildGroups } = require('./solver');
const { isoFromOrdinal } = require('./dates');
const { getDraftRevision } = require('./draft');

// 组合搜索的节点上限：本地小团队年表规模下远不会触达；
// 触达则不返回未经证明为最优的建议，而是 422 SEARCH_LIMIT。
const SEARCH_NODE_BUDGET = 1_000_000;

function httpError(status, body) {
  throw Object.assign({ status }, body);
}

function staleError(submitted, current) {
  return {
    status: 409,
    code: 'DRAFT_REVISION_STALE',
    message:
      `草稿修订号已变化（提交的是 #${submitted}，当前为 #${current}），` +
      '该改选建议可能已过期。请重新执行发布预检后再查看建议，本次不返回建议。',
    submittedDraftRevision: submitted,
    currentDraftRevision: current,
  };
}

// selectionList: [{eventId, claimId}]（路由层已保证为整数对）
function suggestReselection({ selectionList, draftRevision }) {
  // ---- 修订号：开始前先对一次，结束后再对一次（防「计算期间草稿变化」）----
  const revisionAtStart = getDraftRevision();
  if (draftRevision !== revisionAtStart) {
    httpError(409, staleError(draftRevision, revisionAtStart));
  }

  const db = getDb();
  const events = db.prepare('SELECT id, title FROM events ORDER BY id').all();
  const claimRows = db.prepare('SELECT * FROM claims ORDER BY id').all();
  const relations = db
    .prepare('SELECT id, earlier_id AS earlierId, later_id AS laterId, source, note FROM relations ORDER BY id')
    .all();
  const sameDayRelations = db
    .prepare('SELECT id, event_a_id AS eventAId, event_b_id AS eventBId, source, note FROM same_day_relations ORDER BY id')
    .all();

  const eventById = new Map(events.map((e) => [e.id, e]));
  const claimById = new Map(claimRows.map((c) => [c.id, c]));
  const claimsByEvent = new Map(events.map((e) => [e.id, []]));
  for (const c of claimRows) {
    if (claimsByEvent.has(c.event_id)) claimsByEvent.get(c.event_id).push(c);
  }

  // ---- 1) 选择结构校验：重复 / 缺失 ----
  const seen = new Set();
  const duplicateEventIds = [];
  for (const item of selectionList) {
    if (seen.has(item.eventId)) duplicateEventIds.push(item.eventId);
    seen.add(item.eventId);
  }
  const missingEventIds = events.filter((e) => !seen.has(e.id)).map((e) => e.id);
  if (duplicateEventIds.length || missingEventIds.length) {
    httpError(400, {
      code: 'SELECTION_INVALID',
      message: '逐事件选择不完整：每个事件必须恰好出现一次（不能缺失或重复）。',
      missingEventIds,
      duplicateEventIds: [...new Set(duplicateEventIds)],
      invalidSelections: [],
    });
  }

  // ---- 2) 有事件一条主张都没有：改选无从改起 ----
  const noClaimEventIds = events.filter((e) => claimsByEvent.get(e.id).length === 0).map((e) => e.id);
  if (noClaimEventIds.length) {
    httpError(422, {
      code: 'UNRESOLVABLE_BY_RESELECTION',
      reason: 'event_without_claims',
      message:
        `事件 ${noClaimEventIds.map((id) => `「${eventById.get(id).title}」`).join('、')}没有任何时间主张，` +
        '改选只能在各事件现有主张中进行，无法靠改选解决；请先为其补录主张或调整先于关系。',
      eventIds: noClaimEventIds,
      relationIds: [],
    });
  }

  // ---- 3) 归属校验：主张不存在 / 不属于该事件 / 事件不存在 ----
  const invalidSelections = [];
  for (const item of selectionList) {
    if (!eventById.has(item.eventId)) {
      invalidSelections.push({ eventId: item.eventId, claimId: item.claimId, reason: 'event_not_found' });
      continue;
    }
    const c = claimById.get(item.claimId);
    if (!c) {
      invalidSelections.push({ eventId: item.eventId, claimId: item.claimId, reason: 'claim_not_found' });
    } else if (c.event_id !== item.eventId) {
      invalidSelections.push({
        eventId: item.eventId,
        claimId: item.claimId,
        reason: 'claim_belongs_to_other_event',
        actualEventId: c.event_id,
      });
    }
  }
  if (invalidSelections.length) {
    httpError(400, {
      code: 'SELECTION_INVALID',
      message: '存在不属于对应事件（或已删除）的被选主张，已拒绝；请按预检时的草稿逐事件重新选择。',
      missingEventIds: [],
      duplicateEventIds: [],
      invalidSelections,
    });
  }

  const currentClaim = new Map(selectionList.map((i) => [i.eventId, i.claimId]));
  const currentIntervals = new Map(
    selectionList.map((i) => [i.eventId, claimToInterval(claimById.get(i.claimId))])
  );

  // ---- 4) 成环 / 同日组内先于 / 关系指向失效不随主张选择改变，先于求解判定 ----
  const probe = solve(events, currentIntervals, relations, sameDayRelations);
  if (!probe.ok) {
    const err = probe.errors[0];
    if (err.type === 'cycle' || err.type === 'broken_relation' || err.type === 'same_day_before') {
      const reasonText =
        err.type === 'cycle' ? '「先于」关系在同日组折叠后成环'
        : err.type === 'same_day_before' ? '同一「同日」组内存在「先于」关系'
        : '关系指向了不存在的事件';
      httpError(422, {
        code: 'UNRESOLVABLE_BY_RESELECTION',
        reason: err.type,
        message: `${reasonText}，改选主张不能消除该问题：${err.message}`,
        eventIds: err.eventIds,
        relationIds: err.relationIds,
        sameDayRelationIds: err.sameDayRelationIds || [],
        detail: err.detail || '',
        errors: probe.errors,
      });
    }
    // temporal / same_day_interval：正是要搜索改选的情形；
    // missing 在上面校验后理论上不会出现
  }

  // 每事件候选（claims ORDER BY id，故按主张 id 升序）
  const candidates = new Map(
    events.map((e) => [e.id, claimsByEvent.get(e.id).map(claimToInterval)])
  );

  // ---- 5) 分支限界搜索（同日组为单位选组内组合，组间按严格先后传播） ----
  const { assignment, count, limited } = searchFeasibleAssignment({
    events,
    relations,
    sameDayRelations,
    candidates,
    currentClaim,
  });

  if (limited) {
    httpError(422, {
      code: 'SEARCH_LIMIT',
      reason: 'search_limit',
      message:
        `候选组合过多（搜索超过 ${SEARCH_NODE_BUDGET} 个分支仍无法证明最优改选），` +
        '请先缩减互相矛盾的主张或先于关系后重试。',
      eventIds: [],
      relationIds: [],
    });
  }

  if (!assignment) {
    httpError(422, {
      code: 'UNRESOLVABLE_BY_RESELECTION',
      reason: 'no_feasible_combination',
      message:
        '在各事件的现有主张内任意改选，都找不到满足全部「先于」与「同日」关系的具体日期组合；' +
        '无法靠改选解决，请为相关事件补录更早 / 更晚或区间相容的主张，或调整关系。',
      eventIds: [],
      relationIds: relations.map((r) => r.id),
      sameDayRelationIds: sameDayRelations.map((s) => s.id),
    });
  }

  // ---- 6) 用正式求解器复核组合并取得权威求解日期 ----
  const chosenIntervals = new Map(
    events.map((e) => [e.id, candidates.get(e.id).find((c) => c.claimId === assignment.get(e.id))])
  );
  const verified = solve(events, chosenIntervals, relations, sameDayRelations);
  if (!verified.ok) {
    // 理论不可达：搜索到的组合必然可行
    httpError(422, {
      code: 'UNRESOLVABLE_BY_RESELECTION',
      reason: 'no_feasible_combination',
      message: '改选组合复核失败，无法靠改选解决。',
      eventIds: [],
      relationIds: relations.map((r) => r.id),
      sameDayRelationIds: sameDayRelations.map((s) => s.id),
    });
  }

  // ---- 7) 计算期间草稿若被改动，不返回过期建议 ----
  const revisionAtEnd = getDraftRevision();
  if (revisionAtEnd !== revisionAtStart) {
    httpError(409, staleError(draftRevision, revisionAtEnd));
  }

  return buildResponse({
    events,
    relations,
    claimById,
    currentClaim,
    assignment,
    dates: verified.dates,
    changedEventCount: count,
    draftRevision: revisionAtEnd,
  });
}

// ---------- 分支限界搜索 ----------
//
// 以「同日」连通组为单位：每个组枚举组内各事件候选主张的组合，
// 仅保留区间交集非空（能共享同一具体日）的组合为组的候选；
// 组图上每条先于边要求 later 组日期 >= earlier 组日期 + 1：
//   lo(G) = max(组区间起, 对每条 H->G: lo(H) + 1)，超过组区间终点则该候选不可行。
// 最小化「与当前选择不同的事件数」；平手按事件 ID 升序的主张 ID 序列字典序。
function searchFeasibleAssignment({ events, relations, sameDayRelations = [], candidates, currentClaim }) {
  // 同日连通组
  const dsu = new DSU(events.map((e) => e.id));
  for (const s of sameDayRelations) {
    if (candidates.has(s.eventAId) && candidates.has(s.eventBId)) dsu.union(s.eventAId, s.eventBId);
  }
  const groups = buildGroups(events, dsu);
  const rootOfEvent = new Map();
  for (const g of groups) for (const id of g.eventIds) rootOfEvent.set(id, g.root);

  // 组图邻接 / 入边（组内先于边已在求解器前置校验中拦截）
  const groupIds = groups.map((g) => g.root);
  const adj = new Map(groupIds.map((r) => [r, []]));
  const indeg = new Map(groupIds.map((r) => [r, 0]));
  const incoming = new Map(groupIds.map((r) => [r, []]));
  for (const r of relations) {
    if (!rootOfEvent.has(r.earlierId) || !rootOfEvent.has(r.laterId)) continue;
    const ga = rootOfEvent.get(r.earlierId);
    const gb = rootOfEvent.get(r.laterId);
    if (ga === gb) continue;
    adj.get(ga).push(gb);
    indeg.set(gb, indeg.get(gb) + 1);
    incoming.get(gb).push({ from: ga, rel: r });
  }

  // Kahn 拓扑
  const queue = groupIds.filter((r) => indeg.get(r) === 0);
  const topo = [];
  while (queue.length) {
    const root = queue.shift();
    topo.push(root);
    for (const to of adj.get(root)) {
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }

  // 每个组的候选：{ memberClaims: Map(eventId -> claim), lo0(组区间起), hi(组区间止), changeCount }
  // 组内按事件 id 升序枚举各成员候选（候选列表本身按主张 id 升序）。
  function buildGroupOptions(group) {
    const memberLists = group.eventIds.map((id) => candidates.get(id));
    const options = [];
    let generated = 0;
    const rec = (idx, picked, lo, hi, changes) => {
      if (++generated > SEARCH_NODE_BUDGET) return;
      if (idx === memberLists.length) {
        options.push({ memberClaims: new Map(picked), lo0: lo, hi, changes });
        return;
      }
      const eventId = group.eventIds[idx];
      for (const cand of memberLists[idx]) {
        const nlo = Math.max(lo, cand.startOrd);
        const nhi = Math.min(hi, cand.endOrd);
        if (nlo > nhi) continue; // 交集提前为空，剪枝
        picked.push([eventId, cand]);
        rec(idx + 1, picked, nlo, nhi, changes + (cand.claimId === currentClaim.get(eventId) ? 0 : 1));
        picked.pop();
        if (generated > SEARCH_NODE_BUDGET) return;
      }
    };
    rec(0, [], -Infinity, Infinity, 0);
    return { options, truncated: generated > SEARCH_NODE_BUDGET };
  }

  const groupOptions = new Map();
  let truncated = false;
  for (const g of groups) {
    const { options, truncated: t } = buildGroupOptions(g);
    if (t) { truncated = true; break; }
    if (options.length === 0) {
      // 该组在任意改选下区间交集都为空（或某事件无候选）→ 全局无解
      return { assignment: null, count: null, nodes: 0, limited: false };
    }
    // 优先（改选少，其次按组内事件 id 升序的主张 id 序列字典序）——尽早得到小上界
    options.sort((a, b) => {
      if (a.changes !== b.changes) return a.changes - b.changes;
      for (const id of g.eventIds) {
        const x = a.memberClaims.get(id).claimId;
        const y = b.memberClaims.get(id).claimId;
        if (x !== y) return x - y;
      }
      return 0;
    });
    groupOptions.set(g.root, options);
  }
  if (truncated) {
    return { assignment: null, count: null, nodes: 0, limited: true };
  }

  const eventIdsSorted = events.map((e) => e.id).sort((a, b) => a - b);

  function earliestFor(root, option, lower) {
    let lo = option.lo0;
    for (const { from } of incoming.get(root)) {
      const v = lower.get(from) + 1;
      if (v > lo) lo = v;
    }
    return lo <= option.hi ? lo : null;
  }

  // 判断给定组候选是否为「全部保持当前主张」
  function optionIsCurrent(g, option) {
    return g.eventIds.every((id) => option.memberClaims.get(id).claimId === currentClaim.get(id));
  }

  // 贪心种子：拓扑序上优先取保持当前主张的候选，否则取排序第一的可行候选。
  const seed = new Map();
  const seedLower = new Map();
  let seedOk = true;
  for (const root of topo) {
    const g = groups.find((x) => x.root === root);
    const list = groupOptions.get(root);
    let picked = list.find((o) => optionIsCurrent(g, o)) || null;
    let lo = picked && earliestFor(root, picked, seedLower);
    if (lo === null || lo === undefined) {
      picked = null;
      lo = null;
      for (const o of list) {
        const v = earliestFor(root, o, seedLower);
        if (v !== null) { picked = o; lo = v; break; }
      }
    }
    if (picked === null) { seedOk = false; break; }
    seed.set(root, picked);
    seedLower.set(root, lo);
  }
  let best = null;
  if (seedOk) {
    best = { assignment: assignmentFromChoice(seed, groups), count: countGroupChanges(seed, groups) };
  }

  let nodes = 0;
  let limited = false;
  const lower = new Map();
  const choice = new Map();
  const budgetExceeded = Symbol('budget');

  function lexSmallerThanBest() {
    for (const id of eventIdsSorted) {
      const a = choice.get(rootOfEvent.get(id)).memberClaims.get(id).claimId;
      const b = best.assignment.get(id);
      if (a !== b) return a < b;
    }
    return false;
  }

  function changedSoFar(pos) {
    let n = 0;
    for (let i = 0; i < pos; i++) n += choice.get(topo[i]).changes;
    return n;
  }

  function dfs(pos) {
    // 已确定的前 pos 个组的改选数；后续组理论上还可以 0 改选，故只能按 > 剪枝
    const changed = changedSoFar(pos);
    if (best && changed > best.count) return;
    if (++nodes > SEARCH_NODE_BUDGET) { limited = true; throw budgetExceeded; }

    if (pos === topo.length) {
      if (!best || changed < best.count || (changed === best.count && lexSmallerThanBest())) {
        best = { assignment: assignmentFromChoice(choice, groups), count: changed };
      }
      return;
    }

    const root = topo[pos];
    for (const option of groupOptions.get(root)) {
      const lo = earliestFor(root, option, lower);
      if (lo === null) continue;
      lower.set(root, lo);
      choice.set(root, option);
      dfs(pos + 1);
      lower.delete(root);
      choice.delete(root);
      if (limited) return;
    }
  }

  try {
    dfs(0);
  } catch (e) {
    if (e !== budgetExceeded) throw e;
  }

  return {
    assignment: limited || !best ? null : best.assignment,
    count: limited || !best ? null : best.count,
    nodes,
    limited,
  };
}

// 由「组 -> 组候选」组装「事件 -> claimId」
function assignmentFromChoice(choiceByRoot, groups) {
  const m = new Map();
  for (const g of groups) {
    const option = choiceByRoot.get(g.root);
    for (const [eventId, cand] of option.memberClaims) m.set(eventId, cand.claimId);
  }
  return m;
}

function countGroupChanges(choiceByRoot, groups) {
  let n = 0;
  for (const g of groups) {
    const option = choiceByRoot.get(g.root);
    if (option) n += option.changes;
  }
  return n;
}

// 保留导出：按事件计数（单测 / 旧调用兼容）
function countChanges(assignment, currentClaim) {
  let n = 0;
  for (const [eventId, claimId] of assignment) {
    if (currentClaim.get(eventId) !== claimId) n += 1;
  }
  return n;
}

// ---------- 响应组装 ----------
function claimDetail(row) {
  return {
    claimId: row.id,
    dateLabel: row.date_label,
    intervalStart: row.interval_start,
    intervalEnd: row.interval_end,
    source: row.source || '',
  };
}

function buildResponse({ events, claimById, currentClaim, assignment, dates, changedEventCount, draftRevision }) {
  const byEventId = new Map(events.map((e) => [e.id, e]));
  const sortedIds = events.map((e) => e.id).sort((a, b) => a - b);

  const changes = [];
  for (const eventId of sortedIds) {
    const fromId = currentClaim.get(eventId);
    const toId = assignment.get(eventId);
    if (fromId === toId) continue;
    changes.push({
      eventId,
      title: byEventId.get(eventId).title,
      fromClaimId: fromId,
      toClaimId: toId,
      from: claimDetail(claimById.get(fromId)),
      to: claimDetail(claimById.get(toId)),
    });
  }

  const selection = sortedIds.map((eventId) => {
    const claimId = assignment.get(eventId);
    const row = claimById.get(claimId);
    return {
      eventId,
      title: byEventId.get(eventId).title,
      claimId,
      dateLabel: row.date_label,
      intervalStart: row.interval_start,
      intervalEnd: row.interval_end,
      source: row.source || '',
      resolvedDate: isoFromOrdinal(dates.get(eventId)),
    };
  });

  return {
    ok: true,
    code: 'RESELECTION_SUGGESTION',
    draftRevision,
    changedEventCount,
    changes,
    selection,
    note: '建议只读：不会修改草稿、主张或任何已发布版本；可在编辑台将其应用到本机的逐事件选择后重新预检。',
  };
}

module.exports = { suggestReselection, searchFeasibleAssignment, SEARCH_NODE_BUDGET };
