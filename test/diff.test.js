'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM event_lineage;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0 WHERE id = 1;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title, description = '') {
  const r = await call('POST', '/api/editor/events', { body: { title, description } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}

async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}

async function makeRel(earlierId, laterId, extra = {}) {
  const r = await call('POST', '/api/editor/relations', {
    body: { earlierId, laterId, source: extra.source || '', note: extra.note || '' },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

async function publish(selection, baseVersionNo, { editor = '测试员', note = '' } = {}) {
  const r = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo, editor, note },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

async function restoreConfirm(versionNo) {
  const prev = await call('POST', '/api/editor/restore/preview', { body: { versionNo } });
  assert.strictEqual(prev.status, 200, JSON.stringify(prev.json));
  const con = await call('POST', '/api/editor/restore/confirm', {
    body: {
      versionNo,
      draftRevision: prev.json.draftRevision,
      expectedLatestVersionNo: prev.json.latestVersionNo,
    },
  });
  assert.strictEqual(con.status, 200, JSON.stringify(con.json));
  return con.json;
}

function field(fields, name) {
  return fields.find((f) => f.field === name);
}

test('同 id 事件自动配对（same_id）：逐项前后值与未配对事件', async () => {
  const e1 = await makeEvent('动员会', '旧描述');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: '口述甲' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '口述乙' });
  await makeRel(e1, e2, { source: '共同口述' });
  await publish(
    [
      { eventId: e1, claimId: c1 },
      { eventId: e2, claimId: c2 },
    ],
    0
  );

  // 草稿漂移：改标题/描述、改主张、删关系、加新事件
  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '动员大会', description: '新描述' } });
  await call('DELETE', `/api/editor/claims/${c1}`);
  const c1b = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '档案卷41', note: '日期有考异' });
  const e3 = await makeEvent('抽水机到站');
  const c3 = await makeClaim(e3, { precision: 'year', year: 1962, source: '口述丙' });
  await call('DELETE', `/api/editor/relations/1`);
  await publish(
    [
      { eventId: e1, claimId: c1b },
      { eventId: e2, claimId: c2 },
      { eventId: e3, claimId: c3 },
    ],
    1,
    { note: '二版' }
  );

  const r = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 2 },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const d = r.json;
  assert.strictEqual(d.code, 'VERSION_DIFF');
  assert.strictEqual(d.from.versionNo, 1);
  assert.strictEqual(d.to.versionNo, 2);
  assert.strictEqual(d.readOnly, true);

  // 配对：e1、e2 同 id；e3 只在新版，未配对
  assert.strictEqual(d.pairing.pairs.length, 2);
  assert.deepStrictEqual(d.pairing.pairs.map((p) => p.matchKind).sort(), ['same_id', 'same_id']);
  assert.strictEqual(d.pairing.autoPairCount, 2);
  assert.strictEqual(d.pairing.manualPairCount, 0);
  assert.deepStrictEqual(d.pairing.unpairedFrom.map((e) => e.eventId), []);
  assert.deepStrictEqual(d.pairing.unpairedTo.map((e) => e.eventId), [e3]);

  // e1 的逐项前后值
  const ev1 = d.eventDiffs.find((x) => x.fromEventId === e1);
  assert.strictEqual(ev1.changed, true);
  assert.strictEqual(field(ev1.fields, 'title').from, '动员会');
  assert.strictEqual(field(ev1.fields, 'title').to, '动员大会');
  assert.strictEqual(field(ev1.fields, 'description').from, '旧描述');
  assert.strictEqual(field(ev1.fields, 'description').to, '新描述');
  assert.strictEqual(field(ev1.fields, 'precision').from, 'year');
  assert.strictEqual(field(ev1.fields, 'precision').to, 'day');
  assert.strictEqual(field(ev1.fields, 'intervalStart').from, '1958-01-01');
  assert.strictEqual(field(ev1.fields, 'intervalStart').to, '1958-09-12');
  assert.strictEqual(field(ev1.fields, 'intervalEnd').from, '1958-12-31');
  assert.strictEqual(field(ev1.fields, 'intervalEnd').to, '1958-09-12');
  assert.strictEqual(field(ev1.fields, 'source').from, '口述甲');
  assert.strictEqual(field(ev1.fields, 'source').to, '档案卷41');
  assert.strictEqual(field(ev1.fields, 'claimNote').from, '');
  assert.strictEqual(field(ev1.fields, 'claimNote').to, '日期有考异');
  assert.strictEqual(field(ev1.fields, 'resolvedDate').changed, true);

  // e2 完全未变
  const ev2 = d.eventDiffs.find((x) => x.fromEventId === e2);
  assert.strictEqual(ev2.changed, false);
  assert.ok(ev2.fields.every((f) => !f.changed));

  // 关系：e1 先于 e2 在新版被移除（absent_in_to）
  assert.strictEqual(d.relations.removed.length, 1);
  assert.strictEqual(d.relations.removed[0].reason, 'absent_in_to');
  assert.strictEqual(d.relations.removed[0].earlier.fromEventId, e1);
  assert.strictEqual(d.relations.removed[0].later.fromEventId, e2);
  assert.strictEqual(d.relations.added.length, 0);
});

