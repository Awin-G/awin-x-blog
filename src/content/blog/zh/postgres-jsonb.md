---
title: "Postgres JSONB 实践：文档列何时优于数据表"
description: "一份实战指南：Postgres JSONB 运算符、GIN 索引（jsonb_ops vs jsonb_path_ops）、包含查询，以及何时该用文档列、何时不该用。"
pubDate: 2026-12-30
lang: zh
translationKey: postgres-jsonb
tags: [devops, linux]
featured: false
keywords:
  - Postgres JSONB
  - jsonb operators
  - GIN 索引 jsonb
  - jsonb vs json
  - containment
---

Postgres JSONB 是一个看起来像小众附加功能、直到某天你的模式不再适合行列结构时才显现价值的特性。在那一天，你会伸手去拿它——有时明智，有时不然。本文将讲解 `jsonb` 到底是什么、日常工作中真正重要的 **jsonb 运算符**、**GIN 索引 jsonb** 策略如何改变查询性能，以及同样重要的——什么时候*不该*用文档列。

以下所有查询都在一个临时 Postgres 17 容器中运行，使用包含嵌套文档的真实 `products` 表。真实输出，真实执行计划。

## JSONB 是什么（以及不是什么）

`jsonb` 是 JSON 的二进制解析表示。与 `json` 类型——逐字存储原始文本——不同，`jsonb` 会解析文档、丢弃空白、去除重复键并对对象键排序。结果是在磁盘上略大，但查询时快得多，因为数据库永远不需要重新解析文本。

```sql
SELECT '{"b": 2, "a": 1, "a": 3}'::json  AS json_dup,
       '{"b": 2, "a": 1, "a": 3}'::jsonb AS jsonb_dedup;
```

```
         json_dup         |   jsonb_dedup
--------------------------+------------------
 {"b": 2, "a": 1, "a": 3} | {"a": 3, "b": 2}
(1 row)
```

注意 `jsonb` 只保留了最后一个 `"a"` 值并重新排序了键。这种规范化正是 `jsonb` 支持索引和包含检查的原因——二进制形式具有稳定、可比较的结构。

## 真正重要的 JSONB 运算符

你不需要记住二十个运算符。五个就能覆盖大多数实际工作。

### `->` 和 `->>`：提取值

`->` 返回 `jsonb` 值（保留 JSON 类型）；`->>` 返回 `text`。

```sql
SELECT name,
       attrs->'brand'  AS brand_json,
       attrs->>'brand' AS brand_text
FROM products LIMIT 3;
```

```
        name         | brand_json | brand_text
---------------------+------------+------------
 Mechanical Keyboard | "Keychron" | Keychron
 Wireless Mouse      | "Logitech" | Logitech
 USB-C Hub           | "Anker"    | Anker
(3 rows)
```

需要链式提取时用 `->`（如 `attrs->'switch'->>'type'`）。需要纯字符串用于显示或比较时用 `->>`。

### `#>` 和 `#>>`：路径提取

需要深层值时，`#>` 接受路径数组并返回 `jsonb`；`#>>` 返回 `text`。

```sql
SELECT name,
       attrs#>'{switch,type}'      AS switch_type,
       attrs#>>'{firmware,name}'    AS firmware_name
FROM products
WHERE attrs ? 'switch' LIMIT 3;
```

```
        name         |   switch_type   | firmware_name
---------------------+-----------------+---------------
 Mechanical Keyboard | "Gateron Brown" | QMK
(1 row)
```

### `@>`：包含

这是让 JSONB 大放异彩的运算符。`@>` 询问："左侧文档是否包含右侧文档作为子集？"

```sql
SELECT name FROM products WHERE attrs @> '{"wireless": true}';
```

```
          name
-------------------------
 Mechanical Keyboard
 Wireless Mouse
 Noise-Cancel Headphones
 Smart Plug
 Raspberry Pi 5
(5 rows)
```

包含检查适用于任何深度。`attrs @> '{"switch": {"type": "Gateron Brown"}}'` 只会匹配键盘。这就是 GIN 索引加速的查询模式。

### `?`：键存在性

`?` 检查顶层键是否存在。`?|` 和 `?&` 接受键数组。

```sql
SELECT name FROM products WHERE attrs ? 'anc';
```

```
          name
-------------------------
 Noise-Cancel Headphones
(1 row)
```

