---
title: "SQLite VACUUM、integrity_check，以及一个不会变小的数据库文件"
description: "删了 99% 的行，SQLite 文件却没变小？那是 freelist 在作怪。用真实的 page_count、freelist_count、VACUUM、auto_vacuum、incremental_vacuum、VACUUM INTO 和 integrity_check 前后的数字说清楚。"
pubDate: 2027-01-20
lang: zh
translationKey: sqlite-vacuum-and-integrity
tags: [devops, python]
featured: false
keywords:
  - SQLite VACUUM
  - PRAGMA integrity_check
  - auto_vacuum
  - 数据库文件大小
  - freelist
---

你删掉了 99% 的行，SQLite 文件却一点没变小。数据库在磁盘上占着 58 MB，应用其实几乎不用它，而每一次 `ls -lh` 都是同样的结果。这不是 bug，也不是内存泄漏——这是 freelist，是 SQLite 维护里最常见的一个意外。我曾经在一张日志表上踩过这个坑，花了一个下午怀疑是驱动在缓存，现在我在开口之前先量一量。整个主题就一句话：**SQLite VACUUM** 归还空间，freelist 解释**数据库文件大小**为什么不动，而 `PRAGMA integrity_check` 告诉你这个文件有没有在骗你。我们来建一个真实的数据库，把它搞坏，再把它缩小——全部用真实的数字。

下面所有内容只要 `sqlite3` 就能复现。不用 sudo，不用网络，也不用 `ollama`。

## 为什么 SQLite 文件会涨却不会缩（freelist）

SQLite 把所有东西都存在固定大小的**页（page）**里——默认 4096 字节。一张表就是一棵页的 b-tree。当你 `DELETE` 行时，SQLite 并不会把这些页还给文件系统。它把页从表的 b-tree 上摘下来，串到内部的空闲列表——也就是 **freelist**——这样下一次插入可以直接复用它们，而不必把文件再涨大。这是刻意的，而且通常是对的：一张频繁读写的表否则每天要调整上千次文件大小。代价是，`DELETE` 缩小的是你的逻辑数据库，而不是文件。这些页仍然算进文件大小，只是被标记为空闲而已。

我来证明。建一张 20 万行的表，然后只留 2000 行：

```bash
$ sqlite3 events.db "CREATE TABLE events(id INTEGER PRIMARY KEY, ts TEXT, kind TEXT, payload TEXT);"
$ sqlite3 events.db "WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x<200000)
  INSERT INTO events(ts,kind,payload)
  SELECT datetime('now','-'||x||' seconds'),'event-'||(x%7),
         substr(hex(randomblob(120)),1,240) FROM c;"

$ ls -l events.db
-rw-r--r-- 1 root root 58671104 events.db      # 56 MiB，20 万行
```

56 MiB，`page_size` 4096，`page_count` 14324，`freelist_count` 0。现在删掉几乎全部：

```bash
$ sqlite3 events.db "DELETE FROM events WHERE id>2000;"
$ sqlite3 events.db "SELECT count(*) FROM events;"
2000

$ sqlite3 events.db "PRAGMA page_size; PRAGMA page_count; PRAGMA freelist_count;"
4096
14324
14179
$ ls -l events.db
-rw-r--r-- 1 root root 58671104 events.db      # 没变
```

只剩 1% 的行，文件却一字节都没变：还是 `page_count` 14324，还是 58,671,104 字节。那 198,000 行并没有消失——它们的 14,179 个页滑到了 freelist 上。存活数据是 `14324 - 14179 = 145` 个页，大约 593,920 字节。其余是空闲空间，但操作系统仍然按文件向你收费。

<figure>
<svg viewBox="0 0 720 168" width="720" height="168" role="img" aria-label="VACUUM 前大部分页是 freelist；VACUUM 后文件被截断到只含存活页" xmlns="http://www.w3.org/2000/svg">
  <text x="0" y="14" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">删除前 → 删除后 → VACUUM 后</text>
  <!-- 删除前后：都是 14,324 页的文件；145 页在用，14,179 页在 freelist -->
  <rect x="0" y="28" width="6" height="26" fill="currentColor"/>
  <rect x="6" y="28" width="439" height="26" fill="currentColor" opacity="0.18"/>
  <rect x="0" y="34" width="445" height="2" fill="currentColor" opacity="0.4"/>
  <text x="0" y="72" font-family="ui-monospace,monospace" font-size="11" fill="currentColor" opacity="0.75">14,324 页 · 145 在用 · 14,179 在 freelist · 文件仍是 58,671,104 字节</text>
  <!-- VACUUM 后：截断到只剩存活页 -->
  <rect x="0" y="92" width="6" height="26" fill="currentColor"/>
  <path d="M12 92 l-10 -8 M12 92 l-10 8 M14 118 l-10 -8 M14 118 l-10 8" stroke="currentColor" stroke-width="1.5" fill="none"/>
  <text x="0" y="136" font-family="ui-monospace,monospace" font-size="11" fill="currentColor" opacity="0.75">145 页 · freelist_count 0 · 文件截断到 593,920 字节</text>
  <text x="470" y="140" font-family="ui-monospace,monospace" font-size="11" fill="currentColor" opacity="0.55">= VACUUM 重写 + 截断</text>