test('恢复后重新发布：新 id 经谱系自动配对（restore_lineage），不按标题猜测', async () => {
  const e1 = await makeEvent('老桥落成');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: '志书' });
  await publish([{ eventId: e1, claimId: c1 }], 0, { note: 'v1' });

  // 从第 1 版恢复：e1 得到全新草稿 id
  const restored = await restoreConfirm(1);
  const newId = restored.idMap.events[e1];
  assert.notStrictEqual(newId, e1);

  // 草稿里另建一个标题完全相同的事件（标题相似度不得用于配对）
  const decoy = await makeEvent('老桥落成');
  await makeClaim(decoy, { precision: 'year', year: 1990, source: '同名干扰' });
  const newClaim = restored.state.events.find((x) => x.id === newId).claims[0].id;
  const decoyClaim = (await call('GET', '/api/editor/state')).json.events.find((x) => x.id === decoy).claims[0].id;

  // 改一下恢复事件的主张，便于确认配对的是它而不是同名干扰
  await call('PUT', `/api/editor/claims/${newClaim}`, {
    body: { precision: 'day', year: 1958, month: 3, day: 1, source: '志书修订' },
  });
  await publish(
    [
      { eventId: newId, claimId: newClaim },
      { eventId: decoy, claimId: decoyClaim },
    ],
    1,
    { note: 'v2 after restore' }
  );

  const r = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 2 },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const d = r.json;

  // 恢复事件按谱系配对（异 id）；同名干扰事件列为未配对
  assert.strictEqual(d.pairing.pairs.length, 1);
  const p = d.pairing.pairs[0];
  assert.strictEqual(p.fromEventId, e1);
  assert.strictEqual(p.toEventId, newId);
  assert.strictEqual(p.matchKind, 'restore_lineage');
  assert.strictEqual(p.fromTitle, '老桥落成');
  assert.strictEqual(p.toTitle, '老桥落成');
  assert.deepStrictEqual(d.pairing.unpairedTo.map((e) => e.eventId), [decoy]);
  assert.deepStrictEqual(d.pairing.unpairedFrom, []);

  const diff = d.eventDiffs[0];
  assert.strictEqual(diff.toEventId, newId);
  assert.strictEqual(field(diff.fields, 'source').to, '志书修订');
  assert.strictEqual(field(diff.fields, 'precision').to, 'day');
});

test('多次恢复后谱系跨版本仍可身份证明（v1 对 v3）', async () => {
  const e1 = await makeEvent('甲');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  await publish([{ eventId: e1, claimId: c1 }], 0);

  const r1 = await restoreConfirm(1);
  const id2 = r1.idMap.events[e1];
  const cid2 = r1.state.events[0].claims[0].id;
  await publish([{ eventId: id2, claimId: cid2 }], 1); // 第 2 版

  const r2 = await restoreConfirm(2);
  const id3 = r2.idMap.events[id2];
  assert.notStrictEqual(id3, id2);
  const cid3 = r2.state.events[0].claims[0].id;
  await publish([{ eventId: id3, claimId: cid3 }], 2); // 第 3 版

  const r = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 3 },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.pairing.pairs.length, 1);
  assert.strictEqual(r.json.pairing.pairs[0].fromEventId, e1);
  assert.strictEqual(r.json.pairing.pairs[0].toEventId, id3);
  assert.strictEqual(r.json.pairing.pairs[0].matchKind, 'restore_lineage');
});