### `jsonb_path_query`：SQL/JSON 路径语言

对于数组或嵌套结构中更复杂的过滤，Postgres 提供了 `jsonb_path_query` 和 JSON 路径表达式。

```sql
SELECT name,
       jsonb_path_query(attrs, '$.ports[*] ? (@ == "USB-C")') AS usbc_port
FROM products
WHERE attrs @> '{"ports": ["USB-C"]}';
```

```
        name         | usbc_port
---------------------+-----------
 Mechanical Keyboard | "USB-C"
 Wireless Mouse      | "USB-C"
 USB-C Hub           | "USB-C"
 Webcam              | "USB-C"
 Portable SSD        | "USB-C"
 Raspberry Pi 5      | "USB-C"
(6 rows)
```

## 更新嵌套键

`jsonb_set` 更新路径上的值，不触碰文档其余部分：

```sql
UPDATE products
SET attrs = jsonb_set(attrs, '{firmware,version}', '"0.25"')
WHERE name = 'Mechanical Keyboard';

SELECT attrs->'firmware' FROM products WHERE name = 'Mechanical Keyboard';
```

```
                    ?column?
-------------------------------------------------
 {"name": "QMK", "layers": 4, "version": "0.25"}
(1 row)
```

还有 `jsonb_insert` 用于数组，以及 `jsonb_set(..., create_missing := true)` 用于创建尚不存在的中间键。

## 聚合回 JSON

`jsonb_agg` 将行收集回 JSON 数组——对期望文档响应的 API 很有用：

```sql
SELECT jsonb_agg(jsonb_build_object('name', name, 'brand', attrs->>'brand'))
AS product_summary FROM products;
```

```
                                                                                                                                                                                                                                        product_summary
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 [{"name": "Wireless Mouse", "brand": "Logitech"}, {"name": "USB-C Hub", "brand": "Anker"}, {"name": "Monitor Light Bar", "brand": "BenQ"}, {"name": "Webcam", "brand": "Elgato"}, {"name": "Standing Desk", "brand": "FlexiSpot"}, {"name": "Noise-Cancel Headphones", "brand": "Sony"}, {"name": "Portable SSD", "brand": "Samsung"}, {"name": "Smart Plug", "brand": "TP-Link"}, {"name": "Raspberry Pi 5", "brand": "Raspberry Pi"}, {"name": "Mechanical Keyboard", "brand": "Keychron"}]
(1 row)
```

## GIN 索引 JSONB：jsonb_ops vs jsonb_path_ops

`jsonb` 列上的 GIN（通用倒排索引）是让包含和存在性查询变快的关键。Postgres 提供两种操作符类：

- **`jsonb_ops`**（默认）：将每个键和值作为独立条目索引。支持 `@>`、`?`、`?|`、`?&`。
- **`jsonb_path_ops`**：仅索引路径/值哈希。只支持 `@>`，但产生更小的索引。

```sql
CREATE INDEX idx_attrs_gin  ON products USING gin (attrs jsonb_ops);
CREATE INDEX idx_attrs_path ON products USING gin (attrs jsonb_path_ops);

SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) AS size
FROM pg_indexes WHERE tablename = 'products' AND indexname LIKE 'idx_attrs%';
```

```
   indexname    | size
----------------+-------
 idx_attrs_gin  | 16 kB
 idx_attrs_path | 16 kB
(2 rows)
```

在这个小数据集上两者都是 16 kB，但在大规模下 `jsonb_path_ops` 通常小 20–40%，因为它存储的索引条目更少。代价是：它只加速 `@>` 包含查询，不加速 `?` 存在性检查。

### EXPLAIN 显示什么

关于小表的诚实真相：规划器通常倾向于顺序扫描，因为比索引查找更便宜。

```sql
EXPLAIN SELECT name FROM products WHERE attrs @> '{"wireless": true}';
```

```
                       QUERY PLAN
---------------------------------------------------------
 Seq Scan on products  (cost=0.00..1.12 rows=1 width=32)
   Filter: (attrs @> '{"wireless": true}'::jsonb)
(2 rows)
```

这是正确行为——10 行数据时，顺序扫描更快。GIN 索引在数千行以上才显现价值。要看到索引生效需要更大的数据集，但原理成立：GIN 将全表 JSON 解析转变为索引探测。

作为对比，这是一个 GIN 索引*无法*高效加速的查询：

