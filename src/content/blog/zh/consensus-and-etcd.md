---
title: "共识实战：etcd、quorum，以及为什么节点数必须是奇数"
description: "用跑一遍的方式学共识：一个一次性的三节点 etcd 集群，真实的 etcdctl 输出，watch 与 lease，一个事务，杀掉 leader 后证明 quorum，还有 Raft 为什么偏爱奇数。"
pubDate: 2026-12-14
lang: zh
translationKey: consensus-and-etcd
tags: [devops, networking]
featured: false
keywords:
  - etcd
  - Raft consensus
  - quorum
  - leader election
  - linearizable
---

每一个分布式系统最终都会撞上同一堵墙：好几台机器，各自握着一份「真相」的副本，而其中一台刚刚断电了。**共识（consensus）**要干的，就是让它们无论如何都达成一致——不是对某一个值达成一致，而是对一串值的*有序日志*达成一致，于是每个副本都会以相同的顺序重放相同的历史，最终落在相同的状态上。**etcd** 就是这个想法的一个小巧、无聊、极其可靠的实现，底层是 **Raft consensus** 算法；Kubernetes、服务发现、分布式锁，全都悄悄站在它之上。我想用真实的数字而不是一张图来讲 **quorum**，所以在 `127.0.0.1` 上起了一个一次性的三节点 **etcd** 集群，跑了大家真正会拿它去部署的那些操作，杀掉一个节点，然后把终端原样抄了回来。

下面全部是三个 `quay.io/coreos/etcd:v3.5.16` 容器在 host 网络、只绑定 `127.0.0.1` 下的真实输出。跑完之后我把它们全都删掉了。

## 共识要解决的问题：对同一条有序日志达成一致

让共识变得可解的那个技巧叫状态机复制。如果每个副本都从相同的状态出发，并以相同的顺序应用相同的命令，那么它们最终都会到达相同的状态——这是确定性的。所以难点不在于对*某个*值达成一致，而在于对一串值出现的*顺序*达成一致。这就是为什么 Raft 和 Paxos 被描述成「复制日志」。

Raft 假设的是*崩溃*故障，而不是会撒谎的节点（那是拜占庭容错，一个难得多的问题）。它也不试图永远可用：在异步消息加崩溃的模型下，没有任何算法能同时保证安全性和活性，所以 Raft 选择**永远保持安全性**，并在分区期间放弃**活性**，只在多数节点能互相通信时才保持可用。这个取舍，正是 **quorum** 成为这里核心词的原因。

## 一页讲完 Raft consensus

Raft 有三个角色和一个数字。

- **角色**：一个节点要么是 **leader**，要么是 **follower**，要么是 **candidate**。正常情况下有且只有一个 leader，其余的都是 follower。
- **任期（term）**：一个单调递增的整数。每次选举都会让它加一，而看到更高的 term，任何节点都会退位。

### leader election（领导者选举）

follower 期待收到 leader 的心跳。如果一段随机化的**选举超时**（etcd 默认约 1000 ms，带随机化以避免平票）之内没等到，follower 就会变成一个 **candidate**，term 加一，给自己投一票，然后向其他所有节点拉票。凑够**多数**票的 candidate 胜出成为 leader；而看到更高 term、或看到已有 leader 的 candidate 会退回去。随机化让两个节点同时超时变得不太可能。

### 日志复制

客户端永远不会写 follower。写入先到 leader，leader 把条目追加进自己的日志，并把 `AppendEntries` 发给各个 follower。当**集群的多数**——leader 把自己算一票——已经把这个条目**落盘**（写前日志被 `fsync`）之后，该条目才算*已提交*。也只有到这时，leader 才会把它应用到状态机并回复客户端。follower 则在 leader 通知时应用已提交的条目。持久性就活在这一刻：不在内存里，而在一组磁盘多数上的那次 fsync 里。

### quorum = 多数

对于 `N` 个节点，quorum 是 `⌊N/2⌋ + 1`。由此得到两个事实，而它们正是共识之所以能成立的原因：

