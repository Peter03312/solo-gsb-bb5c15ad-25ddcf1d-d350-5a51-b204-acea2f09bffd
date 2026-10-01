'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============ 草稿区（编辑者可随时修改） ============
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 同一事件可保留多条互相矛盾的时间主张；发布时只选一条
CREATE TABLE IF NOT EXISTS claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  precision   TEXT NOT NULL CHECK (precision IN ('year','month','day')),
  year        INTEGER NOT NULL,
  month       INTEGER,
  day         INTEGER,
  date_label  TEXT NOT NULL,                 -- 供展示：如「1958 年 03 月」
  interval_start TEXT NOT NULL,             -- ISO，覆盖区间起点
  interval_end   TEXT NOT NULL,             -- ISO，覆盖区间终点
  source      TEXT NOT NULL DEFAULT '',     -- 出处（受访人/档案/页码）
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claims_event ON claims(event_id);

-- earlier 必须严格先于 later
CREATE TABLE IF NOT EXISTS relations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  earlier_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  later_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (earlier_id <> later_id)
);
CREATE INDEX IF NOT EXISTS idx_rel_earlier ON relations(earlier_id);
CREATE INDEX IF NOT EXISTS idx_rel_later ON relations(later_id);

-- 「同日」关系：两端不分先后（无向），要求两事件被确定为同一个具体日期。
-- 录入时做 a<=b 归一化，便于展示与去重；自同日无意义，CHECK 禁止。
CREATE TABLE IF NOT EXISTS same_day_relations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_a_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  event_b_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source     TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (event_a_id < event_b_id)
);
CREATE INDEX IF NOT EXISTS idx_sdr_a ON same_day_relations(event_a_id);
CREATE INDEX IF NOT EXISTS idx_sdr_b ON same_day_relations(event_b_id);

-- 草稿修订号：草稿区任意增删改（含从历史版本恢复）都单调 +1。
-- 单行单列表；用于「恢复草稿」的乐观并发校验。
CREATE TABLE IF NOT EXISTS draft_meta (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO draft_meta (id, revision) VALUES (1, 0);

-- ============ 发布区（不可变版本快照） ============
CREATE TABLE IF NOT EXISTS versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version_no   INTEGER NOT NULL UNIQUE,
  parent_no    INTEGER,                      -- 从哪个版本发起（0 表示首次）
  editor       TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS version_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id        INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  event_id          INTEGER NOT NULL,       -- 草稿事件 id（版本内不可变，仅作溯源）
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  claim_id          INTEGER NOT NULL,
  precision         TEXT NOT NULL,
  date_label        TEXT NOT NULL,
  interval_start    TEXT NOT NULL,
  interval_end      TEXT NOT NULL,
  resolved_date     TEXT NOT NULL,          -- 求解出的具体日 ISO
  source            TEXT NOT NULL DEFAULT '',
  claim_note        TEXT NOT NULL DEFAULT '',
  sort_order        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ve_version ON version_events(version_id);

CREATE TABLE IF NOT EXISTS version_relations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id   INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  relation_id  INTEGER NOT NULL,
  earlier_event_id INTEGER NOT NULL,
  later_event_id   INTEGER NOT NULL,
  source       TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vr_version ON version_relations(version_id);

-- 「同日」关系的不可变快照（两端不分先后；按事件 id 归一化记录）
CREATE TABLE IF NOT EXISTS version_same_day_relations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id          INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  same_day_relation_id INTEGER NOT NULL,
  event_a_id          INTEGER NOT NULL,
  event_b_id          INTEGER NOT NULL,
  source              TEXT NOT NULL DEFAULT '',
  note                TEXT NOT NULL DEFAULT '',
  sort_order          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vsdr_version ON version_same_day_relations(version_id);

-- 事件身份谱系：从某已发布版本恢复草稿时，每个重建事件记一行
-- 「恢复后的新草稿事件 id → 被恢复快照中的旧草稿事件 id」。
-- 恢复后即使数据库分配了全新事件 id，再次发布的版本仍可凭此链延续身份。
-- 只追加、不更新不删除；不加外键约束——草稿事件事后被删除时，
-- 历史版本之间的身份证明仍须保留。
CREATE TABLE IF NOT EXISTS event_lineage (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_event_id            INTEGER NOT NULL,   -- 恢复后新草稿事件 id
  ancestor_event_id         INTEGER NOT NULL,   -- 被恢复快照内的旧草稿事件 id
  restored_from_version_no  INTEGER NOT NULL,   -- 从第几版恢复（溯源用）
  created_at                TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lineage_draft ON event_lineage(draft_event_id);
CREATE INDEX IF NOT EXISTS idx_lineage_ancestor ON event_lineage(ancestor_event_id);
`;

let db;

function getDb() {
  if (db) return db;
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chronicle.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// 测试时可注入独立数据库
function setDb(instance) {
  db = instance;
}

module.exports = { getDb, setDb, SCHEMA };
