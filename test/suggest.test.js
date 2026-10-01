'use strict';

// 改选建议端到端测试：HTTP 语义 + 求解结果。
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
async function revision() {
  return (await call('GET', '/api/editor/state')).json.draftRevision;
}

function month(y, m) { return { precision: 'month', year: y, month: m, source: 's' }; }
function day(y, m, d) { return { precision: 'day', year: y, month: m, day: d, source: 's' }; }
function year(y) { return { precision: 'year', year: y, source: 's' }; }

test('改选建议：时间无解时返回改选事件数最少的组合、逐项变更与求解日期（只读）', async () => {
  const e1 = await makeEvent('冬月会议');
  const e2 = await makeEvent('春月会议');
  const c1a = await makeClaim(e1, month(1958, 12));            // 当前选择（晚）
  const c1b = await makeClaim(e1, day(1958, 9, 12));           // 备选（更早，但单独改它仍无解）
  const c2a = await makeClaim(e2, month(1958, 1));             // 当前选择（早，矛盾）
  const c2b = await makeClaim(e2, day(1959, 2, 3));            // 备选（晚，改它即可解）
  await makeRel(e1, e2);

  const rev = await revision();
  const val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2a }] },
  });
  assert.strictEqual(val.json.ok, false);
  assert.strictEqual(val.json.errors[0].type, 'temporal');
  assert.strictEqual(val.json.draftRevision, rev);

  const sug = await call('POST', '/api/editor/suggest-reselection', {
    body: {
      selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2a }],
      draftRevision: val.json.draftRevision,
    },
  });
  assert.strictEqual(sug.status, 200, JSON.stringify(sug.json));
  assert.strictEqual(sug.json.changedEventCount, 1);
  assert.strictEqual(sug.json.changes.length, 1);
  assert.deepStrictEqual(sug.json.changes[0], {
    eventId: e2,
    title: '春月会议',
    fromClaimId: c2a,
    toClaimId: c2b,
    from: { claimId: c2a, dateLabel: '1958 年 01 月', intervalStart: '1958-01-01', intervalEnd: '1958-01-31', source: 's' },
    to: { claimId: c2b, dateLabel: '1959 年 02 月 03 日', intervalStart: '1959-02-03', intervalEnd: '1959-02-03', source: 's' },
  });

  // 逐事件求解日期
  const byEvent = new Map(sug.json.selection.map((s) => [s.eventId, s]));
  assert.strictEqual(byEvent.get(e1).resolvedDate, '1958-12-01');
  assert.strictEqual(byEvent.get(e2).resolvedDate, '1959-02-03');
  assert.strictEqual(byEvent.get(e1).claimId, c1a);
  assert.strictEqual(byEvent.get(e2).claimId, c2b);

  // 建议只读：草稿、修订号不变
  assert.strictEqual(await revision(), rev);
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.events.length, 2);
});

test('平手：同为 1 个事件改选时取主张 ID 序列字典序最小者', async () => {
  const e1 = await makeEvent('先');
  const e2 = await makeEvent('后');
  const c1 = await makeClaim(e1, month(1958, 12));
  const c2bad = await makeClaim(e2, month(1958, 1));
  const c2alt1 = await makeClaim(e2, month(1959, 2)); // 先插入，id 较小
  const c2alt2 = await makeClaim(e2, month(1959, 3)); // id 较大，同样可行
  await makeRel(e1, e2);

  const r = await call('POST', '/api/editor/suggest-reselection', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2bad }],
      draftRevision: await revision(),
    },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.changedEventCount, 1);
  assert.strictEqual(r.json.changes[0].toClaimId, c2alt1);
  assert.ok(c2alt1 < c2alt2);
});

test('多事件改选：需要改两个事件时不会返回只改一个的不可行方案', async () => {
  // a < b < c；当前选择全部矛盾（a=1960, b=1959, c=1958）
  const ea = await makeEvent('甲');
  const eb = await makeEvent('乙');
  const ec = await makeEvent('丙');
  const caCur = await makeClaim(ea, year(1960));
  const caAlt = await makeClaim(ea, year(1950));
  const cbCur = await makeClaim(eb, year(1959));
  const cbAlt = await makeClaim(eb, year(1951));
  const ccCur = await makeClaim(ec, year(1958)); // 只有一条，区间整年，但 b 最晚也在 1951 -> c 1958 OK
  await makeRel(ea, eb);
  await makeRel(eb, ec);

  // 单改 a 为 1950：b=1959 -> c=1958 仍矛盾；单改 b 为 1951：a=1960 -> b 下界 1961 出区间。
  // 唯一最少解：a->1950 且 b->1951（改 2 个事件）
  const r = await call('POST', '/api/editor/suggest-reselection', {
    body: {
      selection: [
        { eventId: ea, claimId: caCur },
        { eventId: eb, claimId: cbCur },
        { eventId: ec, claimId: ccCur },
      ],
      draftRevision: await revision(),
    },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.changedEventCount, 2);
  const changed = new Map(r.json.changes.map((c) => [c.eventId, c.toClaimId]));
  assert.strictEqual(changed.get(ea), caAlt);
  assert.strictEqual(changed.get(eb), cbAlt);
  const dates = new Map(r.json.selection.map((s) => [s.eventId, s.resolvedDate]));
  assert.strictEqual(dates.get(ea), '1950-01-01');
  assert.strictEqual(dates.get(eb), '1951-01-01');
  assert.strictEqual(dates.get(ec), '1958-01-01');
});

test('当前选择本身可行：返回 0 项变更', async () => {
  const e1 = await makeEvent('A');
  const e2 = await makeEvent('B');
  const c1 = await makeClaim(e1, day(1958, 3, 1));
  const c2 = await makeClaim(e2, day(1958, 3, 2));
  await makeRel(e1, e2);

  const r = await call('POST', '/api/editor/suggest-reselection', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], draftRevision: await revision() },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.changedEventCount, 0);
  assert.deepStrictEqual(r.json.changes, []);
});