1. **任意两个 quorum 必然相交。** 既然每个已提交条目都有多数节点确认过，而多数必然重叠，那么新选出的 leader 的 quorum 里，必定包含一个见过所有已提交条目的节点。于是不可能选出一个缺失已提交数据的 leader——这就是*linearizable*（线性一致）。
2. **你可以挂掉 `N − quorum` 个节点**而继续服务。

<figure>
<svg viewBox="0 0 680 268" width="100%" role="img" aria-label="一个三节点的 Raft 集群。节点 1 是 leader，节点 2 和节点 3 是 follower。leader 把每个条目复制给 follower，当多数即三分之二都已 fsync 之后该条目被提交。这里的 quorum 是 leader 加一个 follower。">
  <defs>
    <marker id="raft-arrow-zh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>

  <rect x="18" y="14" width="418" height="248" rx="16" fill="#0f766e" opacity="0.06" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="6 5"/>
  <text x="34" y="36" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">quorum = leader + 1 follower = 2 / 3</text>

  <rect x="250" y="52" width="180" height="82" rx="12" fill="none" stroke="#0f766e" stroke-width="2.5"/>
  <text x="340" y="86" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="16" font-weight="600">node 1</text>
  <text x="340" y="110" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">LEADER</text>

  <rect x="60" y="172" width="180" height="82" rx="12" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/>
  <text x="150" y="206" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="16" font-weight="600">node 2</text>
  <text x="150" y="230" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12" opacity="0.8">follower · fsync WAL</text>

  <rect x="440" y="172" width="180" height="82" rx="12" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/>
  <text x="530" y="206" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="16" font-weight="600">node 3</text>
  <text x="530" y="230" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12" opacity="0.8">follower · 可选</text>

  <g fill="none" stroke="#0f766e" stroke-width="2">
    <line x1="300" y1="136" x2="176" y2="168" marker-end="url(#raft-arrow-zh)"/>
    <line x1="382" y1="136" x2="506" y2="168" marker-end="url(#raft-arrow-zh)"/>
  </g>
  <text x="238" y="158" text-anchor="end" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">AppendEntries</text>
</svg>
<figcaption>一个三节点的 Raft 集群。写入先到 leader，再复制给 follower，当多数（2/3）都 fsync 之后才算提交。这次写入并不需要节点 3 的确认——但要扛住第二次故障，就需要它。</figcaption>
</figure>

## 为什么 quorum 偏爱奇数

把算术放进一张表，「奇数」这个民间说法就自己讲清楚了。

| 节点数 `N` | quorum `⌊N/2⌋+1` | 可容忍故障 `⌊(N−1)/2⌋` |
|----------:|------------------:|------------------------------:|
| 1 | 1 | 0 |
| 2 | 2 | **0** |
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |
| 6 | 4 | 2 |
| 7 | 4 | 3 |

两节点集群是那个陷阱：它的 quorum 是 2，所以**挂掉任何一台都会让所有写入停摆**。它并不比单节点更可用，成本却翻倍——根本不存在「两节点高可用」这回事。四节点集群的可容忍故障数与三节点*完全一样*（都是 1），却要为多出来的一个节点、以及每次写入多出来的一个 fsync 确认买单，而且它可能发生 2-2 的分区，让*两边*都选不出 leader。五节点集群能扛住 2 个同时故障，这就是为什么生产环境的控制平面常用 5 个。

所以有用的规模是 1、3、5、7。奇数只是不浪费节点：当 `N` 为偶数时，多数阈值和 `N−1` 时的完全相同，多出来的那个节点除了延迟和账单什么都没换来。而且偶数集群的分区更容易对称地裂开，恰恰是对称裂开时，两边都无法推进。

## etcd 给你什么

etcd 把 Raft 包在一个好用的 API 背后：

- **线性一致的 key-value 存储。** `put`/`get`/`delete` 都作用在复制日志之上，而默认的 `get` 是 linearizable 的——它会走 leader（etcd 的 "read index" 路径），因此你读不到陈旧的值。
- **Watch。** 从某个 revision 起持续推送变更的长连接流。控制器和配置热加载器就是靠它得知更新，无需轮询。
- **Lease。** 挂在 key 上的 TTL。lease 需要被保活，一旦客户端停了，key 会自己消失——这正是 leader election 和锁背后的原语。
- **事务。** 一步之内跨多个 key 的比较并交换（compare-and-swap），是乐观并发和分布式锁的基础。

