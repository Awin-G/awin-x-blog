---
title: "MQTT 5 实战：共享订阅、请求响应 MQTT、用户属性与 reason code"
description: "MQTT 5 带来了共享订阅、请求响应、用户属性、消息过期和真正的 reason code。这篇用 mosquitto 2.1.2 逐个实测，看看哪些特性真正改变了设备端的设计。"
pubDate: 2027-01-26
lang: zh
translationKey: mqtt-5-in-practice
tags: [embedded, networking]
featured: false
keywords:
  - MQTT 5
  - 共享订阅
  - 用户属性
  - 请求响应 MQTT
  - mosquitto
---

多年来我一直用 v3.1.1 跑 MQTT 车队，从没觉得缺什么——直到我想让一组后端 worker
负载均衡地消费一个队列，才发现老协议里没法表达这件事。正是这一个缺口把我推到了
**MQTT 5**，而它也概括了整个故事：v5 是一组小而谨慎的新增能力，其中只有一部分会真正
改变你的设计。

MQTT 是什么，两句话：一个为受限设备设计的微型发布/订阅协议，最短两字节的报文头就能
把消息送给匹配了同一主题字符串的所有订阅者，中间的路由全部由 broker 完成。**MQTT 5**
（OASIS 标准，2019）原封不动地保留了这个内核，在此之上加了一层 property（属性）——
共享订阅、消息元数据和诚实的错误，全都住在这层里。

下面所有实验都跑在一个一次性 broker 上：

```bash
docker run -d --name mqtt5-lab -p 127.0.0.1:1883:1883 eclipse-mosquitto:2
# mosquitto version 2.1.2 starting
```

每条命令都在容器内对 `localhost:1883` 执行（从宿主机经发布端口执行完全等价），每个输出
块都是从终端原样复制的。

## 共享订阅：唯一一个杀手级特性

普通订阅是扇出：三个订阅者挂在 `jobs` 上，每条消息就有三份拷贝。**共享订阅**
（shared subscription）是负载均衡：同一个组里的成员每条消息恰好收到一份，broker 负责
把活儿分匀。订阅时写 `$share/<组名>/<过滤器>`：

```bash
# worker-a 和 worker-b 同时运行：
$ mosquitto_sub -V 5 -u labuser -P labpass -i worker-a -t '$share/workers/jobs' -v
$ mosquitto_sub -V 5 -u labuser -P labpass -i worker-b -t '$share/workers/jobs' -v

$ for i in 1 2 3 4 5 6; do mosquitto_pub -V 5 -u labuser -P labpass -t jobs -m "job-$i"; done

# --- worker-a 收到：
jobs job-1
jobs job-3
jobs job-5
# --- worker-b 收到：
jobs job-2
jobs job-4
jobs job-6
```

六条消息、两个 worker、各三条——round robin（轮询）在真实链路上得到了确认。broker
日志里能看到组的形成：

```text
Received SUBSCRIBE from worker-a
	$share/workers/jobs (QoS 0)
worker-a 0 $share/workers/jobs
Sending SUBACK to worker-a
```

以后扩容只需往同一个组里加 worker，发布方一行都不用改。两个运维注意点：组里没有成员时
发布的消息会被丢弃（组不是队列），QoS 按每个成员生效，所以丢掉一条任务会有影响的话就
用 QoS 1。

