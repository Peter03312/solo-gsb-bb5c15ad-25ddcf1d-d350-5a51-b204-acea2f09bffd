'use strict';

// 「同日」关系端到端测试：录入/删除、修订号、求解三类拒绝、不可变快照、
// 访客可见、恢复重建、无向归一化、版本对照。
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
async function makeRel(a, b, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId: a, laterId: b, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}
async function makeSdr(a, b, extra = {}) {
  const r = await call('POST', '/api/editor/same-day-relations', {
    body: { eventAId: a, eventBId: b, source: extra.source || '', note: extra.note || '' },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.sameDayRelation;
}
async function revision() {
  return (await call('GET', '/api/editor/state')).json.draftRevision;
}

function day(y, m, d, source = 's') { return { precision: 'day', year: y, month: m, day: d, source }; }
function month(y, m, source = 's') { return { precision: 'month', year: y, month: m, source }; }
function year(y, source = 's') { return { precision: 'year', year: y, source }; }

test('同日关系录入：两端无向归一化、state 暴露、口令保护', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const noToken = await call('POST', '/api/editor/same-day-relations', {
    token: null,
    body: { eventAId: e1, eventBId: e2 },
  });
  assert.strictEqual(noToken.status, 401);

  // 反序提交仍归一为小 id 在前
  const sdr = await makeSdr(e2, e1, { source: '两张照片同一日', note: '备注' });
  assert.strictEqual(sdr.eventAId, e1);
  assert.strictEqual(sdr.eventBId, e2);
  assert.strictEqual(sdr.source, '两张照片同一日');

  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.sameDayRelations.length, 1);
  assert.deepStrictEqual(
    st.json.sameDayRelations[0],
    { id: sdr.id, eventAId: e1, eventBId: e2, source: '两张照片同一日', note: '备注' }
  );
});

test('同日关系录入校验：自身 400、事件不存在 404、id 非整数 400', async () => {
  const e1 = await makeEvent('甲');
  const self = await call('POST', '/api/editor/same-day-relations', { body: { eventAId: e1, eventBId: e1 } });
  assert.strictEqual(self.status, 400);
  const bad = await call('POST', '/api/editor/same-day-relations', { body: { eventAId: e1, eventBId: 999 } });
  assert.strictEqual(bad.status, 404);
  const nan = await call('POST', '/api/editor/same-day-relations', { body: { eventAId: 'x', eventBId: e1 } });
  assert.strictEqual(nan.status, 400);
});

test('同日关系增删推进草稿修订号；删除不存在 404', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const r0 = await revision();
  const sdr = await makeSdr(e1, e2);
  assert.strictEqual(await revision(), r0 + 1);
  const del = await call('DELETE', `/api/editor/same-day-relations/${sdr.id}`);
  assert.strictEqual(del.status, 200);
  assert.strictEqual(await revision(), r0 + 2);
  const delAgain = await call('DELETE', `/api/editor/same-day-relations/${sdr.id}`);
  assert.strictEqual(delAgain.status, 404);
});

test('同日组区间相交：共享同一具体日并写入不可变快照，访客可见', async () => {
  const e1 = await makeEvent('上午开会');
  const e2 = await makeEvent('下午照相');
  const c1 = await makeClaim(e1, month(1958, 3));
  const c2 = await makeClaim(e2, day(1958, 3, 20));
  await makeSdr(e1, e2, { source: '王秀兰：同一天的事' });

  const val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] },
  });
  assert.strictEqual(val.status, 200);
  assert.strictEqual(val.json.ok, true, JSON.stringify(val.json));
  const dates = Object.fromEntries(val.json.preview.map((p) => [p.eventId, p.resolvedDate]));
  assert.strictEqual(dates[e1], dates[e2]);
  assert.strictEqual(dates[e2], '1958-03-20'); // 组区间交集起点（月区间与当天交集）

  const pub = await call('POST', '/api/editor/publish', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }],
      baseVersionNo: 0,
    },
  });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  assert.strictEqual(pub.json.version.sameDayRelationCount, 1);
  const snap = pub.json.version.sameDayRelations[0];
  assert.strictEqual(snap.eventAId, e1);
  assert.strictEqual(snap.eventBId, e2);
  assert.strictEqual(snap.source, '王秀兰：同一天的事');
  // 两事件求解日期相同
  const d1 = pub.json.version.events.find((e) => e.eventId === e1).resolvedDate;
  const d2 = pub.json.version.events.find((e) => e.eventId === e2).resolvedDate;
  assert.strictEqual(d1, d2);

  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.version.sameDayRelations.length, 1);
  assert.strictEqual(view.json.version.sameDayRelations[0].source, '王秀兰：同一天的事');
});