</svg>
<figcaption>删除行只是把页移到 freelist，文件大小不变；VACUUM 重写存活页并截断文件，回到实际用量。</figcaption>
</figure>

`dbstat` 告诉你空间到底在哪棵 b-tree 里。聚合模式显示整张表：

```sql
sqlite> SELECT name, pageno, ncell, payload FROM dbstat WHERE aggregate=1 AND name='events';
events|144|2142|544000
```

`events` 表现在只占 144 个页，其余 13,682 个都是 freelist。这个数字解释了谜团：`page_count * page_size`（文件大小）减去 `freelist_count * page_size`（空闲空间）才是你真正在用的。

## 读懂膨胀：page_count × page_size 对比 freelist_count

**数据库文件大小**是操作系统层面的字节数，它从不说谎，但也从不会自我修正，而 freelist 是夹在中间看不见的那层。要读出真实膨胀，把两者结合起来：

```sql
-- 文件里有多少是死掉的？
sqlite> SELECT
  page_count AS total_pages,
  page_count - freelist_count AS live_pages,
  freelist_count AS free_pages,
  ROUND(100.0*freelist_count/page_count,1) AS pct_free
FROM pragma_page_count(), pragma_freelist_count();
total_pages|live_pages|free_pages|pct_free
14324|145|14179|99.0
```

99% 是空闲的。这大致就是我的行动阈值：如果 `pct_free` 是个位数，什么都不用做；如果超过 50% 且文件大于几 MB，就值得想一想了。`PRAGMA page_size` 给出乘数——`14179 * 4096 ≈ 56 MiB` 的可回收空间，就这么躺在一个 `du` 还在向你计费的文件里。

## SQLite VACUUM：真正归还空间的那次重写

**SQLite VACUUM** 是一次彻底的重建。它把每个存活页复制进一个全新的、紧凑的数据库——没有 freelist、没有空洞、已去碎片——然后换入并截断文件。同样的结果：

```bash
$ sqlite3 events.db "PRAGMA page_count; PRAGMA freelist_count;" ; ls -l events.db
14324
14179
-rw-r--r-- 1 root root 58671104 events.db

$ sqlite3 events.db "VACUUM;"

$ sqlite3 events.db "PRAGMA page_count; PRAGMA freelist_count;" ; ls -l events.db
145
0
-rw-r--r-- 1 root root 593920 events.db
```

58,671,104 字节 → 593,920 字节，缩减 99%，`freelist_count` 归 0，2000 行完好无损。"重写"这个词里藏着两个代价。磁盘：VACUUM 会在一个临时文件里构建紧凑后的数据库，所以同一文件系统上的峰值用量约等于当前文件大小。锁：它是覆盖整个数据库的写事务，需要独占访问，所以当有长时间运行的读或写活跃时它会阻塞——或以 `database is locked` 失败，在大型文件上还可能跑好几分钟。这就是我从不随便 VACUUM 的原因（下面详述）。

还有一个真实行为：VACUUM 也是改变几个持久化设置的*唯一*方式。`PRAGMA page_size` 和 `PRAGMA auto_vacuum` 只有在 VACUUM 之后才生效，而且必须在设置它们的同一个连接里做这次 VACUUM：

```bash
$ sqlite3 events.db "PRAGMA page_size=8192; PRAGMA page_size; VACUUM; PRAGMA page_size; PRAGMA page_count;"
4096      # 设置处于待定状态，文件仍是 4096
4096      # ……仍待定
8192      # 只有现在，VACUUM 之后
71
```

## auto_vacuum = FULL 对比 INCREMENTAL，以及 PRAGMA incremental_vacuum

如果你不想自己排 VACUUM，`PRAGMA auto_vacuum` 会自动把空闲页还回去。它必须在数据库有内容之前设置（或者通过一次 VACUUM 来改），因为它会把每一页重写，以维护一张**指针映射表（pointer map）**。在 `NONE` 之上有两种模式：

