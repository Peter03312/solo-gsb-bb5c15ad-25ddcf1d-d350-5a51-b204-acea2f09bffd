'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

// 每个测试文件独立内存库
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

async function makeRel(earlierId, laterId, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

test('编辑者接口需要口令；访客接口公开', async () => {
  const r1 = await call('GET', '/api/editor/state', { token: null });
  assert.strictEqual(r1.status, 401);
  const r2 = await call('GET', '/api/editor/state', { token: 'wrong' });
  assert.strictEqual(r2.status, 401);
  const r3 = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(r3.status, 200);
  assert.strictEqual(r3.json.published, false);
});

test('完整发布流程：矛盾主张可共存，选其中一条发布快照', async () => {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1a = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
  const c1b = await makeClaim(e1, { precision: 'year', year: 1958, source: '县水利志第87页' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
  await makeRel(e1, e2, '二人口述一致');

  // 同事件两条矛盾主张并存
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.events.find((e) => e.id === e1).claims.length, 2);

  // 选 c1a（1958-09-12）与 c2（1959 年 5 月）
  const pub = await call('POST', '/api/editor/publish', {
    body: {
      selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2 }],
      baseVersionNo: 0,
      editor: '测试员甲',
      note: '首版',
    },
  });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  assert.strictEqual(pub.json.versionNo, 1);
  assert.strictEqual(pub.json.version.events[0].title, '动员会');
  assert.strictEqual(pub.json.version.events[0].resolvedDate, '1958-09-12');
  assert.strictEqual(pub.json.version.events[1].resolvedDate, '1959-05-01');
  assert.strictEqual(pub.json.version.relations[0].source, '二人口述一致');

  // 访客只能看到发布版与所选出处
  const pubView = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pubView.status, 200);
  assert.strictEqual(pubView.json.currentVersionNo, 1);
  assert.strictEqual(pubView.json.version.events.length, 2);
  const dongyuan = pubView.json.version.events.find((e) => e.title === '动员会');
  assert.strictEqual(dongyuan.claimId, c1a);
  assert.strictEqual(dongyuan.source, '李宝山口述');
});

test('缺主张无法发布并指明事件；无版本时访客看不到草稿', async () => {
  const e1 = await makeEvent('有主张');
  await makeEvent('无主张');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1960, source: '档案' });
  const st = await call('GET', '/api/editor/state');
  const e2 = st.json.events.find((e) => e.title === '无主张').id;

  const r = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: 0 }], baseVersionNo: 0 },
  });
  // claimId 0 不存在 -> bad_selection（而非缺主张，二者都阻止发布）
  assert.strictEqual(r.status, 422);
  assert.ok(['bad_selection', 'missing'].includes(r.json.errors[0].type));
  assert.ok(r.json.errors[0].eventIds.includes(e2));

  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, false);
});

test('成环发布被拒并报出涉事事件与关系；上一版本保留', async () => {
  const e1 = await makeEvent('A');
  const e2 = await makeEvent('B');
  const e3 = await makeEvent('C');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  const c2 = await makeClaim(e2, { precision: 'year', year: 1958, source: 's' });
  const c3 = await makeClaim(e3, { precision: 'year', year: 1958, source: 's' });
  await makeRel(e1, e2);
  await makeRel(e2, e3);

  // 先发一版好的（DAG）
  const ok = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }], baseVersionNo: 0 },
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));

  // 草稿加回边 C->A 形成环，再发 -> 422 cycle，版本仍为 1
  const ringEdgeId = await makeRel(e3, e1, '环边出处');
  const bad = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }], baseVersionNo: 1 },
  });
  assert.strictEqual(bad.status, 422);
  assert.strictEqual(bad.json.errors[0].type, 'cycle');
  assert.deepStrictEqual(new Set(bad.json.errors[0].eventIds), new Set([e1, e2, e3]));
  assert.ok(bad.json.errors[0].relationIds.includes(ringEdgeId));
  assert.match(bad.json.errors[0].message, /成环/);
  assert.match(bad.json.errors[0].detail, /环边出处/);

  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
});

test('时间无解被拒并给见证链；上一版本保留', async () => {
  const e1 = await makeEvent('冬月会议');
  const e2 = await makeEvent('春月会议');
  const c1 = await makeClaim(e1, { precision: 'month', year: 1958, month: 12, source: 's1' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1958, month: 1, source: 's2' });
  await makeRel(e1, e2);

  const r = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, false);
  assert.strictEqual(r.json.errors[0].type, 'temporal');
  assert.deepStrictEqual(r.json.errors[0].eventIds, [e1, e2]);

  const r2 = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 0 },
  });
  assert.strictEqual(r2.status, 422);
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, false);
});

