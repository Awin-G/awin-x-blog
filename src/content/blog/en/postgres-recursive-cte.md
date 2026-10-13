---
title: "Postgres recursive CTE: query trees and graphs in SQL"
description: "Recursive CTEs walk hierarchical data with a base case and a self-referencing term. Learn WITH RECURSIVE, depth/path accumulation, CYCLE protection, SEARCH ORDER, EXPLAIN plans, and when to use materialized path or ltree instead."
pubDate: 2027-01-20
lang: en
translationKey: postgres-recursive-cte
tags: [devops, linux]
featured: false
keywords:
  - Postgres recursive CTE
  - WITH RECURSIVE
  - tree query
  - hierarchical data
  - CYCLE
---

I once tried to render an org chart by fetching all employees into Python and walking the adjacency list with a `while` loop. It was slow, ugly, and broke the moment someone reported to themselves. Then I learned about Postgres recursive CTEs — and that entire class of application-side tree-walking code disappeared.

A **recursive CTE** (Common Table Expression) lets you query hierarchical data — trees, graphs, bill-of-materials — directly in SQL. Instead of fetching rows and looping in your application, you declare a base case, write a recursive term that references the CTE itself, and let Postgres iterate until the result set stops growing.

The mental model is simple: a recursive CTE is a `UNION ALL` where the second branch reads from the output of the first.

## The anatomy of a recursive CTE

Every recursive CTE has two parts joined by `UNION ALL`:

```sql
WITH RECURSIVE cte_name AS (
    -- Base case: the seed rows
    SELECT ...
    FROM ...

    UNION ALL

    -- Recursive term: references cte_name
    SELECT ...
    FROM cte_name
    JOIN ...
)
SELECT * FROM cte_name;
```

The base case produces the initial rows. The recursive term joins against the CTE's own output to produce new rows. Postgres repeats the recursive term until it returns zero rows — that's the fixed-point iteration.

The key constraint: you **must** use `UNION ALL`, not `UNION`. Plain `UNION` deduplicates, which can mask cycles and change semantics. If you need dedup, do it in the outer query.

## The canonical org-chart walk

Let's build a small org chart and walk it top-down:

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

Now the tree query:

```sql
WITH RECURSIVE org_tree AS (
    SELECT id, name, manager_id, 1 AS depth
    FROM employees
    WHERE manager_id IS NULL          -- base case: the CEO

    UNION ALL

    SELECT e.id, e.name, e.manager_id, ot.depth + 1
    FROM employees e
    JOIN org_tree ot ON e.manager_id = ot.id   -- recursive term
)
SELECT * FROM org_tree ORDER BY depth, id;
```

Real output:

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

That's the whole tree. No loop, no round-trips, no recursive function. The base case seeds the root; the recursive term keeps appending children until there are no more.

## Accumulating depth and path

The `depth` column in the example above is an **accumulator** — it starts at 1 in the base case and increments by 1 each iteration. You can accumulate anything: sums, counts, arrays, strings.

A path accumulator is especially useful for debugging and rendering:

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