test('关系成环：无法靠改选解决，422 cycle', async () => {
  const e1 = await makeEvent('A');
  const e2 = await makeEvent('B');
  const c1 = await makeClaim(e1, year(1958));
  const c2 = await makeClaim(e2, year(1959));
  await makeRel(e1, e2);
  await makeRel(e2, e1);

  const r = await call('POST', '/api/editor/suggest-reselection', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], draftRevision: await revision() },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.code, 'UNRESOLVABLE_BY_RESELECTION');
  assert.strictEqual(r.json.reason, 'cycle');
});

test('事件没有主张：422 event_without_claims', async () => {
  const e1 = await makeEvent('有主张');
  const e2 = await makeEvent('无主张');
  const c1 = await makeClaim(e1, year(1958));
  await makeRel(e1, e2);

  const r = await call('POST', '/api/editor/suggest-reselection', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: 0 }], draftRevision: await revision() },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.reason, 'event_without_claims');
  assert.deepStrictEqual(r.json.eventIds, [e2]);
});

test('全部组合均无解：422 no_feasible_combination', async () => {
  const e1 = await makeEvent('晚');
  const e2 = await makeEvent('早');
  await makeClaim(e1, year(1960));
  await makeClaim(e1, month(1959, 12));
  await makeClaim(e2, year(1958));
  await makeRel(e1, e2); // 1959/1960 的事件不可能先于 1958 年的事件

  const st = await call('GET', '/api/editor/state');
  const c1 = st.json.events.find((e) => e.id === e1).claims[0].id;
  const c2 = st.json.events.find((e) => e.id === e2).claims[0].id;
  const r = await call('POST', '/api/editor/suggest-reselection', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], draftRevision: await revision() },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.reason, 'no_feasible_combination');
  assert.match(r.json.message, /无法靠改选解决|现有主张/);
});

test('选择缺失、重复、主张不属于事件：400 SELECTION_INVALID 明确拒绝', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, year(1958));
  const c2 = await makeClaim(e2, year(1959));

  // 缺失 e2
  let r = await call('POST', '/api/editor/suggest-reselection', {
    body: { selection: [{ eventId: e1, claimId: c1 }], draftRevision: await revision() },
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.code, 'SELECTION_INVALID');
  assert.deepStrictEqual(r.json.missingEventIds, [e2]);

  // 重复 e1
  r = await call('POST', '/api/editor/suggest-reselection', {
    body: {
      selection: [
        { eventId: e1, claimId: c1 },
        { eventId: e1, claimId: c1 },
        { eventId: e2, claimId: c2 },
      ],
      draftRevision: await revision(),
    },
  });
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(r.json.duplicateEventIds, [e1]);

  // c2 不属于 e1
  r = await call('POST', '/api/editor/suggest-reselection', {
    body: { selection: [{ eventId: e1, claimId: c2 }, { eventId: e2, claimId: c2 }], draftRevision: await revision() },
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.invalidSelections[0].reason, 'claim_belongs_to_other_event');
  assert.strictEqual(r.json.invalidSelections[0].actualEventId, e2);

  // 主张不存在
  r = await call('POST', '/api/editor/suggest-reselection', {
    body: { selection: [{ eventId: e1, claimId: 99999 }, { eventId: e2, claimId: c2 }], draftRevision: await revision() },
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.invalidSelections[0].reason, 'claim_not_found');

  // draftRevision 缺失 / 非整数
  r = await call('POST', '/api/editor/suggest-reselection', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] },
  });
  assert.strictEqual(r.status, 400);
});

test('草稿修订号对不上：409 DRAFT_REVISION_STALE，不返回建议且不改数据', async () => {
  const e1 = await makeEvent('冬月会议');
  const e2 = await makeEvent('春月会议');
  const c1 = await makeClaim(e1, month(1958, 12));
  const c2 = await makeClaim(e2, month(1958, 1));
  await makeRel(e1, e2);

  // 预检后草稿被改动（新增一个无关主张 -> 修订号 +1）
  const val = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] },
  });
  const staleRev = val.json.draftRevision;
  await makeClaim(e2, day(1959, 2, 3));
  const currentRev = await revision();
  assert.notStrictEqual(staleRev, currentRev);

  const r = await call('POST', '/api/editor/suggest-reselection', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }],
      draftRevision: staleRev,
    },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'DRAFT_REVISION_STALE');
  assert.strictEqual(r.json.submittedDraftRevision, staleRev);
  assert.strictEqual(r.json.currentDraftRevision, currentRev);
  assert.match(r.json.message, /重新.*预检/);

  // 修订号更新后可正常得到建议（新主张 c3 成为改选目标）
  const st = await call('GET', '/api/editor/state');
  const c3 = st.json.events.find((e) => e.id === e2).claims.find((c) => c.intervalStart === '1959-02-03').id;
  const r2 = await call('POST', '/api/editor/suggest-reselection', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }],
      draftRevision: currentRev,
    },
  });
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));
  assert.strictEqual(r2.json.changes[0].toClaimId, c3);
});

test('建议接口需要编辑者口令；非法 selection 结构 400', async () => {
  const noToken = await call('POST', '/api/editor/suggest-reselection', {
    token: null,
    body: { selection: [], draftRevision: 0 },
  });
  assert.strictEqual(noToken.status, 401);

  const bad = await call('POST', '/api/editor/suggest-reselection', { body: { draftRevision: 0 } });
  assert.strictEqual(bad.status, 400);
});
