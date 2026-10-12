---
title: "Kubernetes 还是单机：什么时候你根本不需要编排器"
description: "Kubernetes 的价值在于跨多节点的众多服务、大规模的滚动更新，以及多租户调度。对独立开发者的一台机器来说，你往往只付出了成本却没拿到收益。这篇文章讲清楚 k8s 到底解决了什么、它给小型运维者带来什么代价、几个诚实折中方案、一张决策表，以及我实际在跑的东西。"
pubDate: 2026-11-12
lang: zh
translationKey: kubernetes-vs-one-box
tags: [devops, self-hosting]
featured: true
keywords:
  - Kubernetes 还是单机
  - 你需要 Kubernetes 吗
  - docker compose
  - systemd
  - k3s
  - 编排
  - 家庭实验室
---

你能在一台机器上跑的生产软件多得惊人。所以真正重要的问题不是“Kubernetes 好不好”——它很好——而是 **Kubernetes 还是单机：你的问题到底需要哪一个？** 两套我都跑过。在一台机器上，我跑着这个博客、几个小 API，还有一堆定时任务；我也运维过编排器毫无疑问是正确答案的集群。诚实的立场是：大多数问“你需要 Kubernetes 吗”的独立开发者，心里其实已经有了答案，只是想要一个把系统保持简单的许可。这就是那个许可，附带推理过程。

## Kubernetes 到底解决了什么

Kubernetes 是一个分布式调度器加一个调和（reconciliation）循环。它里面几乎所有特性，都是为了回答一个**只有在大规模下才会出现**的问题。剥掉营销话术，它真正解决的是四个问题。

### 跨多节点的众多服务

当你的容器多到一台机器装不下时，你就需要一个东西来决定每个容器落在哪、核算容量、并在某台节点挂掉时把工作挪走。这就是**调度器**，用 shell 脚本替代它确实非常难。当你有几十个节点时，一个能在无人介入下把失败的 Pod 重新调度到健康硬件上的调度器，是值真金白银的。而在一台机器上，“它跑在哪”只有一个正确答案，所以你从来不需要问。

### 大规模的滚动更新

Kubernetes 给你声明式发布——`maxSurge`、`maxUnavailable`、就绪门禁（readiness gate），以及当新的 ReplicaSet 永远无法就绪时自动回滚。在单机上，你用一次符号链接切换加一次 `systemctl reload` 也能得到同样的结果，我在[零停机部署](/zh/posts/zero-downtime-deploys/)里详细讲过。区别在于，这条管线要你自己搭，而且每个服务都得搭一遍。三个服务时这是个愉快的下午；三十个服务时它就开始像一个自研编排器了——而自研编排器，正是事故最爱藏身的地方。

### 把调度当成一等公民

Resource requests/limits、节点亲和性、污点与容忍（taints and tolerations）、优先级类。如果你真需要把异构负载打包到共享硬件上并保证服务质量（QoS），Kubernetes 能把这件事表达成配置，而不是定制代码。这是一个真实的能力，不是装饰。

### 多租户隔离

Namespace、RBAC、资源配额、网络策略。当多个团队共享一个集群、某个团队跑飞的作业不能饿死别人时，租户模型就是全部意义所在。而单个运维者没有租户要隔离——你就是那个租户，而且你本来就信任自己。

这就是诚实的清单。如果上面四节没有一节描述你的处境，那这个编排器正在解决别人的问题。

## Kubernetes 给小型运维者带来的代价

代价主要不是钱，而是注意力，而注意力是独立开发者最稀缺的资源。

### 控制面的开销

即便是一个托管控制面，也需要工作节点上带着 kubelet、容器运行时、CNI 插件，以及需要真实存储时的 CSI 驱动。自建控制面则是 etcd、API server、controller manager 和 scheduler——四个必须对同一份状态达成一致的分布式组件。它们会以各种有意思的方式失败，而每一个都成了你要拥有、打补丁、备份、恢复的东西。

### YAML 自成一个 API 面

一个服务就是 Deployment、Service、Ingress、ConfigMap、Secret，还常常加上 ServiceAccount 和 NetworkPolicy。为了发布一个东西，你要维护五到八份文档。YAML 并不难**写**；它是声明式的、可评审的，这是实打实的优点。代价是**体量**：你在为软件维护第二个接口，而只要没人认领它，它就会和代码渐行渐远。

### 升级跑步机

Kubernetes 每年大约发布三个小版本，而每个集群版本只支持大约一年。被弃用的 API 会按日程移除，所以你永远有一个迁移在路上——`extensions/v1beta1` 到 `networking.k8s.io/v1` 是著名的一例，它搞挂了大量本来健康的集群。而在一台机器上，“升级”就是 `apt upgrade`，加上一次你自己挑时间安排的重启。

### 隔着层层间接去调试

一个请求进入 Ingress，打到 Service，被负载均衡到 Pod，可能穿过一个 sidecar，被记到某个节点，再被送到聚合器。出故障时，你得猜是这五层里哪一层把它丢了。而在单机上，同样的排查就是 `journalctl -u api` 和 `ss -ltnp`——请求路径就是进程路径。

## 诚实的折中方案

这不是非黑即白。在“裸进程”和“完整集群”之间，至少有三个合理的停靠点。

### systemd + nginx

