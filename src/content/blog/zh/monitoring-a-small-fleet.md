---
title: "小规模服务器监控：不上一整套监控栈也能睡好觉"
description: "几台机器根本不需要 Prometheus 加 Grafana 才知道自己是不是健康。这篇写小规模服务器监控真正会坏的东西、最小工具集（node_exporter 用不用、systemd 检查脚本、死人开关）、journald 保留策略，以及什么时候这套大栈才真的值。"
pubDate: 2026-10-28
lang: zh
translationKey: monitoring-a-small-fleet
tags: [devops, self-hosting, linux]
featured: false
keywords:
  - 服务器监控
  - 小规模机队监控
  - 死人开关
  - node_exporter
  - 告警
---

我手上跑着几台服务器——一个博客、一两个 API、一台邮件中继、一个 overlay 节点——很多年里我
都把「正经搭一下监控」往后拖，而在我心里那意味着 Prometheus、Grafana、Alertmanager，外加一
台本身还需要被监控的监控机。结果我一直没搭，机器倒也一直活着。这篇写的是我现在怎么做的**服
务器监控**：一套真正最小化的**小规模机队监控**，塞进几个文件里，只告诉我能动手处理的事，并
用一个**死人开关**来兜住所有仪表盘都兜不住的失败模式——一个悄悄不再运行的定时任务。

## 真正会坏的是什么，你又怎么察觉

我的事故清单很无聊，而这正是重点。小机队上我遇到过的每一个真问题都在这里：

| 故障 | 表现 | 你今天会怎么发现 |
| --- | --- | --- |
| **磁盘满** | 写入失败、日志停摆、数据库卡死 | 应用报错，或者干脆整个不工作 |
| **服务挂了** | 崩溃循环、被 OOM 杀掉、一次烂部署 | 用户告诉你，或者冒烟 URL 502 |
| **证书到期** | 浏览器警告、API 客户端崩 | 到期那一天，而不是之前 |
| **备份没在跑** | 定时器悄悄停了、磁盘满了、凭证坏了 | 你真要用它恢复的那一天 |
| **续期把 TLS 弄坏** | reload 失败、服务出去的还是旧证书 | 同样是浏览器开始抱怨的那一天 |

四个「怎么发现」里有三个是**「太晚了」**。这才是我在意的缺口：**小规模机队监控**要做的事，
就是选出最小的一组检查，把「太晚了」变成「十分钟前就报了」。

## 大栈测的东西里，你不需要的那些

Prometheus 和 Grafana 非常好，我在公司项目里也用。但那套标准栈默认测的是 CPU、内存、负载、
吞吐、磁盘 IO、请求速率、延迟直方图，而对几台跑博客和小 API 的机器来说，这里面几乎没有一
个数字会改变我的任何决定。

所以我给每个指标只套一个测试：**这个数变了，我会去做点什么吗？** 每天凌晨两点的负载尖峰
就是备份，我早就知道。对一个静态站点，重要的不是 p99，而是「页面到底还活着没」。

大栈在小机队上的失败在于它把监控变成了一个**你要去访问的仪表盘**，而不再是一个**会来找你
的告警**。

## 最小工具集

四块拼图，每一块你都可以有意识地砍掉：

1. **一个健康检查脚本**，出真问题就返回非零。
2. **一个 `systemd` 定时器**按计划跑它，并用 `OnFailure=` 接上告警。（这里
   [systemd 定时器比 cron 更合适](/zh/posts/systemd-timers-vs-cron/)，因为一个失败的
   定时器单元是 systemd 真会去处理的东西。）
3. **一个死人开关**，给那些本该一直跑下去的任务。
4. **带保留策略的 journald**，让「之前发生了什么」是可查询的。

### 到底要不要 node_exporter？

**node_exporter** 把一台 Linux 机器变成 Prometheus 指标——磁盘、CPU、内存、文件系统、
systemd 单元状态。它是对的工具——前提是有东西会来抓它、并为这些时序写告警规则；没有抓取端
的话，它就只是一个坐在 :9100 上把数字发进虚空的进程。

- **如果你会跑 Prometheus**（或者托管抓取、或者 VictoriaMetrics），那就跑 node_exporter，
  收 `node_systemd_unit_state`、文件系统和 `node_textfile` 这些指标，把你的**告警规则**
  ——不是仪表盘——放进版本控制。这是一套真实、够好的方案。
