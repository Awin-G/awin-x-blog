---
title: "本地智能家居：用 Home Assistant 和 Zigbee 打造没有云的智能家居"
description: "为什么默认云端化的智能家居是一种负债，一个由 Home Assistant、Zigbee、Z-Wave 和本地 MQTT 组成的 local smart home 如何运转，如何挑选厂商倒闭后仍能用的设备，以及那些没人愿意提的老实难点。"
pubDate: 2026-12-01
lang: zh
translationKey: smart-home-without-cloud
tags: [self-hosting, homelab, networking]
featured: false
keywords:
  - local smart home
  - Home Assistant
  - no cloud smart home
  - Zigbee
  - Matter
---

两种智能家居我都亲手搭过。先是"塑料货架"那一版：一堆 Wi-Fi 灯泡和插座，每个都有自己的
App，每个都要注册账号，每个都往外打电话回家。然后在第三个"服务器无法连接"的周末之后，
我把它整个拆掉，重建成了一个 **local smart home**：一个跑在我自己网络里的中枢、直接跟它
通信的 **Zigbee** 设备、负责"聪明事"的 **MQTT**，以及一个厂商账号都没有。这篇讲我为
什么这么做、一个 **no cloud smart home** 到底怎么运作，并且——因为我不卖你任何东西
——也讲那些依然真正棘手的地方。

## 为什么默认云端化的智能家居是一种负债

默认的智能家居，本质上是租来的。硬件是你买的，但钥匙在厂商手里：大脑是一台你不拥有的
服务器，位于你没选过的地区，按一份你看不见的时刻表运行。

- **故障变成你的事。** 厂商后端一抽风，你的灯就不听 App 使唤了——哪怕灯离你只有三英尺，
  而你的网络好得很。我遇到过一个房子：墙上的开关能用，"智能"那部分不能。这体验比压根
  没有智能家居还糟。
- **EOL 的中枢会把你买的东西变砖。** 这条最难看。公司倒闭，或者决定某一代中枢到此为止，
  一个固件"击杀开关"就把还能用的硬件变成电子垃圾。设备从来就不属于你，你只是租了访问权。
- **隐私是默认的税。** 一台便宜的摄像头就是客厅里的一只镜头，外接厂商侧的 AI 流水线。
  就算厂商没有恶意，你也得信任它的留存策略、它的被入侵历史、它的外包人员。有些确实合情
  合理——但决定权从来不在你手上。
- **订阅。** 移动侦测提醒、云端录像、"高级"场景：这些在你拇指盖大小的芯片上跑得好好的
  功能，被一堵月费墙隔开。
- **没有本地控制。** 最糟的一条。断网即云端下线，你的"智能"家居就变成一堆带着坏 App 的
  笨设备。

这些都不是假设。它们的根因是同一个：控制平面位于你掌控之外的地方。

## local-first 的智能家居到底长什么样

local-first 的版本把这张图倒过来。设备跟你局域网上的中枢通信，中枢跟你的手机通信，而
互联网从一个依赖变成可选的附加项。

<figure>
  <svg viewBox="0 0 720 260" role="img" aria-labelledby="local-title-zh local-desc-zh" xmlns="http://www.w3.org/2000/svg">
    <title id="local-title-zh">本地智能家居拓扑：设备通过 Zigbee、Z-Wave 或 Matter 与本地中枢通信</title>
    <desc id="local-desc-zh">传感器、插座和灯泡通过无线连到本地网络上的 Home Assistant 中枢。中枢在本地为手机和面板提供服务，互联网是可选的支线，而非必需。</desc>
    <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <rect x="20" y="30" width="110" height="36" rx="6"/>
      <rect x="20" y="92" width="110" height="36" rx="6"/>
      <rect x="20" y="154" width="110" height="36" rx="6"/>
      <rect x="250" y="80" width="150" height="60" rx="8" stroke-width="2.5"/>
      <rect x="500" y="30" width="120" height="36" rx="6"/>
      <rect x="500" y="110" width="120" height="36" rx="6"/>
      <rect x="500" y="196" width="120" height="36" rx="6" stroke-dasharray="5 4"/>
      <path d="M130 48 C 190 48, 200 100, 250 104"/>
      <path d="M130 110 C 190 110, 200 110, 250 110"/>
      <path d="M130 172 C 190 172, 200 120, 250 116"/>
      <path d="M400 100 C 450 100, 460 48, 500 48"/>
      <path d="M400 112 C 450 112, 460 128, 500 128"/>
      <path d="M400 128 C 450 128, 470 214, 500 214" stroke-dasharray="5 4"/>
    </g>
    <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
      <text x="75" y="53">传感器</text>
      <text x="75" y="115">插座</text>
      <text x="75" y="177">灯泡</text>
      <text x="325" y="105">Home</text>
      <text x="325" y="123">Assistant</text>
      <text x="560" y="53">手机</text>
      <text x="560" y="133">面板</text>
      <text x="560" y="219">互联网（可选）</text>
    </g>
  </svg>
  <figcaption>设备、本地中枢、你自己的客户端——云是一条你可以拉的支线，而不是你依赖的一根线。</figcaption>
