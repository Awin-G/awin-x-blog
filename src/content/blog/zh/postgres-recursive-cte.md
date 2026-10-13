---
title: "Postgres 递归 CTE：用 SQL 查询树与图"
description: "递归 CTE 通过基础用例和自引用递归项来遍历层级数据。学习 WITH RECURSIVE、depth/path 累加器、CYCLE 防环、SEARCH 排序、执行计划分析，以及何时该用物化路径或 ltree 替代。"
pubDate: 2027-01-20
lang: zh
translationKey: postgres-recursive-cte
tags: [devops, linux]
featured: false
keywords:
  - Postgres 递归 CTE
  - WITH RECURSIVE
  - 树查询
  - 层级数据
  - CYCLE
---

我曾经试过用 Python 把全部员工数据拉到内存里，再用 `while` 循环遍历邻接列表来渲染组织架构图。代码又慢又丑，而且一旦有人汇报给自己就死循环。后来我学会了 Postgres 递归 CTE——那一整类应用层遍历代码就此消失了。

**递归 CTE**（公共表表达式）让你在 SQL 中直接查询层级数据——树、图、物料清单。不需要把数据拉到应用层再写循环，你只需要声明一个基础用例，写一个引用 CTE 自身的递归项，然后让 Postgres 迭代直到结果集不再增长。

心智模型很简单：递归 CTE 就是一个 `UNION ALL`，第二个分支读取第一个分支的输出。

## 递归 CTE 的结构

每个递归 CTE 由两部分组成，用 `UNION ALL` 连接：

```sql
WITH RECURSIVE cte_name AS (
    -- 基础用例：种子行
    SELECT ...
    FROM ...

    UNION ALL

    -- 递归项：引用 cte_name
    SELECT ...
    FROM cte_name
    JOIN ...
)
SELECT * FROM cte_name;
```

基础用例产生初始行。递归项将 CTE 自身的输出与源表连接，产生新行。Postgres 反复执行递归项，直到它返回零行——这就是不动点迭代。

关键约束：**必须**使用 `UNION ALL`，不能用 `UNION`。普通 `UNION` 会去重，可能掩盖循环并改变语义。如果需要去重，在外层查询中做。

## 经典的组织架构树遍历

先建一个简单的组织架构表，然后自顶向下遍历：

```sql
CREATE TABLE employees (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    manager_id INT REFERENCES employees(id)
);

INSERT INTO employees (id, name, manager_id) VALUES
(1, 'Alice', NULL),
(2, 'Bob',   1), (3, 'Carol', 1),
(4, 'Dave',  2), (5, 'Eve',   2),
(6, 'Frank', 3), (7, 'Grace', 3),
(8, 'Heidi', 4), (9, 'Ivan',  5);
```

树查询：

```sql
WITH RECURSIVE org_tree AS (
    SELECT id, name, manager_id, 1 AS depth
    FROM employees
    WHERE manager_id IS NULL          -- 基础用例：顶层（CEO）

    UNION ALL

    SELECT e.id, e.name, e.manager_id, ot.depth + 1
    FROM employees e
    JOIN org_tree ot ON e.manager_id = ot.id   -- 递归项
)
SELECT * FROM org_tree ORDER BY depth, id;
```

真实输出：

```
 id | name  | manager_id | depth
----+-------+------------+-------
  1 | Alice |            |     1
  2 | Bob   |          1 |     2
  3 | Carol |          1 |     2
  4 | Dave  |          2 |     3
  5 | Eve   |          2 |     3
  6 | Frank |          3 |     3
  7 | Grace |          3 |     3
  8 | Heidi |          4 |     4
  9 | Ivan  |          5 |     4
(9 rows)
```

整棵树一次查完。没有循环，没有往返通信，没有递归函数。基础用例播种根节点；递归项不断追加子节点，直到没有更多行为止。

## 累加 depth 和 path

上面例子中的 `depth` 列是一个**累加器**——它在基础用例中从 1 开始，每次迭代递增 1。你可以累加任何东西：求和、计数、数组、字符串。

路径累加器对调试和渲染特别有用：

```sql
WITH RECURSIVE org_tree AS (
    SELECT id, name, manager_id, 1 AS depth,
           name::TEXT AS path
    FROM employees
    WHERE manager_id IS NULL

    UNION ALL

    SELECT e.id, e.name, e.manager_id, ot.depth + 1,
           ot.path || ' > ' || e.name
    FROM employees e
    JOIN org_tree ot ON e.manager_id = ot.id
)
SELECT id, name, depth, path FROM org_tree ORDER BY path;
```

