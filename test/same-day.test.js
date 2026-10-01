'use strict';

// 「同日」关系端到端测试：
//   录入 / 删除推进草稿修订号；同日连通组求解；
//   组内先于、区间无交集、折叠成环拒绝发布；
//   快照写入、访客可见、恢复重建、版本对照、改选建议。
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
    DELETE FROM version_same_day_relations;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM event_lineage;
    DELETE FROM same_day_relations;
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

async function makeEvent(title) {
  const r = await call('POST', '/api/editor/events', { body: { title } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}
async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}
async function makeRel(a, b, extra = {}) {
  const r = await call('POST', '/api/editor/relations', {
    body: { earlierId: a, laterId: b, source: extra.source || '', note: extra.note || '' },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}
async function makeSd(a, b, extra = {}) {
  const r = await call('POST', '/api/editor/same-day-relations', {
    body: { eventAId: a, eventBId: b, source: extra.source || '', note: extra.note || '' },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.sameDayRelation.id;
}
function day(y, m, d, source = 's') { return { precision: 'day', year: y, month: m, day: d, source }; }
function month(y, m, source = 's') { return { precision: 'month', year: y, month: m, source }; }
function year(y, source = 's') { return { precision: 'year', year: y, source }; }
async function revision() {
  return (await call('GET', '/api/editor/state')).json.draftRevision;
}
async function publish(selection, baseVersionNo = 0, extra = {}) {
  return call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo, editor: extra.editor || '测试', note: extra.note || '' },
  });
}

// ---------- 录入与修订号 ----------

test('同日关系录入：端点不分先后、按 id 归一化；需口令；自环 400', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');

  // 反序提交，存储仍按 id 升序
  const id = await makeSd(e2, e1, { source: '同日口述' });
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.sameDayRelations.length, 1);
  assert.deepStrictEqual(
    { a: st.json.sameDayRelations[0].eventAId, b: st.json.sameDayRelations[0].eventBId },
    { a: e1, b: e2 }
  );

  const noToken = await call('POST', '/api/editor/same-day-relations', { token: null, body: { eventAId: e1, eventBId: e2 } });
  assert.strictEqual(noToken.status, 401);

  const self = await call('POST', '/api/editor/same-day-relations', { body: { eventAId: e1, eventBId: e1 } });
  assert.strictEqual(self.status, 400);

  const missing = await call('POST', '/api/editor/same-day-relations', { body: { eventAId: e1, eventBId: 999 } });
  assert.strictEqual(missing.status, 404);

  // 删除
  const del = await call('DELETE', `/api/editor/same-day-relations/${id}`);
  assert.strictEqual(del.status, 200);
  assert.strictEqual((await call('GET', '/api/editor/state')).json.sameDayRelations.length, 0);
  const delAgain = await call('DELETE', `/api/editor/same-day-relations/${id}`);
  assert.strictEqual(delAgain.status, 404);
});

test('同日关系录入 / 删除推进草稿修订号', async () => {
  const e1 = await makeEvent('甲'); // rev 1
  const e2 = await makeEvent('乙'); // rev 2
  assert.strictEqual(await revision(), 2);
  const id = await makeSd(e1, e2); // rev 3
  assert.strictEqual(await revision(), 3);
  await call('DELETE', `/api/editor/same-day-relations/${id}`); // rev 4
  assert.strictEqual(await revision(), 4);
});

// ---------- 求解 ----------

test('同日连通组共享同一具体日期，组间先于至少相差一天', async () => {
  const e1 = await makeEvent('早会');
  const e2 = await makeEvent('同日另事');
  const e3 = await makeEvent('次日事');
  const c1 = await makeClaim(e1, month(1958, 3));
  const c2 = await makeClaim(e2, day(1958, 3, 15));
  const c3 = await makeClaim(e3, month(1958, 3));
  await makeSd(e1, e2, { source: '同日依据' });
  await makeRel(e2, e3);

  const val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }] },
  });
  assert.strictEqual(val.json.ok, true, JSON.stringify(val.json));
  const pv = new Map(val.json.preview.map((p) => [p.eventId, p.resolvedDate]));
  assert.strictEqual(pv.get(e1), '1958-03-15'); // 组共享日期 = 日精度事件的当天
  assert.strictEqual(pv.get(e2), '1958-03-15');
  assert.strictEqual(pv.get(e3), '1958-03-16'); // 组间先于至少一天
  assert.deepStrictEqual(val.json.sameDayGroups, [{ eventIds: [e1, e2], resolvedDate: '1958-03-15' }]);
});