Kubernetes 把整个集群状态——每一个对象，再加上它自己用于 leader election 的 `Lease` 记录——都放在 etcd 里。服务发现用的是 watch；锁和 leader election 用的是 lease 和事务。而 Patroni 用 etcd 作为 [Postgres 复制](/zh/posts/postgres-replication/) 故障切换的共识存储——哪怕「数据库」本身，底下也靠着一个共识原语撑着。而你在这里追求的那个全序（total order），恰恰是 [消息队列](/zh/posts/message-queues/) 会刻意*不*承诺的。

## 起一个集群，从终端里读出 quorum

三个容器，host 网络，每个节点一个进程：

```bash
docker run -d --name etcd-n1 --network host quay.io/coreos/etcd:v3.5.16 etcd \
  --name n1 \
  --initial-advertise-peer-urls http://127.0.0.1:2380 \
  --listen-peer-urls http://127.0.0.1:2380 \
  --listen-client-urls http://127.0.0.1:2379 \
  --advertise-client-urls http://127.0.0.1:2379 \
  --initial-cluster "n1=http://127.0.0.1:2380,n2=http://127.0.0.1:2480,n3=http://127.0.0.1:2580" \
  --initial-cluster-token etcd-lab-token --initial-cluster-state new
# ...etcd-n2 (2479/2480) 与 etcd-n3 (2579/2580) 同理
```

`endpoint status` 是最有用的单个命令：它告诉你此刻谁是 leader。

```text
$ etcdctl --endpoints=2379,2479,2579 endpoint status --write-out=table
+-----------------------+-----------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+
|       ENDPOINT        |       ID        | VERSION | DB SIZE | IS LEADER | IS LEARNER | RAFT TERM | RAFT INDEX | RAFT APPLIED INDEX | ERRORS |
+-----------------------+-----------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+
| http://127.0.0.1:2379 | c25e5b1c0555423 |  3.5.16 |   20 kB |      true |      false |         2 |         11 |                 11 |        |
| http://127.0.0.1:2479 | f2fadaf659e19a3 |  3.5.16 |   20 kB |     false |      false |         2 |         11 |                 11 |        |
| http://127.0.0.1:2579 |  b5de7d28e0c8b6 |  3.5.16 |   20 kB |     false |      false |         2 |         11 |                 11 |        |
+-----------------------+-----------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+

$ etcdctl --endpoints=2379,2479,2579 endpoint health --write-out=table
+-----------------------+--------+-------------+-------+
|       ENDPOINT        | HEALTH |    TOOK     | ERROR |
+-----------------------+--------+-------------+-------+
| http://127.0.0.1:2379 |   true |  6.649745ms |       |
| http://127.0.0.1:2479 |   true |  7.072436ms |       |
| http://127.0.0.1:2579 |   true | 11.039627ms |       |
+-----------------------+--------+-------------+-------+
```

`IS LEADER = true` 标出了 leader。`RAFT TERM` 在节点间一致（它们对当前任期达成了一致），而 `RAFT INDEX` 与 `RAFT APPLIED INDEX` 相等，意味着每个节点都已追上。`member list` 展示的则是 Raft 实际据以做决策的那份配置：

```text
$ etcdctl --endpoints=2379,2479,2579 member list --write-out=table
+-----------------+---------+------+-----------------------+-----------------------+------------+
|       ID        | STATUS  | NAME |      PEER ADDRS       |     CLIENT ADDRS      | IS LEARNER |
+-----------------+---------+------+-----------------------+-----------------------+------------+
|  b5de7d28e0c8b6 | started |   n3 | http://127.0.0.1:2580 | http://127.0.0.1:2579 |      false |
| c25e5b1c0555423 | started |   n1 | http://127.0.0.1:2380 | http://127.0.0.1:2379 |      false |
| f2fadaf659e19a3 | started |   n2 | http://127.0.0.1:2480 | http://127.0.0.1:2479 |      false |
+-----------------+---------+------+-----------------------+-----------------------+------------+
```