<figure>
<svg viewBox="0 0 640 220" width="100%" role="img" aria-label="发布者向主题 jobs 发布消息，broker 依据共享订阅组 workers 把每条消息交替投递给 worker-a（收到 job-1、job-3、job-5）和 worker-b（收到 job-2、job-4、job-6）。">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1" fill="none">
    <rect x="12" y="86" width="118" height="48" rx="6"/>
    <rect x="238" y="62" width="164" height="98" rx="6"/>
    <rect x="500" y="30" width="128" height="48" rx="6"/>
    <rect x="500" y="142" width="128" height="48" rx="6"/>
  </g>
  <g font-family="ui-monospace, monospace" font-size="12" fill="currentColor">
    <text x="26" y="106">publisher</text>
    <text x="26" y="122" font-size="10" opacity="0.75">topic: jobs</text>
    <text x="252" y="82">broker</text>
    <text x="252" y="98" font-size="10" opacity="0.75">group: $share/workers</text>
    <text x="252" y="112" font-size="10" opacity="0.75">filter: jobs</text>
    <text x="514" y="50">worker-a</text>
    <text x="514" y="66" font-size="10" fill="#0f766e">job-1, job-3, job-5</text>
    <text x="514" y="162">worker-b</text>
    <text x="514" y="178" font-size="10" fill="#0f766e">job-2, job-4, job-6</text>
    <text x="150" y="100" font-size="10" fill="#0f766e">job-1</text>
    <text x="150" y="126" font-size="10" fill="#0f766e">job-2, job-3, …</text>
    <text x="424" y="44" font-size="10" opacity="0.75">交替投递</text>
  </g>
  <g stroke="#0f766e" stroke-width="1.5" fill="none">
    <line x1="130" y1="110" x2="232" y2="110" marker-end="url(#ar1)"/>
    <path d="M402 88 C 460 88, 460 54, 494 54" marker-end="url(#ar1)"/>
    <path d="M402 136 C 460 136, 460 166, 494 166" marker-end="url(#ar1)"/>
  </g>
</svg>
<figcaption>共享订阅组把扇出变成了负载均衡：<code>jobs</code> 上的每条消息都会投递给
<code>$share/workers/jobs</code> 组里恰好一个成员。</figcaption>
</figure>

### 为什么 v3.1.1 做不到

共享订阅只在 v5 规范里有定义；`$share/` 前缀对 v3.1.1 客户端没有任何意义。差别就是扇出
对均衡，同样的实测换成 `-V 311`，当场可见：

```bash
$ mosquitto_sub -V 311 -u labuser -P labpass -i fan-a -t jobs -v     # fan-b 相同
$ for i in 1 2 3 4; do mosquitto_pub -V 311 -u labuser -P labpass -t jobs -m "task-$i"; done

# --- fan-a 收到：
jobs task-1
jobs task-2
jobs task-3
jobs task-4
# --- fan-b 收到：（同样四条）
jobs task-1
jobs task-2
jobs task-3
jobs task-4
```

两个订阅者都收到了每一条消息，因为一个 v3.1.1 客户端所能订阅的东西本来就只有这一种。
（mosquitto 恰好也能容忍 v3.1.1 客户端订阅这个字面量，但这是 broker 一方的宽容，不是
协议特性——v3.1.1 的客户端库根本不提供这个接口。）通常这一个实测就足以证明 v5 的价值。

## 请求响应 MQTT：response-topic 与 correlation-data

MQTT 天生是单向的，经典做法是双方私下约定一个"回复主题"。v5 把它做进了协议：请求带上
`response-topic` 属性（回复应该发去哪里）和 `correlation-data`（请求方用来匹配回复的
不透明令牌）。**请求响应 MQTT** 的模式于是变成三行命令：

```bash
# 响应方：盯住请求主题，打印随消息到达的属性
$ mosquitto_sub -V 5 -u labuser -P labpass -i responder -t svc/echo/request \
    -F "[request] topic=%t payload=%p response-topic=%R correlation=%D"

# 调用方：盯住回复主题
$ mosquitto_sub -V 5 -u labuser -P labpass -i caller -t svc/echo/response \
    -F "[reply]   topic=%t payload=%p correlation=%D"

# 请求本身，带 response-topic + correlation-data + user property：
$ mosquitto_pub -V 5 -u labuser -P labpass -q 1 -i caller-req -t svc/echo/request -m 'ping' \
    -D PUBLISH response-topic svc/echo/response \
    -D PUBLISH correlation-data req-42 \
    -D PUBLISH user-property trace rpc-1

[request] topic=svc/echo/request payload=ping response-topic=svc/echo/response correlation=req-42
```