</figure>

几个组成部分：

- **一个本地中枢。** 在一台小型迷你主机或专用设备上跑 **Home Assistant** 是最常见的答案。
  它跑在我的网络里，它的数据库是我自己备份的一个文件，ISP 抽风时它照常工作。它还同时会
  说所有协议，这很重要，因为没有任何单一射频能很好地覆盖整栋房子。
- **Zigbee**（以及 **Z-Wave**）负责网状网。它们跑在自己的频段上，通常是用一个插在中枢上的
  USB 棒，组成一张**自愈网状网（self-healing mesh）**——每个市电供电的设备都为邻居做中继。
  它们不走你的 Wi-Fi，所以一屋子传感器不会把你 2.4 GHz 频段搅成一锅粥。一根 30 美元的
  棒加一个协调器，就是全部基础设施。
- **本地 MQTT。** **MQTT** 是中枢无法原生对话的设备的通用语：ESP32 板子、DIY 传感器、
  Zigbee2MQTT 桥、任何你自己刷的东西。把一个 broker 指向 `localhost`，你的设备就向你拥有
  的 topic 树发布状态。想看小设备端的具体范式，可以读
  [在单片机上跑 MQTT](/zh/posts/mqtt-on-a-microcontroller/)。
- **没有厂商账号。** 我坚持的一条规矩：如果一个设备入网要求我去别人网站注册账号，那它就别
  进门。本地中枢让你能执行这条规矩。

## "厂商倒闭后还能用吗"测试

这是买设备时最有用的一个筛子，而几乎没人真的去跑它。下单前，问三个问题：

1. **离线时还能用吗？** 拔掉你的 WAN 网线，然后试着开灯。如果 App 卡在转圈上，那这款产品
   只是别人服务器的瘦客户端，不是智能设备。
2. **本地控制器不靠厂商能跟它对话吗？** 如果它说 **Zigbee**、**Z-Wave**，或者走本地线程的
   **Matter**，你就能把它配到自己的中枢上，厂商的云无关紧要。如果它只会"通过 HTTPS 走厂商
   云"，那就走人。
3. **EOL 时会怎样？** 找一个要么暴露本地 API、要么有明确方案能继续工作的产品——而不是那种
   App 是唯一控制面的。

务实的赢家其实很无聊：**Zigbee** 的传感器、插座和灯泡便宜、省电，而且几乎都能配到本地协调器
上。如果你干脆绕开厂商自带的中枢，还加分。

## 老实的难点

只卖梦的文章我不敬重。这些地方依然会疼：

- **Matter 并不会自动等于本地。** Matter 是真实的进步——一个共享的应用层，让设备和控制器
  能互操作——但它对*控制器*住在哪只字未提。很多"Matter"产品仍然要厂商 App、厂商账号，以及
  用于配网、远程访问或固件的云 fabric。把它通过你本地的 Thread 边界路由器配到 Home
  Assistant 上，是真的本地；用厂商 App，就不是。同一个协议，不同的拓扑。把细则读清楚。
- **固件更新。** 去掉云，意味着打补丁成了你的事。有些设备通过你的协调器走 Zigbee 更新；有些
  非得厂商 App；有些**永远**不更新，这就变成一个你现在要做的安全决策。这是实打实的杂活
  ——也正是你原先默认信任厂商替你做的同一件杂活，只是现在它可见了。
