# 地方口述史事件年表（Oral Chronicle）

供地方口述史团队本机使用的事件年表 Web 应用。编辑者录入**事件**、带**出处**的时间主张（可精确到年 / 月 / 日）、事件之间的**「先于」关系**，以及带出处与备注、两端不分先后的**「同日」关系**；同一事件可以保留多条互相矛盾的主张。发布时为每个事件选定一条主张，系统检查全部先后与同日关系后生成**不可变版本**。访客只能看到最新已发布年表。

- 技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 浏览器原生界面（无需前端构建）

## 一键启动（Docker Compose，推荐）

```bash
docker compose up -d --build
```

启动即完成：安装依赖、初始化 SQLite 数据库（自动建表）、挂载持久化数据卷。
Compose 默认 `SEED_DEMO=1`，首次启动会写入一组演示草稿（3 个事件，含矛盾主张），方便体验发布流程。

访问地址：

| 用途 | 地址 |
| --- --- | --- |
| 访客年表（只读最新已发布版本） | http://localhost:3000/ |
| 编辑者工作台 | http://localhost:3000/editor |
| 最新发布快照 JSON | http://localhost:3000/api/public/chronicle |

编辑者口令默认在 `docker-compose.yml` 中为 `change-me-please`，**请修改后使用**：在编辑台右上角输入口令并保存（仅保存在该浏览器 localStorage 中，请求以 `X-Editor-Token` 头发送）。

停止与查看日志：

```bash
docker compose logs -f
docker compose down            # 保留数据卷
docker compose down -v         # 同时删除数据库数据卷
```

## 不用 Docker，本机直接运行

要求 Node.js ≥ 20。