### 读、写，以及等到一次 watch 事件

```text
$ etcdctl put /config/site/theme dark
OK

$ etcdctl get /config/site/theme
/config/site/theme
dark

# 一个终端里开着 watch，另一个终端里做 put：
$ etcdctl watch /config/site/theme
PUT
/config/site/theme
nord
```

watch 推送的是*变更本身*，而不是轮询的结果——那就是 Raft 的日志，从客户端指定的 revision 起被流式推送过来。

### 事务：比较并交换，锁的根基

一个事务会比较一个或多个 key，比较成立时执行一组请求，不成立时执行另一组。这就是乐观并发：写入者只有在世界仍如它所假设的样子时才提交。

```text
# 只有当 theme 仍是 "nord" 时才推进 version：
$ etcdctl txn
compares:
success requests (get, put, del):
failure requests (get, put, del):
SUCCESS

OK

# 一个仍以为 theme 是 "dark" 的陈旧写入者被拒绝：
$ etcdctl txn
compares:
success requests (get, put, del):
failure requests (get, put, del):
FAILURE

/config/site/version
2
```

那个陈旧写入者的 `put /config/site/version 3` 根本没执行；执行的是失败分支。正是「让我这次写入以我读到的那个值为前提」这一条性质，把 key-value 存储变成了锁服务。

### Lease：TTL，以及客户端死掉时会怎样

```text
$ etcdctl lease grant 10
lease 5423a12f6b7d1d11 granted with TTL(10s)

$ etcdctl put /locks/leader node-a --lease=5423a12f6b7d1d11
OK

$ etcdctl lease timetolive 5423a12f6b7d1d11 --keys
lease 5423a12f6b7d1d11 granted with TTL(10s), remaining(9s), attached keys([/locks/leader])

# ...保活 11 秒...
$ etcdctl get /locks/leader
$ echo $?
0
$ etcdctl lease timetolive 5423a12f6b7d1d11
lease 5423a12f6b7d1d11 already expired
```

没有发出任何 delete；key 因为 lease 到期而自行消失。`get` 什么都没返回。这就是基于 lease 的锁里故障检测的全部机制。

## 杀掉节点，证明 quorum

先停掉 **leader**，节点 1：

```text
$ etcdctl --endpoints=2479,2579 endpoint status --write-out=table
+-----------------------+-----------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+
|       ENDPOINT        |       ID        | VERSION | DB SIZE | IS LEADER | IS LEARNER | RAFT TERM | RAFT INDEX | RAFT APPLIED INDEX | ERRORS |
+-----------------------+-----------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+
| http://127.0.0.1:2479 | f2fadaf659e19a3 |  3.5.16 |   20 kB |      true |      false |         3 |         26 |                 26 |        |
| http://127.0.0.1:2579 |  b5de7d28e0c8b6 |  3.5.16 |   20 kB |     false |      false |         3 |         26 |                 26 |        |
+-----------------------+-----------------+---------+---------+-----------+------------+-----------+------------+--------------------+--------+

$ etcdctl --endpoints=2479,2579 put /config/site/theme solar
OK
```

有两个东西动了：`RAFT TERM` 从 2 变成了 3——发生了一次新的选举——而 leader 现在变成了节点 2。剩下三分之二仍然构成 quorum，所以集群照常提供写入。这就是人们说的「高可用」意义上的故障切换，而它花费的代价大约是「一次选举超时」。

接着我把节点 2 也停掉，只剩三分之一：

```text
$ etcdctl --endpoints=2579 endpoint health --write-out=table
+-----------------------+--------+--------------+---------------------------+
|       ENDPOINT        | HEALTH |     TOOK     |           ERROR           |
+-----------------------+--------+--------------+---------------------------+
| http://127.0.0.1:2579 |  false | 3.001579531s | context deadline exceeded |
+-----------------------+--------+--------------+---------------------------+
Error: unhealthy cluster

$ etcdctl --endpoints=2579 put /config/site/theme aqua
Error: context deadline exceeded
```

