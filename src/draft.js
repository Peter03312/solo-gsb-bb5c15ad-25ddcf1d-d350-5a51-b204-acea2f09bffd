'use strict';

// 草稿区共享逻辑：行→API 转换、草稿全貌组装、修订号与草稿变更事务包装。
const { getDb } = require('./db');
const { latestVersionNo, getVersionSummary } = require('./publish');

// ---------- 修订号（草稿区任意增删改都单调 +1） ----------
function getDraftRevision() {
  const row = getDb().prepare('SELECT revision FROM draft_meta WHERE id = 1').get();
  return row ? row.revision : 0;
}

// 在已有事务内推进修订号
function bumpDraftRevision(db = getDb()) {
  db.prepare('UPDATE draft_meta SET revision = revision + 1 WHERE id = 1').run();
}

// 草稿变更统一入口：一个事务内执行写入并推进修订号。
// fn 可返回结果对象；非错误性的 4xx 应在 fn 外先行校验。
function draftMutation(fn) {
  const db = getDb();
  return db.transaction(() => {
    const result = fn(db);
    bumpDraftRevision(db);
    return result;
  })();
}

// ---------- 行 → API ----------
function claimRowToApi(c) {
  return {
    id: c.id,
    eventId: c.event_id,
    precision: c.precision,
    year: c.year,
    month: c.month,
    day: c.day,
    dateLabel: c.date_label,
    intervalStart: c.interval_start,
    intervalEnd: c.interval_end,
    source: c.source,
    note: c.note,
  };
}

function eventRowToApi(e) {
  const claims = getDb()
    .prepare('SELECT * FROM claims WHERE event_id = ? ORDER BY id')
    .all(e.id)
    .map(claimRowToApi);
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    claims,
  };
}

function relationRowToApi(r) {
  return {
    id: r.id,
    earlierId: r.earlier_id,
    laterId: r.later_id,
    source: r.source,
    note: r.note,
  };
}

function sameDayRowToApi(r) {
  return {
    id: r.id,
    eventAId: r.event_a_id,
    eventBId: r.event_b_id,
    source: r.source,
    note: r.note,
  };
}

// 草稿全貌（供 /api/editor/state 与恢复后返回复用）
function readDraftState() {
  const db = getDb();
  const events = db.prepare('SELECT * FROM events ORDER BY id').all().map(eventRowToApi);
  const relations = db.prepare('SELECT * FROM relations ORDER BY id').all().map(relationRowToApi);
  const sameDayRelations = db
    .prepare('SELECT * FROM same_day_relations ORDER BY id')
    .all()
    .map(sameDayRowToApi);
  const currentVersionNo = latestVersionNo();
  return {
    currentVersionNo,
    currentVersion: getVersionSummary(currentVersionNo) || null,
    draftRevision: getDraftRevision(),
    events,
    relations,
    sameDayRelations,
  };
}

module.exports = {
  getDraftRevision,
  bumpDraftRevision,
  draftMutation,
  claimRowToApi,
  eventRowToApi,
  relationRowToApi,
  sameDayRowToApi,
  readDraftState,
};