```bash
npm install
npm start                     # 默认 http://localhost:3000
# 可选：写入演示草稿
npm run seed
npm test                      # 运行求解器与接口测试
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（本机直跑可设 `127.0.0.1`） |
| `EDITOR_TOKEN` | `editor` | 编辑者口令，生产使用务必修改 |
| `DB_PATH` | `./data/chronicle.db`（容器内 `/app/data/chronicle.db`） | SQLite 数据库文件路径，目录自动创建 |
| `SEED_DEMO` | 未设置 | 设为 `1` 时启动写入演示草稿（仅在库为空时） |

改端口示例：

```bash
PORT=8080 EDITOR_TOKEN=my-secret npm start
# 访客 http://localhost:8080/ ，编辑 http://localhost:8080/editor
```

## 使用方式

### 编辑（http://localhost:3000/editor）

1. 右上角输入编辑者口令并保存。
2. 在「事件与时间主张」中添加事件；每个事件可添加**任意多条**时间主张，每条必须填写出处（受访人 / 访谈时间 / 档案全宗 / 页码等），矛盾说法可用「考异备注」记录。
3. 用单选按钮为**每个**事件选定一条拟发布主张（选择只保存在当前浏览器中）。
4. 在「先于」关系中声明 A 严格先于 B，可附出处；在「同日」关系中声明两个事件同一天发生（两端不分先后），可附出处与备注。同日关系可经多条连成「同日连通组」。
5. 「校验能否发布」先预览；「发布新版本」正式生成不可变快照。

### 发布规则（为什么会发布失败）

粗精度日期按其覆盖的闭区间处理：

- 精确到**年**（如「1958 年」）：区间 `1958-01-01 ~ 1958-12-31`
- 精确到**月**（如「1958 年 3 月」）：区间 `1958-03-01 ~ 1958-03-31`
- 精确到**日**（如「1958 年 3 月 12 日」）：区间即当天

发布时，系统为每个事件在其选定主张的区间内确定一个**具体日期**，并把**「先于」与「同日」关系一起求解**：

- 每条「先于」关系两端**严格相差至少一天**（不允许同一天）；
- **「同日」连通组**（由同日关系无向连成）内所有事件**共享同一个具体日期**，该日期必须落在组内每条主张区间的**共同交集**里；
- 「先于」要求在**折叠后的同日组图**上成立——不同同日组之间至少相差一天。

以下情况会拒绝发布，错误面板会标明涉事事件与关系（点击可定位；同日关系与先于关系分别给出 id），**上一已发布版本保持不变**：

1. **缺少主张**：有事件未选定主张（或选定了已删除 / 不属于该事件的主张）；
2. **同日组内先于**（错误类型 `same_day_before`）：同一同日组的两个事件之间存在「先于」关系或先于链（含经过组外事件折回的链，如 A 同日 C 而 A 先于 B 先于 C）；
3. **同日组日期无交集**（`same_day_interval`）：同组各事件选定主张的覆盖区间没有共同的一天（如分别主张 1 月与 2 月）；
4. **关系成环**（`cycle`）：把同日组折叠成单个节点后，「先于」关系构成有向环（未同日事件的自环在录入时即被禁止）；
5. **时间无解**（`temporal`）：折叠后的组图是 DAG，但区间内不存在满足全部严格先后关系的具体日期。错误信息会给出一条导致矛盾的见证链，例如「冬月会议 先于 春月会议」却分别主张 1958 年 12 月、1958 年 1 月。

发布成功后得到递增版本号（第 1 版、第 2 版……），事件、所选主张（精度、区间、出处、考异）、「先于」关系、「同日」关系与求解日期全部**复制进版本快照**；此后修改草稿不影响任何旧版本。访客页只展示当前最新版本（含全部已发布同日关系）。

### 时间无解时查看「改选建议」（只读）

预检（「校验能否发布」）报出**时间无解**后，错误面板会出现「查看改选建议」按钮。改选建议在以下硬约束内求解：

- **只能在各事件的现有主张中另选一条**——不能新增 / 修改主张，**先于关系、同日关系与主张覆盖日期区间一律不变**；
- 目标：**改选事件数最少**的可行组合；平手时，按事件 ID 升序排列、比较各事件的主张 ID 序列，取字典序最小者；
- 返回：需改选的事件数、**逐项变更**（事件 / 原主张 / 建议主张 / 出处 / 区间）与建议组合中每个事件的**求解日期**。

对话框只读展示建议，绝不修改服务器上的草稿或任何发布版本；可点「应用到本机选择」把建议写入**当前浏览器**的逐事件单选（仅 localStorage），随后必须重新预检 / 发布。

请求必须带回**预检时的草稿修订号**（预检响应中的 `draftRevision`）：

- 预检后草稿被他人增删改过，或**计算建议期间草稿修订号发生变化** → 返回 **409 `DRAFT_REVISION_STALE`**，不返回任何（可能过期的）建议，编辑台提示重新预检；
- 选择缺失、事件重复、主张不存在或不属于该事件 → **400 `SELECTION_INVALID`**，逐项列明拒绝原因；
- **关系成环**（`reason:"cycle"`）、**同日组内先于**（`reason:"same_day_before"`）、**某事件没有任何主张**（`reason:"event_without_claims"`）、**现有主张的所有组合都不满足先后 / 同日关系**（`reason:"no_feasible_combination"`）→ **422 `UNRESOLVABLE_BY_RESELECTION`**，明确说明无法靠改选解决，需补录主张或调整关系。

建议接口是纯只读计算，**不推进草稿修订号、不写草稿、不写发布版本**。

### 从任一已发布版本预览并恢复草稿

在编辑台右下「已发布版本」中，每版都有「预览并恢复为此版」按钮：

1. **预览（不改数据）**：对话框列出该版的事件、每条事件的**被选时间主张**（精度 / 区间 / 出处 / 求解日期）、全部「先于」关系与全部「同日」关系，并对照列出**当前草稿中将被替换**的内容（现有事件及其主张数、现有先于 / 同日关系）与当前草稿修订号。预览只是只读核对，不落任何数据。
2. **确认**：请求回传**预览时的草稿修订号**与**当时最新版本号**。服务器在单个事务内：
   - 若该版本不存在 → 404；
   - 若确认前草稿被他人增删改过（修订号不一致）或最新版本号已变化 → **409 恢复冲突且不改任何数据**，需重新预览；
   - 否则**原子替换整个草稿**：清空现有事件 / 主张 / 先于 / 同日关系，按快照重建事件、「先于」关系与「同日」关系，每个事件**只恢复该版被选定的那一条主张**（未选主张从不进快照，无法恢复）；返回**旧快照 id → 新草稿 id 的映射**（`events / claims / relations / sameDayRelations`）以及重建后的草稿全貌（即编辑台继续校验发布所需的**待选主张**）。编辑台会自动预选每条恢复的主张。
3. 恢复后可照常「校验能否发布」「发布新版本」，仍须遵守编辑口令、求解校验与 `baseVersionNo` 冲突约定（恢复不改变 `baseVersionNo`，也不会自动发布）。

草稿区每一次增删改（事件 / 主张 / 关系，以及恢复本身）都会把**草稿修订号** +1；`GET /api/editor/state` 与恢复接口都会返回 `draftRevision`。**历史快照与访客年表在恢复过程中保持不变**。

### 两份已发布年表对照（只读）

在编辑台右下「已发布版本 → 两版对照」中选择旧版与新版，点「对照两版」：

1. **身份配对（不按标题相似度猜测）**：
   - 两版中的事件**草稿 id 相同** → 自动配对（`same_id`）；
   - 事件若曾**从某版恢复草稿**、数据库分配了新 id 后再次发布，系统按恢复时记录的**身份谱系**（`event_lineage`）把新旧事件判为同一身份（`restore_lineage`，多次恢复、跨多版仍可沿链证明）；
   - 谱系无法唯一证明的（例如两批完全独立的录入）→ 两版分别列为**未配对**，不会因标题相同而擅自配对。
2. **人工一对一配对（仅本次对照有效）**：对话框可从两侧未配对事件中逐对指定配对；提交时**重复（同一事件出现多次）、跨版不存在、与已有确定配对冲突**都会被**整组拒绝**并逐项列出原因，不保存、不猜测。
3. **逐项前后值**：每对事件展示标题、描述、主张日期精度、日期、区间起止、出处、考异备注、求解日期的旧版值 / 新版值与是否变化。
4. **「先于」关系**：先按事件配对把两端映射到同一身份后再比较——
   - 同端点对两侧各恰好一条：比较**出处、备注**，列为新增 / 移除 / 修改 / 无变化；
   - **同端点多条关系、无法唯一对应时只列增删，不推断修改**；
   - 端点事件未配对的关系，随未配对事件列入新增 / 移除。
5. **「同日」关系**：同日关系无向，先把两端按身份配对（不分先后）后再比较——
   - 同一对身份两侧各恰好一条：比较**出处、备注**，列为新增 / 移除 / 修改 / 无变化；
   - 同身份对多条、无法唯一对应时**只列增删**；任一端点事件未配对则随事件列入新增 / 移除。

对照是**纯只读**操作：不写历史快照、不写当前草稿、不推进草稿修订号；人工配对不持久化。未知版本返回 404 `VERSION_NOT_FOUND`，既有版本查询接口的响应结构保持不变。

### 两名编辑者并发修改（版本冲突）

发布请求必须带 `baseVersionNo`（编辑台打开时自动记录当前最新版本号）。若两名编辑者都从第 N 版开始改，第一人发布产生第 N+1 版后，第二人仍以 `baseVersionNo=N` 提交时：

- 服务器返回 **409 版本冲突**，编辑台弹出冲突框，告知对方发布的第 N+1 版概况；
- **不会**静默覆盖对方版本；
- 第二人需点击「刷新到最新版本并重新确认选择」，重新核对每个事件的主张单选后再发布。

### 访客（http://localhost:3000/）

只渲染最新已发布版本：按系统确定的日期排列的时间线、每条事件所选主张的精度与出处、全部「先于」关系与全部「同日」关系及其出处。草稿、未发布主张、未发布关系均不出现在任何公开接口中。尚无发布版本时仅显示「尚未发布」。

## 数据与备份

- 单文件 SQLite 数据库：容器中位于 `/app/data/chronicle.db`（Docker 卷 `chronicle-data`），本机直跑位于 `./data/chronicle.db`。
- 备份：停止写入后复制该 `.db` 文件即可（或使用 SQLite 的 `.backup` 命令）。
- 历史版本表 `versions / version_events / version_relations / version_same_day_relations` 只追加、不更新不删除，保证不可变。
- 身份谱系表 `event_lineage` 同样只追加：每次从版本恢复草稿时记录「新草稿事件 id → 被恢复事件的身份根」，供版本对照在新 id 下延续事件身份；不设外键级联，草稿事件事后删除也不影响历史版本间的身份证明。

## 目录结构

```
src/
  server.js     Express 入口、口令中间件、静态界面
  routes.js     公开只读 API 与编辑者草稿/发布/恢复/版本对照 API
  db.js         SQLite 连接与建表（草稿区 + 版本快照区 + 草稿修订号 + 事件身份谱系；含同日关系表）
  dates.js      年/月/日精度 → 覆盖区间（公历序数日）
  solver.js     同日连通组（并查集）+ Tarjan 环检测 + 折叠组图拓扑下界传播求严格先后 / 同日可行解
  suggest.js    时间无解时的只读改选建议：以同日组为单位分支限界求最少改选组合 + 平手字典序
  publish.js    发布事务：再校验 + 版本冲突检查 + 写不可变快照
  draft.js      草稿全貌组装、草稿修订号与草稿变更事务
  restore.js    恢复事务：预览只读 + 乐观并发校验 + 按快照原子重建草稿 + 写身份谱系
  lineage.js    身份谱系读取 / 求根（对照判定 restore_lineage 配对）
  diff.js       两版对照（只读）：身份配对 + 逐项前后值 + 关系增删改
  seed.js       演示数据