响应方直接从消息里读出回复主题，在原路上回包，并带回同一个 correlation 令牌：

```bash
$ mosquitto_pub -V 5 -u labuser -P labpass -q 1 -i responder-rep -t svc/echo/response -m 'pong' \
    -D PUBLISH correlation-data req-42

[reply]   topic=svc/echo/response payload=pong correlation=req-42
```

这就是一次完整的往返：代码里无需约定回复主题，无需为每个客户端发明命名空间，还有一个
能扛住重试的关联令牌。payload 从此不必携带的东西：去哪里回复，以及这条回复回答的是哪
个请求。

## 用户属性：元数据不必再塞进 payload

v3.1.1 时代的诱惑是把路由提示塞进 payload——给一个两字节的温度值套一层 JSON 信封，
在每一字节都是空口工时的链路上。**用户属性**（user properties）是搭在消息旁边的
名称/值字符串对，订阅方读取它们完全不需要解析 payload：

```bash
$ mosquitto_pub -V 5 -u labuser -P labpass -t sensors/lab1/temperature -m '21.5' \
    -D PUBLISH user-property unit celsius \
    -D PUBLISH user-property sensor bme280 \
    -D PUBLISH user-property seq 17

# 订阅方：
$ mosquitto_sub -V 5 -u labuser -P labpass -i watch -t sensors/lab1/temperature \
    -F "%t props=[%P] payload=%p"

sensors/lab1/temperature props=[unit:celsius sensor:bme280 seq:17] payload=21.5
```

payload 仍然是干净的 `21.5`。单位、传感器身份、序列号、trace id 全部挪到了报文头里：
受限设备可以用很低的代价编码它们，后端也不需要反序列化任何东西就能按它们过滤。
同名属性允许出现多次，拿来做标签很方便。

## 消息过期：给消息本身一个 TTL

保留消息（retained message）是 MQTT 记住"当前状态"的方式——也是让陈旧状态比发布它的
设备活得更久的方式。v5 可以给消息直接指定过期间隔：

```bash
$ mosquitto_pub -V 5 -u labuser -P labpass -r -q 1 -t sensors/lab1/status -m 'retained-21.5C' \
    -D PUBLISH message-expiry-interval 5

# 在有效期内订阅：
$ mosquitto_sub -V 5 -u labuser -P labpass -i exp1 -t sensors/lab1/status \
    -F "%t payload=%p expiry-left=%E retained=%r" -C 1 -W 3

sensors/lab1/status payload=retained-21.5C expiry-left=5 retained=1

# 7 秒后做同样的订阅：
$ mosquitto_sub -V 5 -u labuser -P labpass -i exp2 -t sensors/lab1/status -C 1 -W 4
Timed out            # 退出码 27：broker 已丢弃过期的保留消息
```

过期时间从发布时刻起算，不是从每个订阅者连接的时刻起算。实用场景：会自愈的保留状态。
给可用性主题带上 60 秒过期发布一次，死掉的设备就不可能长时间留下一个"online"。
（mosquitto 在下次访问到某条保留消息时会顺手删除它；`retain_expiry_interval` 可以让它改
为定时扫描。）

## Reason code：终于有可以拿来做事的错误

这是个安静的生活质量提升。v3.1.1 用 SUBACK 上一个笼统的 `0x80` 回答失败，或者干脆让
连接死掉。v5 给每个确认都附上 reason code——以及一句人类可读的 reason string。对着一个
带 ACL 的 broker，差别毫不含糊：

