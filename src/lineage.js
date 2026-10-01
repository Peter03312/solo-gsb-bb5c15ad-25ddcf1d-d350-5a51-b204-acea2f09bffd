'use strict';

// 事件身份谱系（event_lineage）的读取与求根。
//
// event_lineage 每行：恢复草稿后新建的草稿事件 id -> 被恢复快照事件的身份根 id。
// 同一现实世界事件可能因为「恢复 → 再发布 → 再恢复」而在数据库里多次换 id，
// 但沿谱系链最终会收敛到同一个身份根（identity root）。
//
// 未经过恢复的草稿事件（或其身份根自身）在谱系表中没有作为 draft_event_id 的行，
// 此时身份根就是事件 id 本身。

const { getDb } = require('./db');

// 加载全部「草稿事件 id -> 祖先事件 id」映射（对照只读取，表为只追加）。
function loadLineageMap(db = getDb()) {
  // 按 id 升序：若历史数据中同一草稿事件出现多条出链，以最新一条为准。
  const rows = db
    .prepare('SELECT draft_event_id AS draftId, ancestor_event_id AS ancestorId FROM event_lineage ORDER BY id')
    .all();
  const map = new Map();
  for (const r of rows) {
    map.set(r.draftId, r.ancestorId);
  }
  return map;
}

// 在给定谱系映射上求事件的身份根；带环保护（理论上谱系只追加不形成环）。
function rootOf(eventId, map) {
  let cur = eventId;
  const seen = new Set();
  while (map.has(cur)) {
    if (seen.has(cur)) break;
    seen.add(cur);
    cur = map.get(cur);
  }
  return cur;
}

// 恢复事务内按单个事件 id 求根（直接查表，避免把整表读进事务）。
function rootEventId(db, eventId) {
  let cur = eventId;
  const seen = new Set();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const row = db.prepare('SELECT ancestor_event_id AS a FROM event_lineage WHERE draft_event_id = ?').get(cur);
    if (!row) break;
    cur = row.a;
  }
  return cur;
}

module.exports = { loadLineageMap, rootOf, rootEventId };
