'use strict';

// 两份已发布年表的版本对照（纯只读）。
//
// 身份配对规则（绝不按标题相似度猜测）：
//   1. 同一草稿事件 id 直接出现在两版中（草稿未经过恢复重建）→ same_id；
//   2. 事件经「从版本恢复草稿」后数据库分配了新 id，但 event_lineage 谱系链
//      可证明与旧事件同根（身份根一致，且各版侧唯一）→ restore_lineage；
//   3. 谱系无法唯一证明（同根事件在一侧出现多个）→ 不自动配对，列为未配对，
//      编辑者可在本次对照请求中给出一对一人工配对 → manual（不持久化）。
//
// 人工配对须拒绝：重复、事件在对应版本不存在、与已有确定配对冲突。
//
// 关系按配对后的两端（端点对）比较：端点对两侧唯一对应时比较出处 / 备注；
// 任一侧同端点有多条关系、无法唯一对应时，只列新增 / 移除，不推断修改。
//
// 本模块不写库、不推进草稿修订号、不修改任何历史快照或当前草稿。

const { getDb } = require('./db');
const { getVersionDetail } = require('./publish');
const { loadLineageMap, rootOf } = require('./lineage');

const MANUAL_PAIR_LIMIT = 1000;

// 逐项对照的事件字段（顺序即展示顺序）
const EVENT_FIELDS = [
  'title',
  'description',
  'precision',
  'dateLabel',
  'intervalStart',
  'intervalEnd',
  'source',
  'claimNote',
  'resolvedDate',
];

const RELATION_FIELDS = ['source', 'note'];

function httpError(status, body) {
  throw Object.assign({ status }, body);
}
function versionHeader(detail, no) {
  return {
    versionNo: no,
    parentNo: detail.parentNo,
    editor: detail.editor || '',
    note: detail.note || '',
    publishedAt: detail.publishedAt,
    eventCount: detail.eventCount,
    relationCount: detail.relationCount,
  };
}

// ---------- 自动配对 ----------
function buildAutoPairs(fromEvents, toEvents, lineageMap) {
  // 身份根 -> 各侧事件 id 列表
  const groups = new Map();
  function bucket(events, side) {
    for (const ev of events) {
      const root = rootOf(ev.eventId, lineageMap);
      if (!groups.has(root)) groups.set(root, { from: [], to: [] });
      groups.get(root)[side].push(ev.eventId);
    }
  }
  bucket(fromEvents, 'from');
  bucket(toEvents, 'to');

  // fromEventId -> toEventId（仅确定配对）
  const autoFrom = new Map();
  const autoTo = new Map();
  const pairs = [];
  for (const { from, to } of groups.values()) {
    if (from.length === 1 && to.length === 1) {
      const fromId = from[0];
      const toId = to[0];
      autoFrom.set(fromId, toId);
      autoTo.set(toId, fromId);
      pairs.push({ fromEventId: fromId, toEventId: toId, matchKind: fromId === toId ? 'same_id' : 'restore_lineage' });
    }
    // 一侧 0 个（仅出现在另一版）或任一侧多个（身份不唯一）：不自动配对
  }
  // 按旧版顺序稳定输出
  const orderFrom = new Map(fromEvents.map((e, i) => [e.eventId, i]));
  pairs.sort((a, b) => orderFrom.get(a.fromEventId) - orderFrom.get(b.fromEventId));
  return { pairs, autoFrom, autoTo };
}

