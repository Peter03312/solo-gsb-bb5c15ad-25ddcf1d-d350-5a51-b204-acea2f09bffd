'use strict';

const express = require('express');
const { getDb } = require('./db');
const { parseClaimDate, claimInterval, formatClaimDate } = require('./dates');
const { evaluateDraft, publishVersion, latestVersionNo, getVersionDetail } = require('./publish');
const {
  draftMutation,
  claimRowToApi,
  eventRowToApi,
  readDraftState,
  getDraftRevision,
} = require('./draft');
const { previewRestore, confirmRestore } = require('./restore');
const { suggestReselection } = require('./suggest');
const { compareVersions } = require('./diff');

const router = express.Router();

// ---------- 辅助 ----------
function badRequest(message) {
  return { status: 400, message };
}

function requirePositiveInt(body, field) {
  const v = Number(body[field]);
  if (!Number.isInteger(v) || v < 1) {
    throw badRequest(`字段 ${field} 必须是正整数`);
  }
  return v;
}

function requireNonNegativeInt(body, field) {
  const v = Number(body[field]);
  if (!Number.isInteger(v) || v < 0) {
    throw badRequest(`字段 ${field} 必须是非负整数`);
  }
  return v;
}

function requireString(body, field, { max = 500, allowEmpty = false } = {}) {
  const v = body[field];
  if (typeof v !== 'string') throw badRequest(`字段 ${field} 必须是字符串`);
  if (!allowEmpty && v.trim() === '') throw badRequest(`字段 ${field} 不能为空`);
  if (v.length > max) throw badRequest(`字段 ${field} 长度不能超过 ${max}`);
  return v;
}

function optionalString(body, field, max = 2000) {
  const v = body[field];
  if (v == null) return '';
  if (typeof v !== 'string') throw badRequest(`字段 ${field} 必须是字符串`);
  if (v.length > max) throw badRequest(`字段 ${field} 长度不能超过 ${max}`);
  return v;
}

// 事件不存在 → 404
function getEventOr404(id) {
  const ev = getDb().prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!ev) throw { status: 404, message: `事件 ${id} 不存在` };
  return ev;
}

function readClaimPayload(body) {
  const { precision, year, month, day } = parseClaimDate(body || {});
  const source = requireString(body, 'source', { max: 1000 });
  const note = optionalString(body, 'note', 2000);
  const { start, end } = claimInterval(precision, year, month, day);
  return {
    precision,
    year,
    month,
    day,
    dateLabel: formatClaimDate(precision, year, month, day),
    intervalStart: start,
    intervalEnd: end,
    source,
    note,
  };
}

// ================= 公开接口（访客，无需口令） =================
// 只暴露最新已发布版本的不可变快照，不触碰草稿。

router.get('/api/public/chronicle', (req, res) => {
  const no = latestVersionNo();
  if (no === 0) {
    return res.json({ published: false, message: '年表尚未发布任何版本' });
  }
  res.json({ published: true, currentVersionNo: no, version: getVersionDetail(no) });
});

router.get('/api/public/versions', (req, res) => {
  const no = latestVersionNo();
  const rows = getDb()
    .prepare(
      `SELECT version_no AS versionNo, parent_no AS parentNo, editor, note, published_at AS publishedAt
         FROM versions ORDER BY version_no DESC`
    )
    .all();
  res.json({ currentVersionNo: no, versions: rows });
});

router.get('/api/public/versions/:no', (req, res) => {
  const no = Number(req.params.no);
  const detail = getVersionDetail(no);
  if (!detail) throw { status: 404, message: `版本 ${req.params.no} 不存在` };
  res.json({ version: detail });
});

// ================= 编辑者接口 =================

// 草稿全貌：事件、主张、关系 + 当前最新版本号 + 草稿修订号
router.get('/api/editor/state', (req, res) => {
  res.json(readDraftState());
});

// ---- 事件 CRUD（每次增删改都推进草稿修订号） ----
router.post('/api/editor/events', (req, res) => {
  const title = requireString(req.body, 'title', { max: 200 });
  const description = optionalString(req.body, 'description', 5000);
  const newId = draftMutation((db) =>
    db.prepare('INSERT INTO events (title, description) VALUES (?, ?)').run(title.trim(), description).lastInsertRowid
  );
  res.status(201).json({ event: eventRowToApi(getEventOr404(newId)) });
});