```sql
EXPLAIN SELECT name FROM products WHERE attrs->>'brand' = 'Keychron';
```

```
                        QUERY PLAN
----------------------------------------------------------
 Seq Scan on products  (cost=0.00..1.15 rows=1 width=32)
   Filter: ((attrs ->> 'brand'::text) = 'Keychron'::text)
(2 rows)
```

`->>` 运算符提取文本并进行比较——GIN 索引在这里帮不上忙。如果你经常通过某个提取值查询，那个值应该是一个真实列（或至少一个表达式索引）。

## JSONB 是正确工具的场景

JSONB 在以下情况下值得使用：

- **属性稀疏或不断演变。** 产品目录中有些商品有 `firmware`，有些有 `sensor`，下个月有人加了 `ai_features`。为每个都加列是模式变更的折磨；`jsonb` 列吸收这些变化。
- **存储外部负载。** Webhook 请求体、API 响应、配置块——需要保留和偶尔查询但不需要连接的数据。
- **元数据灵活。** 用户偏好、功能开关、A/B 测试分配——因实体而异但不关系化查询的东西。
- **需要包含查询。** "查找所有 `attrs @> '{"wireless": true, "ports": ["USB-C"]}'` 的商品"是单次索引查找。

## JSONB 是错误工具的场景

在以下情况下应该用普通表：

- **你关系化地查询该值。** 每次请求都 `WHERE attrs->>'status' = 'active'` 是 `status` 应该成为带 B-tree 索引的真实列的信号。
- **需要约束。** JSONB 上的 `CHECK` 约束可能但笨拙。外键、`NOT NULL` 和 `UNIQUE` 是列的原生特性。
- **数据完整性重要。** JSONB 本质上是无模式的。如果你需要保证每行都有 `user_id` 且它是整数，列能强制执行；JSONB 不能。
- **你在把所有东西都 JSONB 化。** 90% 的列都是 `jsonb` 的表是模式异味。数据库无法优化它看不到的东西。

## 将 JSONB 与普通列结合

实用模式是混合：热查询字段作为真实列；其余作为 JSONB。

```sql
CREATE TABLE orders (
    id          bigserial PRIMARY KEY,
    user_id     bigint NOT NULL REFERENCES users(id),
    status      text NOT NULL,
    total       numeric(12,2) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    metadata    jsonb
);
```

`user_id`、`status` 和 `total` 被频繁查询——它们获得正确的类型、约束和索引。`metadata` 保存其余所有内容：发货备注、折扣码、A/B 变体、第三方负载。你在需要的地方获得关系完整性，在不需要的地方获得灵活性。

## 性能与存储注意事项

- **TOAST 压缩：** 大型 JSONB 值被压缩并存储在行外。50 KB 的文档不会膨胀你的行。
- **索引大小：** GIN 索引比相同数据上的 B-tree 索引更大。`jsonb_path_ops` 比 `jsonb_ops` 更小但支持的运算符更少。
- **写放大：** 每个改变文档的 `jsonb_set` 都会创建整个文档的新版本（MVCC）。对大型文档频繁进行小更新代价很高。
- **部分索引：** 你可以只索引匹配条件的行：`CREATE INDEX ON products USING gin (attrs) WHERE attrs ? 'firmware'`。

## 决策清单

在以下情况下使用 JSONB：

1. 数据是文档形状的，因行而异。
2. 你通过包含（`@>`）或键存在性（`?`）查询。
3. 你不需要对内部字段做关系约束。
4. 替代方案是数十个可空列或 EAV 表。

在以下情况下不要使用 JSONB：

1. 你会在每个请求中用 `=`、`<`、`>` 查询提取的值。
2. 你需要对内层字段做外键、唯一约束或 NOT NULL。
3. 数据高度关系化，连接是主要访问路径。
4. 你用它是因为设计模式感觉像工作。

Postgres JSONB 是一个强大的工具，就像一个装备精良的 workshop 一样强大——技巧在于知道该拿哪个工具。当数据确实是文档形状时，带 GIN 索引的 JSONB 给出查询性能，这些性能需要大量应用代码才能复制。当数据是关系型的，再多的 `jsonb_path_query` 技巧也打不过一个合适的表。

更多关于索引策略的内容，参见 [数据库索引](/zh/posts/database-indexing/) 和 [Postgres 索引类型](/zh/posts/postgres-index-types/)。
