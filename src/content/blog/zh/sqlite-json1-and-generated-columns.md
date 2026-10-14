---
title: "SQLite JSON：在单文件中查询 JSON（以及何时该规范化）"
description: "SQLite 的 JSON1 扩展让你可以对存储在 TEXT 列中的 JSON 进行查询、过滤和索引——json_extract、->>、json_each，以及让查询更快的生成列技巧。"
pubDate: 2027-01-31
lang: zh
translationKey: sqlite-json1-and-generated-columns
tags: [devops, python]
featured: false
keywords:
  - SQLite JSON
  - json_extract
  - 生成列
  - json_each
  - JSON 字段索引
---

我一直在越来越多地把 SQLite 作为副业项目、homelab 工具和本地优先应用的默认数据库。如果你从 Postgres 或 MongoDB 过来，把 JSON 塞进单个文件这个想法要么让人觉得解放，要么让人觉得鲁莽——说实话，两者都有。SQLite 内置的 JSON1 扩展让 JSON 成为一等但在使用之前，你需要理解它的存储现实和一个性能技巧。

这是我希望自己当初能有的实用指南：真正重要的函数、让 JSON 可快速查询的生成列模式，以及关于何时保留 JSON、何时规范化为真实列的诚实建议。如果你还不熟悉 SQLite 本身，请先从 [SQLite 就够了](/zh/posts/sqlite-is-enough/) 和 [SQLite CLI  cookbook](/zh/posts/sqlite-cli-cookbook/) 开始。

## 为什么 JSON 在 SQLite 中真正有用

在 SQLite 中使用 JSON 的理由不是"简化版 MongoDB"——而是因为大量真实数据本质上是**叶子数据**：你一次性写入、整块读取、很少按字段过滤的 blob。想想配置文件、API 响应缓存、事件负载、设备遥测或标签列表。把这些都规范化到子表中是你不需要的开销。

SQLite 将 JSON 存储为普通 `TEXT`。没有二进制 JSON 类型，没有特殊编码——就是你插入时那个字符串，逐字节一致。这很重要，因为每次调用 `json_extract` 都要重新解析文本。对于一个每天读取十次的 200 字节配置 blob，这代价为零。对于一个每秒查询 1,000 次的 50 MB JSON 文档，这就是瓶颈。要知道自己处在在哪一边。

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  doc TEXT NOT NULL
);

INSERT INTO events (doc) VALUES
('{"sensor":"temp-1","reading":23.5,"unit":"C","tags":["indoor","lab"],"ts":"2026-10-14T08:00:00Z"}'),
('{"sensor":"temp-2","reading":19.8,"unit":"C","tags":["outdoor","roof"],"ts":"2026-10-14T08:05:00Z"}'),
('{"sensor":"hum-1","reading":62.1,"unit":"%","tags":["indoor","lab"],"ts":"2026-10-14T08:10:00Z"}'),
('{"sensor":"temp-1","reading":24.1,"unit":"C","tags":["indoor","lab"],"ts":"2026-10-14T08:15:00Z"}'),
('{"sensor":"press-1","reading":1013.2,"unit":"hPa","tags":["outdoor"],"ts":"2026-10-14T08:20:00Z"}');
```

这就是全部 schema。当新传感器类型带着额外字段出现时，不需要迁移——只需插入不同形状的 JSON。这种灵活性正是关键所在。

## 真正重要的 JSON1 函数

SQLite 的 JSON1 扩展提供了一套聚焦的工具。你不需要全部掌握；以下四个覆盖了 95 % 的实际工作。

### json_extract 和 -> / ->> 操作符

`json_extract(doc, '$.sensor')` 通过 JSONPath 提取值。`->` 操作符是简写，返回 JSON（保留字符串的引号）；`->>` 返回不带引号的文本。当你需要比较或索引字符串值时，用 `->>`。

```sql
SELECT id, doc->'$.sensor' AS arrow_json, doc->>'$.sensor' AS arrow_text
FROM events LIMIT 3;
```

```
id  arrow_json  arrow_text
--  ----------  ----------
 1  "temp-1"    temp-1
 2  "temp-2"    temp-2
 3  "hum-1"     hum-1
```

`->` 给你 `"temp-1"`（带引号的 JSON 字符串字面量）；`->>` 给你 `temp-1`（裸文本）。对于过滤和索引，`->>` 几乎总是你想要的。

### json_each 和 json_tree：数组展开为行

`json_each` 是一个表值函数——它将 JSON 数组展开为行。这就是你查询"所有标记为 `indoor` 的事件"的方式：

```sql
SELECT e.id, je.key, je.value AS tag
FROM events e, json_each(e.doc, '$.tags') je
WHERE e.id = 1;
```

```
id  key   tag
--  ---  ------
 1    0  indoor
 1    1  lab
