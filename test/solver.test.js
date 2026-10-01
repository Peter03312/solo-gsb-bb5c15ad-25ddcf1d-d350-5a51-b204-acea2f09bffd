'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { solve } = require('../src/solver');
const { ordinalFromIso, isoFromOrdinal } = require('../src/dates');

function events(...titles) {
  return titles.map((title, i) => ({ id: i + 1, title }));
}
function sel(claimId, start, end) {
  return {
    claimId,
    startOrd: ordinalFromIso(start),
    endOrd: ordinalFromIso(end),
    source: '',
    label: `${start}~${end}`,
  };
}
function selectedMap(arr) {
  const m = new Map();
  arr.forEach((s, i) => m.set(i + 1, s));
  return m;
}

test('日精度严格先后：同日无解，次日可行', () => {
  const evs = events('A', 'B');
  const rels = [{ id: 1, earlierId: 1, laterId: 2 }];

  let r = solve(evs, selectedMap([sel(1, '1958-03-01', '1958-03-01'), sel(2, '1958-03-01', '1958-03-01')]), rels);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'temporal');
  assert.deepStrictEqual(r.errors[0].eventIds, [1, 2]);
  assert.deepStrictEqual(r.errors[0].relationIds, [1]);

  r = solve(evs, selectedMap([sel(1, '1958-03-01', '1958-03-01'), sel(2, '1958-03-02', '1958-03-02')]), rels);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(isoFromOrdinal(r.dates.get(1)), '1958-03-01');
  assert.strictEqual(isoFromOrdinal(r.dates.get(2)), '1958-03-02');
});

test('粗粒度跨区间传播：12月 → 次年1月 可行，→ 同年1月 无解', () => {
  const evs = events('动员会', '通水');
  const rels = [{ id: 1, earlierId: 1, laterId: 2 }];

  const ok = solve(
    evs,
    selectedMap([sel(10, '1958-12-01', '1958-12-31'), sel(20, '1959-01-01', '1959-01-31')]),
    rels
  );
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(isoFromOrdinal(ok.dates.get(2)), '1959-01-01');

  const bad = solve(
    evs,
    selectedMap([sel(10, '1958-12-01', '1958-12-31'), sel(20, '1958-01-01', '1958-01-31')]),
    rels
  );
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.errors[0].type, 'temporal');
});

test('长链传播把后期事件推出区间', () => {
  const evs = events('A', 'B', 'C');
  const rels = [
    { id: 1, earlierId: 1, laterId: 2 },
    { id: 2, earlierId: 2, laterId: 3 },
  ];
  const r = solve(
    evs,
    selectedMap([
      sel(1, '1958-01-01', '1958-12-31'),
      sel(2, '1958-01-01', '1958-12-31'),
      sel(3, '1958-01-05', '1958-01-10'), // 最早被迫到 1958-01-03，仍可行
    ]),
    rels
  );
  assert.strictEqual(r.ok, true);

  const r2 = solve(
    evs,
    selectedMap([
      sel(1, '1958-12-01', '1958-12-31'),
      sel(2, '1958-12-01', '1958-12-31'),
      sel(3, '1958-01-01', '1958-01-10'),
    ]),
    rels
  );
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.errors[0].type, 'temporal');
  assert.deepStrictEqual(r2.errors[0].eventIds, [1, 2, 3]);
  assert.deepStrictEqual(r2.errors[0].relationIds, [1, 2]);
});

test('关系成环：报 cycle 且列出涉事事件与关系', () => {
  const evs = events('A', 'B', 'C');
  const rels = [
    { id: 1, earlierId: 1, laterId: 2 },
    { id: 2, earlierId: 2, laterId: 3 },
    { id: 3, earlierId: 3, laterId: 1 },
  ];
  const r = solve(
    evs,
    selectedMap([
      sel(1, '1958-01-01', '1958-12-31'),
      sel(2, '1958-01-01', '1958-12-31'),
      sel(3, '1958-01-01', '1958-12-31'),
    ]),
    rels
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'cycle');
  assert.deepStrictEqual(new Set(r.errors[0].eventIds), new Set([1, 2, 3]));
  assert.deepStrictEqual(new Set(r.errors[0].relationIds), new Set([1, 2, 3]));
});

test('自环也是环', () => {
  const evs = events('A');
  const r = solve(evs, selectedMap([sel(1, '1958-01-01', '1958-12-31')]), [
    { id: 9, earlierId: 1, laterId: 1 },
  ]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'cycle');
});

