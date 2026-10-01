'use strict';

// 改选搜索的纯单元测试：最小改选数 + 平手时按事件 ID 排序的主张 ID 全序列字典序。
const { test } = require('node:test');
const assert = require('node:assert');
const { ordinalFromIso } = require('../src/dates');
const { searchFeasibleAssignment } = require('../src/suggest');

function events(...titles) {
  return titles.map((title, i) => ({ id: i + 1, title }));
}
function c(claimId, start, end) {
  return { claimId, startOrd: ordinalFromIso(start), endOrd: ordinalFromIso(end), source: '', label: `${start}~${end}` };
}

function run({ evs, rels, cands, current }) {
  const candidates = new Map();
  for (const [eid, list] of Object.entries(cands)) candidates.set(Number(eid), list);
  const currentClaim = new Map(current.map(([eid, cid]) => [eid, cid]));
  return searchFeasibleAssignment({ events: evs, relations: rels, candidates, currentClaim });
}

test('最小改选数优先：能改 1 个事件就不返回改 2 个的组合', () => {
  const evs = events('A', 'B');
  const rels = [{ id: 1, earlierId: 1, laterId: 2 }];
  // 当前：A=12月, B=1月（矛盾）。改 B 到 2 月即可（1 个）；
  // 另一个可行解是 A 改 11 月 + B 保持？11月 < 次年1月仍需 B>=12月… 这里直接构造两个解：
  // 解1（改1）：B -> #3 (1959-02)
  // 解2（改2）：A -> #4 (1958-06), B -> #3 (1958-07)（同样只改 B？否，A 也改了）
  const r = run({
    evs,
    rels,
    cands: {
      1: [c(1, '1958-12-01', '1958-12-31'), c(4, '1958-06-01', '1958-06-30')],
      2: [c(2, '1958-01-01', '1958-01-31'), c(3, '1959-02-01', '1959-02-28'), c(5, '1958-07-01', '1958-07-31')],
    },
    current: [[1, 1], [2, 2]],
  });
  assert.strictEqual(r.limited, false);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.assignment.get(1), 1); // A 保持
  assert.strictEqual(r.assignment.get(2), 3); // B 改到最小可行
});

test('平手比较的是按事件 ID 排序的「全部事件」主张 ID 序列，而非仅改选事件', () => {
  // 三事件无关系：各事件独立，任何候选都可行 → 最优是 0 改选。
  // 为制造「改选数相同 + 序列不同」，让当前选择本身不可行且必须改同一事件，
  // 但该事件有两个同样可行的备选（id 7 与 id 9，都大于保持项 id 8 不可能保持）。
  // 更精确地验证全向量：事件 1 无关系可在两个可行区间任选，
  // 当前事件1选 #9（不可行情形由关系排除），两个可行解事件1取 #7 或 #8；
  // 事件 2 也被迫改，其改选结果相同。比较事件1位置即见分晓。
  const evs = events('A', 'B');
  const rels = [{ id: 1, earlierId: 1, laterId: 2 }];
  // A 当前 #9 = 1958-12（后），备选 #7=1958-01、#8=1958-06 都更早；
  // B 只有一个区间 1958-07，当前 A=12月 → B 下界 1959-01 出区间，必须把 A 改早。
  // 改 A 到 #7（1月，B→7月可行）或 #8（6月，B 下界 7月，仍可行），都是 1 个改选。
  // 序列比较：事件1 位 #7 < #8 → 取 #7。
  const r = run({
    evs,
    rels,
    cands: {
      1: [c(7, '1958-01-01', '1958-01-31'), c(8, '1958-06-01', '1958-06-30'), c(9, '1958-12-01', '1958-12-31')],
      2: [c(10, '1958-07-01', '1958-07-31')],
    },
    current: [[1, 9], [2, 10]],
  });
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.assignment.get(1), 7);
  assert.strictEqual(r.assignment.get(2), 10);
});

test('全序列字典序：事件1被迫相同改选、事件2有两个等价可行备选时取小 id', () => {
  // 双改选平手场景：两个事件都必须改（与当前不同），但事件2有两个可行备选。
  // 比较向量在事件1相同后继续比较事件2。
  const evs = events('A', 'B', 'C');
  const rels = [
    { id: 1, earlierId: 1, laterId: 2 },
    { id: 2, earlierId: 2, laterId: 3 },
  ];
  // 当前：A=#20(1960年), B=#30(1959年), C=#40(1958年)，链矛盾。
  // A 必须改到 1950：#11(1950) 唯一；
  // B 必须改到 A 之后且 C(1958) 之前：#12(1951) 或 #13(1952) 都可行；
  // C 保持 #40(1958)。两个解都改 A、B 两个事件（C 不变），平手 → B 取小 id #12。
  const r = run({
    evs,
    rels,
    cands: {
      1: [c(11, '1950-01-01', '1950-12-31'), c(20, '1960-01-01', '1960-12-31')],
      2: [c(12, '1951-01-01', '1951-12-31'), c(13, '1952-01-01', '1952-12-31'), c(30, '1959-01-01', '1959-12-31')],
      3: [c(40, '1958-01-01', '1958-12-31')],
    },
    current: [[1, 20], [2, 30], [3, 40]],
  });
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.assignment.get(1), 11);
  assert.strictEqual(r.assignment.get(2), 12);
  assert.strictEqual(r.assignment.get(3), 40);
});

test('全部组合均无解时 assignment 为 null', () => {
  const evs = events('晚', '早');
  const rels = [{ id: 1, earlierId: 1, laterId: 2 }];
  const r = run({
    evs,
    rels,
    cands: {
      1: [c(1, '1960-01-01', '1960-12-31'), c(2, '1959-12-01', '1959-12-31')],
      2: [c(3, '1958-01-01', '1958-12-31')],
    },
    current: [[1, 1], [2, 3]],
  });
  assert.strictEqual(r.assignment, null);
  assert.strictEqual(r.count, null);
  assert.strictEqual(r.limited, false);
});

test('保持项优先但不牺牲可行性：当前主张可行则 0 改选', () => {
  const evs = events('A', 'B');
  const rels = [{ id: 1, earlierId: 1, laterId: 2 }];
  const r = run({
    evs,
    rels,
    cands: {
      1: [c(5, '1958-01-01', '1958-12-31')],
      2: [c(6, '1959-01-01', '1959-12-31'), c(7, '1958-06-01', '1958-06-30')],
    },
    current: [[1, 5], [2, 6]],
  });
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.assignment.get(1), 5);
  assert.strictEqual(r.assignment.get(2), 6);
});