test('组内存在先于：预检与发布拒绝 same_day_before，指出事件与两类关系，上一版本不变', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, year(1958));
  const c2 = await makeClaim(e2, year(1958));
  const sdrId = (await makeSdr(e1, e2)).id;
  const relId = await makeRel(e1, e2, '冲突出处');

  const val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] },
  });
  assert.strictEqual(val.json.ok, false);
  const err = val.json.errors[0];
  assert.strictEqual(err.type, 'same_day_before');
  assert.deepStrictEqual(new Set(err.eventIds), new Set([e1, e2]));
  assert.deepStrictEqual(err.relationIds, [relId]);
  assert.deepStrictEqual(err.sameDayRelationIds, [sdrId]);

  // 先发过一版好的，再验证拒绝发布时上一版不变
  await call('DELETE', `/api/editor/relations/${relId}`);
  const ok = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 0 },
  });
  assert.strictEqual(ok.status, 201);
  await makeRel(e1, e2, '冲突出处'); // 重新制造冲突
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 1 },
  });
  assert.strictEqual(pub.status, 422);
  assert.strictEqual(pub.json.errors[0].type, 'same_day_before');
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
});

test('组内先于链（A同日C，A先于B先于C）：同样拒绝', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const e3 = await makeEvent('丙');
  const cs = [
    await makeClaim(e1, year(1958)),
    await makeClaim(e2, year(1958)),
    await makeClaim(e3, year(1958)),
  ];
  await makeSdr(e1, e3);
  await makeRel(e1, e2);
  await makeRel(e2, e3);

  const val = await call('POST', '/api/editor/validate', {
    body: {
      selection: [
        { eventId: e1, claimId: cs[0] },
        { eventId: e2, claimId: cs[1] },
        { eventId: e3, claimId: cs[2] },
      ],
    },
  });
  assert.strictEqual(val.json.ok, false);
  assert.strictEqual(val.json.errors[0].type, 'same_day_before');
});

test('组内日期区间无交集：拒绝 same_day_interval 并给见证事件与同日关系', async () => {
  const e1 = await makeEvent('一月会');
  const e2 = await makeEvent('二月会');
  const c1 = await makeClaim(e1, month(1958, 1));
  const c2 = await makeClaim(e2, month(1958, 2));
  const sdrId = (await makeSdr(e1, e2)).id;

  const val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] },
  });
  assert.strictEqual(val.json.ok, false);
  const err = val.json.errors[0];
  assert.strictEqual(err.type, 'same_day_interval');
  assert.deepStrictEqual(new Set(err.witnessEventIds), new Set([e1, e2]));
  assert.deepStrictEqual(err.sameDayRelationIds, [sdrId]);

  const pub = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 0 },
  });
  assert.strictEqual(pub.status, 422);
});

test('折叠后先于成环：拒绝 cycle；组间先于至少相差一天', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const e3 = await makeEvent('丙');
  const c1 = await makeClaim(e1, day(1958, 3, 10));
  const c2 = await makeClaim(e2, day(1958, 3, 10));
  const c3 = await makeClaim(e3, day(1958, 4, 1));
  // 甲同日乙；甲先于丙、丙先于甲 => 折叠成环
  await makeSdr(e1, e2);
  await makeRel(e1, e3);
  await makeRel(e3, e1);

  const val = await call('POST', '/api/editor/validate', {
    body: {
      selection: [
        { eventId: e1, claimId: c1 },
        { eventId: e2, claimId: c2 },
        { eventId: e3, claimId: c3 },
      ],
    },
  });
  assert.strictEqual(val.json.ok, false);
  assert.strictEqual(val.json.errors[0].type, 'cycle');
  // 涉事事件覆盖整个同日组
  assert.deepStrictEqual(new Set(val.json.errors[0].eventIds), new Set([e1, e2, e3]));
});