test('同日关系可传递：A 同日 B、B 同日 C => 三者同日', async () => {
  const a = await makeEvent('A');
  const b = await makeEvent('B');
  const c = await makeEvent('C');
  const ca = await makeClaim(a, month(1958, 5));
  const cb = await makeClaim(b, day(1958, 5, 20));
  const cc = await makeClaim(c, month(1958, 5));
  await makeSd(a, b);
  await makeSd(b, c);

  const val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: a, claimId: ca }, { eventId: b, claimId: cb }, { eventId: c, claimId: cc }] },
  });
  assert.strictEqual(val.json.ok, true, JSON.stringify(val.json));
  assert.deepStrictEqual(val.json.sameDayGroups[0].eventIds.sort((x, y) => x - y), [a, b, c]);
  assert.strictEqual(val.json.sameDayGroups[0].resolvedDate, '1958-05-20');
});

test('拒绝发布：同日组内存在先于链（422 same_day_conflict，指出事件与两类关系；上一版本不变）', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const e3 = await makeEvent('丙');
  const c1 = await makeClaim(e1, year(1958));
  const c2 = await makeClaim(e2, year(1958));
  const c3 = await makeClaim(e3, year(1958));
  // 先发一版好的
  const ok = await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }], 0);
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));

  const sdId = await makeSd(e1, e3); // e1 同日 e3
  const relId = await makeRel(e1, e2);
  await makeRel(e2, e3); // e1 先于 e2 先于 e3，与「e1 同日 e3」矛盾

  const bad = await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }], 1);
  assert.strictEqual(bad.status, 422, JSON.stringify(bad.json));
  const err = bad.json.errors[0];
  assert.strictEqual(err.type, 'same_day_conflict');
  // 同日组两端 e1、e3 必在事件列表；中间事件 e2 也随见证链列出以便定位
  assert.ok(err.eventIds.includes(e1));
  assert.ok(err.eventIds.includes(e3));
  // 见证链上的先于关系被指出（e1->e2 与 e2->e3）
  assert.ok(err.relationIds.includes(relId));
  assert.ok(err.sameDayRelationIds.includes(sdId));
  assert.match(err.message, /同日/);

  // 上一版本不变
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);

  // 预检同样报错且可定位
  const val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }] },
  });
  assert.strictEqual(val.json.ok, false);
  assert.strictEqual(val.json.errors[0].type, 'same_day_conflict');
});

test('拒绝发布：同日组内日期区间无交集（422 same_day_interval）', async () => {
  const e1 = await makeEvent('一月事');
  const e2 = await makeEvent('腊月事');
  const c1 = await makeClaim(e1, month(1958, 1));
  const c2 = await makeClaim(e2, month(1958, 12));
  await makeSd(e1, e2);

  const r = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] },
  });
  assert.strictEqual(r.json.ok, false);
  assert.strictEqual(r.json.errors[0].type, 'same_day_interval');
  assert.deepStrictEqual(new Set(r.json.errors[0].eventIds), new Set([e1, e2]));

  const pub = await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0);
  assert.strictEqual(pub.status, 422);
});

test('拒绝发布：折叠同日组后先于成环（422 cycle，指出组、事件与关系）', async () => {
  // G1={1,2 同日}，G2={3}。环 G1 -> G2 -> G1 但从 G1 的同一成员出入（e1），
  // 同日组内并不存在两个不同成员间的先于链 → 属组间折叠成环（cycle）。
  const e1 = await makeEvent('G1-甲');
  const e2 = await makeEvent('G1-乙');
  const e3 = await makeEvent('G2');
  const c1 = await makeClaim(e1, year(1958));
  const c2 = await makeClaim(e2, year(1958));
  const c3 = await makeClaim(e3, year(1958));
  await makeSd(e1, e2);
  const r1 = await makeRel(e1, e3); // G1（从 e1 出）-> G2
  const r2 = await makeRel(e3, e1); // G2 -> G1（回到 e1 同一成员）

  const pub = await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }], 0);
  assert.strictEqual(pub.status, 422);
  const err = pub.json.errors[0];
  assert.strictEqual(err.type, 'cycle');
  assert.deepStrictEqual(new Set(err.eventIds), new Set([e1, e2, e3]));
  assert.deepStrictEqual(new Set(err.relationIds), new Set([r1, r2]));
  assert.match(err.message, /成环/);
});