```
 id | name  | depth |            path
----+-------+-------+----------------------------
  1 | Alice |     1 | Alice
  2 | Bob   |     2 | Alice > Bob
  4 | Dave  |     3 | Alice > Bob > Dave
  8 | Heidi |     4 | Alice > Bob > Dave > Heidi
  5 | Eve   |     3 | Alice > Bob > Eve
  9 | Ivan  |     4 | Alice > Bob > Eve > Ivan
  3 | Carol |     2 | Alice > Carol
  6 | Frank |     3 | Alice > Carol > Frank
  7 | Grace |     3 | Alice > Carol > Grace
(9 rows)
```

`path` 列让层级关系一目了然。`depth` 列让你可以按层级缩进或过滤——`WHERE depth <= 2` 只取前两层。

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 280" width="640" height="280" role="img" aria-label="逐层遍历的组织架构树">
  <defs>
    <style>
      .node { fill: #fff; stroke: currentColor; stroke-width: 2; }
      .edge { stroke: currentColor; stroke-width: 1.5; fill: none; opacity: 0.4; }
      .label { font-family: system-ui, sans-serif; font-size: 13px; fill: currentColor; }
      .lvl { font-family: system-ui, sans-serif; font-size: 11px; fill: #0f766e; font-weight: 600; }
    </style>
  </defs>
  <rect width="640" height="280" fill="none"/>
  <!-- 边 -->
  <path class="edge" d="M320 50 L160 120"/>
  <path class="edge" d="M320 50 L480 120"/>
  <path class="edge" d="M160 120 L80 200"/>
  <path class="edge" d="M160 120 L240 200"/>
  <path class="edge" d="M480 120 L400 200"/>
  <path class="edge" d="M480 120 L560 200"/>
  <!-- 层级标签 -->
  <text class="lvl" x="20" y="54">第 1 层</text>
  <text class="lvl" x="20" y="124">第 2 层</text>
  <text class="lvl" x="20" y="204">第 3 层</text>
  <!-- 节点 -->
  <circle class="node" cx="320" cy="50" r="18"/>
  <text class="label" x="320" y="55" text-anchor="middle">Alice</text>
  <circle class="node" cx="160" cy="120" r="18"/>
  <text class="label" x="160" y="125" text-anchor="middle">Bob</text>
  <circle class="node" cx="480" cy="120" r="18"/>
  <text class="label" x="480" y="125" text-anchor="middle">Carol</text>
  <circle class="node" cx="80" cy="200" r="18"/>
  <text class="label" x="80" y="205" text-anchor="middle">Dave</text>
  <circle class="node" cx="240" cy="200" r="18"/>
  <text class="label" x="240" y="205" text-anchor="middle">Eve</text>
  <circle class="node" cx="400" cy="200" r="18"/>
  <text class="label" x="400" y="205" text-anchor="middle">Frank</text>
  <circle class="node" cx="560" cy="200" r="18"/>
  <text class="label" x="560" y="205" text-anchor="middle">Grace</text>
</svg>
<figcaption>递归项每次迭代向下遍历一层。<code>depth</code> 累加器记录每行是由第几次迭代产生的。</figcaption>
</figure>

## 无限循环的危险

递归 CTE 很强大，但如果数据中存在环，它可能无限循环。如果 Alice 汇报给 Bob，Bob 又汇报给 Alice，递归项永远不会到达不动点。

我故意制造了一个环来演示。我把 Alice 的 `manager_id` 指向 Heidi（深度第四层），形成 Alice → Bob → Dave → Heidi → Alice 的循环。

### `CYCLE` 子句

Postgres 14+ 提供了 `CYCLE` 子句——最简洁的内置防环机制：

```sql
WITH RECURSIVE org_tree AS (
    SELECT id, name, manager_id, 1 AS depth,
           ARRAY[id] AS visited
    FROM employees
    WHERE id = 1

    UNION ALL

    SELECT e.id, e.name, e.manager_id, ot.depth + 1,
           ot.visited || e.id
    FROM employees e
    JOIN org_tree ot ON e.manager_id = ot.id
    WHERE NOT ot.is_cycle
)
CYCLE id SET is_cycle USING cyc_path
SELECT id, name, depth, is_cycle, visited FROM org_tree ORDER BY depth, id;
```

```
 id | name  | depth | is_cycle |   visited
----+-------+-------+----------+-------------
  1 | Alice |     1 | f        | {1}
  2 | Bob   |     2 | f        | {1,2}
  3 | Carol |     2 | f        | {1,3}
  4 | Dave  |     3 | f        | {1,2,4}
  5 | Eve   |     3 | f        | {1,2,5}
  6 | Frank |     3 | f        | {1,3,6}
  7 | Grace |     3 | f        | {1,3,7}
  8 | Heidi |     4 | f        | {1,2,4,8}
  9 | Ivan  |     4 | f        | {1,2,5,9}
  1 | Alice |     5 | t        | {1,2,4,8,1}
(10 rows)
```

`CYCLE id SET is_cycle USING cyc_path` 告诉 Postgres：通过 `id` 追踪路径，当某行的 `id` 已出现在路径中时，将 `is_cycle` 设为 `true` 并停止从该行递归。第二行 Alice 的 `is_cycle = t`——循环被捕获，而非无限继续。

### 深度限制（Postgres 14 之前或额外保险）

在 `CYCLE` 子句出现之前，标准的防循环措施是手动深度限制：

```sql
WITH RECURSIVE deep_walk AS (
    SELECT id, name, manager_id, 1 AS depth
    FROM employees
    WHERE manager_id IS NULL

    UNION ALL

    SELECT e.id, e.name, e.manager_id, dw.depth + 1
    FROM employees e
    JOIN deep_walk dw ON e.manager_id = dw.id
    WHERE dw.depth < 5          -- 硬性安全上限
)
SELECT * FROM deep_walk ORDER BY depth, id;
```

无论是否存在环，这都将递归限制在第 5 层。方法简单粗暴但有效——即使已有 `CYCLE`，加上深度限制作为双重保险仍然值得。

## `SEARCH DEPTH FIRST` 与 `SEARCH BREADTH FIRST`

默认情况下，返回行的顺序是不确定的。`SEARCH` 子句让你控制遍历顺序：

```sql
WITH RECURSIVE org_tree AS (
    SELECT id, name, manager_id, 1 AS depth
    FROM employees
    WHERE manager_id IS NULL

    UNION ALL

    SELECT e.id, e.name, e.manager_id, ot.depth + 1
    FROM employees e
    JOIN org_tree ot ON e.manager_id = ot.id
)
SEARCH DEPTH FIRST BY id SET order_col
SELECT id, name, depth, order_col FROM org_tree ORDER BY order_col;
```

```
 id | name  | depth |     order_col
----+-------+-------+-------------------
  1 | Alice |     1 | {(1)}
  2 | Bob   |     2 | {(1),(2)}
  4 | Dave  |     3 | {(1),(2),(4)}
  8 | Heidi |     4 | {(1),(2),(4),(8)}
  5 | Eve   |     3 | {(1),(2),(5)}
  9 | Ivan  |     4 | {(1),(2),(5),(9)}
  3 | Carol |     2 | {(1),(3)}
  6 | Frank |     3 | {(1),(3),(6)}
  7 | Grace |     3 | {(1),(3),(7)}
(9 rows)
```

`SEARCH DEPTH FIRST` 在回溯之前先完整走到底——`order_col` 显示 Alice → Bob → Dave → Heidi 排在 Eve 前面。`SEARCH BREADTH FIRST` 逐层处理：

```sql
-- 同样的 CTE，改用 SEARCH BREADTH FIRST
SEARCH BREADTH FIRST BY id SET order_col
SELECT id, name, depth, order_col FROM org_tree ORDER BY order_col;
```

```
 id | name  | depth | order_col
----+-------+-----------+-----------
  1 | Alice |     1 | (0,1)
  2 | Bob   |     2 | (1,2)
  3 | Carol |     2 | (1,3)
  4 | Dave  |     3 | (2,4)
  5 | Eve   |     3 | (2,5)
  6 | Frank |     3 | (2,6)
  7 | Grace |     3 | (2,7)
  8 | Heidi |     4 | (3,8)
  9 | Ivan  |     4 | (3,9)
(9 rows)
```

广度优先按深度分组——当你需要逐层处理时很有用（例如先通知所有二层经理，再通知三层）。

## 执行计划揭示的真相

一个常见误解是递归 CTE 很慢，因为它是"规划器中的循环"。其实不是。看真实的 `EXPLAIN (ANALYZE)`：

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
WITH RECURSIVE org_tree AS (
    SELECT id, name, manager_id, 1 AS depth
    FROM employees
    WHERE manager_id IS NULL

    UNION ALL

    SELECT e.id, e.name, e.manager_id, ot.depth + 1
    FROM employees e
    JOIN org_tree ot ON e.manager_id = ot.id
)
SELECT * FROM org_tree ORDER BY depth, id;
```

```
                                            QUERY PLAN
---------------------------------------------------------------------------------------------------
 Sort (actual time=0.160..0.162 rows=9 loops=1)
   Sort Key: org_tree.depth, org_tree.id
   Sort Method: quicksort  Memory: 25kB
   Buffers: shared hit=5
   CTE org_tree
     ->  Recursive Union (actual time=0.010..0.138 rows=9 loops=1)
           Buffers: shared hit=5
           ->  Seq Scan on employees (actual time=0.009..0.009 rows=1 loops=1)
                 Filter: (manager_id IS NULL)
                 Rows Removed by Filter: 8
                 Buffers: shared hit=1
           ->  Hash Join (actual time=0.020..0.022 rows=2 loops=4)
                 Hash Cond: (e.manager_id = ot.id)
                 Buffers: shared hit=4
                 ->  Seq Scan on employees e (actual time=0.002..0.003 rows=9 loops=4)
                       Buffers: shared hit=4
                 ->  Hash (actual time=0.012..0.012 rows=2 loops=4)
                       Buckets: 1024  Batches: 1  Memory Usage: 9kB
                       ->  WorkTable Scan on org_tree ot (actual time=0.001..0.002 rows=2 loops=4)
   ->  CTE Scan on org_tree (actual time=0.011..0.142 rows=9 loops=1)
         Buffers: shared hit=5
 Planning Time: 0.167 ms
 Execution Time: 0.282 ms
(23 rows)
```

规划器将递归项视为**工作表（worktable）**——一种临时内存结构，保存中间结果。每次迭代扫描工作表，与 `employees` 连接，追加新行。Hash Join 的 `loops=4` 意味着递归项执行了 4 次（每个深度层一次）后耗尽整棵树。

关键洞察：递归**不是**规划器执行模型中的嵌套循环。它就是工作表扫描 + 连接，和其他任何连接一样。性能特征是可预测的——每次迭代都是对 `employees` 的索引查找或顺序扫描。

## 实际用例

### 物料清单（BOM）

物料清单是经典的递归展开场景。给定零部件和子零部件关系，计算总用量：

```sql
CREATE TABLE parts (
    part_id SERIAL PRIMARY KEY,
    part_name TEXT NOT NULL,
    parent_id INT REFERENCES parts(part_id),
    quantity INT NOT NULL DEFAULT 1
);

INSERT INTO parts (part_id, part_name, parent_id, quantity) VALUES
(1, 'Bicycle', NULL, 1),
(2, 'Frame', 1, 1),   (3, 'Wheel', 1, 2),   (4, 'Handlebar', 1, 1),
(5, 'Spoke', 3, 36),  (6, 'Rim', 3, 1),     (7, 'Tire', 3, 1),
(8, 'Bolt', 2, 10),   (9, 'Bolt', 5, 1),    (10, 'Bolt', 6, 1);

WITH RECURSIVE bom AS (
    SELECT p.part_id, p.part_name, p.parent_id, p.quantity,
           p.quantity AS total_qty, 1 AS level
    FROM parts p
    WHERE p.parent_id IS NULL

    UNION ALL

    SELECT p.part_id, p.part_name, p.parent_id, p.quantity,
           p.quantity * bom.total_qty, bom.level + 1
    FROM parts p
    JOIN bom ON p.parent_id = bom.part_id
)
SELECT level, part_name, quantity, total_qty
FROM bom ORDER BY level, part_id;
```

```
 level | part_name | quantity | total_qty
-------+-----------+----------+-----------
     1 | Bicycle   |        1 |         1
     2 | Frame     |        1 |         1
     2 | Wheel     |        2 |         2
     2 | Handlebar |        1 |         1
     3 | Spoke     |       36 |        72
     3 | Rim       |        1 |         2
     3 | Tire      |        1 |         2
     3 | Bolt      |       10 |        10
     4 | Bolt      |        1 |        72
     4 | Bolt      |        1 |         2
(10 rows)
```

累加器 `total_qty` 沿树向下乘法：每辆自行车需要 2 个轮子，每个轮子需要 36 根辐条，所以一辆自行车需要 72 根辐条。递归项处理了乘法运算——不需要过程式代码。

### 生成日期序列

递归 CTE 不只是为树而生。没有数字表，需要生成日期范围？

```sql
WITH RECURSIVE dates AS (
    SELECT '2025-01-01'::DATE AS d
    UNION ALL
    SELECT d + 1 FROM dates WHERE d < '2025-01-10'::DATE
)
SELECT d, EXTRACT(ISODOW FROM d) AS dow FROM dates;
```

```
    d      | dow
------------+-----
 2025-01-01 |   3
 2025-01-02 |   4
 2025-01-03 |   5
 2025-01-04 |   6
 2025-01-05 |   7
 2025-01-06 |   1
 2025-01-07 |   2
 2025-01-08 |   3
 2025-01-09 |   4
 2025-01-10 |   5
(10 rows)
```

基础用例是一个日期；递归项每次加一天。`WHERE d < ...` 是终止条件。简单，不需要额外的表。

### 图可达性

给定边 `(from_node, to_node)`，找出从源节点出发的所有路径：

```sql
CREATE TABLE graph_edges (from_node INT NOT NULL, to_node INT NOT NULL);

INSERT INTO graph_edges (from_node, to_node) VALUES
(1, 2), (1, 3), (2, 4), (3, 4), (4, 5), (5, 6), (3, 6);

WITH RECURSIVE reach AS (
    SELECT from_node, to_node, ARRAY[from_node, to_node] AS path
    FROM graph_edges
    WHERE from_node = 1

    UNION ALL

    SELECT r.from_node, e.to_node, r.path || e.to_node
    FROM reach r
    JOIN graph_edges e ON r.to_node = e.from_node
    WHERE NOT e.to_node = ANY(r.path)
)
SELECT from_node, to_node, array_to_string(path, ' -> ') AS path
FROM reach ORDER BY path;
```

```
 from_node | to_node |         path
-----------+---------+-----------------------
         1 |       2 | 1 -> 2
         1 |       4 | 1 -> 2 -> 4
         1 |       5 | 1 -> 2 -> 4 -> 5
         1 |       6 | 1 -> 2 -> 4 -> 5 -> 6
         1 |       3 | 1 -> 3
         1 |       4 | 1 -> 3 -> 4
         1 |       5 | 1 -> 3 -> 4 -> 5
         1 |       6 | 1 -> 3 -> 4 -> 5 -> 6
         1 |       6 | 1 -> 3 -> 6
(9 rows)
```

`WHERE NOT e.to_node = ANY(r.path)` 是手动防环守卫——节点重复时停止。生产环境中，请改用 `CYCLE` 子句。

## 何时不该用递归 CTE

递归 CTE 很优雅，但并非总是最佳选择。

**适合使用递归 CTE 的场景：**
- 偶尔查询树（临时报表、管理页面）
- 深度未知或变化很大
- 遍历图或可变深度层级
- 想保持 schema 简单（仅用邻接列表）

**应考虑替代方案的场景：**

- **高频查询树**（如每个页面渲染菜单）。**物化路径**（存储 `1.2.4.5` 字符串）或**闭包表**（存储所有祖先-后代对）以写入复杂度换取读取速度。如果每秒执行数千次递归 CTE，对大树来说开销可能很大。

- **需要按路径前缀查子树**。物化路径在此场景出色：`WHERE path LIKE '1.2.%'` 一次索引扫描就能拿到整个子树。参见 [Postgres 索引类型](/zh/posts/postgres-index-types/) 了解 GIN 和 BTREE 索引的应用。

- **树很大且基本不变**。`ltree` 是 Postgres 的专用扩展，针对层级数据优化了祖先、后代和模式匹配操作。搭建更复杂，但对深层频繁查询快得多。

- **需要在写入时强制"无环"**。递归 CTE 在查询时检测环；触发器或应用层检查在写入时阻止环。`CYCLE` 子句是安全网，不是约束。

## 总结

递归 CTE 用一条声明式 SQL 语句取代了整类应用层遍历代码。模式始终相同：基础用例、递归项、`UNION ALL`、终止条件（隐式不动点、显式 `WHERE` 或 `CYCLE` 子句）。

从组织架构树遍历开始。加上 `depth` 累加器。加个 `path` 用于调试。用 `CYCLE` 或深度限制防止循环。然后应用到 BOM、日期序列和图遍历——相同模式，不同数据。

想深入了解查询调优，参见 [Postgres EXPLAIN](/zh/posts/postgres-explain/) 和 [Postgres 索引类型](/zh/posts/postgres-index-types/)。一旦理解了工作表如何驱动迭代，你就能自信地分析性能。

下次有人给你一棵树让你在应用层渲染时，请微笑，然后写一个递归 CTE。