test('组间严格相差一天：同具体日的两同日组不满足先于，改日可行', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, day(1958, 3, 10));
  const c2 = await makeClaim(e2, day(1958, 3, 10));
  await makeRel(e1, e2);
  // 两条「不同日」但日期恰好相同 -> 严格先于无解（与既有语义一致）
  let val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] },
  });
  assert.strictEqual(val.json.ok, false);
  assert.strictEqual(val.json.errors[0].type, 'temporal');

  // 改成次日 -> 可行
  const c2b = await makeClaim(e2, day(1958, 3, 11));
  val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2b }] },
  });
  assert.strictEqual(val.json.ok, true, JSON.stringify(val.json));
});

test('改选建议可解同日组区间冲突：改选事件数最少且只读', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1a = await makeClaim(e1, month(1958, 1));           // 当前（矛盾）
  const c1b = await makeClaim(e1, day(1958, 3, 20));          // 备选
  const c2 = await makeClaim(e2, day(1958, 3, 20));
  await makeSdr(e1, e2);

  const val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2 }] },
  });
  assert.strictEqual(val.json.ok, false);

  const sug = await call('POST', '/api/editor/suggest-reselection', {
    body: {
      selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2 }],
      draftRevision: val.json.draftRevision,
    },
  });
  assert.strictEqual(sug.status, 200, JSON.stringify(sug.json));
  assert.strictEqual(sug.json.changedEventCount, 1);
  assert.strictEqual(sug.json.changes[0].eventId, e1);
  assert.strictEqual(sug.json.changes[0].toClaimId, c1b);
  // 组内共享同一天
  const sel = Object.fromEntries(sug.json.selection.map((s) => [s.eventId, s.resolvedDate]));
  assert.strictEqual(sel[e1], sel[e2]);
});

test('改选建议：同日组内先于不可通过改选解决 -> 422 same_day_before', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, year(1958));
  const c2 = await makeClaim(e2, year(1958));
  await makeSdr(e1, e2);
  await makeRel(e1, e2);

  const rev = await revision();
  const sug = await call('POST', '/api/editor/suggest-reselection', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }],
      draftRevision: rev,
    },
  });
  assert.strictEqual(sug.status, 422);
  assert.strictEqual(sug.json.code, 'UNRESOLVABLE_BY_RESELECTION');
  assert.strictEqual(sug.json.reason, 'same_day_before');
});

test('恢复历史版本：同日关系随快照重建、进入 idMap，恢复后可再发布', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, day(1958, 3, 20));
  const c2 = await makeClaim(e2, month(1958, 3));
  const sdr = await makeSdr(e1, e2, { source: '同日出处' });

  const pub = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 0 },
  });
  assert.strictEqual(pub.status, 201);

  // 草稿漂移：新事件
  await makeEvent('闯入事件');

  const preview = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 1 } });
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.json.snapshot.sameDayRelations.length, 1);
  assert.strictEqual(preview.json.snapshot.sameDayRelations[0].source, '同日出处');
  assert.strictEqual(preview.json.currentDraft.sameDayRelations.length, 1);

  const con = await call('POST', '/api/editor/restore/confirm', {
    body: {
      versionNo: 1,
      draftRevision: preview.json.draftRevision,
      expectedLatestVersionNo: preview.json.latestVersionNo,
    },
  });
  assert.strictEqual(con.status, 200, JSON.stringify(con.json));
  assert.ok(con.json.idMap.sameDayRelations);
  assert.strictEqual(Object.keys(con.json.idMap.sameDayRelations).length, 1);
  assert.strictEqual(con.json.idMap.sameDayRelations[sdr.id], con.json.state.sameDayRelations[0].id);

  // 草稿被重建：同日关系在，闯入事件没了
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.events.length, 2);
  assert.strictEqual(st.json.sameDayRelations.length, 1);
  assert.deepStrictEqual(
    [st.json.sameDayRelations[0].eventAId, st.json.sameDayRelations[0].eventBId],
    [st.json.events[0].id, st.json.events[1].id].sort((a, b) => a - b)
  );

  // 恢复后可再次发布
  const sel = st.json.events.map((ev) => ({ eventId: ev.id, claimId: ev.claims[0].id }));
  const pub2 = await call('POST', '/api/editor/publish', {
    body: { selection: sel, baseVersionNo: 1 },
  });
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));
  assert.strictEqual(pub2.json.versionNo, 2);
  assert.strictEqual(pub2.json.version.sameDayRelations.length, 1);
});