test('组间先后与粗精度区间：同日组下界被前一组推后仍可行', async () => {
  // G1={1 日精度 1958-03-10}；G2={2 月精度 1958-03}
  // G1 先于 G2 => G2 最早 1958-03-11，在 3 月内可行
  const e1 = await makeEvent('初十日');
  const e2 = await makeEvent('同月稍后');
  const c1 = await makeClaim(e1, day(1958, 3, 10));
  const c2 = await makeClaim(e2, month(1958, 3));
  await makeRel(e1, e2);

  const val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] },
  });
  assert.strictEqual(val.json.ok, true);
  const pv = new Map(val.json.preview.map((p) => [p.eventId, p.resolvedDate]));
  assert.strictEqual(pv.get(e2), '1958-03-11');
});

test('组间先后时间无解：见证链包含同日组（temporal）', async () => {
  // G1={1,2 同日}：e1 日精度 1958-03-31、e2 月精度 3 月 => 组只能取 03-31
  // G2={3} 月精度 1958-03；G1 先于 G2 => G2 最早 04-01，超出 3 月 => 无解
  const e1 = await makeEvent('组1-甲');
  const e2 = await makeEvent('组1-乙');
  const e3 = await makeEvent('组2');
  const c1 = await makeClaim(e1, day(1958, 3, 31));
  const c2 = await makeClaim(e2, month(1958, 3));
  const c3 = await makeClaim(e3, month(1958, 3));
  await makeSd(e1, e2);
  await makeRel(e2, e3);

  const val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }] },
  });
  assert.strictEqual(val.json.ok, false);
  assert.strictEqual(val.json.errors[0].type, 'temporal');
  assert.ok(val.json.errors[0].eventIds.includes(e1));
  assert.ok(val.json.errors[0].eventIds.includes(e3));
});

// ---------- 快照 / 访客 ----------

test('发布快照写入同日关系；访客年表展示；删除草稿不影响快照', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, day(1958, 5, 1));
  const c2 = await makeClaim(e2, month(1958, 5));
  const sdId = await makeSd(e1, e2, { source: '档案同日记载' });

  const pub = await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0, { note: '含同日' });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  assert.strictEqual(pub.json.version.sameDayRelations.length, 1);
  assert.strictEqual(pub.json.version.sameDayRelations[0].source, '档案同日记载');
  assert.strictEqual(pub.json.version.sameDayRelationCount, 1);
  assert.deepStrictEqual(
    pub.json.version.sameDayRelations[0],
    { sameDayRelationId: sdId, eventAId: e1, eventBId: e2, source: '档案同日记载', note: '' }
  );
  // 组内求解日期相同
  const dates = new Map(pub.json.version.events.map((e) => [e.eventId, e.resolvedDate]));
  assert.strictEqual(dates.get(e1), dates.get(e2));

  // 访客接口
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.version.sameDayRelations.length, 1);
  assert.strictEqual(view.json.version.sameDayRelationCount, 1);
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.json.version.sameDayRelations.length, 1);

  // 草稿删除同日关系后，旧版快照不变
  await call('DELETE', `/api/editor/same-day-relations/${sdId}`);
  const v1b = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1b.json.version.sameDayRelations.length, 1);
});

// ---------- 恢复 ----------

test('从历史版本恢复：重建同日关系并返回 id 映射；谱系身份在对照中延续', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, day(1958, 6, 1));
  const c2 = await makeClaim(e2, month(1958, 6));
  const sdId = await makeSd(e1, e2, { source: '同日出处' });
  const pub = await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0);
  assert.strictEqual(pub.status, 201);

  // 草稿漂移
  const e3 = await makeEvent('草稿新增丙');
  await makeClaim(e3, year(2000));

  const preview = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 1 } });
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.json.snapshot.sameDayRelations.length, 1);
  assert.strictEqual(preview.json.currentDraft.sameDayRelations.length, 1);

  const con = await call('POST', '/api/editor/restore/confirm', {
    body: {
      versionNo: 1,
      draftRevision: preview.json.draftRevision,
      expectedLatestVersionNo: preview.json.latestVersionNo,
    },
  });
  assert.strictEqual(con.status, 200, JSON.stringify(con.json));

  // 同日关系已按新事件 id 重建
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.events.length, 2);
  assert.strictEqual(st.json.sameDayRelations.length, 1);
  const newSd = st.json.sameDayRelations[0];
  assert.strictEqual(newSd.source, '同日出处');
  const newIds = st.json.events.map((e) => e.id).sort((a, b) => a - b);
  assert.deepStrictEqual([newSd.eventAId, newSd.eventBId], newIds);
  // id 映射含同日关系
  assert.strictEqual(con.json.idMap.sameDayRelations[sdId], newSd.id);

  // 恢复后的同日组仍可正常求解与再发布
  const newJia = st.json.events.find((e) => e.title === '甲').id;
  const newYi = st.json.events.find((e) => e.title === '乙').id;
  const sel = st.json.events.map((e) => ({ eventId: e.id, claimId: e.claims[0].id }));
  const pub2 = await publish(sel, 1, { editor: '恢复后' });
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));

  // 跨恢复对照：事件按 restore_lineage 配对；同日关系应无变化
  const diff = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 2 },
  });
  assert.strictEqual(diff.status, 200);
  const pair = diff.json.pairing.pairs.find((p) => p.fromEventId === e1);
  assert.strictEqual(pair.matchKind, 'restore_lineage');
  assert.strictEqual(pair.toEventId, newJia);
  assert.strictEqual(diff.json.sameDayRelations.unchanged.length, 1);
  assert.strictEqual(diff.json.sameDayRelations.added.length, 0);
  assert.strictEqual(diff.json.sameDayRelations.removed.length, 0);
  assert.strictEqual(diff.json.sameDayRelations.changed.length, 0);
  assert.ok(newIds.includes(newJia) && newIds.includes(newYi));
});