// ---------- 人工配对校验与合并 ----------
function applyManualPairs(rawPairs, { fromEvents, toEvents, autoFrom, autoTo }) {
  const invalidPairs = [];
  if (!Array.isArray(rawPairs)) {
    httpError(400, {
      code: 'PAIR_INVALID',
      message: 'manualPairs 必须是 [{fromEventId, toEventId}] 数组',
      invalidPairs: [],
    });
  }
  if (rawPairs.length > MANUAL_PAIR_LIMIT) {
    httpError(400, {
      code: 'PAIR_INVALID',
      message: `一次对照最多指定 ${MANUAL_PAIR_LIMIT} 条人工配对`,
      invalidPairs: [],
    });
  }

  const fromIds = new Set(fromEvents.map((e) => e.eventId));
  const toIds = new Set(toEvents.map((e) => e.eventId));

  const pairFrom = new Map(autoFrom); // 已确定配对
  const pairTo = new Map(autoTo);
  const seenFrom = new Set(); // 本请求中已出现
  const seenTo = new Set();
  const acceptedManual = [];

  for (const item of rawPairs) {
    const fromId = Number(item && item.fromEventId);
    const toId = Number(item && item.toEventId);
    if (!Number.isInteger(fromId) || !Number.isInteger(toId)) {
      invalidPairs.push({ fromEventId: item && item.fromEventId, toEventId: item && item.toEventId, reason: 'invalid_pair' });
      continue;
    }

    // 跨版不存在
    if (!fromIds.has(fromId)) {
      invalidPairs.push({ fromEventId: fromId, toEventId: toId, reason: 'from_event_not_found' });
      continue;
    }
    if (!toIds.has(toId)) {
      invalidPairs.push({ fromEventId: fromId, toEventId: toId, reason: 'to_event_not_found' });
      continue;
    }

    // 请求内重复（先于冲突判定：逐项给出「重复」原因；同一对写两次记 duplicated_pair）
    const dupFrom = seenFrom.has(fromId);
    const dupTo = seenTo.has(toId);
    if (dupFrom || dupTo) {
      invalidPairs.push({
        fromEventId: fromId,
        toEventId: toId,
        reason: dupFrom && dupTo ? 'duplicated_pair' : dupFrom ? 'duplicated_from' : 'duplicated_to',
      });
      continue;
    }
    seenFrom.add(fromId);
    seenTo.add(toId);

    // 与已有确定配对冲突；恰好与自动配对相同则幂等接受（不改变配对）
    const autoMatchedTo = pairFrom.get(fromId);
    const autoMatchedFrom = pairTo.get(toId);
    if (autoMatchedTo !== undefined || autoMatchedFrom !== undefined) {
      if (autoMatchedTo === toId && autoMatchedFrom === fromId) {
        // 已由自动配对确定为同一对：幂等，不算冲突
        continue;
      }
      invalidPairs.push({
        fromEventId: fromId,
        toEventId: toId,
        reason: 'conflict_with_pair',
        existingFromEventId: autoMatchedFrom !== undefined ? autoMatchedFrom : null,
        existingToEventId: autoMatchedTo !== undefined ? autoMatchedTo : null,
      });
      continue;
    }

    pairFrom.set(fromId, toId);
    pairTo.set(toId, fromId);
    acceptedManual.push({ fromEventId: fromId, toEventId: toId, matchKind: 'manual' });
  }

  if (invalidPairs.length) {
    httpError(400, {
      code: 'PAIR_INVALID',
      message: '人工配对存在重复、跨版不存在或与已有确定配对冲突，已整组拒绝；系统不按标题相似度猜测配对。',
      invalidPairs,
    });
  }

  return { pairFrom, pairTo, acceptedManual };
}

// ---------- 事件逐项前后值 ----------
function diffEventFields(fromEv, toEv) {
  const fields = EVENT_FIELDS.map((field) => {
    const from = fromEv[field] == null ? '' : String(fromEv[field]);
    const to = toEv[field] == null ? '' : String(toEv[field]);
    return { field, from, to, changed: from !== to };
  });
  return { fields, changed: fields.some((f) => f.changed) };
}