public/         访客页与编辑台（原生 HTML/CSS/JS）
test/           node:test 单元与端到端测试（含成环、无解、409 冲突、恢复、版本对照）
```

## 主要 HTTP API

公开（无口令）：

- `GET /api/public/chronicle` — 最新已发布版本完整快照
- `GET /api/public/versions` / `GET /api/public/versions/:no` — 版本清单 / 指定版本

编辑（需请求头 `X-Editor-Token`）：

- `GET  /api/editor/state` — 草稿全貌 + 当前版本号
- 事件：`POST /api/editor/events`、`PUT/DELETE /api/editor/events/:id`
- 主张：`POST /api/editor/events/:id/claims`、`PUT/DELETE /api/editor/claims/:claimId`
- 关系：`POST /api/editor/relations`、`DELETE /api/editor/relations/:id`
- 同日关系（两端不分先后，录入时按事件 id 归一为小 id 在前）：`POST /api/editor/same-day-relations`、`DELETE /api/editor/same-day-relations/:id`
- `POST /api/editor/validate` — 预校验（不落库）；响应额外带 `draftRevision`，供下一步查看改选建议
- `POST /api/editor/suggest-reselection` — 时间无解时查看改选建议（**只读**：不写草稿 / 不推进修订号 / 不碰发布版本）；体含 `selection:[{eventId,claimId}]`（须逐事件、不缺不重、主张归属合法）与预检返回的 `draftRevision`
  - 200：`{ok, code:"RESELECTION_SUGGESTION", draftRevision, changedEventCount, changes:[{eventId,title,fromClaimId,toClaimId,from,to}], selection:[{eventId,title,claimId,dateLabel,intervalStart,intervalEnd,source,resolvedDate}]}`
  - 400：`{code:"SELECTION_INVALID", missingEventIds, duplicateEventIds, invalidSelections:[{eventId,claimId,reason}]}`（`reason`：`event_not_found | claim_not_found | claim_belongs_to_other_event`）
  - 409：`{code:"DRAFT_REVISION_STALE", submittedDraftRevision, currentDraftRevision}` — 预检后或计算期间草稿已变，重新预检
  - 422：`{code:"UNRESOLVABLE_BY_RESELECTION", reason:"cycle|same_day_before|event_without_claims|no_feasible_combination", message, eventIds, relationIds, sameDayRelationIds}`
- `POST /api/editor/publish` — 发布；体含 `selection:[{eventId,claimId}]`、`baseVersionNo`、`editor`、`note`
  - 422：`{errors:[{type:missing|same_day_before|same_day_interval|cycle|temporal, eventIds, relationIds, sameDayRelationIds, message, detail}]}`（`same_day_interval` 另带 `witnessEventIds`）
  - 409：`{code:"VERSION_CONFLICT", baseVersionNo, currentVersionNo, currentVersion}`
- 从历史版本恢复草稿：
  - `POST /api/editor/restore/preview` — 体含 `versionNo`；只读返回该版事件/被选主张/关系、当前草稿将被替换的内容、`draftRevision` 与 `latestVersionNo`；版本不存在 → 404 `VERSION_NOT_FOUND`
  - `POST /api/editor/restore/confirm` — 体含 `versionNo`、`draftRevision`、`expectedLatestVersionNo`（取预览返回值）；原子替换整个草稿，返回 `{restoredFromVersionNo, idMap:{events,claims,relations,sameDayRelations}, state}`（`state` 即新草稿全貌，含待选主张）
    - 409：`{code:"RESTORE_CONFLICT", message, previewDraftRevision, currentDraftRevision, expectedLatestVersionNo, currentVersionNo}`
    - 404：`{code:"VERSION_NOT_FOUND"}`
- 两版年表对照（只读）：`POST /api/editor/versions/diff` — 体含 `fromVersionNo`、`toVersionNo`（均为正整数版本号，可相同）与可选 `manualPairs:[{fromEventId,toEventId}]`（仅本次对照有效）；不推进修订号、不写任何数据
  - 200：`{code:"VERSION_DIFF", readOnly, from,to, pairing:{autoPairCount, manualPairCount, pairs:[{fromEventId,toEventId,matchKind,fromTitle,toTitle}], unpairedFrom, unpairedTo}, eventDiffs:[{fromEventId,toEventId,matchKind,fromTitle,toTitle,changed, fields:[{field,from,to,changed}]}], relations:{unchanged,changed,added,removed}, sameDayRelations:{unchanged,changed,added,removed}}`
    - `matchKind`：`same_id`（草稿 id 相同）/ `restore_lineage`（恢复谱系证明同身份）/ `manual`（本次人工配对）
    - 事件字段 `field` 依次为 `title, description, precision, dateLabel, intervalStart, intervalEnd, source, claimNote, resolvedDate`
    - 先于关系条目：配对后两端 `earlier/later:{fromEventId,toEventId,fromTitle,toTitle}`；`changed/unchanged` 带 `fields:[{field:source|note,from,to,changed}]`；`added/removed` 带 `reason`（`absent_in_from | absent_in_to | endpoint_unpaired | ambiguous_endpoint_group`）与关系在两版中的 id
    - 同日关系条目：无向两端 `eventA/eventB:{fromEventId,toEventId,fromTitle,toTitle}`（按身份配对、端点不分先后）；`changed/unchanged` 带 `fields`，`added/removed` 带同样的 `reason` 与两版中的 id（字段名为 `sameDayRelationIdFrom/sameDayRelationIdTo`）
  - 400：`{code:"PAIR_INVALID", invalidPairs:[{fromEventId,toEventId,reason}]}`，`reason`：`invalid_pair | duplicated_from | duplicated_to | duplicated_pair | from_event_not_found | to_event_not_found | conflict_with_pair`（冲突项另带 `existingFromEventId/existingToEventId`）
  - 400：`{code:"VERSION_NO_INVALID"}`（版本号非正整数）；404：`{code:"VERSION_NOT_FOUND", versionNo}`（任一版本未知）
- 所有草稿增删改接口（含恢复确认）都会推进 `GET /api/editor/state` 返回的 `draftRevision`；预览、发布、改选建议与版本对照不推进。`state` 与各发布快照均含 `sameDayRelations`（同日关系）字段；版本汇总另含 `sameDayRelationCount`。

## 改选建议 HTTP 调用示例

编辑台已内置该流程（预检报「时间无解」时点「查看改选建议」）。直接调用 API：

```bash
TOKEN=editor            # 与 EDITOR_TOKEN 一致
BASE=http://localhost:3000