test('关系对照：出处 / 备注变化为修改；同端点多条无法对应时只列增删', async () => {
  const e1 = await makeEvent('A');
  const e2 = await makeEvent('B');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  const c2 = await makeClaim(e2, { precision: 'year', year: 1960, source: 's' });

  // 第 1 版：一条 A->B（出处 src1）+ 一条 C 不参与（让 A->B 唯一）
  const rid = await makeRel(e1, e2, { source: 'src1' });
  await publish(
    [
      { eventId: e1, claimId: c1 },
      { eventId: e2, claimId: c2 },
    ],
    0
  );

  // 第 2 版：A->B 改备注（同端点唯一 → 修改）
  const st = await call('GET', '/api/editor/state');
  const currentRel = st.json.relations[0];
  // 草稿关系没有 PUT 接口：删除后按同端点重建
  await call('DELETE', `/api/editor/relations/${currentRel.id}`);
  const rid2 = await makeRel(e1, e2, { source: 'src1', note: '新增备注' });
  assert.strictEqual(rid, 1);
  assert.notStrictEqual(rid2, rid);
  await publish(
    [
      { eventId: e1, claimId: c1 },
      { eventId: e2, claimId: c2 },
    ],
    1
  );

  let r = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 2 },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.relations.changed.length, 1);
  const ch = r.json.relations.changed[0];
  assert.strictEqual(ch.relationIdFrom, 1);
  assert.strictEqual(ch.relationIdTo, 2);
  assert.strictEqual(field(ch.fields, 'note').from, '');
  assert.strictEqual(field(ch.fields, 'note').to, '新增备注');
  assert.strictEqual(field(ch.fields, 'source').changed, false);
  assert.strictEqual(r.json.relations.unchanged.length, 0);
  assert.strictEqual(r.json.relations.added.length, 0);
  assert.strictEqual(r.json.relations.removed.length, 0);

  // 第 3 版：同端点 A->B 出现两条（草稿录入层允许重复边）→ 只列增删
  await makeRel(e1, e2, { source: 'src2' });
  await publish(
    [
      { eventId: e1, claimId: c1 },
      { eventId: e2, claimId: c2 },
    ],
    2
  );
  r = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 2, toVersionNo: 3 },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.relations.changed.length, 0);
  assert.strictEqual(r.json.relations.unchanged.length, 0);
  assert.strictEqual(r.json.relations.removed.length, 1);
  assert.strictEqual(r.json.relations.added.length, 2);
  assert.ok(r.json.relations.removed.every((x) => x.reason === 'ambiguous_endpoint_group'));
  assert.ok(r.json.relations.added.every((x) => x.reason === 'ambiguous_endpoint_group'));
  assert.deepStrictEqual(r.json.relations.added[0].groupSize, { from: 1, to: 2 });
});

test('端点未配对的关系：随未配对事件列入新增 / 移除', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  const c2 = await makeClaim(e2, { precision: 'year', year: 1960, source: 's' });
  await makeRel(e1, e2, { source: 'rel' });
  await publish(
    [
      { eventId: e1, claimId: c1 },
      { eventId: e2, claimId: c2 },
    ],
    0
  );

  // 第 2 版：删除乙与关系，新增丙，甲 先于 丙
  await call('DELETE', `/api/editor/events/${e2}`);
  const e3 = await makeEvent('丙');
  const c3 = await makeClaim(e3, { precision: 'year', year: 1965, source: 's' });
  await makeRel(e1, e3, { source: 'rel2' });
  await publish(
    [
      { eventId: e1, claimId: c1 },
      { eventId: e3, claimId: c3 },
    ],
    1
  );

  const r = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 2 },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.pairing.pairs.length, 1);
  const removed = r.json.relations.removed.find((x) => x.reason === 'endpoint_unpaired');
  const added = r.json.relations.added.find((x) => x.reason === 'endpoint_unpaired');
  assert.ok(removed, '应列移除（端点未配对）');
  assert.ok(added, '应列新增（端点未配对）');
  assert.strictEqual(removed.later.fromEventId, e2);
  assert.strictEqual(removed.later.toEventId, null);
  assert.strictEqual(added.earlier.toEventId, e1);
  assert.strictEqual(added.later.toEventId, e3);
  assert.strictEqual(added.later.fromEventId, null);
});

