---
title: "2026 年的 password hashing：argon2 vs bcrypt vs scrypt（以及为什么用 md5/sha 是一种犯罪）"
description: "2026 年的密码存储：哈希必须抵御什么，为什么 md5 与 SHA-256 是方向性错误，盐值与 memory-hard 如何改变攻击成本，argon2 vs bcrypt vs scrypt 与 FIPS 场景下的 pbkdf2，如何挑选 Argon2id 参数、pepper 的用法，以及如何用 rehash on login 迁移而不把任何用户锁在门外。"
pubDate: 2026-11-16
lang: zh
translationKey: password-hashing
tags: [security, devops]
featured: false
keywords:
  - 密码哈希
  - argon2 vs bcrypt
  - memory-hard（内存硬）
  - 密码存储
  - 盐值
---

我审过很多 **password hashing** 代码，失败的样子总是同一种。一个务实、其他方面也很懂安全的
人，递给我一个登录系统，里面存的是 `sha256(password + salt)`——或者更糟，裸的 MD5——然后问我，
对「一个小应用」来说 **argon2 vs bcrypt** 这件事重不重要。重要，而且不是因为潮流。快速
哈希存在的意义就是快，而登录恰恰是速度成为敌人的地方：谁偷走了你的数据库，谁就能在离线
状态下、在没有限流的情况下，把同一个函数跑上几十亿次。那么：password hashing 究竟要抵御
什么，为什么加了盐的 **memory-hard** 函数能改变攻击成本，以及 2026 年怎样做真正的**密码
存储**而不把任何一个用户锁在门外。

## password hashing 必须抵御什么

威胁模型不是「有人在登录页上猜密码」，而是「有人把你 `users` 表的一份拷贝整个带走」——
泄露的备份、SQL 注入、被偷的只读副本、日志里一句手滑的 `SELECT *`。一旦攻击者拿到这些
摘要，他就不再是在对着*你的服务器*猜，而是对着自己的硬件猜，想猜多久猜多久。

- **离线暴力破解。** 没有限流、没有锁定、没有验证码、没有日志。攻击者先跑词典，再跑变形
  规则，再跑掩码模式，一次拿一个候选去比对所有账户。你唯一的杠杆，是一次猜测要花多大
  代价。
- **GPU 与 ASIC 攻击。** 一块现代 GPU 每秒能算几百亿次 SHA-256，专用 ASIC 更是远不止。
  一个方案是否安全，取决于它*单次猜测*的代价能否扛住这种并行度。
- **彩虹表。** 预先算好的 `hash → 明文` 表，让攻击者直接查表而不是现算。它之所以有效，
  是因为同一个密码在全世界的每一个数据库里都产生同一个摘要。

速度让这三种攻击都变便宜，所以密码哈希的全部职责就是慢——而且是*内存*昂贵，那是一种
不同、也更强硬的慢。

## 为什么快速哈希是错的（对密码存储而言 md5/sha 是一种犯罪）

MD5、SHA-1、SHA-256 是为完整性设计的，不是为保密设计的。它们被*刻意*做得便宜：单趟
计算、每块几十个 ALU 操作、内部状态极小。这正是你哈希一个 4 GB 文件时想要的，也恰恰是
摘要是密码时最不想要的。单块高端 GPU 上的大致速率：

- MD5：约 10<sup>11</sup> 次/秒。
- SHA-1 / SHA-256：约 10<sup>10</sup> 次/秒，调优后更高。
- bcrypt（cost 12）：约 10<sup>4</sup>–10<sup>5</sup> 次/秒。
- Argon2id（64 MiB，t=3）：约 10<sup>2</sup>–10<sup>3</sup> 次/秒，且受内存带宽
  而非算力限制。

这是六到八个数量级的差距——「午饭前被破」和「你这辈子都等不到」之间的区别。一个八位密码
的键空间大约是 10<sup>12</sup>–10<sup>15</sup>；快速哈希几小时就能扫完，memory-hard
函数则把同一次搜索拉成几百年。

### 「但是我加了盐啊」

加盐是必要的，但不是充分的，而人们总把这两件事混为一谈。常见的错误是
`sha256(salt + password)`：加了盐、每个用户都唯一，依然是一种犯罪，因为攻击者的 GPU
每个候选仍然以 10<sup>10</sup>/s 的速率在跑这个函数。盐解决了一个问题——彩虹表和相同摘要
——对另一个问题（原始速度）毫无帮助。

## 盐值与 memory-hard：两个真正有效的想法