# 1) 预检：失败时记下响应里的 draftRevision
curl -s -X POST "$BASE/api/editor/validate" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"selection":[{"eventId":1,"claimId":1},{"eventId":2,"claimId":3}]}'
# -> {"ok":false,"draftRevision":7,"errors":[{"type":"temporal", ...}]}

# 2) 带回同一份逐事件选择与预检时的 draftRevision 查看改选建议
curl -s -X POST "$BASE/api/editor/suggest-reselection" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"selection":[{"eventId":1,"claimId":1},{"eventId":2,"claimId":3}],
       "draftRevision":7}'
# -> {"ok":true,"code":"RESELECTION_SUGGESTION","changedEventCount":1,
#     "changes":[{"eventId":2,"fromClaimId":3,"toClaimId":4,...}],
#     "selection":[{"eventId":1,"claimId":1,"resolvedDate":"1958-12-01"},
#                  {"eventId":2,"claimId":4,"resolvedDate":"1959-02-03"}], ...}
```

建议只描述「把哪些事件改选到哪条现有主张」即可解，不代替发布：确认采纳后用建议的 `selection` 重新调用 `/api/editor/validate` 与 `/api/editor/publish`（仍须遵守 `baseVersionNo` 冲突约定）。

## 两版对照 HTTP 调用示例

编辑台已内置（「已发布版本 → 两版对照」）。直接调用 API：

```bash
TOKEN=editor            # 与 EDITOR_TOKEN 一致
BASE=http://localhost:3000

