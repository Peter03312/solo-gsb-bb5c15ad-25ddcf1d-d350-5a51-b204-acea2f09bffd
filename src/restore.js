'use strict';

// 从任一已发布版本预览 / 恢复草稿。
//
// 预览（previewRestore）只读：列出该版事件、被选主张、「先于」关系，
// 以及当前草稿中将被替换的内容，绝不改数据。
//
// 确认（confirmRestore）须回传预览时的草稿修订号 draftRevision 与
// 当时最新版本号 expectedLatestVersionNo；在一个事务内：
//   1. 校验版本仍存在；
//   2. 校验草稿与最新版本均未变化（否则 409，不改任何数据）；
//   3. 原子清空草稿区并按快照重建事件 / 被选主张 / 关系；
//   4. 推进草稿修订号；
//   5. 返回旧快照 id → 新草稿 id 的映射及重建后的草稿全貌（含待选主张）。
// 历史快照（versions*）与访客年表均不受影响。

const { getDb } = require('./db');
const { latestVersionNo, getVersionDetail } = require('./publish');
const { ordinalFromIso, ymdFromOrdinal } = require('./dates');
const { getDraftRevision, bumpDraftRevision, readDraftState } = require('./draft');
const { rootEventId } = require('./lineage');

function httpError(status, body) {
  throw Object.assign({ status }, body);
}

function getVersionId(no) {
  const row = getDb().prepare('SELECT id FROM versions WHERE version_no = ?').get(no);
  return row ? row.id : null;
}

// ---------- 预览（只读） ----------
function previewRestore(versionNo) {
  const db = getDb();
  const versionId = getVersionId(versionNo);
  if (versionId === null) {
    httpError(404, { code: 'VERSION_NOT_FOUND', message: `版本 ${versionNo} 不存在` });
  }
  const version = getVersionDetail(versionNo);

  const snapEvents = db
    .prepare(
      `SELECT event_id AS eventId, title, description, claim_id AS claimId, precision,
              date_label AS dateLabel, interval_start AS intervalStart,
              interval_end AS intervalEnd, resolved_date AS resolvedDate,
              source, claim_note AS claimNote
         FROM version_events WHERE version_id = ? ORDER BY sort_order`
    )
    .all(versionId);

  const snapRelations = db
    .prepare(
      `SELECT relation_id AS relationId, earlier_event_id AS earlierEventId,
              later_event_id AS laterEventId, source, note
         FROM version_relations WHERE version_id = ? ORDER BY sort_order`
    )
    .all(versionId);

  const snapSameDayRelations = db
    .prepare(
      `SELECT same_day_relation_id AS sameDayRelationId, event_a_id AS eventAId,
              event_b_id AS eventBId, source, note
         FROM version_same_day_relations WHERE version_id = ? ORDER BY sort_order`
    )
    .all(versionId);

  // 当前草稿中将被替换的内容
  const currentEvents = db
    .prepare(
      `SELECT e.id, e.title,
              (SELECT COUNT(*) FROM claims c WHERE c.event_id = e.id) AS claimCount
         FROM events e ORDER BY e.id`
    )
    .all();
  const currentRelations = db
    .prepare('SELECT id, earlier_id AS earlierId, later_id AS laterId FROM relations ORDER BY id')
    .all();
  const currentSameDayRelations = db
    .prepare('SELECT id, event_a_id AS eventAId, event_b_id AS eventBId FROM same_day_relations ORDER BY id')
    .all();

  return {
    versionNo,
    version,
    draftRevision: getDraftRevision(),
    latestVersionNo: latestVersionNo(),
    snapshot: { events: snapEvents, relations: snapRelations, sameDayRelations: snapSameDayRelations },
    currentDraft: {
      events: currentEvents,
      relations: currentRelations,
      sameDayRelations: currentSameDayRelations,
    },
  };
}