router.put('/api/editor/events/:id', (req, res) => {
  const id = Number(req.params.id);
  getEventOr404(id);
  const title = requireString(req.body, 'title', { max: 200 });
  const description = optionalString(req.body, 'description', 5000);
  draftMutation((db) =>
    db
      .prepare('UPDATE events SET title = ?, description = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(title.trim(), description, id)
  );
  res.json({ event: eventRowToApi(getEventOr404(id)) });
});

router.delete('/api/editor/events/:id', (req, res) => {
  const id = Number(req.params.id);
  getEventOr404(id);
  draftMutation((db) => db.prepare('DELETE FROM events WHERE id = ?').run(id));
  res.json({ deleted: id });
});

// ---- 主张 CRUD（同一事件允许矛盾主张并存） ----
router.post('/api/editor/events/:id/claims', (req, res) => {
  const eventId = Number(req.params.id);
  getEventOr404(eventId);
  const p = readClaimPayload(req.body);
  const newId = draftMutation((db) =>
    db
      .prepare(
        `INSERT INTO claims
           (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(eventId, p.precision, p.year, p.month, p.day, p.dateLabel, p.intervalStart, p.intervalEnd, p.source, p.note)
      .lastInsertRowid
  );
  res.status(201).json({ claim: claimRowToApi(getDb().prepare('SELECT * FROM claims WHERE id = ?').get(newId)) });
});

router.put('/api/editor/claims/:claimId', (req, res) => {
  const claimId = Number(req.params.claimId);
  const existing = getDb().prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!existing) throw { status: 404, message: `主张 ${claimId} 不存在` };
  const p = readClaimPayload(req.body);
  draftMutation((db) =>
    db
      .prepare(
        `UPDATE claims SET precision=?, year=?, month=?, day=?, date_label=?,
           interval_start=?, interval_end=?, source=?, note=? WHERE id=?`
      )
      .run(p.precision, p.year, p.month, p.day, p.dateLabel, p.intervalStart, p.intervalEnd, p.source, p.note, claimId)
  );
  res.json({ claim: claimRowToApi(getDb().prepare('SELECT * FROM claims WHERE id = ?').get(claimId)) });
});

router.delete('/api/editor/claims/:claimId', (req, res) => {
  const claimId = Number(req.params.claimId);
  const existing = getDb().prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!existing) throw { status: 404, message: `主张 ${claimId} 不存在` };
  draftMutation((db) => db.prepare('DELETE FROM claims WHERE id = ?').run(claimId));
  res.json({ deleted: claimId });
});

// ---- 关系 CRUD ----
router.post('/api/editor/relations', (req, res) => {
  const earlierId = Number(req.body.earlierId);
  const laterId = Number(req.body.laterId);
  if (!Number.isInteger(earlierId) || !Number.isInteger(laterId)) {
    throw badRequest('earlierId 与 laterId 必须是事件 id 整数');
  }
  if (earlierId === laterId) throw badRequest('一个事件不能先于自身');
  getEventOr404(earlierId);
  getEventOr404(laterId);
  const source = optionalString(req.body, 'source', 1000);
  const note = optionalString(req.body, 'note', 2000);
  const newId = draftMutation((db) =>
    db.prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)')
      .run(earlierId, laterId, source, note).lastInsertRowid
  );
  const row = getDb().prepare('SELECT * FROM relations WHERE id = ?').get(newId);
  res.status(201).json({
    relation: { id: row.id, earlierId: row.earlier_id, laterId: row.later_id, source: row.source, note: row.note },
  });
});

router.delete('/api/editor/relations/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = getDb().prepare('SELECT * FROM relations WHERE id = ?').get(id);
  if (!row) throw { status: 404, message: `关系 ${id} 不存在` };
  draftMutation((db) => db.prepare('DELETE FROM relations WHERE id = ?').run(id));
  res.json({ deleted: id });
});

// ---- 发布前预检：不落库，返回求解错误或可行日期 ----
router.post('/api/editor/validate', (req, res) => {
  const selectionList = normalizeSelection(req.body);
  const result = evaluateDraft(selectionList);
  if (!result.ok) {
    return res.json({ ok: false, draftRevision: getDraftRevision(), errors: result.errors });
  }
  const { dates, events, selected } = result;
  const preview = events
    .map((ev) => {
      const sel = selected.get(ev.id);
      return {
        eventId: ev.id,
        title: ev.title,
        claimId: sel.claimId,
        resolvedDate: iso(dates.get(ev.id)),
        intervalStart: iso(sel.startOrd),
        intervalEnd: iso(sel.endOrd),
      };
    })
    .sort((a, b) => a.resolvedDate.localeCompare(b.resolvedDate));
  res.json({ ok: true, draftRevision: getDraftRevision(), preview });
});

function iso(ord) {
  return require('./dates').isoFromOrdinal(ord);
}

// ---- 时间无解时的改选建议（只读，不落库、不推进修订号）----
// 体含 selection:[{eventId,claimId}]（逐事件、不缺不重、归属合法）与 draftRevision。
// 409 DRAFT_REVISION_STALE：草稿在预检后或计算期间被改动，不返回过期建议。
// 422 UNRESOLVABLE_BY_RESELECTION：成环 / 事件无主张 / 全部组合均无解。
router.post('/api/editor/suggest-reselection', (req, res) => {
  const selectionList = normalizeSelection(req.body);
  const draftRevision = requireNonNegativeInt(req.body || {}, 'draftRevision');
  res.json(suggestReselection({ selectionList, draftRevision }));
});

function normalizeSelection(body) {
  const raw = body && body.selection;
  if (!Array.isArray(raw)) throw badRequest('selection 必须是 [{eventId, claimId}] 数组');
  return raw.map((item) => {
    const eventId = Number(item && item.eventId);
    const claimId = Number(item && item.claimId);
    if (!Number.isInteger(eventId) || !Number.isInteger(claimId)) {
      throw badRequest('selection 中每项必须包含整数 eventId 与 claimId');
    }
    return { eventId, claimId };
  });
}

// ---- 正式发布：创建不可变版本 ----
router.post('/api/editor/publish', (req, res) => {
  const selectionList = normalizeSelection(req.body);
  const baseVersionNo = req.body.baseVersionNo === null || req.body.baseVersionNo === undefined
    ? null
    : Number(req.body.baseVersionNo);
  if (baseVersionNo !== null && !Number.isInteger(baseVersionNo)) {
    throw badRequest('baseVersionNo 必须是整数或 null');
  }
  const editor = optionalString(req.body, 'editor', 200) || '匿名编辑';
  const note = optionalString(req.body, 'note', 1000);
  const result = publishVersion({ selectionList, baseVersionNo, editor, note });
  res.status(201).json({ ok: true, ...result });
});

// 版本列表（编辑者视角，结构与公开一致）
router.get('/api/editor/versions', (req, res) => {
  const no = latestVersionNo();
  const rows = getDb()
    .prepare(
      `SELECT version_no AS versionNo, parent_no AS parentNo, editor, note, published_at AS publishedAt
         FROM versions ORDER BY version_no DESC`
    )
    .all();
  res.json({ currentVersionNo: no, versions: rows });
});

// ---- 两份已发布年表对照（只读，不改快照 / 草稿 / 修订号） ----
// 体含 fromVersionNo、toVersionNo，以及仅本次对照有效的 manualPairs。
// 未知版本 → 404 VERSION_NOT_FOUND；人工配对非法 → 400 PAIR_INVALID（逐项列原因）。
router.post('/api/editor/versions/diff', (req, res) => {
  const body = req.body || {};
  const result = compareVersions({
    fromVersionNo: Number(body.fromVersionNo),
    toVersionNo: Number(body.toVersionNo),
    manualPairs: body.manualPairs == null ? [] : body.manualPairs,
  });
  res.json(result);
});

// ---- 从任一已发布版本预览恢复（只读，不改任何数据） ----
router.post('/api/editor/restore/preview', (req, res) => {
  const versionNo = requirePositiveInt(req.body || {}, 'versionNo');
  res.json(previewRestore(versionNo));
});

// ---- 确认恢复：回传预览时的草稿修订号与最新版本号做乐观并发校验 ----
router.post('/api/editor/restore/confirm', (req, res) => {
  const body = req.body || {};
  const versionNo = requirePositiveInt(body, 'versionNo');
  const draftRevision = requireNonNegativeInt(body, 'draftRevision');
  const expectedLatestVersionNo = requireNonNegativeInt(body, 'expectedLatestVersionNo');
  const result = confirmRestore({ versionNo, draftRevision, expectedLatestVersionNo });
  res.json(result);
});

module.exports = router;