# 1) 对照第 1 版与第 2 版（自动按草稿 id / 恢复谱系配对）
curl -s -X POST "$BASE/api/editor/versions/diff" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"fromVersionNo":1,"toVersionNo":2}'
# -> {"ok":true,"code":"VERSION_DIFF","readOnly":true,
#     "pairing":{"autoPairCount":2,"manualPairCount":0,
#       "pairs":[{"fromEventId":1,"toEventId":3,"matchKind":"restore_lineage",...}],
#       "unpairedFrom":[],"unpairedTo":[{"eventId":5,"title":"抽水机到站"}]},
#     "eventDiffs":[{"fromEventId":1,"toEventId":3,"changed":true,
#       "fields":[{"field":"precision","from":"year","to":"day","changed":true}, ...]}],
#     "relations":{"unchanged":[...],"changed":[],"added":[...],"removed":[]}}

# 2) 谱系无法证明身份的事件，为本次对照指定一对一人工配对（不保存）
curl -s -X POST "$BASE/api/editor/versions/diff" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"fromVersionNo":1,"toVersionNo":2,
       "manualPairs":[{"fromEventId":1,"toEventId":7},{"fromEventId":2,"toEventId":8}]}'
# 重复 / 跨版不存在 / 与自动确定配对冲突 → 400 PAIR_INVALID，逐项列原因：
# {"code":"PAIR_INVALID","invalidPairs":[{"fromEventId":1,"toEventId":8,
#   "reason":"conflict_with_pair","existingFromEventId":2,"existingToEventId":7}]}