test('版本冲突：两位编辑基于同一版本，后者发布得到 409，且未覆盖前者', async () => {
  const e1 = await makeEvent('事件甲');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });

  // 编辑甲基于 0 发布 -> 第 1 版
  const a = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }], baseVersionNo: 0, editor: '甲' },
  });
  assert.strictEqual(a.status, 201);
  assert.strictEqual(a.json.versionNo, 1);

  // 草稿新增事件；编辑乙仍基于 0 提交
  const e2 = await makeEvent('事件乙');
  const c2 = await makeClaim(e2, { precision: 'year', year: 1960, source: 's2' });
  const b = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 0, editor: '乙' },
  });
  assert.strictEqual(b.status, 409);
  assert.strictEqual(b.json.code, 'VERSION_CONFLICT');
  assert.strictEqual(b.json.currentVersionNo, 1);
  assert.strictEqual(b.json.baseVersionNo, 0);

  // 最新仍为第 1 版（未被乙静默覆盖）
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
  assert.strictEqual(view.json.version.eventCount, 1);

  // 乙重新基于 1 确认后发布 -> 第 2 版
  const b2 = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 1, editor: '乙' },
  });
  assert.strictEqual(b2.status, 201);
  assert.strictEqual(b2.json.versionNo, 2);
  assert.strictEqual(b2.json.version.parentNo, 1);

  // 旧版快照不可变且仍可取
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.status, 200);
  assert.strictEqual(v1.json.version.eventCount, 1);
});

test('发布后继续改草稿不影响已发布快照', async () => {
  const e1 = await makeEvent('老标题');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 3, day: 1, source: 's' });
  await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }], baseVersionNo: 0 },
  });

  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '新标题', description: '改了' } });
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.json.version.events[0].title, '老标题');

  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].title, '老标题');
});

test('自环关系在录入时即被拒绝', async () => {
  const e1 = await makeEvent('X');
  const r = await call('POST', '/api/editor/relations', { body: { earlierId: e1, laterId: e1 } });
  assert.strictEqual(r.status, 400);
});

// ---------- 草稿修订号 ----------

test('草稿修订号：任意增删改都 +1；预览恢复与发布不推进', async () => {
  let st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.draftRevision, 0);

  const e1 = await makeEvent('修订事件');
  st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.draftRevision, 1); // 增事件

  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.draftRevision, 2); // 增主张

  await call('PUT', `/api/editor/claims/${c1}`, {
    body: { precision: 'year', year: 1959, source: 's2' },
  });
  assert.strictEqual((await call('GET', '/api/editor/state')).json.draftRevision, 3); // 改主张

  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '改名', description: '' } });
  assert.strictEqual((await call('GET', '/api/editor/state')).json.draftRevision, 4); // 改事件

  const e2 = await makeEvent('关系对象');
  assert.strictEqual((await call('GET', '/api/editor/state')).json.draftRevision, 5);
  const rid = await makeRel(e1, e2);
  assert.strictEqual((await call('GET', '/api/editor/state')).json.draftRevision, 6); // 增关系
  await call('DELETE', `/api/editor/relations/${rid}`);
  assert.strictEqual((await call('GET', '/api/editor/state')).json.draftRevision, 7); // 删关系
  await call('DELETE', `/api/editor/claims/${c1}`);
  assert.strictEqual((await call('GET', '/api/editor/state')).json.draftRevision, 8); // 删主张
  await call('DELETE', `/api/editor/events/${e1}`);
  assert.strictEqual((await call('GET', '/api/editor/state')).json.draftRevision, 9); // 删事件（连带）

  // 恢复预览是只读，不推进修订号
  const c2 = await makeClaim(e2, { precision: 'year', year: 1970, source: 's' });
  const beforePub = (await call('GET', '/api/editor/state')).json.draftRevision;
  await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e2, claimId: c2 }], baseVersionNo: 0 },
  });
  const prev = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 1 } });
  assert.strictEqual(prev.status, 200);
  assert.strictEqual((await call('GET', '/api/editor/state')).json.draftRevision, beforePub); // 发布+预览均不推进
});

// ---------- 恢复 ----------