// ---------- 版本对照 ----------

test('两版对照：同日关系新增 / 移除 / 修改 / 无变化', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const e3 = await makeEvent('丙');
  const c1 = await makeClaim(e1, year(1958));
  const c2 = await makeClaim(e2, year(1958));
  const c3 = await makeClaim(e3, year(1958));
  await makeSd(e1, e2, { source: '同源于口述' }); // 第 1 版：1-2 同日
  await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }], 0);

  // 第 2 版：1-2 同日备注/出处改为新出处；新增 2-3 同日
  const rows = await call('GET', '/api/editor/state');
  const sd12 = rows.json.sameDayRelations[0].id;
  await call('DELETE', `/api/editor/same-day-relations/${sd12}`);
  await makeSd(e1, e2, { source: '档案新出处' });
  await makeSd(e2, e3, { source: '新增同日' });
  const pub2 = await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }], 1);
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));

  const diff = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 2 },
  });
  assert.strictEqual(diff.status, 200, JSON.stringify(diff.json));
  const sd = diff.json.sameDayRelations;
  assert.strictEqual(sd.added.length, 1);
  assert.strictEqual(sd.added[0].reason, 'absent_in_from');
  assert.deepStrictEqual(
    sd.added[0].endpoints.map((x) => x.toEventId).sort((a, b) => a - b),
    [e2, e3]
  );
  assert.strictEqual(sd.changed.length, 1);
  const field = sd.changed[0].fields.find((f) => f.field === 'source');
  assert.strictEqual(field.changed, true);
  assert.strictEqual(field.from, '同源于口述');
  assert.strictEqual(field.to, '档案新出处');
  assert.strictEqual(sd.removed.length, 0);
  assert.strictEqual(sd.unchanged.length, 0);
});

test('两版对照：同日关系随未配对事件列入增删', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, year(1958));
  const c2 = await makeClaim(e2, year(1958));
  await makeSd(e1, e2);
  await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0);

  // 直接改草稿为全新两事件（谱系无关），发布第 2 版
  const rows = await call('GET', '/api/editor/state');
  for (const r of rows.json.sameDayRelations) {
    await call('DELETE', `/api/editor/same-day-relations/${r.id}`);
  }
  await call('DELETE', `/api/editor/events/${e1}`);
  await call('DELETE', `/api/editor/events/${e2}`);
  const n1 = await makeEvent('新甲');
  const n2 = await makeEvent('新乙');
  const cn1 = await makeClaim(n1, year(1959));
  const cn2 = await makeClaim(n2, year(1959));
  await makeSd(n1, n2);
  const pub2 = await publish([{ eventId: n1, claimId: cn1 }, { eventId: n2, claimId: cn2 }], 1);
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));

  const diff = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 2 },
  });
  assert.strictEqual(diff.status, 200);
  assert.strictEqual(diff.json.sameDayRelations.removed.length, 1);
  assert.strictEqual(diff.json.sameDayRelations.removed[0].reason, 'endpoint_unpaired');
  assert.strictEqual(diff.json.sameDayRelations.added.length, 1);
  assert.strictEqual(diff.json.sameDayRelations.added[0].reason, 'endpoint_unpaired');
});