```bash
# 订阅一个被禁止的主题：
$ mosquitto_sub -V 5 -u labuser -P labpass -i t5 -t 'restricted/secret' -d
Client t5 sending SUBSCRIBE (Mid: 1, Topic: restricted/secret, QoS: 0, Options: 0x00)
Client t5 received SUBACK
Subscribed (mid: 1): 135            # 135 = Not authorized（未授权）

# 往同一主题发 QoS 1：
$ mosquitto_pub -V 5 -u labuser -P labpass -q 1 -t 'restricted/secret' -m 'hello' -d
Client t-pubdenied sending PUBLISH (d0, q1, r0, m1, 'restricted/secret', ... (5 bytes))
Client t-pubdenied received PUBACK (Mid: 1, RC:135)
```

同一个 broker、同一个主题，v3.1.1 客户端：

```bash
$ mosquitto_sub -V 311 -u labuser -P labpass -i t311 -t 'restricted/secret' -d
Subscribed (mid: 1): 128           # 0x80 = 失败，不告诉原因

$ mosquitto_pub -V 311 -u labuser -P labpass -q 1 -t 'restricted/secret' -m 'hello' -d
Client t-pub311 received PUBACK (Mid: 1, RC:0)      # “成功”……

# ……与此同时 broker 日志里是：
Denied PUBLISH from t-pub311 (d0, q1, r0, m1, 'restricted/secret', ... (5 bytes))
```

最后那个场景是 MQTT 里最糟的失败模式：v3.1.1 客户端被告知消息已被接受，broker 却默默
把它丢了。在 v5 里，同样的尝试会拿到 135 的 PUBACK，客户端可以记录、告警，或者改投别处。reason code 也会出现在正常路径上：一条没有匹配到任何订阅者的 QoS 1 发布会拿回
`RC:16`（"No matching subscribers"，无匹配订阅者）——这是一个免费的检查，确认你的主题
拼写得和你以为的一样。实际值得记住的码：135 未授权、143 topic filter 非法、149 包过大、
155 QoS 不支持、158 不支持共享订阅、161 不支持订阅标识符。

我的测试里 broker 一侧用的是 mosquitto 的 dynamic security 插件，一条 deny 规则就是一行
ACL：

```bash
plugin /usr/lib/mosquitto_dynamic_security.so
plugin_opt_config_file /mosquitto/config/dynsec.json

# 创建用户/角色之后，产出上面那些 135 的规则：
mosquitto_ctrl -u admin -P adminpass dynsec addRoleACL lab \
    subscribeLiteral restricted/secret deny 1
mosquitto_ctrl -u admin -P adminpass dynsec addRoleACL lab \
    publishClientSend 'restricted/#' deny 1
```

## 主题别名：在受限链路上每消息少几字节

每条 PUBLISH 通常都要重复完整的主题字符串——对每隔几秒就在同一主题上发一次读数的设备来
说很浪费。**主题别名**（topic alias）是连接上注册的一个 16 位句柄：第一次带主题和别名
编号发送，之后只发编号。两个方向都支持，通过 CONNECT 里的 `topic-alias-maximum` 协商：

```bash
# 订阅方声明自己接受来自 broker 的别名：
$ mosquitto_sub -V 5 -u labuser -P labpass -i alias-watch -t sensors/lab1/temperature \
    -D CONNECT topic-alias-maximum 5 -F "%t alias=%A props=[%P] %p"

# 发布方在自己的连接上注册别名 7：
$ printf 'reading-1\nreading-2\n' | mosquitto_pub -V 5 -u labuser -P labpass \
    -t sensors/lab1/temperature -l -D PUBLISH topic-alias 7 \
    -D PUBLISH user-property unit celsius

sensors/lab1/temperature alias=1 props=[unit:celsius] reading-1
sensors/lab1/temperature alias=1 props=[unit:celsius] reading-2
```

订阅方解析别名后仍然打印完整主题，而 `alias=1` 说明 broker 在这条连接上建了句柄：从
第二条消息起，主题字符串完全不在链路上了。在主题名 20 字节的 NB-IoT 链路上，这省下的
是每次读数的大部分 payload 预算。别名随连接的生死而生死——重连即失效。

## 会话与 keep alive：同样的概念，更锋利的边角

