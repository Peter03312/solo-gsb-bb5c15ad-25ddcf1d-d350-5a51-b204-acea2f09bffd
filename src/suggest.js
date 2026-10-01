'use strict';

// 改选建议（只读）。
//
// 当发布预检出现「时间无解」时，在
//   - 不改变任何「先于」关系；
//   - 不改变主张的覆盖区间（只能在各事件的现有主张里另选一条）
// 的前提下，求一个可行组合，并满足：
//   1. 改选事件数最少；
//   2. 平手时取「按事件 ID 排序后的主张 ID 序列」字典序最小。
//
// 无法靠改选解决的三种情形（HTTP 422 UNRESOLVABLE_BY_RESELECTION）：
//   cycle                    —— 先于关系成环（换主张不能破环）
//   event_without_claims     —— 有事件一条主张都没有
//   no_feasible_combination  —— 现有主张的全部组合都不满足先后关系
//
// 请求本身不合法（HTTP 400 SELECTION_INVALID）：选择缺失、事件重复、
// 主张不存在或不属于该事件、事件 id 不存在。
//
// 草稿修订号对不上（HTTP 409 DRAFT_REVISION_STALE）：不返回建议，重新预检。
//
// 本模块不执行任何写库操作，不推进草稿修订号，不触碰发布版本。

const { getDb } = require('./db');
const { solve, claimToInterval } = require('./solver');
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

  // ---- 4) 成环（以及关系指向失效）不随主张选择改变，先于求解判定 ----
  const probe = solve(events, currentIntervals, relations);
  if (!probe.ok) {
    const err = probe.errors[0];
    if (err.type === 'cycle' || err.type === 'broken_relation') {
      httpError(422, {
        code: 'UNRESOLVABLE_BY_RESELECTION',
        reason: err.type,
        message: `「先于」关系${err.type === 'cycle' ? '成环' : '指向了不存在的事件'}，改选主张不能消除该问题：${err.message}`,
        eventIds: err.eventIds,
        relationIds: err.relationIds,
        detail: err.detail || '',
        errors: probe.errors,
      });
    }
    // temporal：正是要搜索改选的情形；missing 在上面校验后理论上不会出现
  }

  // 每事件候选（claims ORDER BY id，故按主张 id 升序）
  const candidates = new Map(
    events.map((e) => [e.id, claimsByEvent.get(e.id).map(claimToInterval)])
  );

  // ---- 5) 分支限界搜索 ----
  const { assignment, count, limited } = searchFeasibleAssignment({
    events,
    relations,
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
        '在各事件的现有主张内任意改选，都找不到满足全部「先于」关系的具体日期组合；' +
        '无法靠改选解决，请为相关事件补录更早 / 更晚的主张，或调整先于关系。',
      eventIds: [],
      relationIds: relations.map((r) => r.id),
    });
  }

  // ---- 6) 用正式求解器复核组合并取得权威求解日期 ----
  const chosenIntervals = new Map(
    events.map((e) => [e.id, candidates.get(e.id).find((c) => c.claimId === assignment.get(e.id))])
  );
  const verified = solve(events, chosenIntervals, relations);
  if (!verified.ok) {
    // 理论不可达：搜索到的组合必然可行
    httpError(422, {
      code: 'UNRESOLVABLE_BY_RESELECTION',
      reason: 'no_feasible_combination',
      message: '改选组合复核失败，无法靠改选解决。',
      eventIds: [],
      relationIds: relations.map((r) => r.id),
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
// 事件按拓扑序逐个赋值；每条候选主张给出事件的最早可行日
//   lo(v) = max(区间起点, 对每条 u->v: lo(u) + 1)
// lo(v) 超过区间终点则该候选不可行。
// 最小化「与当前选择不同的事件数」；平手按事件 ID 升序的主张 ID 序列字典序。
function searchFeasibleAssignment({ events, relations, candidates, currentClaim }) {
  const adj = new Map(events.map((e) => [e.id, []]));
  const indeg = new Map(events.map((e) => [e.id, 0]));
  const incoming = new Map(events.map((e) => [e.id, []]));
  for (const r of relations) {
    if (!adj.has(r.earlierId) || !adj.has(r.laterId)) continue; // 成环/失效已在前置校验拦截
    adj.get(r.earlierId).push(r.laterId);
    indeg.set(r.laterId, indeg.get(r.laterId) + 1);
    incoming.get(r.laterId).push(r);
  }

  // Kahn 拓扑（前置 solve 已保证是 DAG）
  const queue = events.filter((e) => indeg.get(e.id) === 0).map((e) => e.id);
  const topo = [];
  while (queue.length) {
    const id = queue.shift();
    topo.push(id);
    for (const to of adj.get(id)) {
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }

  const eventIdsSorted = events.map((e) => e.id).sort((a, b) => a - b);

  function earliestFor(id, cand, lower) {
    let lo = cand.startOrd;
    for (const r of incoming.get(id)) {
      const v = lower.get(r.earlierId) + 1;
      if (v > lo) lo = v;
    }
    return lo <= cand.endOrd ? lo : null;
  }

  // 贪心种子求一个上界：拓扑序上优先保留当前主张，否则取最小可行主张 id。
  const seed = new Map();
  const seedLower = new Map();
  let seedOk = true;
  for (const id of topo) {
    const curId = currentClaim.get(id);
    const list = candidates.get(id);
    let picked = list.find((c) => c.claimId === curId) || null;
    let lo = picked && earliestFor(id, picked, seedLower);
    if (lo === null || lo === undefined) {
      picked = null;
      lo = null;
      for (const c of list) {
        const v = earliestFor(id, c, seedLower);
        if (v !== null) { picked = c; lo = v; break; }
      }
    }
    if (picked === null) { seedOk = false; break; }
    seed.set(id, picked.claimId);
    seedLower.set(id, lo);
  }
  let best = null;
  if (seedOk) {
    best = { assignment: seed, count: countChanges(seed, currentClaim) };
  }

  let nodes = 0;
  let limited = false;
  const lower = new Map();
  const assign = new Map();
  const budgetExceeded = Symbol('budget');

  function lexSmallerThanBest() {
    for (const id of eventIdsSorted) {
      const a = assign.get(id);
      const b = best.assignment.get(id);
      if (a !== b) return a < b;
    }
    return false;
  }

  function dfs(pos, changed) {
    if (best && changed > best.count) return;
    if (++nodes > SEARCH_NODE_BUDGET) { limited = true; throw budgetExceeded; }

    if (pos === topo.length) {
      if (!best || changed < best.count || (changed === best.count && lexSmallerThanBest())) {
        best = { assignment: new Map(assign), count: changed };
      }
      return;
    }

    const id = topo[pos];
    const curId = currentClaim.get(id);
    // 当前主张优先探（尽早得到少改选上界），其余按主张 id 升序
    const ordered = candidates.get(id)
      .slice()
      .sort((a, b) => (a.claimId === curId ? -1 : b.claimId === curId ? 1 : a.claimId - b.claimId));

    for (const cand of ordered) {
      const lo = earliestFor(id, cand, lower);
      if (lo === null) continue;
      lower.set(id, lo);
      assign.set(id, cand.claimId);
      dfs(pos + 1, changed + (cand.claimId === curId ? 0 : 1));
      lower.delete(id);
      assign.delete(id);
      if (limited) return;
    }
  }

  try {
    dfs(0, 0);
  } catch (e) {
    if (e !== budgetExceeded) throw e;
  }

  return {
    assignment: limited ? null : best && best.assignment,
    count: limited || !best ? null : best.count,
    nodes,
    limited,
  };
}

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