# 3) 未知版本明确报错
curl -s -X POST "$BASE/api/editor/versions/diff" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"fromVersionNo":1,"toVersionNo":99}'
# -> 404 {"code":"VERSION_NOT_FOUND","versionNo":99}
```

## 同日关系 HTTP 调用示例

编辑台已内置该流程（右侧「『同日』关系」卡片；校验错误点击可定位到具体事件 / 关系）。直接调用 API：

```bash
TOKEN=editor            # 与 EDITOR_TOKEN 一致
BASE=http://localhost:3000

# 1) 录入同日关系（两端不分先后；提交顺序任意，服务端按事件 id 归一）
curl -s -X POST "$BASE/api/editor/same-day-relations" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"eventAId":2,"eventBId":1,"source":"王秀兰口述：动员会与分粮同一天","note":"上午动员、傍晚分粮"}'
# -> {"sameDayRelation":{"id":1,"eventAId":1,"eventBId":2,"source":"...","note":"..."}}

# 2) 草稿全貌含 sameDayRelations；增删同日关系会推进 draftRevision
curl -s "$BASE/api/editor/state" -H "X-Editor-Token: $TOKEN"
# -> {"draftRevision":N,...,"sameDayRelations":[{"id":1,"eventAId":1,"eventBId":2,...}]}

# 3) 预检 / 发布：同日与先于一起求解；组内冲突时 422 并指出事件与两类关系 id
curl -s -X POST "$BASE/api/editor/validate" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"selection":[{"eventId":1,"claimId":1},{"eventId":2,"claimId":4}]}'
# 冲突示例：
# {"ok":false,"errors":[{"type":"same_day_interval",
#   "eventIds":[1,2],"relationIds":[],"sameDayRelationIds":[1],
#   "witnessEventIds":[2,1], "message":"...没有共同交集..."}]}
# {"ok":false,"errors":[{"type":"same_day_before",
#   "eventIds":[1,2],"relationIds":[7],"sameDayRelationIds":[1], ...}]}

# 4) 发布快照与访客年表都含 sameDayRelations
curl -s "$BASE/api/public/chronicle"
# -> {"published":true,"version":{ ...,
#      "sameDayRelationCount":1,
#      "sameDayRelations":[{"sameDayRelationId":1,"eventAId":1,"eventBId":2,
#                           "source":"王秀兰口述...","note":"..."}]}}