<figure>
<svg viewBox="0 0 610 156" width="100%" role="img" aria-label="密码与随机盐一起输入像 Argon2id 这样的 memory-hard 函数；数据库保存的正是产生的摘要及其参数。">
  <defs>
    <marker id="hf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="10"  y="18" width="152" height="42" rx="8"/>
    <rect x="10"  y="96" width="152" height="42" rx="8"/>
    <rect x="224" y="32" width="190" height="92" rx="10"/>
    <rect x="466" y="50" width="134" height="56" rx="8"/>
    <path d="M162 39 H224" marker-end="url(#hf-arrow)"/>
    <path d="M162 117 H224" marker-end="url(#hf-arrow)"/>
    <path d="M414 78 H466" marker-end="url(#hf-arrow)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="86"  y="44"  text-anchor="middle">密码</text>
    <text x="86"  y="122" text-anchor="middle">随机盐（16 B）</text>
    <text x="319" y="66"  text-anchor="middle">Argon2id</text>
    <text x="319" y="86"  text-anchor="middle" font-size="12" opacity="0.8">memory-hard 函数</text>
    <text x="319" y="104" text-anchor="middle" font-size="12" opacity="0.8">m, t, p</text>
    <text x="533" y="74"  text-anchor="middle">摘要</text>
    <text x="533" y="92"  text-anchor="middle" font-size="12" opacity="0.8">+ 参数存进库</text>
  </g>
</svg>
<figcaption>盐和参数随摘要一起保存，它们都不是秘密。唯一必须保持「猜起来很贵」的，是函数本身。</figcaption>
</figure>

两个彼此独立的思路，各自解决了一半问题。2026 年的密码存储，本质上就是「两个都要，叠在
一起」。

### 盐值消灭彩虹表与碰撞攻击

**盐值（salt）**是设定密码时生成的一个随机值——16 字节足够——以*明文*形式存在摘要旁边。
它不是秘密。它的职责是：

- 让预计算失效：彩虹表得为每一个盐重新构建。
- 让相同密码产生不同摘要，于是破掉一个账户对攻击者猜测下一个毫无帮助。
- 逼攻击者一次只能打一个账户，而且是按全价、永远地打。

每个用户用唯一、随机的盐，从 CSPRNG 取。绝不用全局盐，绝不拿用户名当盐。

### memory-hard 函数消灭 GPU 与 ASIC

GPU 有成千上万个核心，但每个核心能分到的超快内存很少。**memory-hard** 函数强迫每一次
猜测都去分配并触碰一块很大的工作集——几十兆字节——于是吞吐被内存带宽而不是 ALU 单元数量
卡住。这就是为什么 Argon2id 和 scrypt 在那些把 SHA-256 变得像白送的硬件上依旧很慢。

memory-hard、加盐、再配上可调的时间成本，就是现代的基线。在 2026 年，缺了这三样里任何一
样的，都只是舍入误差。

## argon2 vs bcrypt vs scrypt（以及 FIPS 场景下的 pbkdf2）

值得了解的函数有四个：现代默认、靠谱的旧兜底、合理的替代，以及合规场景专用的那个。

### Argon2id——我推荐的默认

Argon2 在 2015 年赢下 Password Hashing Competition，并被写进 RFC 9106。它有三个变体：
`argon2d`（数据相关，在专门的攻击下最好，但在共享硬件上更容易泄露）、`argon2i`（数据
无关，抗侧信道），以及 **`argon2id`**——混合体，也是密码场景正确的默认，因为它既抗 GPU
攻击又对侧信道做了加固。它的参数很显式：内存 `m`（KiB）、时间成本 `t`、并行度 `p`。OWASP 的下限是 `m=19 MiB, t=2, p=1`；RFC 9106 给出 `m=64 MiB,
t=3, p=4`，以及高内存档 `m=2 GiB, t=1, p=4`。

### bcrypt——依然够用，而且无处不在

bcrypt 来自 1999 年，它不会消失。它有一个真实的工作因子，每种语言和框架都有实现，cost
取 12 对 GPU 来说依然是一堵结实的墙。两个坑：它**不是 memory-hard**，所以 FPGA 和 ASIC
相对它的优势比相对 Argon2id 更大；而且它会静默地**把密码截断到 72 字节**（有些实现还会把
NUL 字节处理错）。如果你继承了一个 bcrypt 数据库，留着它、把 cost 调高、然后懒迁移。如果
今天让你从头选，选 Argon2id。

### scrypt——memory-hard，一个不错的旧选项

scrypt（2009）在「memory-hard」这个词流行之前就已经内存硬了：参数 `N`（成本）、`r`
（块大小）、`p`（并行度），内存占用大致是 `128 · N · r` 字节。一组常见可用的取值是
`N=2^17, r=8, p=1`——约 128 MiB。它很扎实，但 Argon2id 能给出同样的保护，参数更简单、侧信道行为也更好。

### pbkdf2——当 FIPS 是硬要求时