- **如果你不会**，就别「以防万一」地跑 node_exporter。一个失败就返回 1 的脚本加一个会来
  叫你的单元，已经覆盖了磁盘、服务和证书，且不引入任何新守护进程。

我最后选的是「暂时不上」，而且有一个东西让门一直开着：等我真加上 Prometheus，这个检查脚本
的结果就会变成又一条指标。

```bash
# 只有在有东西抓取时才值得——上真正有用的采集器，不是全部
node_exporter \
  --collector.systemd \
  --collector.textfile.directory=/var/lib/node_exporter/textfile
```

```bash
# 定时任务/cron 就能把一件事发布成指标，不用写任何 exporter 代码
printf 'backup_last_success_timestamp %s\n' "$(date +%s)" \
  > /var/lib/node_exporter/textfile/backup.prom
```

## 用 systemd 定时器跑一个检查脚本

这就是全部套路，大概四十行。一个脚本，一个退出码：零表示健康，非零表示来叫我。

```bash
#!/usr/bin/env bash
# /usr/local/sbin/healthcheck.sh — 一台机器，一个退出码
set -uo pipefail
fail=0
say() { echo "[healthcheck] $*"; }

# 磁盘：任何真实文件系统超过 90% 就失败
while read -r fs pct; do
  pct=${pct%\%}
  [ "$pct" -ge 90 ] && { say "DISK $fs at ${pct}%"; fail=1; }
done < <(df -P -x tmpfs -x devtmpfs --output=target,pcent | tail -n +2)

# 必须活着的服务
for unit in nginx sshd; do
  systemctl is-active --quiet "$unit" || { say "UNIT $unit down"; fail=1; }
done

# 对外提供的 TLS 证书：14 天内到期就失败
exp=$(echo | openssl s_client -connect 127.0.0.1:443 \
        -servername blog.awin-x.top 2>/dev/null \
      | openssl x509 -noout -enddate | cut -d= -f2)
if [ -n "$exp" ]; then
  left=$(( ( $(date -d "$exp" +%s) - $(date +%s) ) / 86400 ))
  [ "$left" -lt 14 ] && { say "CERT expires in ${left}d"; fail=1; }
fi

exit "$fail"
```

现在每五分钟跑一次，把告警交给 systemd 的 `OnFailure=` 处理。

```ini
# /etc/systemd/system/healthcheck.service
[Unit]
Description=Local health checks
OnFailure=alert@%n.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/healthcheck.sh
```

```ini
# /etc/systemd/system/healthcheck.timer
[Unit]
Description=Run health checks every 5 minutes

[Timer]
OnCalendar=*:0/5
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
```

告警单元做成模板，这样每个失败的服务都能复用——它只是往你会看的地方 POST（ntfy、
webhook、邮件中继都行）。

```ini
# /etc/systemd/system/alert@.service
[Unit]
Description=Send alert for %i

[Service]
Type=oneshot
ExecStart=/usr/bin/curl -fsS -m 10 -d "job %i failed on $(hostname)" \
  https://ntfy.sh/your-private-topic
```

这就是没有 Prometheus、没有 Alertmanager 的**告警**。单元名告诉你*哪个*检查失败了，
`journalctl -u healthcheck` 告诉你为什么。

## 死人开关：给那些本该一直跑的任务

上面那些检查抓的是**此刻已经坏了**的东西。它们抓不到**悄悄不再发生**的东西——一个被人
disable 掉的备份定时器、一个不再触发的续期任务。这一类失败恰恰是大栈最无力的地方，因为
「缺席」很难告警：没有指标、没有事件、没有日志行。