一台机器，由 systemd 监管的原生进程，日志进 journal，nginx 做反向代理和 TLS 终止。这就是我在[不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/)里描述的形态，它能扛的流量比大多数人以为的多。你得到失败重启、资源限制、单元间依赖，以及 socket 激活——也就是调度器有用的一半，却没有任何分布式系统。

### docker compose / podman compose

当你想要镜像和进程隔离、但不想要调度器时，`docker compose` 就是正确的尺寸。一份 `compose.yaml` 描述一台主机上的几个服务，而 `restart: unless-stopped` 免费给你失败重启。

```yaml
# compose.yaml —— 三个服务，一台机器，没有编排器
services:
  api:
    image: ghcr.io/example/api:1.4.2
    restart: unless-stopped
    env_file: .env
    ports: ["127.0.0.1:9001:9001"]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:9001/healthz"]
      interval: 30s
  worker:
    image: ghcr.io/example/api:1.4.2
    restart: unless-stopped
    command: ["/app/worker"]
    depends_on: [api]
  postgres:
    image: postgres:17
    restart: unless-stopped
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes:
  pgdata:
```

`podman compose` 能跑同一份文件而不需要守护进程——如果你不喜欢主机上有个 root 拥有的 socket，它会更适合。

### k3s 或者单个 Nomad

如果你想要 Kubernetes 的 API——manifest、`kubectl`、Helm chart 与 operator 生态——但不想要控制面的重量，**k3s** 是单个二进制、控制面经过精简，在一台机器上跑得很舒服。对于家庭实验室或小型机器群，只要声明式 API 本身就是价值所在，这是一个站得住脚的选择，而且它给你留了长成真集群的门。Nomad 是另一个诚实选项：单个二进制、更简单的 job 描述，而且没有 etcd 需要你去理解。

## 一张决策表

| 维度 | 单机（systemd + nginx） | docker compose | k3s / Nomad | 完整 Kubernetes |
| --- | --- | --- | --- | --- |
| 服务数量 | 1–10 | 3–20 | 10–50 | 20+ |
| 节点数量 | 1 | 1 | 1–5 | 3+（多可用区） |
| 共享的团队 | 1 | 1 | 1–2 | 很多 |
| 自动扩缩容 | 不需要 | 不需要 | 偶尔 | 必需 |
| 自愈需求 | 失败重启 | 失败重启 | 节点丢失时重调度 | 跨节点重调度 |
| 升级成本 | `apt upgrade` | 拉新镜像 | 升级 k3s | 集群升级 + API 迁移 |
| 调试路径 | `journalctl`、`ss` | `docker logs` | `kubectl`、日志 | ingress → service → pod → sidecar |
| 何时选它 | 你就是运维者，且只有一台机器 | 想要镜像但不想要调度器 | 想要 k8s API 但不想要集群 | 多节点、多团队、真正的规模 |

读这张表时要找到你**所在的行**，而不是找“最强”的那一列。正确答案是仍然覆盖你**实际**全部需求的最左边那一列。

## 你需要 Kubernetes 吗？对独立开发者来说，多半不需要

我的明确建议：**一台机器、nginx、加 systemd；如果你想要镜像，那就 `docker compose`。** 只有当你有了第二个节点、并且有理由把基础设施当成 API 来对待时，才加上 k3s。等你有多个团队、多个节点、以及一个能指着说的自动扩缩容需求时，再去够完整 Kubernetes——而不是提前。过早编排的失效方式不是它坏掉，而是它能用、但很慢，并悄悄吃掉你本想用来做真实产品的时间。每一小时花在跟控制面搏斗上的时间，都不是花在用户愿意为之付费的东西上。

## 我实际在跑什么

具体一点，下面是我这套设置的形态，免得这话听起来只是纸上建议：

- **一台小 VPS。** 前面是 nginx，为每个主机名终止 TLS；后面是 systemd 单元，一个服务一个单元，每个都带 `Restart=on-failure` 和 `MemoryMax` 限制，这样一次内存泄漏不会拖垮整台机器。
- **凡不是我写的，就上 `docker compose`。** 如果上游只提供容器，我宁愿在同一台机器上用 compose 跑它，而不是跟 tarball 搏斗；再在它前面放一个 nginx `proxy_pass`，这样从外面看每个服务都长一个样。
- **定时任务用 systemd timer，而不是 cron**，这样作业有日志、有依赖、还能用 `flock` 做单飞。我在 [systemd timer 对比 cron](/zh/posts/systemd-timers-vs-cron/)里写过取舍。
- **部署就是一次符号链接切换**，按照[零停机](/zh/posts/zero-downtime-deploys/)那套模式：在线上版本旁边构建、健康检查、切换、排空。
- **配置存在一个 Git 仓库里**，手动应用，或者用一份简短的 Ansible playbook——就是我写给[单台服务器的 Ansible](/zh/posts/ansible-for-one-server/)的那套。
- **备份是可恢复的**，而不只是存在。我按计划测一次恢复，因为没测过的备份只是一种传闻。

整套栈都装得进我脑子里，而这正是重点。我自托管了什么、以及为什么，你可以在这篇[我在 2026 年自托管的东西](/zh/posts/what-i-self-host-2026/)里读到全貌；里面没有一个需要编排器，而一旦我加上一个，它们全都只会更难运维。

如果你的单机确实到了极限——CPU 打满、内存见顶、第二台机器不可避免——那么恭喜，你挣来了一个调度器，现在挑一个是真正的技术决策，而不是简历上的一行。在那之前，满足你需求的最简单架构不是妥协。它就是正确的工程选择。