# 5) 删除同日关系（推进草稿修订号）
curl -s -X DELETE "$BASE/api/editor/same-day-relations/1" -H "X-Editor-Token: $TOKEN"
```

同日关系随发布写入不可变快照；从历史版本恢复草稿时一并重建（恢复确认返回的 `idMap.sameDayRelations` 给出旧快照 id → 新草稿 id 映射）；两版对照响应中的 `sameDayRelations` 按已确定事件身份给出新增 / 移除 / 修改（无法唯一对应时只列增删）。

## 本轮变动（事件「同日」关系）

- 新增**「同日」关系**：编辑者可在两个事件之间记录带**出处**与**备注**的同日关系，**两端不分先后**（提交顺序任意，服务端按事件 id 归一）。新增草稿表 `same_day_relations` 与编辑接口 `POST/DELETE /api/editor/same-day-relations`；录入、删除都推进草稿修订号。
- **预检与发布把同日关系与严格「先于」关系一起求解**（`src/solver.js`）：年 / 月 / 日主张仍按覆盖闭区间取值；同日关系无向连成**连通组（并查集）**，同组事件共享一个具体日期（取组内区间交集），「先于」在**折叠后的组图**上要求组间至少相差一天。三类新增拒绝——`same_day_before`（组内两事件间存在先于 / 先于链）、`same_day_interval`（组内区间无交集）、折叠后 `cycle`（折叠后先于成环）——均在错误中列出**冲突事件与先于 / 同日关系 id**，拒绝发布时**上一版本不变**（既有 `temporal / missing / cycle` 语义保持兼容，自环仍报 `cycle`）。
- 发布把同日关系写入新的不可变快照表 `version_same_day_relations`；公开年表与版本 JSON 增加 `sameDayRelations`（汇总增加 `sameDayRelationCount`）。
- **改选建议**（`src/suggest.js`）支持同日约束：以同日组为单位枚举组内主张组合（区间交集非空），组图上求最少改选数 + 平手字典序；`same_day_before / cycle` 等结构性冲突仍返回 422，明确无法靠改选解决。
- **恢复历史版本**按快照重建同日关系并返回 `idMap.sameDayRelations`；**版本对照**（`src/diff.js`）新增 `sameDayRelations` 分区：两端按已确定事件身份无向配对，唯一对应比较出处 / 备注，无法唯一对应只列增删，未配对端点随事件列增删。
- 编辑台新增「『同日』关系」录入卡片，校验错误可点击定位到涉事事件、先于关系与同日关系；恢复预览 / 两版对照对话框展示同日关系；访客年表展示已发布同日关系。
- 新增测试 `test/sameday.test.js`（录入归一化 / 校验 / 修订号、三类求解拒绝、改选建议、不可变快照与访客可见、恢复重建、版本对照修改与歧义增删）。新增表自动创建，旧库可直接启动；既有接口路径与响应字段保持兼容（均为**新增字段**）。

## 本轮变动（两版年表对照）

- 新增只读接口 `POST /api/editor/versions/diff` 与对照模块 `src/diff.js`：按「草稿 id → 恢复谱系」判定事件身份，逐项给出事件标题 / 描述 / 主张精度 / 日期 / 区间 / 出处 / 考异 / 求解日期前后值；关系按配对后端点比较新增、移除、修改（出处、备注），同端点多条无法唯一对应时只列增删；支持仅本次有效的一对一人工配对并逐项拒绝非法配对，绝不按标题相似度猜测。
- 新增只追加表 `event_lineage` 与 `src/lineage.js`：恢复事务（`src/restore.js`）在按快照重建草稿时记录「新草稿事件 id → 被恢复事件身份根」，使恢复后再次发布的事件即使拿到新数据库 id，仍可在旧版本对照中延续身份（支持多次恢复、跨版追溯）。
- 编辑台「已发布版本」卡片新增两版选择与对照对话框（事件前后值表、未配对事件、人工配对表单、关系增删改分区）。
- 新增测试 `test/diff.test.js`（自动 / 谱系 / 多跳谱系配对、人工配对全部分支、关系修改与歧义增删、未配对端点、404/400/401、只读语义）。
- 对照不写任何数据、不推进草稿修订号，历史快照与当前草稿不变；未知版本明确 404；既有接口与响应结构无破坏性变化，新增表自动创建，旧库可直接启动。