test('版本对照：同日关系按已配对身份比较新增/移除/修改，歧义只列增删', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const e3 = await makeEvent('丙');
  // 第 2 版会新增「乙同日丙」，经连通性三者并为一组，故丙也取同一天
  const c1 = await makeClaim(e1, day(1958, 3, 20));
  const c2 = await makeClaim(e2, day(1958, 3, 20));
  const c3 = await makeClaim(e3, day(1958, 3, 20));
  // 第 1 版：甲同日乙（出处 old）
  await makeSdr(e1, e2, { source: '旧出处' });
  const pub1 = await call('POST', '/api/editor/publish', {
    body: {
      selection: [
        { eventId: e1, claimId: c1 },
        { eventId: e2, claimId: c2 },
        { eventId: e3, claimId: c3 },
      ],
      baseVersionNo: 0,
    },
  });
  assert.strictEqual(pub1.status, 201, JSON.stringify(pub1.json));

  // 第 2 版：同端点对（甲,乙）出处改为「新出处」-> 唯一对应判为修改；新增（乙,丙）
  let st = await call('GET', '/api/editor/state');
  const oldSdrId = st.json.sameDayRelations[0].id;
  await call('DELETE', `/api/editor/same-day-relations/${oldSdrId}`);
  await makeSdr(e1, e2, { source: '新出处' });
  await makeSdr(e2, e3);
  const pub2 = await call('POST', '/api/editor/publish', {
    body: {
      selection: [
        { eventId: e1, claimId: c1 },
        { eventId: e2, claimId: c2 },
        { eventId: e3, claimId: c3 },
      ],
      baseVersionNo: 1,
    },
  });
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));

  const diff = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 2 },
  });
  assert.strictEqual(diff.status, 200, JSON.stringify(diff.json));
  const sd = diff.json.sameDayRelations;
  assert.strictEqual(sd.changed.length, 1, JSON.stringify(sd));
  assert.strictEqual(sd.changed[0].fields.find((f) => f.field === 'source').from, '旧出处');
  assert.strictEqual(sd.changed[0].fields.find((f) => f.field === 'source').to, '新出处');
  assert.strictEqual(sd.added.length, 1);
  assert.strictEqual(sd.added[0].reason, 'absent_in_from');
  assert.deepStrictEqual(
    [sd.added[0].eventA.toEventId, sd.added[0].eventB.toEventId].sort((a, b) => a - b),
    [e2, e3].sort((a, b) => a - b)
  );
});

test('版本对照：同日关系同端点多条无法唯一对应时只列增删', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, day(1958, 3, 20));
  const c2 = await makeClaim(e2, day(1958, 3, 20));
  // 第 1 版：同端点两条同日（出处不同）
  await makeSdr(e1, e2, { source: '出处一' });
  await makeSdr(e1, e2, { source: '出处二' });
  const pub1 = await call('POST', '/api/editor/publish', {
    body: {
      selection: [
        { eventId: e1, claimId: c1 },
        { eventId: e2, claimId: c2 },
      ],
      baseVersionNo: 0,
    },
  });
  assert.strictEqual(pub1.status, 201, JSON.stringify(pub1.json));

  // 第 2 版：仍是同端点两条但出处变化，无法唯一对应 -> 2 移除 + 2 新增，无修改
  let st = await call('GET', '/api/editor/state');
  for (const s of st.json.sameDayRelations) {
    await call('DELETE', `/api/editor/same-day-relations/${s.id}`);
  }
  await makeSdr(e1, e2, { source: '出处甲' });
  await makeSdr(e1, e2, { source: '出处乙' });
  const pub2 = await call('POST', '/api/editor/publish', {
    body: {
      selection: [
        { eventId: e1, claimId: c1 },
        { eventId: e2, claimId: c2 },
      ],
      baseVersionNo: 1,
    },
  });
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));

  const diff = await call('POST', '/api/editor/versions/diff', {
    body: { fromVersionNo: 1, toVersionNo: 2 },
  });
  assert.strictEqual(diff.status, 200, JSON.stringify(diff.json));
  const sd = diff.json.sameDayRelations;
  assert.strictEqual(sd.changed.length, 0);
  assert.strictEqual(sd.removed.length, 2);
  assert.strictEqual(sd.added.length, 2);
  assert.ok(sd.removed.every((r) => r.reason === 'ambiguous_endpoint_group'));
  assert.ok(sd.added.every((r) => r.reason === 'ambiguous_endpoint_group'));
});