```

`json_tree` 是递归版本——它遍历整个文档，每个嵌套层级，返回每个键/值对。对于调试或"在文档中查找任何名为 X 的字段"很有用：

```sql
SELECT key, type, value FROM json_tree((SELECT doc FROM events WHERE id = 1)) LIMIT 12;
```

```
  key     type                                                 value
-------  ------  -------------------------------------------------------------------------------------------------
         object  {"sensor":"temp-1","reading":23.5,"unit":"C","tags":["indoor","lab"],"ts":"2026-10-14T08:00:00Z"}
sensor   text    temp-1
reading  real                                                                                                 23.5
unit     text    C
tags     array   ["indoor","lab"]
      0  text    indoor
      1  text    lab
ts       text    2026-10-14T08:00:00Z
```

### json_set、json_patch 和构建 JSON

你可以用 `json_set`（设置单个路径）或 `json_patch`（合并 JSON 对象，RFC 7396 风格）就地修改 JSON。两者都返回一个新的 JSON 字符串——SQLite 中的 JSON 是不可变的。

```sql
SELECT json_set(doc, '$.reading', 99.9) AS after_set FROM events WHERE id = 1;
```

```
-------------------------------------------------------------------------------------------------
{"sensor":"temp-1","reading":99.9,"unit":"C","tags":["indoor","lab"],"ts":"2026-10-14T08:00:00Z"}
```

```sql
SELECT json_patch(doc, '{"reading": 88.8, "extra": true}') AS after_patch FROM events WHERE id = 1;
```

```
--------------------------------------------------------------------------------------------------------------
{"sensor":"temp-1","reading":88.8,"unit":"C","tags":["indoor","lab"],"ts":"2026-10-14T08:00:00Z","extra":true}
```

你还可以用 `json_object` 和 `json_group_array` 从行构建 JSON——方便地将查询结果导出为 JSON 负载：

```sql
SELECT json_group_array(json_object('sensor', sensor, 'reading', reading)) AS payload
FROM (SELECT json_extract(doc,'$.sensor') AS sensor, json_extract(doc,'$.reading') AS reading FROM events);
```

```
------------------------------------------------------------------------------------
[{"sensor":"temp-1","reading":23.5},{"sensor":"temp-2","reading":19.8},{"sensor":"hum-1","reading":62.1},{"sensor":"temp-1","reading":24.1},{"sensor":"press-1","reading":1013.2}]
```

## 性能技巧：带索引的生成列

这是让 SQLite JSON 在大规模下真正可用的关键。你可以创建一个**生成列**——一个由表达式计算的虚拟列——然后对其索引。SQLite 会物化生成列（使用 `STORED`），索引使查找从 O(n) 变为 O(log n)。

```sql
CREATE TABLE events2 (
  id INTEGER PRIMARY KEY,
  doc TEXT NOT NULL,
  sensor TEXT GENERATED ALWAYS AS (json_extract(doc, '$.sensor')) STORED
);
CREATE INDEX idx_events2_sensor ON events2(sensor);
```

生成列 `sensor` 在写入时计算并存储在磁盘上。你不能直接插入它——它从 `doc` 派生。现在对 `sensor` 过滤的查询会使用索引：

```sql
EXPLAIN QUERY PLAN SELECT * FROM events2 WHERE sensor = 'temp-1';
```

```
QUERY PLAN
`--SEARCH events2 USING INDEX idx_events2_sensor (sensor=?)
```

`SEARCH ... USING INDEX` 就是好的计划。将其与未索引表上相同查询的原始表达式进行对比：

```sql
EXPLAIN QUERY PLAN SELECT * FROM events WHERE json_extract(doc, '$.sensor') = 'temp-1';
```