test('恢复预览只读：列出该版事件/被选主张/关系及将被替换的当前草稿', async () => {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1a = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
  const c1b = await makeClaim(e1, { precision: 'year', year: 1958, source: '水利志（未选）' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
  await makeRel(e1, e2, '二人口述一致');

  const pub = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2 }], baseVersionNo: 0 },
  });
  assert.strictEqual(pub.status, 201);

  // 草稿继续漂移：改标题、加未发布主张、加未发布事件
  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '动员会（新标题）', description: '' } });
  await makeClaim(e2, { precision: 'year', year: 2000, source: '未发布主张' });
  const e3 = await makeEvent('未发布事件');

  const revisionBefore = (await call('GET', '/api/editor/state')).json.draftRevision;
  const r = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 1 } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.draftRevision, revisionBefore);
  assert.strictEqual(r.json.latestVersionNo, 1);

  // 该版内容：只有被选主张 c1a，没有 c1b
  assert.deepStrictEqual(r.json.snapshot.events.map((e) => e.title), ['动员会', '通水会']);
  const snapE1 = r.json.snapshot.events.find((e) => e.eventId === e1);
  assert.strictEqual(snapE1.claimId, c1a);
  assert.strictEqual(snapE1.source, '李宝山口述');
  assert.strictEqual(r.json.snapshot.relations[0].source, '二人口述一致');

  // 当前草稿将被替换的内容包含漂移后的三项
  assert.strictEqual(r.json.currentDraft.events.length, 3);
  const curE1 = r.json.currentDraft.events.find((e) => e.id === e1);
  assert.strictEqual(curE1.title, '动员会（新标题）');
  const curE2 = r.json.currentDraft.events.find((e) => e.id === e2);
  assert.strictEqual(curE2.claimCount, 2);
  assert.ok(r.json.currentDraft.events.some((e) => e.id === e3));

  // 预览不改任何数据
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.draftRevision, revisionBefore);
  assert.strictEqual(st.json.events.find((e) => e.id === e1).title, '动员会（新标题）');
});

test('确认恢复：原子替换整个草稿，按快照重建且只恢复被选主张，返回 id 映射与待选主张', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 3, day: 1, source: 's1' });
  const c1extra = await makeClaim(e1, { precision: 'year', year: 1999, source: '未选矛盾主张' });
  const c2 = await makeClaim(e2, { precision: 'day', year: 1958, month: 3, day: 2, source: 's2' });
  await makeRel(e1, e2, 'rel-src');

  const pub = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], baseVersionNo: 0 },
  });
  assert.strictEqual(pub.status, 201);

  // 草稿漂移：新事件、新主张
  const e3 = await makeEvent('丙（草稿新增）');
  await makeClaim(e3, { precision: 'year', year: 2001, source: '草稿新主张' });

  const preview = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 1 } });
  assert.strictEqual(preview.status, 200);

  const con = await call('POST', '/api/editor/restore/confirm', {
    body: {
      versionNo: 1,
      draftRevision: preview.json.draftRevision,
      expectedLatestVersionNo: preview.json.latestVersionNo,
    },
  });
  assert.strictEqual(con.status, 200, JSON.stringify(con.json));

  // 返回旧快照 id → 新草稿 id 映射
  assert.strictEqual(con.json.restoredFromVersionNo, 1);
  assert.strictEqual(con.json.idMap.events[e1], con.json.state.events.find((x) => x.title === '甲').id);
  assert.strictEqual(con.json.idMap.claims[c1], con.json.state.events.find((x) => x.title === '甲').claims[0].id);
  assert.ok(!(c1extra in con.json.idMap.claims)); // 未选主张不在映射中（未恢复）

  // 草稿被整体替换：只有甲、乙；每事件恰一条主张（待选主张）
  const st = await call('GET', '/api/editor/state');
  assert.deepStrictEqual(st.json.events.map((e) => e.title).sort(), ['乙', '甲']);
  const jia = st.json.events.find((e) => e.title === '甲');
  assert.strictEqual(jia.claims.length, 1);
  assert.strictEqual(jia.claims[0].dateLabel, '1958 年 03 月 01 日');
  assert.strictEqual(jia.claims[0].source, 's1');
  assert.strictEqual(jia.claims[0].precision, 'day');
  assert.strictEqual(st.json.relations.length, 1);
  assert.strictEqual(st.json.relations[0].source, 'rel-src');

  // 恢复推进了修订号
  assert.strictEqual(st.json.draftRevision, preview.json.draftRevision + 1);

  // 历史快照与访客年表保持不变
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.json.version.eventCount, 2);
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);

  // 恢复后的草稿可继续按既有口令 / 校验 / baseVersionNo 约定发布
  const newJia = jia.id;
  const newYi = st.json.events.find((e) => e.title === '乙').id;
  const sel = [
    { eventId: newJia, claimId: jia.claims[0].id },
    { eventId: newYi, claimId: st.json.events.find((e) => e.title === '乙').claims[0].id },
  ];
  const val = await call('POST', '/api/editor/validate', { body: { selection: sel } });
  assert.strictEqual(val.json.ok, true, JSON.stringify(val.json));
  const pub2 = await call('POST', '/api/editor/publish', {
    body: { selection: sel, baseVersionNo: 1, editor: '恢复后再发布' },
  });
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));
  assert.strictEqual(pub2.json.versionNo, 2);
  assert.strictEqual(pub2.json.version.parentNo, 1);
});