PBKDF2 老、到处都有、经 FIPS 认证，也是四者里最弱的：它只迭代 CPU，不 memory-hard，
所以 GPU 很喜欢它。目前 OWASP 的指引大约是 PBKDF2-HMAC-SHA256 迭代 60 万次，换来大约
四分之一秒的 CPU 开销。当 FIPS 140-3 认证或受监管的客户*要求*它时才选它；其余情况，第
一个伸手去够的应该是 Argon2id。

| 函数 | 是否 memory-hard | 2026 年常见参数 | 什么时候用 |
| --- | --- | --- | --- |
| Argon2id | 是 | m=64 MiB, t=3, p=4 | 新代码的默认 |
| bcrypt | 否 | cost 12 | 继承来的库 |
| scrypt | 是 | N=2^17, r=8, p=1 | 生态本就在用 |
| PBKDF2 | 否 | SHA-256 迭代 60 万 | FIPS / 合规 |

## 参数怎么选：内存、时间，以及如何定它们

对它们四个，规则都一样：**在真正干活的机器上做基准测试**，把成本抬到「一次哈希大约
250–500 毫秒」（按你预期的登录并发量），并在登录本身变成拒绝服务向量之前停下来。别把一篇博客的数字照抄到不同尺寸的机器上。

宁可**多给内存，少加迭代**。更多内存会压缩攻击者能塞进高速缓存的猜测数、抬高 ASIC 的
门槛；更多迭代基本只是在烧你自己的 CPU。给每个并发登录留一笔固定预算——64 MiB 是个不错
的起点——让 `m × 并发登录数` 放得下，再去调 `t` 命中延迟目标。

```bash
# 在真正会跑登录的那台机器上测，不要在你的笔记本上测。
# argon2 -m <log2 KiB> -t <趟数> -p <lane>；2^16 KiB = 64 MiB
for m in 15 16 17; do
  for t in 2 3 4; do
    /usr/bin/time -f "m=2^${m} t=${t} p=4 -> %e s" \
      argon2 -m "$m" -t "$t" -p 4 -l 32 -e \
      -s "$(head -c 16 /dev/urandom | base64)" <<< "benchmark" >/dev/null
  done
done
```

下面是一段具体的 Python Argon2id 哈希，参数就是那台登录服务器上基准测试落到的值：

```python
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

# 64 MiB、3 趟、4 lane —— 在登录机上调到每次哈希约 250 毫秒。
ph = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4,
                    hash_len=32, salt_len=16)

digest = ph.hash("correct horse battery staple")
print(digest)
# $argon2id$v=19$m=65536,t=3,p=4$<base64 盐>$<base64 摘要>
#  ^方案    ^版本 ^参数
#  验证方需要的一切都在这个字符串里 —— 方案和参数都在。
```

## Pepper：数据库永远拿不到的那把密钥

**pepper（胡椒）**是在哈希之前混入密码的一把密钥，存放在密码数据库以外的地方——应用配置
值、systemd 凭据、KMS。如果数据库泄露了但应用服务器没有一并沦陷，攻击者根本无法验证任何
猜测。与盐不同，pepper 是秘密的、且按部署共享，所以要把它当密钥对待，而不是当字段。

最简单的正确做法是先做一次 HMAC，再做哈希：

```python
import hmac, hashlib
from argon2 import PasswordHasher

ph = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)

def hash_with_pepper(password: str, pepper: bytes) -> str:
    # pepper 永远不会进数据库；重活仍然交给 argon2id 干。
    pre = hmac.new(pepper, password.encode(), hashlib.sha256).digest()
    return ph.hash(pre)
```

两个诚实的提醒。第一，pepper 的好坏只取决于它存在哪——放进凭据存储，而不是和表结构放在
同一个仓库里，这正是我写在 [secrets management](/zh/posts/secrets-management/) 里的那套
纪律。第二，轮换 pepper 意味着把每个密码都重新哈希一遍，所以在它旁边留一个版本标记，并
接受「轮换是一次迁移，而不是一次改配置」。

## 迁移到 Argon2id：rehash on login，不把任何用户锁在门外

你不需要一个「切换日」。因为 Argon2id 的摘要是自描述的——方案、版本、参数全都在那个存储
字符串里——你可以一次一个成功登录地把用户升级掉。