v3.1.1 的 clean session 是个布尔值：订阅要么在断线后存活，要么不存活——没法说"我的会话
保留五分钟"。v5 把它拆成 clean start（每次连接）加 session expiry interval（单位秒）：

```bash
# 建一个持久会话，然后退出，让会话继续存活：
$ mosquitto_sub -V 5 -u labuser -P labpass -c -x 300 -q 1 -i durable-1 -t 'cmd/durable-1/#' -E

# durable-1 离线时发一条 QoS 1 命令：
$ mosquitto_pub -V 5 -u labuser -P labpass -q 1 -t cmd/durable-1/led -m 'on'

# 重连——broker 恢复会话，把排队的命令交出来：
$ mosquitto_sub -V 5 -u labuser -P labpass -c -x 300 -q 1 -i durable-1 -t 'cmd/durable-1/#' -C 1 -W 5 -v

cmd/durable-1/led on
```

重连时 broker 日志里的一行就说明了机制——`Sending CONNACK to durable-1 (1, 0)`：第一个
数字是 session present 标志，告诉客户端"我还记得你，这是你错过的东西"。keep alive 本身
没有变化——默认 60 秒、一个 PINGREQ 定时器——只是 v5 的 broker 现在可以用 server keep
alive 覆盖它，设备于是能知道真实的心跳节奏，而不是去猜 NAT 的超时。

## 保持不变的部份

内核没有动，这正是一次小版本号升级该有的样子：

- **QoS 0/1/2** —— 定义相同、报文流程相同；QoS 1 发布仍然靠 `PUBACK` 确认（成功时
  `RC:0`）。
- **保留消息** —— broker 侧每个主题存一份"最后已知值"，现在可选带过期时间。
- **遗嘱消息（LWT）** —— 连接时注册一条消息，你消失时 broker 代发。下面这次实测用
  `kill -9` 杀掉一个订阅者，其遗嘱主题上的观察者如约收到了 payload：

```bash
# 观察者已订阅；受害者注册了 --will-topic status/device
$ kill -9 <mosquitto_sub pid>     # 非正常断开；broker 触发遗嘱
status/device offline
```

  v5 增加了 will delay interval，遗嘱可以等几秒再发——如果只是"重连得慢"，还来得及撤销。
- **主题与通配符** —— `+`/`#` 的匹配规则完全一样。

[MQTT-on-a-microcontroller 那篇](/posts/mqtt-on-a-microcontroller/)深入讲了 QoS、保留和遗
嘱在真实硬件上的权衡，[智能家居那篇](/posts/smart-home-without-cloud/)展示了同一协议如何
作为本地自动化栈的骨架——两者都不依赖本文的任何内容。

## 你到底需不需要 v5？

老实的回答：经常不需要；这份特性清单的老实版本很短。

- **需要 v5 的情况**：你想要共享订阅（唯一的杀手级特性）、结构化的消息元数据、消息
  过期，或者凌晨三点能拿去排查的错误。如果你的后端是一组消费某个主题的 worker 池，
  v5 就不是锦上添花——v3.1.1 在结构上根本无法表达你的设计。
- **broker 和客户端都得支持。** mosquitto、EMQX、HiveMQ、NanoMQ 都会说 v5，paho-mqtt、
  ESP-IDF 客户端和大多数现代库也一样。混合部署也没问题：v5 broker 可以在同一端口上同时
  服务两个版本、无需额外配置，而那些客户端只是永远看不到以上的一切。
- **共享订阅的细节因 broker 而异。** round robin 是 mosquitto 的实现；别的 broker 提供
  sticky、随机或哈希分发。在把公平性做进业务逻辑之前，先测清楚你的 broker 实际给哪一种。
- **不要为了升级而升级。** 如果你的设备只是上报遥测、订阅命令，v3.1.1 确实够用；"两字节
  报文头的协议原封不动"这份自由度，比任何 property 都值钱。但当下一次设计会上有人在一根
  队列后面画出一池 worker 时，你已经知道该伸手拿哪个版本了。