// ---------- 确认恢复（原子替换整个草稿） ----------
function confirmRestore({ versionNo, draftRevision, expectedLatestVersionNo }) {
  const db = getDb();

  const tx = db.transaction(() => {
    // 版本不存在：404（优先于冲突检查）
    const versionId = getVersionId(versionNo);
    if (versionId === null) {
      httpError(404, { code: 'VERSION_NOT_FOUND', message: `版本 ${versionNo} 不存在` });
    }

    // 乐观并发：草稿或最新版本在预览后发生变化则报冲突，且不改数据
    const latest = latestVersionNo();
    const currentRevision = getDraftRevision();
    if (currentRevision !== draftRevision || latest !== expectedLatestVersionNo) {
      const reasons = [];
      if (currentRevision !== draftRevision) {
        reasons.push(`草稿已被修改（预览时修订号 ${draftRevision}，当前 ${currentRevision}）`);
      }
      if (latest !== expectedLatestVersionNo) {
        reasons.push(`最新版本已变化（预览时第 ${expectedLatestVersionNo} 版，当前第 ${latest} 版）`);
      }
      httpError(409, {
        code: 'RESTORE_CONFLICT',
        message: `恢复冲突：${reasons.join('；')}。请重新预览后再确认，本次未改动任何草稿数据。`,
        previewDraftRevision: draftRevision,
        currentDraftRevision: currentRevision,
        expectedLatestVersionNo,
        currentVersionNo: latest,
      });
    }

    // 先从不可变快照读出待重建内容（草稿区的清空不影响 version_* 表）
    const snapEvents = db
      .prepare('SELECT * FROM version_events WHERE version_id = ? ORDER BY sort_order')
      .all(versionId);
    const snapRels = db
      .prepare('SELECT * FROM version_relations WHERE version_id = ? ORDER BY sort_order')
      .all(versionId);
    const snapSdrs = db
      .prepare('SELECT * FROM version_same_day_relations WHERE version_id = ? ORDER BY sort_order')
      .all(versionId);

    // ---- 原子替换草稿区 ----
    // 外键 ON DELETE CASCADE 会连带 claims / relations；为稳妥显式清空。
    db.prepare('DELETE FROM same_day_relations').run();
    db.prepare('DELETE FROM relations').run();
    db.prepare('DELETE FROM claims').run();
    db.prepare('DELETE FROM events').run();

    const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
    const insClaim = db.prepare(`
      INSERT INTO claims
        (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insRel = db.prepare(
      'INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)'
    );
    const insSdr = db.prepare(
      'INSERT INTO same_day_relations (event_a_id, event_b_id, source, note) VALUES (?, ?, ?, ?)'
    );

    // 快照只保存当版被选主张，故每个事件只重建一条主张（待编辑台继续校验发布）。
    const eventIdMap = {};
    const claimIdMap = {};
    const insLineage = db.prepare(`
      INSERT INTO event_lineage (draft_event_id, ancestor_event_id, restored_from_version_no)
      VALUES (?, ?, ?)
    `);
    for (const se of snapEvents) {
      const info = insEvent.run(se.title, se.description);
      const newEventId = info.lastInsertRowid;
      eventIdMap[se.event_id] = newEventId;

      // 身份延续：新草稿事件继承被恢复事件的身份（即使数据库分配了新 id）。
      // ancestor 记快照事件的“身份根”（它自身可能由更早一次恢复而来），
      // 使多次恢复后仍可沿链追溯到同一身份。
      insLineage.run(newEventId, rootEventId(db, se.event_id), versionNo);

      const { year, month, day } = ymdFromOrdinal(ordinalFromIso(se.interval_start));
      const c = insClaim.run(
        newEventId,
        se.precision,
        year,
        se.precision === 'year' ? null : month,
        se.precision === 'day' ? day : null,
        se.date_label,
        se.interval_start,
        se.interval_end,
        se.source,
        se.claim_note
      );
      claimIdMap[se.claim_id] = c.lastInsertRowid;
    }

    // 按快照重建「先于」关系（引用映射到新事件 id）
    const relationIdMap = {};
    for (const sr of snapRels) {
      const newEarlier = eventIdMap[sr.earlier_event_id];
      const newLater = eventIdMap[sr.later_event_id];
      if (newEarlier === undefined || newLater === undefined) continue; // 快照自洽，理论不会发生
      const info = insRel.run(newEarlier, newLater, sr.source || '', sr.note || '');
      relationIdMap[sr.relation_id] = info.lastInsertRowid;
    }

    // 按快照重建「同日」关系（无向，引用映射到新事件 id）
    const sameDayRelationIdMap = {};
    for (const ss of snapSdrs) {
      const newA = eventIdMap[ss.event_a_id];
      const newB = eventIdMap[ss.event_b_id];
      if (newA === undefined || newB === undefined) continue;
      // 映射后仍按小 id 在前归一化
      const a = Math.min(newA, newB);
      const b = Math.max(newA, newB);
      const info = insSdr.run(a, b, ss.source || '', ss.note || '');
      sameDayRelationIdMap[ss.same_day_relation_id] = info.lastInsertRowid;
    }

    // 恢复本身也是一次草稿变更，推进修订号
    bumpDraftRevision(db);

    return { eventIdMap, claimIdMap, relationIdMap, sameDayRelationIdMap };
  });

  const { eventIdMap, claimIdMap, relationIdMap, sameDayRelationIdMap } = tx();

  return {
    ok: true,
    restoredFromVersionNo: versionNo,
    idMap: {
      events: eventIdMap,
      claims: claimIdMap,
      relations: relationIdMap,
      sameDayRelations: sameDayRelationIdMap,
    },
    state: readDraftState(),
  };
}

module.exports = { previewRestore, confirmRestore };