- **语音助手想要云。** Alexa 和 Google 就是云服务，句号。你可以把本地中枢桥接到它们
  （Home Assistant 有集成），但桥一挂，或厂商改条款，语音控制就跟着挂。本地语音在变好，
  但仍是发烧友项目。如果语音不可让步，那就接受麦克风是一台云设备，并相应地把它隔离开。
- **Wi-Fi 设备泛滥。** 每个便宜 Wi-Fi 灯泡都是又一个 2.4 GHz 站点、又一条 DHCP 租约、又一个
  带厂商追踪 SDK 的东西。十个下来，你路由器的客户端列表看着像个小办公室。这正是 Zigbee 的
  一大理由：射频不碰你的 Wi-Fi，中枢只呈现一个干净的接口。

## 网络层面的影响

本地中枢不会消掉网络问题，它只是改变了问题。你的中枢、broker 和任何 DIY 设备，应该待在一个
跟你手机不同的网段，因为"本地"不等于"可信"——它意味着"由我控制"。给中枢和它的设备一个专属的
**IoT VLAN**，只在需要的地方放开出站互联网，让你可信的设备通过规则、而不是靠扁平网的"离得近"
去够到中枢。整套范式我写在
[家庭网络分段](/zh/posts/home-network-segmentation/) 里了；简短版就是：一个隔离网段、它与
你的笔记本之间默认拒绝，再给中枢自己的出站调用（时间同步、更新，以及你保留的语音桥）列一
小份允许清单。

## 一条务实的入门路径

你不需要在一个周末里重建整栋房子。

1. **买一个中枢和一根射频棒。** 一台跑 **Home Assistant** 的迷你主机或受支持的 SBC，加一个
   **Zigbee** USB 协调器。这就是全部地基。
2. **从一类设备开始。** 插座或温度传感器。上两三个，确认拔掉 WAN 后它们仍然能用，再扩张。
   Zigbee 基础设施靠增加市电供电的中继器来扩展，所以早点买两个智能插座。
3. **撞墙时再接 MQTT。** 一旦你有了 ESP32 或者一个没有原生集成的设备，就架个 broker 桥过去。
4. **给网络分段。** 一个 IoT VLAN 放中枢和它的伙伴，一套规则。
5. **到这时再考虑语音。** 并且清楚地知道音频去了哪里。

下面这段配置是我实际用来把 Zigbee2MQTT 桥和一个本地传感器放在同一个 broker 上、并用专属
topic 前缀避免泄漏到我其他服务的做法：

```yaml
# docker-compose.yml（节选）—— 智能家居专用的纯本地 MQTT
services:
  mosquitto:
    image: eclipse-mosquitto:2
    restart: unless-stopped
    ports:
      - "127.0.0.1:1883:1883"   # 绑定到回环，而不是 0.0.0.0
    volumes:
      - ./mosquitto:/mosquitto/config

# mosquitto/config/mosquitto.conf
#   listener 1883 127.0.0.1
#   allow_anonymous false
#   password_file /mosquitto/config/passwd

# zigbee2mqtt/configuration.yaml（节选）
mqtt:
  server: mqtt://127.0.0.1:1883
  base_topic: zigbee2mqtt
  user: zigbee
  password: !secret mqtt_password
homeassistant:
  discovery_topic: homeassistant
frontend:
  port: 8081
```

其中有两个细节值回票价：broker 绑定到 `127.0.0.1`，这样除非我放行，局域网上没东西能碰它；
`base_topic` 让智能家居的流量待在自己的命名空间里。local-first 不只是一张拓扑图，它体现在
默认值里。

## 简短版

一个 **no cloud smart home** 不是关于讨厌云。它是关于把控制平面放到你拥有的硬件上，让一次
故障、一次收购、一次涨价都伸不进你的走廊。买个中枢，跑 **Home Assistant**，宁用 **Zigbee**
和本地 **MQTT** 也别用厂商 App，每台设备在掏钱之前先跑一遍"离线还能用吗"。老实承认
**Matter** 依然可能带云味，固件更新现在归你，语音助手集成会把你离开的云又请回来，而一
张全是 Wi-Fi 小玩意的扁平网本身就是一团乱。然后给它分段，从三个传感器开始，等你的房子变得
无聊就停手。无聊才是目标——无聊意味着断网时它照样能用。