解法是一个反向告警，一个**死人开关**。不是「出问题时告警」，而是「心跳停止到达时告警」。
任务成功时去 ping 一个看门狗；如果 ping 在窗口内没到，它就来找你。我用
[Healthchecks](https://healthchecks.io/) 做这件事——可自托管，免费版对小机队也够用。

```bash
#!/usr/bin/env bash
# /usr/local/sbin/backup.sh — 带死人开关
set -euo pipefail
URL="https://hc-ping.com/your-uuid-here"

# 脚本在任何地方挂掉，都告诉看门狗然后退出
trap 'curl -fsS -m 10 "$URL/fail" >/dev/null || true' ERR

# ... 真正的备份工作 ...
pg_dump app | gzip > /srv/backups/app-$(date +%F).sql.gz

# 成功：一次 ping。错过它，看门狗就会来叫你。
curl -fsS -m 10 --retry 3 "$URL" >/dev/null
```

一个**死人开关**把这件事反过来：**ping 的缺席**才是信号。一个从没收到你夜间任务的看门狗，
不管任务是崩了、定时器被关了、还是整台机器断电，都会来叫你——这是逐指标告警抓不到的失败。

## 只在「值得动手」的条件上告警

让监控变得没用的最快方法，就是让告警变得可以忽略。我的规矩：**如果一个告警响了，而正确的
反应是「什么都不做」，那就删掉它。** 每一次呼叫都应该对应一个动作——重启单元、清磁盘、续
证书、修任务。

- 对**「磁盘超过 90%」**告警，不对「磁盘 IO 很高」告警。前者是一件事要做，后者只是一个事实。
- 对**「证书 14 天内到期」**告警，不对「TLS 握手延迟变了」告警。
- 对**「备份任务没有回报」**告警，不对「备份吞吐掉了」告警。
- **不要**单独对 CPU 或内存告警。如果机器慢到值得在意，对真实服务的一次冒烟检查就会失败，
  *那*才是告警。

一个响得频繁又毫无意义的告警，只会训练你忽略它。

## 一份你真能查的日志

就算告警做得好，接下来的问题永远是「出事之前那一刻发生了什么」。如果日志一轮转就没了，你
恰恰在需要看的时候是瞎的。`journald` 本来就在收集每个 systemd 单元的 stdout/stderr 和内核
消息，`journalctl` 也是真正的查询接口——但前提是你给这份日志一个落脚处和一个预算。

```ini
# /etc/systemd/journald.conf
[Journal]
Storage=persistent
SystemMaxUse=500M
MaxRetentionSec=14day
ForwardToSyslog=no
```

三点要紧。**persistent** 意味着日志能挺过重启——默认它可能只活在 `/run` 里，一重启就没了。
**`SystemMaxUse`** 给它能吃掉的磁盘封顶，这样一个话痨服务永远填不满这个卷。**`MaxRetentionSec`**
让日志除了按大小、也按时钟过期，于是「14 天」是一个承诺，而不是一个期望。

然后你不用去 grep 那些轮转过的文件，就能问出真问题：

```bash
# 某个单元过去一小时记下的一切
journalctl -u healthcheck --since "1 hour ago"

# 只挑错误，跨所有单元，从上次启动算起
journalctl -p err -b --no-pager
```

这是一份可查询的日志，没有 Loki、没有 Elasticsearch、没有要维护的索引。日志的统计那一面是
[另一件基于日志的活](/zh/posts/self-hosted-analytics/)，两者共用同一个 journal。

## 什么时候你确实想要 Prometheus 和 Grafana

我不是在反对那套栈，我反对的是在你还没有一个它能回答的问题之前就先把它装上。下面任何一条
成立，就值得把它请出来：

- **机器多到不止几台**，「这是哪台主机」不再显而易见。
- **你需要趋势**——「磁盘什么时候会用完？」阈值检查答不了，图能答。
- **你有 SLO 或延迟目标**，p95/p99 随时间的变化是真会进入决策的输入。
- **有多人 on-call**，需要一个共享、可靠的视图。
- **你想跨服务关联**，或者对「磁盘涨得比保留窗口还快」这类表达式告警。

其中任何一条成真的话，这篇里的方案都没白做——它变成你的 `OnFailure` 处理器和 textfile
指标，喂给你刚加上去的栈。先上 Prometheus 和 `node_exporter`，然后告警规则，Grafana 放最后。

这些全都跑在几台小机器上，这支机队的样子写在
[我 2026 年都自托管了什么](/zh/posts/what-i-self-host-2026/)。监控不必是一个平台——一张短
清单、一个脚本，和一个能听见沉默的看门狗就够了。

只对你会去修的东西告警，其余的什么都不说。