test('恢复确认：预览后草稿被改动 → 409 RESTORE_CONFLICT 且不改数据', async () => {
  const e1 = await makeEvent('甲');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }], baseVersionNo: 0 },
  });

  const preview = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 1 } });

  // 另一编辑者改了草稿（修订号前进）
  const e2 = await makeEvent('闯入事件');

  const con = await call('POST', '/api/editor/restore/confirm', {
    body: {
      versionNo: 1,
      draftRevision: preview.json.draftRevision,
      expectedLatestVersionNo: preview.json.latestVersionNo,
    },
  });
  assert.strictEqual(con.status, 409);
  assert.strictEqual(con.json.code, 'RESTORE_CONFLICT');
  assert.strictEqual(con.json.currentDraftRevision, preview.json.draftRevision + 1);
  assert.match(con.json.message, /草稿已被修改/);

  // 数据未被恢复改动：闯入事件仍在
  const st = await call('GET', '/api/editor/state');
  assert.ok(st.json.events.some((e) => e.id === e2));
  assert.strictEqual(st.json.events.find((e) => e.id === e1).title, '甲');
});

test('恢复确认：预览后有新版本发布 → 409 且不改数据', async () => {
  const e1 = await makeEvent('甲');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: 's' });
  await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1 }], baseVersionNo: 0, editor: 'v1' },
  });

  const preview = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 1 } });

  // 第二位编辑者基于 1 发布第 2 版（草稿修订号不变，只最新版本号变）
  const c1b = await makeClaim(e1, { precision: 'year', year: 1959, source: 's2' });
  const revisionBefore = (await call('GET', '/api/editor/state')).json.draftRevision;
  const pub2 = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e1, claimId: c1b }], baseVersionNo: 1, editor: 'v2' },
  });
  assert.strictEqual(pub2.status, 201);
  // 新增主张使修订号 +1；为隔离“最新版本变化”这一原因，这里直接以旧修订号提交
  assert.strictEqual((await call('GET', '/api/editor/state')).json.draftRevision, revisionBefore);

  const con = await call('POST', '/api/editor/restore/confirm', {
    body: { versionNo: 1, draftRevision: preview.json.draftRevision, expectedLatestVersionNo: 1 },
  });
  assert.strictEqual(con.status, 409);
  assert.strictEqual(con.json.code, 'RESTORE_CONFLICT');
  assert.strictEqual(con.json.currentVersionNo, 2);
  assert.match(con.json.message, /最新版本已变化/);

  // 访客年表仍是第 2 版，草稿未被替换
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 2);
  const st = await call('GET', '/api/editor/state');
  assert.strictEqual(st.json.events.find((e) => e.id === e1).claims.length, 2);
});

test('恢复预览/确认：版本不存在返回 404；非法参数 400；接口需口令', async () => {
  const p1 = await call('POST', '/api/editor/restore/preview', { body: { versionNo: 99 } });
  assert.strictEqual(p1.status, 404);
  assert.strictEqual(p1.json.code, 'VERSION_NOT_FOUND');

  const c1 = await call('POST', '/api/editor/restore/confirm', {
    body: { versionNo: 99, draftRevision: 0, expectedLatestVersionNo: 0 },
  });
  assert.strictEqual(c1.status, 404);
  assert.strictEqual(c1.json.code, 'VERSION_NOT_FOUND');

  const bad = await call('POST', '/api/editor/restore/preview', { body: { versionNo: -3 } });
  assert.strictEqual(bad.status, 400);
  const bad2 = await call('POST', '/api/editor/restore/confirm', {
    body: { versionNo: 1, draftRevision: 'x' },
  });
  assert.strictEqual(bad2.status, 400);

  const noToken = await call('POST', '/api/editor/restore/preview', { token: null, body: { versionNo: 1 } });
  assert.strictEqual(noToken.status, 401);
});