```
QUERY PLAN
`--SCAN events
```

这个 `SCAN` 是全表扫描——SQLite 必须重新解析每行的 JSON 来评估谓词。对于 1,000 行，可以忽略不计。对于有 5 ms 查询预算的 1,000,000 行，这就是"即时"和"超时"的区别。生成列是中间地带：你保留了 JSON 的 schema 灵活性，但你过滤的字段位于真实、已索引的列中。

## json_valid 作为 CHECK 约束

因为 JSON 只是 `TEXT`，什么能阻止你插入格式错误的 JSON——直到你添加一个 `CHECK` 约束：

```sql
CREATE TABLE events3 (
  id INTEGER PRIMARY KEY,
  doc TEXT NOT NULL CHECK (json_valid(doc))
);
INSERT INTO events3 (doc) VALUES ('{"ok":true}');
INSERT INTO events3 (doc) VALUES ('{bad json}');
```

```
Error near line 13: CHECK constraint failed: json_valid(doc)
```

`json_valid` 对格式正确的 JSON 返回 1，对其他任何内容返回 0。作为 `CHECK`，它在数据库层强制执行数据完整性——你的应用即使想写垃圾也写不进去。代价是 SQLite 在每次插入时重新验证文本，但对于典型负载，这只是微秒级。

<figure>
<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="JSON 文档流入生成列，再流入索引">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <style>
    .box { fill: none; stroke: #0f766e; stroke-width: 1.5; rx: 6; }
    .label { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; fill: currentColor; }
    .small { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; fill: currentColor; opacity: 0.75; }
    .arrow { stroke: #0f766e; stroke-width: 1.5; fill: none; marker-end: url(#arrow); }
  </style>
  <rect class="box" x="20" y="60" width="160" height="120" rx="6"/>
  <text class="label" x="100" y="85" text-anchor="middle">doc (TEXT)</text>
  <text class="small" x="100" y="105" text-anchor="middle">{"sensor":"temp-1",</text>
  <text class="small" x="100" y="120" text-anchor="middle">"reading":23.5,...}</text>
  <text class="small" x="100" y="145" text-anchor="middle">json_extract</text>
  <text class="small" x="100" y="160" text-anchor="middle">'$.sensor'</text>
  <path class="arrow" d="M 180 120 L 230 120"/>
  <rect class="box" x="230" y="60" width="160" height="120" rx="6"/>
  <text class="label" x="310" y="85" text-anchor="middle">sensor (STORED)</text>
  <text class="small" x="310" y="105" text-anchor="middle">生成列</text>
  <text class="small" x="310" y="125" text-anchor="middle">"temp-1"</text>
  <text class="small" x="310" y="150" text-anchor="middle">写入时物化</text>
  <text class="small" x="310" y="165" text-anchor="middle">存储到磁盘</text>
  <path class="arrow" d="M 390 120 L 440 120"/>
  <rect class="box" x="440" y="60" width="180" height="120" rx="6"/>
  <text class="label" x="530" y="85" text-anchor="middle">idx_sensor</text>
  <text class="small" x="530" y="105" text-anchor="middle">B-tree 索引</text>
  <text class="small" x="530" y="125" text-anchor="middle">O(log n) 查找</text>
  <text class="small" x="530" y="150" text-anchor="middle">SEARCH 而非</text>
  <text class="small" x="530" y="165" text-anchor="middle">SCAN</text>
</svg>
<figcaption>JSON 文档 → 生成列 → 索引。生成列从 JSON 派生，存储在磁盘上，并建索引以实现快速查找。</figcaption>
</figure>

## 诚实的建议：何时保留 JSON，何时规范化

在多个项目中使用这个模式后，以下是我的经验法则：

**保留 JSON 当：**
- 数据是叶子数据——整块读取，从不按单个字段过滤。
- schema 确实不稳定——新字段频繁出现，你不想每周都迁移。
- 你在缓存 API 响应或配置 blob，你信任它们且很少深入查询。

**规范化为真实列当：**
- 你在大多数查询中按特定字段过滤或连接——使其成为真实列（或带索引的生成列）。
- 你需要引用完整性——外键不适用于 JSON 字段。
- JSON 文档很大（数 KB）而你只需要几个字段——将这些字段提取为真实列，可选地保留完整 blob。

**生成列是中间地带**，当你两者都想要时：对变化的部分保持 schema 灵活性，对你过滤的部分保持查询性能。你存储 JSON blob 以保留完整文档，但热门字段是可索引和可查询的。

我看到的常见错误是把 SQLite 中的 JSON 当作"总是好的"或"总是hack"。两者都不对。它是一个有明确性能特征的工具：对叶子数据免费，对带生成列的过滤字段廉价，如果你试图索引 SQLite 查询规划器无法使用的深层嵌套路径，那就很贵。知道你属于哪种情况，SQLite 中的 JSON 就能很好地为你服务。

---

*如果你正在构建 SQLite 应用，你可能还会发现 [SQLite CLI cookbook](/zh/posts/sqlite-cli-cookbook/) 中的日常命令很有用，以及 [SQLite 就够了](/zh/posts/sqlite-is-enough/) 中关于默认选择 Postgres 的案例分析。*