只剩三分之一时，没有 quorum，幸存者无法把自己选成 leader，也无法提交任何东西。注意这次故障的*形状*：写入并没有返回「不行」，而是一直**阻塞**到客户端超时。节点还活着，数据完好无损，但它拒绝就此事对你说谎。把其他节点拉回来，它就会重新加入。

## Leader election 作为一种模式：持有 lease，并让它活着

上面那个 lease 演示*就是* leader election。所有候选者都尝试在同一个 lease 之下创建同一个 key，比如 `/locks/leader`，用一个只有在 key 尚不存在时才成功的事务（比较 `create_revision == 0`）。有且只有一个胜出。胜出者持有 lease，并用 `KeepAlive` 不断续期；失败者 watch 这个 key，等待它消失。如果 leader 崩溃或断了网，它的 lease 不再被续期，key 在 TTL 之后过期，watch 们醒来，其中一个赢下下一轮事务。故障切换时间就在 TTL 的量级上——所以 lease 通常很短（几秒），并配一个紧凑的保活间隔。

有两个我总得反复解释的脚注：

- **所有权是一个 lease，不是一个标志位。** 别信「我当初创建过这个 key」——你是在*你的 lease 活着期间*才是 leader。行动前重新确认，并把保活失败当作丢掉选举来处理。
- **读也不是没有共识成本的。** follower 可能提供陈旧的读。如果你要依据某个值做决策，请从 leader 读，或从一个已知 revision 起 watch。这正是 linearizable 与 serializable 的区别。

Kubernetes 自己就用这个模式——每个 leader-election 组对应一个 `Lease` 对象，调度器也用一个。当你在 API 里看到「leader election」，底下就是 etcd 里一个挂了 lease 的 key。

## 代价：fsync、延迟，以及「别把大数据塞进去」

共识不是免费的，代价体现在三个地方。

- **每次写入都要付一个往返加一次磁盘同步。** 一次提交要等 quorum 里最慢的那个成员 `fsync`。在好的 SSD 上这是几百微秒到几毫秒；跨地域时就是 RTT。节点越多，长尾越糟，这就是为什么五节点集群可测量地比三节点慢。把 etcd 放在一块低 fsync 延迟、专属的快速磁盘上——一块过载的磁盘会拖垮整个集群的吞吐。
- **没有 quorum 时写入是停住，而不是快速失败。** 正如演示所示，处于少数的节点会阻塞。这是正确的行为，但它意味着你的可用性只和你的 quorum 一样好。
- **etcd 是控制平面，不是数据存储。** 整个 keyspace 都放在内存里，value 有大小限制，默认存储配额也很小。它是为小 key、短 value（几 KB）、几十万个 key 而设计的。把 blob 放进对象存储或数据库；把*指针*放进 etcd。过大的 value 会撑爆 Raft 日志、拖慢复制、让快照变得痛苦。

## 我的建议

- **几乎一切都跑 3 个节点；只有在你必须扛住两个同时故障**、并且接受额外延迟时才上 5 个。永远不要 2 个。
- **盯住 quorum 相关的指标**：leader 变更（`etcd_server_leader_changes_seen_total`）、是否还有 leader（`etcd_server_has_leader`）、apply/commit 延迟，以及 DB 大小对配额。一个「活着」却不断丢失 leader 的集群，就是一个磁盘或网络有问题的集群。
- **用对原语**：leader election 和锁用 lease，配置和服务发现用 watch，比较并交换用事务。能用 watch 的就别轮询。
- **保持小、保持无聊、保持跑在快盘上。**

归根结底，「奇数」规则不过是从侧面看到的多数规则：quorum 让一群机器即使在部分成员走向死亡时，也能对一条有序日志讲出真话。它也是那些你本就信任的系统底下的基质——你配置的[复制](/zh/posts/postgres-replication/)，和你往里灌事件的[队列](/zh/posts/message-queues/)，都假设已经有人先把顺序定好了。