// ---------- 关系对照 ----------
function diffRelations(fromDetail, toDetail, pairFrom, pairTo) {
  const fromTitle = new Map(fromDetail.events.map((e) => [e.eventId, e.title]));
  const toTitle = new Map(toDetail.events.map((e) => [e.eventId, e.title]));

  const title = (map, id) => (map.has(id) ? map.get(id) : `#${id}`);

  // 以「旧版端点」描述端点；未配对一侧的 id / title 为 null。
  function endpointFrom(evFromId) {
    const toId = pairFrom.has(evFromId) ? pairFrom.get(evFromId) : null;
    return {
      fromEventId: evFromId,
      toEventId: toId,
      fromTitle: title(fromTitle, evFromId),
      toTitle: toId !== null ? title(toTitle, toId) : null,
    };
  }
  function endpointTo(evToId) {
    const fromId = pairTo.has(evToId) ? pairTo.get(evToId) : null;
    return {
      fromEventId: fromId,
      toEventId: evToId,
      fromTitle: fromId !== null ? title(fromTitle, fromId) : null,
      toTitle: title(toTitle, evToId),
    };
  }

  // 两端均已配对的关系按「配对后端点对」归组；任一端未配对直接记增 / 删。
  const fromGroups = new Map(); // key(新版端点对) -> [from relations]
  const removed = [];
  for (const r of fromDetail.relations) {
    const eaTo = pairFrom.get(r.earlierEventId);
    const ebTo = pairFrom.get(r.laterEventId);
    if (eaTo === undefined || ebTo === undefined) {
      removed.push({
        relationIdFrom: r.relationId,
        relationIdTo: null,
        earlier: endpointFrom(r.earlierEventId),
        later: endpointFrom(r.laterEventId),
        source: r.source || '',
        note: r.note || '',
        reason: 'endpoint_unpaired',
      });
      continue;
    }
    const key = `${eaTo}|${ebTo}`;
    if (!fromGroups.has(key)) fromGroups.set(key, []);
    fromGroups.get(key).push(r);
  }

  const toGroups = new Map(); // key(新版端点对) -> [to relations]
  const added = [];
  for (const r of toDetail.relations) {
    const eaFrom = pairTo.get(r.earlierEventId);
    const ebFrom = pairTo.get(r.laterEventId);
    if (eaFrom === undefined || ebFrom === undefined) {
      added.push({
        relationIdFrom: null,
        relationIdTo: r.relationId,
        earlier: endpointTo(r.earlierEventId),
        later: endpointTo(r.laterEventId),
        source: r.source || '',
        note: r.note || '',
        reason: 'endpoint_unpaired',
      });
      continue;
    }
    const key = `${r.earlierEventId}|${r.laterEventId}`;
    if (!toGroups.has(key)) toGroups.set(key, []);
    toGroups.get(key).push(r);
  }

  const unchanged = [];
  const changed = [];

  function relFields(a, b) {
    return RELATION_FIELDS.map((field) => {
      const av = a[field] || '';
      const bv = b[field] || '';
      return { field, from: av, to: bv, changed: av !== bv };
    });
  }

  // 按旧版关系的出现顺序遍历端点对，保证输出稳定
  const seenKeys = new Set();
  for (const r of fromDetail.relations) {
    const eaTo = pairFrom.get(r.earlierEventId);
    const ebTo = pairFrom.get(r.laterEventId);
    if (eaTo === undefined || ebTo === undefined) continue;
    const key = `${eaTo}|${ebTo}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const gFrom = fromGroups.get(key) || [];
    const gTo = toGroups.get(key) || [];
    if (gTo.length === 0) {
      for (const rf of gFrom) {
        removed.push({
          relationIdFrom: rf.relationId,
          relationIdTo: null,
          earlier: endpointFrom(rf.earlierEventId),
          later: endpointFrom(rf.laterEventId),
          source: rf.source || '',
          note: rf.note || '',
          reason: 'absent_in_to',
        });
      }
      continue;
    }
    if (gFrom.length === 1 && gTo.length === 1) {
      const rf = gFrom[0];
      const rt = gTo[0];
      const fields = relFields(rf, rt);
      const isChanged = fields.some((f) => f.changed);
      const entry = {
        relationIdFrom: rf.relationId,
        relationIdTo: rt.relationId,
        earlier: endpointFrom(rf.earlierEventId),
        later: endpointFrom(rf.laterEventId),
        fields,
        changed: isChanged,
      };
      (isChanged ? changed : unchanged).push(entry);
      continue;
    }
    // 同端点多条、无法唯一对应：只列增删，不推断修改
    for (const rf of gFrom) {
      removed.push({
        relationIdFrom: rf.relationId,
        relationIdTo: null,
        earlier: endpointFrom(rf.earlierEventId),
        later: endpointFrom(rf.laterEventId),
        source: rf.source || '',
        note: rf.note || '',
        reason: 'ambiguous_endpoint_group',
        groupSize: { from: gFrom.length, to: gTo.length },
      });
    }
    for (const rt of gTo) {
      added.push({
        relationIdFrom: null,
        relationIdTo: rt.relationId,
        earlier: endpointTo(rt.earlierEventId),
        later: endpointTo(rt.laterEventId),
        source: rt.source || '',
        note: rt.note || '',
        reason: 'ambiguous_endpoint_group',
        groupSize: { from: gFrom.length, to: gTo.length },
      });
    }
  }

  // 新版中独有的端点对（旧版完全没有）→ 新增
  for (const r of toDetail.relations) {
    const key = `${r.earlierEventId}|${r.laterEventId}`;
    if (seenKeys.has(key)) continue;
    // 端点未配对的已在前面计入 added
    if (!pairTo.has(r.earlierEventId) || !pairTo.has(r.laterEventId)) continue;
    seenKeys.add(key);
    for (const rt of toGroups.get(key)) {
      added.push({
        relationIdFrom: null,
        relationIdTo: rt.relationId,
        earlier: endpointTo(rt.earlierEventId),
        later: endpointTo(rt.laterEventId),
        source: rt.source || '',
        note: rt.note || '',
        reason: 'absent_in_from',
      });
    }
  }

  // 新增 / 移除列表保持各版稳定插入顺序
  return { unchanged, changed, removed, added };
}

// ---------- 「同日」关系对照（无向；端点对按 id 归一化） ----------
function diffSameDayRelations(fromDetail, toDetail, pairFrom, pairTo) {
  const fromTitle = new Map(fromDetail.events.map((e) => [e.eventId, e.title]));
  const toTitle = new Map(toDetail.events.map((e) => [e.eventId, e.title]));

  const title = (map, id) => (map.has(id) ? map.get(id) : `#${id}`);
  const epKey = (a, b) => (a <= b ? `${a}|${b}` : `${b}|${a}`);

  // 由旧版侧一对事件生成端点描述（映射到新版身份；未配对一侧为 null）
  function endpointFrom(evFromId) {
    const toId = pairFrom.has(evFromId) ? pairFrom.get(evFromId) : null;
    return {
      fromEventId: evFromId,
      toEventId: toId,
      fromTitle: title(fromTitle, evFromId),
      toTitle: toId !== null ? title(toTitle, toId) : null,
    };
  }
  function endpointTo(evToId) {
    const fromId = pairTo.has(evToId) ? pairTo.get(evToId) : null;
    return {
      fromEventId: fromId,
      toEventId: evToId,
      toTitle: title(toTitle, evToId),
      fromTitle: fromId !== null ? title(fromTitle, fromId) : null,
    };
  }
  const byFromId = (x, y) => {
    // 展示排序：有旧版 id 的按旧版 id，否则按新版 id
    if (x.fromEventId !== null && y.fromEventId !== null) return x.fromEventId - y.fromEventId;
    return (x.toEventId ?? Infinity) - (y.toEventId ?? Infinity);
  };
  const endpointsFrom = (r) => [endpointFrom(r.eventAId), endpointFrom(r.eventBId)].sort(byFromId);
  const endpointsTo = (r) => [endpointTo(r.eventAId), endpointTo(r.eventBId)].sort(byFromId);

  function relFields(a, b) {
    return RELATION_FIELDS.map((field) => {
      const av = a[field] || '';
      const bv = b[field] || '';
      return { field, from: av, to: bv, changed: av !== bv };
    });
  }

  const removed = [];
  const added = [];
  const fromGroups = new Map(); // key(新版端点对) -> [from rows]
  for (const r of fromDetail.sameDayRelations || []) {
    const x = pairFrom.get(r.eventAId);
    const y = pairFrom.get(r.eventBId);
    if (x === undefined || y === undefined) {
      removed.push({
        relationIdFrom: r.sameDayRelationId,
        relationIdTo: null,
        endpoints: endpointsFrom(r),
        source: r.source || '',
        note: r.note || '',
        reason: 'endpoint_unpaired',
      });
      continue;
    }
    const key = epKey(x, y);
    if (!fromGroups.has(key)) fromGroups.set(key, []);
    fromGroups.get(key).push(r);
  }

  const toGroups = new Map();
  for (const r of toDetail.sameDayRelations || []) {
    const x = pairTo.get(r.eventAId);
    const y = pairTo.get(r.eventBId);
    if (x === undefined || y === undefined) {
      added.push({
        relationIdFrom: null,
        relationIdTo: r.sameDayRelationId,
        endpoints: endpointsTo(r),
        source: r.source || '',
        note: r.note || '',
        reason: 'endpoint_unpaired',
      });
      continue;
    }
    const key = epKey(r.eventAId, r.eventBId);
    if (!toGroups.has(key)) toGroups.set(key, []);
    toGroups.get(key).push(r);
  }

  const unchanged = [];
  const changed = [];
  const seenKeys = new Set();

  // 以旧版关系出现顺序遍历端点对
  for (const r of fromDetail.sameDayRelations || []) {
    const x = pairFrom.get(r.eventAId);
    const y = pairFrom.get(r.eventBId);
    if (x === undefined || y === undefined) continue;
    const key = epKey(x, y);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const gFrom = fromGroups.get(key) || [];
    const gTo = toGroups.get(key) || [];
    if (gTo.length === 0) {
      for (const rf of gFrom) {
        removed.push({
          relationIdFrom: rf.sameDayRelationId,
          relationIdTo: null,
          endpoints: endpointsFrom(rf),
          source: rf.source || '',
          note: rf.note || '',
          reason: 'absent_in_to',
        });
      }
      continue;
    }
    if (gFrom.length === 1 && gTo.length === 1) {
      const rf = gFrom[0];
      const rt = gTo[0];
      const fields = relFields(rf, rt);
      const isChanged = fields.some((f) => f.changed);
      const entry = {
        relationIdFrom: rf.sameDayRelationId,
        relationIdTo: rt.sameDayRelationId,
        endpoints: endpointsFrom(rf),
        fields,
        changed: isChanged,
      };
      (isChanged ? changed : unchanged).push(entry);
      continue;
    }
    // 同端点多条、无法唯一对应：只列增删
    for (const rf of gFrom) {
      removed.push({
        relationIdFrom: rf.sameDayRelationId,
        relationIdTo: null,
        endpoints: endpointsFrom(rf),
        source: rf.source || '',
        note: rf.note || '',
        reason: 'ambiguous_endpoint_group',
        groupSize: { from: gFrom.length, to: gTo.length },
      });
    }
    for (const rt of gTo) {
      added.push({
        relationIdFrom: null,
        relationIdTo: rt.sameDayRelationId,
        endpoints: endpointsTo(rt),
        source: rt.source || '',
        note: rt.note || '',
        reason: 'ambiguous_endpoint_group',
        groupSize: { from: gFrom.length, to: gTo.length },
      });
    }
  }

  // 新版独有端点对
  for (const r of toDetail.sameDayRelations || []) {
    if (!pairTo.has(r.eventAId) || !pairTo.has(r.eventBId)) continue;
    const key = epKey(r.eventAId, r.eventBId);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    for (const rt of toGroups.get(key)) {
      added.push({
        relationIdFrom: null,
        relationIdTo: rt.sameDayRelationId,
        endpoints: endpointsTo(rt),
        source: rt.source || '',
        note: rt.note || '',
        reason: 'absent_in_from',
      });
    }
  }

  return { unchanged, changed, removed, added };
}

// ---------- 主入口 ----------
function compareVersions({ fromVersionNo, toVersionNo, manualPairs = [] }) {
  const db = getDb();

  if (!Number.isInteger(fromVersionNo) || fromVersionNo < 1) {
    httpError(400, { code: 'VERSION_NO_INVALID', message: 'fromVersionNo 必须是正整数（已发布版本号）', versionNo: fromVersionNo });
  }
  if (!Number.isInteger(toVersionNo) || toVersionNo < 1) {
    httpError(400, { code: 'VERSION_NO_INVALID', message: 'toVersionNo 必须是正整数（已发布版本号）', versionNo: toVersionNo });
  }

  // 先查旧版再查新版：未知版本明确 404（既有单版本查询响应不受影响）
  const fromDetail = getVersionDetail(fromVersionNo);
  if (!fromDetail) {
    httpError(404, { code: 'VERSION_NOT_FOUND', message: `版本 ${fromVersionNo} 不存在`, versionNo: fromVersionNo });
  }
  const toDetail = getVersionDetail(toVersionNo);
  if (!toDetail) {
    httpError(404, { code: 'VERSION_NOT_FOUND', message: `版本 ${toVersionNo} 不存在`, versionNo: toVersionNo });
  }

  const lineageMap = loadLineageMap(db);
  const { pairs: autoPairs, autoFrom, autoTo } = buildAutoPairs(fromDetail.events, toDetail.events, lineageMap);

  const { pairFrom, pairTo, acceptedManual } = applyManualPairs(manualPairs, {
    fromEvents: fromDetail.events,
    toEvents: toDetail.events,
    autoFrom,
    autoTo,
  });

  // 最终确定配对（自动 + 人工），按旧版顺序
  const fromById = new Map(fromDetail.events.map((e) => [e.eventId, e]));
  const toById = new Map(toDetail.events.map((e) => [e.eventId, e]));
  const pairList = [];
  for (const ev of fromDetail.events) {
    if (pairFrom.has(ev.eventId)) {
      const toId = pairFrom.get(ev.eventId);
      const isAuto = autoFrom.has(ev.eventId) && autoFrom.get(ev.eventId) === toId;
      pairList.push({
        fromEventId: ev.eventId,
        toEventId: toId,
        matchKind: isAuto ? (ev.eventId === toId ? 'same_id' : 'restore_lineage') : 'manual',
      });
    }
  }

  const pairedFrom = new Set(pairList.map((p) => p.fromEventId));
  const pairedTo = new Set(pairList.map((p) => p.toEventId));

  const unpairedFrom = fromDetail.events
    .filter((e) => !pairedFrom.has(e.eventId))
    .map((e) => ({ eventId: e.eventId, title: e.title }));
  const unpairedTo = toDetail.events
    .filter((e) => !pairedTo.has(e.eventId))
    .map((e) => ({ eventId: e.eventId, title: e.title }));

  // 事件逐项前后值
  const eventDiffs = pairList.map((p) => {
    const fromEv = fromById.get(p.fromEventId);
    const toEv = toById.get(p.toEventId);
    const { fields, changed } = diffEventFields(fromEv, toEv);
    return {
      fromEventId: p.fromEventId,
      toEventId: p.toEventId,
      matchKind: p.matchKind,
      fromTitle: fromEv.title,
      toTitle: toEv.title,
      fields,
      changed,
    };
  });

  // 关系按配对后端点比较
  const relations = diffRelations(fromDetail, toDetail, pairFrom, pairTo);
  const sameDayRelations = diffSameDayRelations(fromDetail, toDetail, pairFrom, pairTo);

  return {
    ok: true,
    code: 'VERSION_DIFF',
    readOnly: true,
    note: '版本对照为只读结果：不写草稿、不推进草稿修订号、不修改任何历史快照。人工配对仅对本次对照有效，不持久化。',
    from: versionHeader(fromDetail, fromVersionNo),
    to: versionHeader(toDetail, toVersionNo),
    pairing: {
      autoPairCount: autoPairs.length,
      manualPairCount: acceptedManual.length,
      pairs: pairList.map((p) => ({
        fromEventId: p.fromEventId,
        toEventId: p.toEventId,
        matchKind: p.matchKind,
        fromTitle: fromById.get(p.fromEventId).title,
        toTitle: toById.get(p.toEventId).title,
      })),
      unpairedFrom,
      unpairedTo,
    },
    eventDiffs,
    relations,
    sameDayRelations,
  };
}

module.exports = { compareVersions, EVENT_FIELDS, RELATION_FIELDS };