test('人工配对：为谱系无法证明的事件指定一对一配对，随配对比较关系', async () => {
  // 两份完全独立的草稿（无恢复关系），各自发布一版，含一条同方向关系
  const a1 = await makeEvent('旧事件A');
  const b1 = await makeEvent('旧事件B');
  const ca1 = await makeClaim(a1, { precision: 'year', year: 1958, source: 's' });
  const cb1 = await makeClaim(b1, { precision: 'year', year: 1960, source: 's' });
  await makeRel(a1, b1, { source: '旧出处' });
  await publish(
    [
      { eventId: a1, claimId: ca1 },
      { eventId: b1, claimId: cb1 },
    ],
    0
  );

  // 清空草稿，模拟另一批编辑独立建库式录入
  mem.exec('DELETE FROM relations; DELETE FROM claims; DELETE FROM events;');
  const a2 = await makeEvent('新事件A');
  const b2 = await makeEvent('新事件B');
  const ca2 = await makeClaim(a2, { precision: 'month', year: 1958, month: 6, source: 's2' });
  const cb2 = await makeClaim(b2, { precision: 'year', year: 1961, source: 's' });
  await makeRel(a2, b2, { source: '新出处' });
  await publish(
    [
      { eventId: a2, claimId: ca2 },
      { eventId: b2, claimId: cb2 },
    ],
    1,
    { note: '独立第二版' }
  );

  // 不指定人工配对：全部未配对，关系全部按 endpoint_unpaired 增删
  let r = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 2 },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.pairing.pairs.length, 0);
  assert.strictEqual(r.json.pairing.unpairedFrom.length, 2);
  assert.strictEqual(r.json.pairing.unpairedTo.length, 2);
  assert.strictEqual(r.json.relations.changed.length, 0);

  // 指定一对一人工配对
  r = await call('POST', '/api/editor/versions/diff', {
    body: {
      fromVersionNo: 1,
      toVersionNo: 2,
      manualPairs: [
        { fromEventId: a1, toEventId: a2 },
        { fromEventId: b1, toEventId: b2 },
      ],
    },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.pairing.pairs.length, 2);
  assert.deepStrictEqual(r.json.pairing.pairs.map((p) => p.matchKind).sort(), ['manual', 'manual']);
  assert.strictEqual(r.json.pairing.manualPairCount, 2);
  assert.strictEqual(r.json.pairing.unpairedFrom.length, 0);
  // a1 的精度 / 区间变化
  const da = r.json.eventDiffs.find((x) => x.fromEventId === a1);
  assert.strictEqual(field(da.fields, 'precision').from, 'year');
  assert.strictEqual(field(da.fields, 'precision').to, 'month');
  // 配对后关系唯一对应：出处变化
  assert.strictEqual(r.json.relations.changed.length, 1);
  assert.strictEqual(field(r.json.relations.changed[0].fields, 'source').from, '旧出处');
  assert.strictEqual(field(r.json.relations.changed[0].fields, 'source').to, '新出处');
});