- **FULL（1）：** 一旦某个事务提交并在文件末尾留下空闲页，SQLite 就截断文件。自动、始终紧凑，代价是每次提交都稍慢一点。
- **INCREMENTAL（2）：** 空闲页进 freelist，但文件*不会*自动截断。你在自己的节奏上用 `PRAGMA incremental_vacuum` 回收。

拿三个数据库做同样的"20 万行再删掉 19.8 万行"，创建时设好 `auto_vacuum`：

```bash
# 插入 20 万行、删除 19.8 万行之后，各模式的文件大小：
auto_vacuum=NONE          -> 58671104 字节   （freelist 保留空间）
auto_vacuum=FULL          -> 598016   字节   （提交时自动截断文件）
auto_vacuum=INCREMENTAL   -> 58744832 字节   （不截断；比 NONE 还略大——那是指针映射表的页）
```

`INCREMENTAL` 看起来什么都没做，而这正是诚实的部分：它不会替你截断，由你决定何时：

```bash
# 把 INCREMENTAL 数据库缩回原来的大小：
$ sqlite3 av.db "PRAGMA freelist_count; PRAGMA page_count;" ; ls -l av.db
14179
14342
-rw-r--r-- 1 root root 58744832 av.db

$ sqlite3 av.db "PRAGMA incremental_vacuum;"

$ sqlite3 av.db "PRAGMA freelist_count; PRAGMA page_count;" ; ls -l av.db
0
146
-rw-r--r-- 1 root root 598016 av.db
```

`PRAGMA incremental_vacuum` 把 58.7 MB 回收到 0.57 MB，`freelist_count` 归 0。所以这个取舍是真实的：`FULL` 自动帮你缩，但每次提交都要付费，并且存的指针映射表会增加页数（我那个只有一行的测试文件，一打开自动清理就从几百字节涨到了 12,288 字节）。`INCREMENTAL` 让写入保持便宜，让你把回收批量放到一个清静时刻的一次 `incremental_vacuum` 里——对写入密集的日志表，我通常这么选。`NONE` 是默认，对大多数数据库也是正确选择；你只需接受偶尔手动 VACUUM。这正是我在 [SQLite 并发](/zh/posts/sqlite-concurrency/) 里讲的"单写者"世界——这些 pragma 全都踩在同一把写锁上。

## VACUUM INTO：一份一致的在线副本

`VACUUM INTO 'file.db'` 是 VACUUM 的亲戚，但干的活不一样：它把一份新压紧的副本写到新文件，数据库本身不动。因为它产出的是紧凑、自包含的镜像，它是一份极好的在线备份——即使有读在跑、处在 WAL 模式、写到一半，你也能得到一致的快照：

```bash
$ rm -f backup.db
$ sqlite3 events.db "VACUUM INTO 'backup.db';"
$ sqlite3 backup.db "SELECT count(*) FROM events;"
2000
$ sqlite3 backup.db "PRAGMA integrity_check;"
ok
```

源库不变，副本紧凑且去碎片，行数对得上。我试过对一个 WAL 库、在某个连接事务进行中执行它，副本仍然 `ok`——VACUUM INTO 读的是一个稳定快照，所以不同于裸 `cp` 文件（可能抓到写了一半的 WAL），它在线运行也安全。对于定期备份，这就是我伸手去拿的那一行命令，也是对 [SQLite 够用了](/zh/posts/sqlite-is-enough/) 里 `.backup` 方案的一个好补充。

## PRAGMA integrity_check 对比 quick_check：损坏的页长什么样

`quick_check` 和 `integrity_check` 都会扫描文件找损坏。`integrity_check` 是彻底的那个：走遍每一棵 b-tree，验证 cell 结构，检查索引条目是否指回真实的表行，并用一个临时索引重新校验 NOT NULL 和 UNIQUE 约束。`quick_check` 走同样的结构检查，但跳过昂贵的"索引对表"和约束交叉检查——所以它便宜得多，对于例行"这文件是不是明显坏了"的探测通常够用。在我这个刚 VACUUM 过的好库上，两者都干净：

```sql
sqlite> PRAGMA quick_check;
ok
sqlite> PRAGMA integrity_check;
ok
```

现在我用 `dd` 搞坏一个*副本*——把 200 字节垃圾直接写进一个数据页——再检查一遍。页大小是 4096，所以 offset 40960 落在表 b-tree 内：

```bash
$ cp events.db corrupt.db
$ printf 'GARBAGEGARBAGEGARBAGEGARBAGE' | dd of=corrupt.db bs=1 seek=40960 count=200 conv=notrunc status=none
$ sqlite3 corrupt.db "PRAGMA quick_check;"
Error: database disk image is malformed
*** in database main ***
Tree 2 page 11: btreeInitPage() returns error code 11
```