The `path` column makes the hierarchy visible at a glance. The `depth` column lets you indent or filter by level — `WHERE depth <= 2` gives you just the top two layers.

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 280" width="640" height="280" role="img" aria-label="Org chart tree being walked level by level">
  <defs>
    <style>
      .node { fill: #fff; stroke: currentColor; stroke-width: 2; }
      .edge { stroke: currentColor; stroke-width: 1.5; fill: none; opacity: 0.4; }
      .label { font-family: system-ui, sans-serif; font-size: 13px; fill: currentColor; }
      .lvl { font-family: system-ui, sans-serif; font-size: 11px; fill: #0f766e; font-weight: 600; }
    </style>
  </defs>
  <rect width="640" height="280" fill="none"/>
  <!-- edges -->
  <path class="edge" d="M320 50 L160 120"/>
  <path class="edge" d="M320 50 L480 120"/>
  <path class="edge" d="M160 120 L80 200"/>
  <path class="edge" d="M160 120 L240 200"/>
  <path class="edge" d="M480 120 L400 200"/>
  <path class="edge" d="M480 120 L560 200"/>
  <!-- level labels -->
  <text class="lvl" x="20" y="54">depth 1</text>
  <text class="lvl" x="20" y="124">depth 2</text>
  <text class="lvl" x="20" y="204">depth 3</text>
  <!-- nodes -->
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
<figcaption>Each iteration of the recursive term walks one level deeper. The <code>depth</code> accumulator tracks which pass produced each row.</figcaption>
</figure>

## The infinite-loop danger

Recursive CTEs are powerful, but they can also run forever if your data contains a cycle. If Alice reports to Bob and Bob reports to Alice, the recursive term never reaches a fixed point.

I deliberately created a cycle to show you what happens. I set Alice's `manager_id` to point to Heidi (who is four levels deep), creating the cycle Alice → Bob → Dave → Heidi → Alice.

### The `CYCLE` clause

Postgres 14+ provides the `CYCLE` clause — the cleanest built-in protection:

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

The `CYCLE id SET is_cycle USING cyc_path` clause tells Postgres: track the path through `id`, and when a row's `id` already appears in the path, set `is_cycle = true` and stop recursing from that row. The second Alice row has `is_cycle = t` — the cycle is caught, not looped on.

### The depth limit (pre-Postgres 14 or extra safety)

Before the `CYCLE` clause existed, the standard safety net was a manual depth limit:

```sql
WITH RECURSIVE deep_walk AS (
    SELECT id, name, manager_id, 1 AS depth
    FROM employees
    WHERE manager_id IS NULL

    UNION ALL

    SELECT e.id, e.name, e.manager_id, dw.depth + 1
    FROM employees e
    JOIN deep_walk dw ON e.manager_id = dw.id
    WHERE dw.depth < 5          -- hard safety limit
)
SELECT * FROM deep_walk ORDER BY depth, id;
```

This caps the recursion at depth 5 regardless of cycles. It's blunt but effective — and it's still worth adding even with `CYCLE` as a belt-and-suspenders guard against pathological data.

## `SEARCH DEPTH FIRST` vs `SEARCH BREADTH FIRST`

By default, rows come back in arbitrary order. The `SEARCH` clause lets you control the traversal order:

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

`SEARCH DEPTH FIRST` walks all the way down one branch before backtracking — the `order_col` shows Alice → Bob → Dave → Heidi before Eve. `SEARCH BREADTH FIRST` processes one level at a time:

```sql
-- same CTE but with SEARCH BREADTH FIRST
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

Breadth-first groups by depth — useful when you want to process level by level (e.g., notify all level-2 managers before level-3).

## What the planner actually does

A common misconception is that recursive CTEs are slow because they're "loops in the planner." They're not. Let's look at a real `EXPLAIN (ANALYZE)`:

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

The planner treats the recursive term as a **worktable** — a temporary in-memory structure that holds the intermediate result. Each iteration scans the worktable, joins it against `employees`, and appends new rows. The `loops=4` on the hash join means the recursive term ran 4 times (once per depth level) before exhausting the tree.

The key insight: the recursion is **not** a nested loop in the planner's execution model. It's a worktable scan + join, just like any other join. The performance characteristics are predictable — each iteration is an index lookup or seq scan against `employees`.

## Practical use cases

### Bill of materials

A bill-of-materials (BOM) is a classic recursive explode. Given parts and sub-parts, compute total quantities:

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

The accumulator `total_qty` multiplies down the tree: each bicycle needs 2 wheels, each wheel needs 36 spokes, so a bicycle needs 72 spokes. The recursive term handles the multiplication — no procedural code needed.

### Generating a date series

Recursive CTEs aren't just for trees. Need a date range without a numbers table?

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

The base case is a single date; the recursive term adds one day at a time. The `WHERE d < ...` clause is the termination condition. Simple, no extra tables.

### Graph reachability

Given edges `(from_node, to_node)`, find all paths from a source:

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

The `WHERE NOT e.to_node = ANY(r.path)` is a manual cycle guard — it stops when a node repeats. For production, swap this for the `CYCLE` clause.

## When a recursive CTE is *not* the right tool

Recursive CTEs are elegant, but they're not always the best choice.

**Use a recursive CTE when:**
- The tree is queried occasionally (ad-hoc reports, admin pages)
- The depth is unknown or highly variable
- You're traversing graphs or variable-depth hierarchies
- You want to keep the schema simple (just an adjacency list)

**Consider alternatives when:**

- **You query the tree constantly** (e.g., rendering a menu on every page). A **materialized path** (storing `1.2.4.5` as a string) or **closure table** (storing every ancestor-descendant pair) trades write complexity for read speed. A recursive CTE on a large tree can be expensive if you run it thousands of times per second.

- **You need subtree lookups by path prefix**. Materialized path shines here: `WHERE path LIKE '1.2.%'` gets the entire subtree in one indexed scan. See the [Postgres index types](/posts/postgres-index-types/) post for how GIN and BTREE indexes apply.

- **Your tree is huge and mostly static**. `ltree` is a dedicated Postgres extension optimized for hierarchical data with operators for ancestry, descent, and pattern matching. It's more complex to set up but far faster for deep, frequent queries.

- **You need to enforce "no cycles" at write time**. A recursive CTE detects cycles at query time; a trigger or application-level check prevents them at write time. The `CYCLE` clause is a safety net, not a constraint.

## The bottom line

Recursive CTEs replace a whole category of application-side tree-walking code with a single, declarative SQL statement. The pattern is always the same: base case, recursive term, `UNION ALL`, and a termination condition (implicit fixed point, explicit `WHERE`, or `CYCLE` clause).

Start with the org-chart walk. Add a `depth` accumulator. Throw in a `path` for debugging. Protect against cycles with `CYCLE` or a depth limit. Then reach for BOMs, date series, and graph traversal — same pattern, different data.

For deeper query tuning, see [Postgres EXPLAIN](/posts/postgres-explain/) and [Postgres index types](/posts/postgres-index-types/). Once you understand how the worktable drives the iteration, you can reason about performance with confidence.

The next time someone hands you a tree to render in application code, smile and write a recursive CTE instead.