test('人工配对：重复 / 跨版不存在 / 与确定配对冲突逐项拒绝（400 PAIR_INVALID）', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  const c2 = await makeClaim(e2, { precision: 'year', year: 1960, source: 's' });
  await publish(
    [
      { eventId: e1, claimId: c1 },
      { eventId: e2, claimId: c2 },
    ],
    0
  );
  // 第 2 版同草稿（same_id 确定配对已存在），另加新事件 e3
  const e3 = await makeEvent('丙');
  const c3 = await makeClaim(e3, { precision: 'year', year: 1970, source: 's' });
  await publish(
    [
      { eventId: e1, claimId: c1 },
      { eventId: e2, claimId: c2 },
      { eventId: e3, claimId: c3 },
    ],
    1
  );

  const r = await call('POST', '/api/editor/versions/diff', {
    body: {
      fromVersionNo: 1,
      toVersionNo: 2,
      manualPairs: [
        { fromEventId: e1, toEventId: e3 }, // 与 e1↔e1 的 same_id 确定配对冲突
        { fromEventId: e2, toEventId: e3 }, // to 与上一条重复 → duplicated_to
        { fromEventId: e1, toEventId: e2 }, // from 与第一条重复 → duplicated_from
        { fromEventId: e1, toEventId: e3 }, // 整条重复 → duplicated_pair
        { fromEventId: 999, toEventId: e1 }, // 旧版事件不存在
        { fromEventId: e1, toEventId: 888 }, // 新版事件不存在
        { fromEventId: 'x', toEventId: null }, // 非法
      ],
    },
  });
  assert.strictEqual(r.status, 400, JSON.stringify(r.json));
  assert.strictEqual(r.json.code, 'PAIR_INVALID');
  const reasons = r.json.invalidPairs.map((p) => p.reason);
  assert.ok(reasons.includes('conflict_with_pair'));
  assert.ok(reasons.includes('duplicated_from'));
  assert.ok(reasons.includes('from_event_not_found'));
  assert.ok(reasons.includes('to_event_not_found'));
  assert.ok(reasons.includes('invalid_pair'));
  // 冲突项带既有配对信息
  const conflict = r.json.invalidPairs.find((p) => p.reason === 'conflict_with_pair');
  assert.ok(conflict.existingToEventId !== null || conflict.existingFromEventId !== null);
});

test('人工配对：与已有确定配对相同则幂等，不报错', async () => {
  const e1 = await makeEvent('甲');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  await publish([{ eventId: e1, claimId: c1 }], 0);
  await publish([{ eventId: e1, claimId: c1 }], 1);

  const r = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 2, manualPairs: [{ fromEventId: e1, toEventId: e1 }] },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.pairing.pairs.length, 1);
  assert.strictEqual(r.json.pairing.pairs[0].matchKind, 'same_id');
  assert.strictEqual(r.json.pairing.manualPairCount, 0);
});

test('同一版本自相对照：全部 same_id 配对且无变化', async () => {
  const e1 = await makeEvent('甲');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  await publish([{ eventId: e1, claimId: c1 }], 0);

  const r = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 1 },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.pairing.pairs.length, 1);
  assert.strictEqual(r.json.pairing.pairs[0].matchKind, 'same_id');
  assert.strictEqual(r.json.eventDiffs[0].changed, false);
  assert.strictEqual(r.json.relations.added.length + r.json.relations.removed.length, 0);
});

test('未知版本明确 404；非法版本号 400；对照只读不推进修订号；需要口令', async () => {
  const e1 = await makeEvent('甲');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  await publish([{ eventId: e1, claimId: c1 }], 0);
  const revisionBefore = (await call('GET', '/api/editor/state')).json.draftRevision;

  const missing = await call('POST', '/api/editor/versions/diff', { body: { fromVersionNo: 1, toVersionNo: 99 } });
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.json.code, 'VERSION_NOT_FOUND');
  assert.strictEqual(missing.json.versionNo, 99);

  const missingFrom = await call('POST', '/api/editor/versions/diff', { body: { fromVersionNo: 7, toVersionNo: 1 } });
  assert.strictEqual(missingFrom.status, 404);
  assert.strictEqual(missingFrom.json.versionNo, 7);

  const bad = await call('POST', '/api/editor/versions/diff', { body: { fromVersionNo: 0, toVersionNo: 1 } });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.json.code, 'VERSION_NO_INVALID');
  const bad2 = await call('POST', '/api/editor/versions/diff', { body: { fromVersionNo: 'x', toVersionNo: 1 } });
  assert.strictEqual(bad2.status, 400);

  // 只读：修订号不变
  await call('POST', '/api/editor/versions/diff', { body: { fromVersionNo: 1, toVersionNo: 1 } });
  assert.strictEqual((await call('GET', '/api/editor/state')).json.draftRevision, revisionBefore);

  // 历史快照可照常用于既有接口（兼容性）
  const detail = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.json.version.versionNo, 1);

  // 需要编辑口令
  const noToken = await call('POST', '/api/editor/versions/diff', {
    token: null,
    body: { fromVersionNo: 1, toVersionNo: 1 },
  });
  assert.strictEqual(noToken.status, 401);
});