test('两版对照：同端点多条同日关系无法唯一对应时只列增删', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, year(1958));
  const c2 = await makeClaim(e2, year(1958));
  // 第 1 版：同端点两条
  await makeSd(e1, e2, { source: '出处一' });
  await makeSd(e1, e2, { source: '出处二' });
  await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0);

  const st1 = await call('GET', '/api/editor/state');
  for (const r of st1.json.sameDayRelations) {
    await call('DELETE', `/api/editor/same-day-relations/${r.id}`);
  }
  // 第 2 版：同端点两条（内容不同）
  await makeSd(e1, e2, { source: '出处三' });
  await makeSd(e1, e2, { source: '出处四' });
  const pub2 = await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 1);
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));

  const diff = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 2 },
  });
  assert.strictEqual(diff.status, 200);
  assert.strictEqual(diff.json.sameDayRelations.removed.length, 2);
  assert.strictEqual(diff.json.sameDayRelations.added.length, 2);
  assert.ok(diff.json.sameDayRelations.removed.every((r) => r.reason === 'ambiguous_endpoint_group'));
  assert.strictEqual(diff.json.sameDayRelations.changed.length, 0);
});

// ---------- 改选建议 ----------

test('改选建议：同日区间无交集时可靠改选解决（组为单位搜索）', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, month(1958, 1)); // 当前：1 月
  const c1b = await makeClaim(e1, day(1958, 6, 15)); // 备选：与 6 月同日
  const c2 = await makeClaim(e2, month(1958, 6));
  await makeSd(e1, e2);

  const val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] },
  });
  assert.strictEqual(val.json.ok, false);
  assert.strictEqual(val.json.errors[0].type, 'same_day_interval');

  const sug = await call('POST', '/api/editor/suggest-reselection', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }],
      draftRevision: val.json.draftRevision,
    },
  });
  assert.strictEqual(sug.status, 200, JSON.stringify(sug.json));
  assert.strictEqual(sug.json.changedEventCount, 1);
  assert.strictEqual(sug.json.changes[0].eventId, e1);
  assert.strictEqual(sug.json.changes[0].toClaimId, c1b);
  const dates = new Map(sug.json.selection.map((s) => [s.eventId, s.resolvedDate]));
  assert.strictEqual(dates.get(e1), '1958-06-15');
  assert.strictEqual(dates.get(e2), '1958-06-15'); // 同日共享
});

test('改选建议：同日组内先于冲突无法靠改选解决 → 422 same_day_conflict', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, year(1958));
  const c2 = await makeClaim(e2, year(1959));
  await makeSd(e1, e2);
  await makeRel(e1, e2);

  const r = await call('POST', '/api/editor/suggest-reselection', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], draftRevision: await revision() },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.code, 'UNRESOLVABLE_BY_RESELECTION');
  assert.strictEqual(r.json.reason, 'same_day_conflict');
  assert.ok(r.json.relationIds.length >= 1);
  assert.ok(r.json.sameDayRelationIds.length >= 1);
});

test('改选建议：同日组所有组合区间都无交集 → 422 no_feasible_combination', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  await makeClaim(e1, year(1958));
  await makeClaim(e1, month(1958, 1));
  await makeClaim(e2, year(1959));
  await makeClaim(e2, month(1959, 12));
  await makeSd(e1, e2); // 1958 的任何区间与 1959 的任何区间均无交集

  const st = await call('GET', '/api/editor/state');
  const c1 = st.json.events.find((e) => e.id === e1).claims[0].id;
  const c2 = st.json.events.find((e) => e.id === e2).claims[0].id;
  const r = await call('POST', '/api/editor/suggest-reselection', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], draftRevision: await revision() },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.reason, 'no_feasible_combination');
});

test('改选建议（同日）：改选数最少 + 平手按事件 id 主张序列字典序', async () => {
  // G={1,2 同日}，e1 当前 1 月、e2 固定 6 月；e1 有两个 6 月备选 #小 / #大。
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  await makeClaim(e1, month(1958, 1)); // 当前（矛盾）
  const altSmall = await makeClaim(e1, day(1958, 6, 20)); // 先插入，id 小
  const altBig = await makeClaim(e1, day(1958, 6, 25));
  const c2 = await makeClaim(e2, month(1958, 6));
  await makeSd(e1, e2);

  const st = await call('GET', '/api/editor/state');
  const cur1 = st.json.events.find((e) => e.id === e1).claims[0].id;
  const r = await call('POST', '/api/editor/suggest-reselection', {
    body: { selection: [{ eventId: e1, claimId: cur1 }, { eventId: e2, claimId: c2 }], draftRevision: await revision() },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.changedEventCount, 1);
  assert.strictEqual(r.json.changes[0].toClaimId, altSmall);
  assert.ok(altSmall < altBig);
});