<figure>
<svg viewBox="0 0 648 150" width="100%" role="img" aria-label="每次登录成功时用存储的摘要做校验；如果它用的是弱方案或旧方案，就用 Argon2id 重新哈希并更新该行。">
  <defs>
    <marker id="hf-arrow2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="8" y="52" width="112" height="44" rx="8"/>
    <rect x="156" y="42" width="176" height="64" rx="8"/>
    <polygon points="392,73 432,43 472,73 432,103"/>
    <rect x="500" y="48" width="140" height="52" rx="8"/>
    <path d="M120 74 H156" marker-end="url(#hf-arrow2)"/>
    <path d="M332 74 H392" marker-end="url(#hf-arrow2)"/>
    <path d="M472 73 H500" marker-end="url(#hf-arrow2)"/>
    <path d="M432 103 V126" marker-end="url(#hf-arrow2)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="64"  y="78" text-anchor="middle">登录</text>
    <text x="244" y="68" text-anchor="middle">用存储的摘要</text>
    <text x="244" y="88" text-anchor="middle">+ 参数校验</text>
    <text x="432" y="78" text-anchor="middle" font-size="12">偏弱？</text>
    <text x="486" y="66" text-anchor="middle" font-size="11" opacity="0.8">是</text>
    <text x="570" y="70" text-anchor="middle" font-size="12">用 Argon2id</text>
    <text x="570" y="88" text-anchor="middle" font-size="12">重哈希并 UPDATE</text>
    <text x="432" y="142" text-anchor="middle" font-size="11" opacity="0.8">否 —— 用户已经是最新的</text>
  </g>
</svg>
<figcaption>rehash on login：用该行此刻还在用的方案去校验，只有当它低于目标时才重写。停留在旧方案上的用户，会一直正常用到下一次成功登录为止。</figcaption>
</figure>

这个技巧就叫 **rehash on login（登录时重哈希）**：

1. 取出存储的摘要，从字符串前缀读出它的方案。
2. 用**那个**方案校验提交上来的密码。
3. 如果校验成功，*并且*方案或参数低于你的目标，就算一个新的 Argon2id 摘要并覆盖该行。
4. 返回成功。用户完全不知道发生过什么。

从不登录的账户会保留旧摘要，这可以接受：没被使用的凭据不是泄露的那一个。只要确保那些
绕过密码校验的账户找回流程也写入一个 Argon2id 摘要。

```python
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

TARGET = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)

def check_and_upgrade(user, password, db):
    stored = user.password_hash

    if stored.startswith("$argon2"):
        try:
            TARGET.verify(stored, password)
        except VerifyMismatchError:
            return False
        # 偏弱的 Argon2 参数（比如 m=19456,t=2）会被透明地升级。
        if TARGET.check_needs_rehash(stored):
            db.set_password_hash(user.id, TARGET.hash(password))
        return True

    # 旧的 bcrypt / pbkdf2 / sha256：用旧代码校验，然后升级。
    if Legacy.verify(stored, password):
        db.set_password_hash(user.id, TARGET.hash(password))
        return True
    return False
```

如果你那套旧方案是**没有加盐的快速哈希**，请把这些账户当作已沦陷、而不是当待迁移来处理：
在下次登录时强制重置密码，而不是把一个攻击者大概率已经拿到的凭据悄悄重哈希一遍。

## 运维一侧：限流与泄露检查

哈希保护的是那份快照；它对你登录表单上有人正在实时手打猜测这件事毫无作用。这是两套独立的
控制，你两个都需要。

- **限流与锁定。** 按账户、按 IP 限流，指数退避，连续失败后短暂锁定，敏感操作加 MFA。这
  和 [加固公网服务器](/zh/posts/hardening-a-public-server/) 是同一种纵深防御姿态：假定有
  一层会失败，就在它后面再放一层。
- **注册与登录时的泄露检查。** 拒绝那些已知泄露的密码。Have I Been Pwned 的 range API
  让你在不发送密码本身的前提下完成检查，用的是 k-anonymity：发出去 SHA-1 的前五个十六
  进制字符，剩下的在本地比对。

```python
import hashlib, urllib.request

def breach_count(password: str) -> int:
    sha1 = hashlib.sha1(password.encode()).hexdigest().upper()
    prefix, suffix = sha1[:5], sha1[5:]
    # 只有 5 个字符的前缀会离开本进程；密码本身永远不会。
    body = urllib.request.urlopen(
        f"https://api.pwnedpasswords.com/range/{prefix}", timeout=3
    ).read().decode()
    for line in body.splitlines():
        digest, count = line.split(":")
        if digest == suffix:
            return int(count)
    return 0
```

## 2026 年的密码存储：我实际怎么做

- **新代码一律先伸手去够 Argon2id。** 起点 64 MiB、t=3、p=4，在你的硬件上调到约
  250–500 毫秒。每个密码都加盐，永远。
- **密码存储绝不选 md5、sha-1 或裸 sha-256。** 快速哈希是方向性错误，盐救不了它们。
- **rehash on login。** 自描述的摘要把迁移变成后台进程，而不是一个维护窗口。绝不要为了换
  算法把用户锁在门外。
- **能单独存得下就加一个 pepper**，并且绝不在没有限流和泄露检查兜底的情况下校验密码。
- **每年复查一次参数。** 2023 年安全的设置到了 2026 年就更便宜了；重新
  跑一遍基准、把成本抬高，然后让 rehash on login 把它落实下去。