`btreeInitPage() returns error code 11` 就是 SQLite 读一个页头却看不懂——那个页的 cell 指针数组或头字节已经描述不了一棵合法的 b-tree 页。`PRAGMA integrity_check` 在这里报同样的 malformed 错误，因为这是连那个便宜的检查都能抓住的结构性损坏。关于范围的教训：页*头*或*cell 指针数组*里的一个字节翻转两者都会中招；而更细微的损坏——索引与它的表对不上，或某行违反 NOT NULL——恰恰是 `integrity_check` 能抓到、`quick_check` 可能放过的。恢复备份时或在重要文件上每周跑一次 `integrity_check`；想定期廉价地探脉搏就跑 `quick_check`。若 integrity_check 失败而你又没有备份，`.recover` 有时能把行从一个垂死的文件里抠出来——见 [SQLite CLI cookbook](/zh/posts/sqlite-cli-cookbook/)。

## PRAGMA optimize：让查询规划器保持诚实

还有一个属于维护的 pragma，它跟空间无关。查询规划器用 `sqlite_stat1` 里的统计信息选索引，而这些统计在大改动之后会过期——之后执行计划退化，没人知道为什么。`PRAGMA optimize` 是那个便宜、可排期的修复：它只对那些变化足够大的表跑 `ANALYZE`，而且在什么都没动时它被设计成近乎免费。在我这些小库上，它正确地决定什么都不做。强制触发底层的工作，你就能看到效果：

```sql
sqlite> EXPLAIN QUERY PLAN SELECT * FROM orders WHERE cust=42;
QUERY PLAN
`--SCAN orders
sqlite> ANALYZE;                -- PRAGMA optimize 有选择触发的东西
sqlite> SELECT tbl, idx, stat FROM sqlite_stat1;
orders|idx_orders_cust|30000 30
sqlite> EXPLAIN QUERY PLAN SELECT * FROM orders WHERE cust=42;
QUERY PLAN
`--SEARCH orders USING INDEX idx_orders_cust (cust=?)
```

一旦规划器拿到了行数，全表扫描就变成了索引查找。如果你恢复了备份或批量加载了数据，紧接着跑一次 `PRAGMA optimize;`——它便宜，而且只碰那些变过的表。

## 诚实的运维建议：别随便 VACUUM

下面是让你远离麻烦的部分，而我是用自己一贯的方式学会的——把某个文件搞贵过一次。

1. **VACUUM 不是免费的。** 它重写整个数据库，持有写锁，还需要大约文件大小的一份临时磁盘。在几十亿字节级的数据库上，它是一个计划好的维护窗口，不是一条查询。在小数据库（几乎所有东西实际跑的那种）上，它是毫秒级操作，完全没问题。
2. **别给庞大、只追加的表排盲目 VACUUM。** events 或 audit 表只会无限增长；对它每晚 VACUUM 等于每晚做一次几乎没帮助的全量重写。一时的臃肿文件用一次 VACUUM 修好，或用 `auto_vacuum=INCREMENTAL` 配定期 `incremental_vacuum`，然后把冷数据归档/分区。回收空闲空间毫无意义，如果你从不真正停止增长。
3. **创建时就定好 auto_vacuum。** 常见场景用 `NONE`，频繁改动的文件用 `INCREMENTAL`，`FULL` 只在你真的想要始终紧凑、且能付得起每次提交时。将来改它意味着一次性的 VACUUM，还会额外增加指针映射页——要知道它会在变小之前先让文件大一点。
4. **用 VACUUM INTO 备份，用 integrity_check 校验。** `VACUUM INTO 'backup.db'` 给你一份紧凑、一致的在线快照；对副本跑 `PRAGMA integrity_check`，在你真需要它之前先确认它是真的。一个你从未做过完整性检查的备份是希望，不是备份。
5. **盯住那个难堪的指标。** 在大于几 MB 的文件上，`freelist_count / page_count` 超过 50% 就是你的信号。低于这个数，别去动它。

整个故事就是一个等式：**数据库文件大小**是 `page_count * page_size`，**freelist** 是 SQLite 复用而非归还的空闲空间，而 **SQLite VACUUM**——或者 `incremental_vacuum`，或者 `auto_vacuum=FULL`——是你把这些空闲空间变回更小文件的方式。它不上台面，它是一个真正的工程师在惊慌之前会去查的东西，也是"文件怎么不变小"和确切知道为什么之间的区别。