test('缺少被选主张报 missing 并指出事件', () => {
  const evs = events('A', 'B');
  const r = solve(evs, new Map([[1, sel(1, '1958-01-01', '1958-01-01')]]), []);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'missing');
  assert.deepStrictEqual(r.errors[0].eventIds, [2]);
});

test('无边时各事件取区间起点', () => {
  const evs = events('A', 'B');
  const r = solve(
    evs,
    selectedMap([sel(1, '1962-01-01', '1962-12-31'), sel(2, '1962-10-01', '1962-10-31')]),
    []
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(isoFromOrdinal(r.dates.get(1)), '1962-01-01');
  assert.strictEqual(isoFromOrdinal(r.dates.get(2)), '1962-10-01');
});

// ---------- 同日关系 ----------

function sd(id, a, b, source = '') {
  return { id, eventAId: a, eventBId: b, source };
}

test('同日组共享具体日期：粗精度事件被同日的日精度事件定到当天', () => {
  const evs = events('A', 'B', 'C');
  const rels = [{ id: 1, earlierId: 2, laterId: 3 }];
  const sdr = [sd(1, 1, 2)];
  const r = solve(
    evs,
    selectedMap([
      sel(1, '1958-03-01', '1958-03-31'),
      sel(2, '1958-03-15', '1958-03-15'),
      sel(3, '1958-03-01', '1958-03-31'),
    ]),
    rels,
    sdr
  );
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(isoFromOrdinal(r.dates.get(1)), '1958-03-15');
  assert.strictEqual(isoFromOrdinal(r.dates.get(2)), '1958-03-15');
  assert.strictEqual(isoFromOrdinal(r.dates.get(3)), '1958-03-16'); // 组间至少差一天
  assert.deepStrictEqual(r.groups, [[1, 2]]);
});

test('同日组区间无交集报 same_day_interval', () => {
  const evs = events('A', 'B');
  const r = solve(
    evs,
    selectedMap([sel(1, '1958-01-01', '1958-01-31'), sel(2, '1958-12-01', '1958-12-31')]),
    [],
    [sd(1, 1, 2)]
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'same_day_interval');
  assert.deepStrictEqual(r.errors[0].sameDayRelationIds, [1]);
});

test('同日组内直接先于边报 same_day_conflict', () => {
  const evs = events('A', 'B');
  const r = solve(
    evs,
    selectedMap([sel(1, '1958-01-01', '1958-12-31'), sel(2, '1958-01-01', '1958-12-31')]),
    [{ id: 7, earlierId: 1, laterId: 2 }],
    [sd(9, 1, 2)]
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'same_day_conflict');
  assert.deepStrictEqual(new Set(r.errors[0].eventIds), new Set([1, 2]));
  assert.ok(r.errors[0].relationIds.includes(7));
  assert.ok(r.errors[0].sameDayRelationIds.includes(9));
});

test('同日组经中间事件的先于链（绕回同组另一成员）报 same_day_conflict', () => {
  // 1 同日 3；1 先于 2 先于 3 => 折叠图 G{1,3} -> 2 -> G 且出入不同成员
  const evs = events('A', 'B', 'C');
  const r = solve(
    evs,
    selectedMap([
      sel(1, '1958-01-01', '1958-12-31'),
      sel(2, '1958-01-01', '1958-12-31'),
      sel(3, '1958-01-01', '1958-12-31'),
    ]),
    [
      { id: 1, earlierId: 1, laterId: 2 },
      { id: 2, earlierId: 2, laterId: 3 },
    ],
    [sd(5, 1, 3)]
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'same_day_conflict');
  assert.ok(r.errors[0].eventIds.includes(1));
  assert.ok(r.errors[0].eventIds.includes(3));
});

test('折叠组图成环但同日组出入同一成员，仍报 cycle', () => {
  // 1 同日 2；1 先于 3、3 先于 1（从 G 的成员 1 出入，2 与 1 无先后之分）
  const evs = events('A', 'B', 'C');
  const r = solve(
    evs,
    selectedMap([
      sel(1, '1958-01-01', '1958-12-31'),
      sel(2, '1958-01-01', '1958-12-31'),
      sel(3, '1958-01-01', '1958-12-31'),
    ]),
    [
      { id: 1, earlierId: 1, laterId: 3 },
      { id: 2, earlierId: 3, laterId: 1 },
    ],
    [sd(5, 1, 2)]
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'cycle');
});
