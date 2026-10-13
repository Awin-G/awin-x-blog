---
title: "MQTT 5 in practice: shared subscriptions, request/response and the reason codes that matter"
description: "MQTT 5 adds shared subscriptions, request-response MQTT patterns, user properties, message expiry and real reason codes. Here is what each one actually changes, with real mosquitto 2.1.2 output."
pubDate: 2027-01-26
lang: en
translationKey: mqtt-5-in-practice
tags: [embedded, networking]
featured: false
keywords:
  - MQTT 5
  - shared subscriptions
  - user properties
  - request response MQTT
  - mosquitto
---

I have shipped MQTT fleets for years on v3.1.1 and never needed anything else — until I
wanted a pool of backend workers to load-balance a queue, and discovered there is no way to
say that in the old protocol. That single gap is what pushed me to **MQTT 5**, and it
summarizes the whole story: v5 is a small set of additions, and only some of them change how
you design systems.

MQTT, in two sentences: a tiny publish/subscribe protocol for constrained devices, where a
two-byte minimum header carries a message to any number of subscribers that matched a topic
string, and the broker in the middle does all the routing. **MQTT 5** (OASIS standard, 2019)
keeps that core byte-for-byte compatible and adds a properties layer — and the request
response MQTT pattern, shared subscriptions, metadata and honest errors all live in that
layer.

The lab for every experiment below is a throwaway broker:

```bash
docker run -d --name mqtt5-lab -p 127.0.0.1:1883:1883 eclipse-mosquitto:2
# mosquitto version 2.1.2 starting
```

Every command ran against `localhost:1883` inside that container (identical from the host
through the published port), and every output block is copy-pasted from the terminal.

## Shared subscriptions: the one killer feature

A normal subscription is fan-out: three subscribers on `jobs`, three copies of every
message. A **shared subscription** is load balancing: members of a group receive each message
exactly once, and the broker spreads the work. You subscribe to `$share/<group>/<filter>`:

```bash
# worker-a and worker-b run simultaneously:
$ mosquitto_sub -V 5 -u labuser -P labpass -i worker-a -t '$share/workers/jobs' -v
$ mosquitto_sub -V 5 -u labuser -P labpass -i worker-b -t '$share/workers/jobs' -v

$ for i in 1 2 3 4 5 6; do mosquitto_pub -V 5 -u labuser -P labpass -t jobs -m "job-$i"; done

# --- worker-a received:
jobs job-1
jobs job-3
jobs job-5
# --- worker-b received:
jobs job-2
jobs job-4
jobs job-6
```

Six messages, two workers, three each — round robin, confirmed on the wire. The broker log
shows the group forming:

```text
Received SUBSCRIBE from worker-a
	$share/workers/jobs (QoS 0)
worker-a 0 $share/workers/jobs
Sending SUBACK to worker-a
```

Now scale the fleet by adding workers to the same group with no publisher change. Two
operational notes: a message published while the group is empty is dropped (a group is not a
queue), and QoS still applies per member, so use QoS 1 if losing a job would hurt.

<figure>
<svg viewBox="0 0 640 220" width="100%" role="img" aria-label="A publisher sends to topic jobs. The broker routes to a shared subscription group workers, which delivers each message alternately to worker-a, which gets job-1, job-3, job-5, and worker-b, which gets job-2, job-4, job-6.">
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
    <text x="424" y="44" font-size="10" opacity="0.75">alternating delivery</text>
  </g>
  <g stroke="#0f766e" stroke-width="1.5" fill="none">
    <line x1="130" y1="110" x2="232" y2="110" marker-end="url(#ar1)"/>
    <path d="M402 88 C 460 88, 460 54, 494 54" marker-end="url(#ar1)"/>
    <path d="M402 136 C 460 136, 460 166, 494 166" marker-end="url(#ar1)"/>
  </g>
</svg>
<figcaption>A shared subscription group turns fan-out into load balancing: every message on
<code>jobs</code> is delivered to exactly one member of
<code>$share/workers/jobs</code>.</figcaption>
</figure>

### Why v3.1.1 cannot do this

Shared subscriptions are defined in the v5 spec only; `$share/` means nothing to a v3.1.1
client. The difference is fan-out versus balancing, visible the moment you run the same test
with `-V 311`:

```bash
$ mosquitto_sub -V 311 -u labuser -P labpass -i fan-a -t jobs -v     # fan-b identical
$ for i in 1 2 3 4; do mosquitto_pub -V 311 -u labuser -P labpass -t jobs -m "task-$i"; done

# --- fan-a received:
jobs task-1
jobs task-2
jobs task-3
jobs task-4
# --- fan-b received:  (the same four messages)
jobs task-1
jobs task-2
jobs task-3
jobs task-4
```

Both subscribers get every message, because that is the only thing a v3.1.1 client *can*
subscribe to. (Mosquitto happens to tolerate the literal filter from a v3.1.1 client, but
that is the broker being lenient, not a protocol feature — v3.1.1 client libraries do not
offer it.) Usually this one demo justifies v5 on its own.

## Request response MQTT: response-topic and correlation-data

MQTT is one-way by nature, and the classic workaround is a "reply topic" both sides agree on
out of band. v5 makes it protocol-level: a request carries a `response-topic` property (where
the reply should go) and `correlation-data` (an opaque token the requester can match replies
against). The request-response MQTT pattern becomes three lines:

```bash
# responder: watch the request topic and show the properties it received
$ mosquitto_sub -V 5 -u labuser -P labpass -i responder -t svc/echo/request \
    -F "[request] topic=%t payload=%p response-topic=%R correlation=%D"

# caller: watch the reply topic
$ mosquitto_sub -V 5 -u labuser -P labpass -i caller -t svc/echo/response \
    -F "[reply]   topic=%t payload=%p correlation=%D"

# the request itself, with response-topic + correlation-data + user properties:
$ mosquitto_pub -V 5 -u labuser -P labpass -q 1 -i caller-req -t svc/echo/request -m 'ping' \
    -D PUBLISH response-topic svc/echo/response \
    -D PUBLISH correlation-data req-42 \
    -D PUBLISH user-property trace rpc-1

[request] topic=svc/echo/request payload=ping response-topic=svc/echo/response correlation=req-42
```

The responder reads the reply topic straight out of the message and answers on it, echoing the
correlation token:

```bash
$ mosquitto_pub -V 5 -u labuser -P labpass -q 1 -i responder-rep -t svc/echo/response -m 'pong' \
    -D PUBLISH correlation-data req-42

[reply]   topic=svc/echo/response payload=pong correlation=req-42
```

That is a complete round trip: no reply topics agreed in code, no per-client namespace to
invent, and a correlation token that survives retries. What the payload never had to carry:
where to reply, and which request this answers.

## User properties: metadata without abusing the payload

The temptation with v3.1.1 is to stuff routing hints into the payload — a JSON envelope
wrapped around a two-byte temperature. **User properties** are name/value string pairs that
ride alongside the message, and any subscriber can read them without parsing the payload:

```bash
$ mosquitto_pub -V 5 -u labuser -P labpass -t sensors/lab1/temperature -m '21.5' \
    -D PUBLISH user-property unit celsius \
    -D PUBLISH user-property sensor bme280 \
    -D PUBLISH user-property seq 17

# subscriber:
$ mosquitto_sub -V 5 -u labuser -P labpass -i watch -t sensors/lab1/temperature \
    -F "%t props=[%P] payload=%p"

sensors/lab1/temperature props=[unit:celsius sensor:bme280 seq:17] payload=21.5
```

The payload stays `21.5`. Units, sensor identity, sequence numbers and tracing ids move into
headers where a constrained device can encode them cheaply and a backend can filter on them
without deserialising anything. Multiple properties with the same name are legal — handy for
tags.

## Message expiry: a TTL on the message itself

Retained messages are how MQTT remembers "current state" — and also how a stale state
outlives the device that published it. v5 puts an expiry interval on the message:

```bash
$ mosquitto_pub -V 5 -u labuser -P labpass -r -q 1 -t sensors/lab1/status -m 'retained-21.5C' \
    -D PUBLISH message-expiry-interval 5

# subscribe within the window:
$ mosquitto_sub -V 5 -u labuser -P labpass -i exp1 -t sensors/lab1/status \
    -F "%t payload=%p expiry-left=%E retained=%r" -C 1 -W 3

sensors/lab1/status payload=retained-21.5C expiry-left=5 retained=1

# the same subscription after 7 seconds:
$ mosquitto_sub -V 5 -u labuser -P labpass -i exp2 -t sensors/lab1/status -C 1 -W 4
Timed out            # exit 27: the broker dropped the expired retained message
```

The interval counts down from publish time, not from when each subscriber connects. The
practical use: retained state that self-heals. Publish availability with a 60-second expiry
and a dead device can never leave an "online" behind for long. (Mosquitto removes an expired
retained message the next time it is accessed; `retain_expiry_interval` makes it sweep on a
timer instead.)

## Reason codes: errors you can act on

This is the quiet quality-of-life feature. v3.1.1 answers failure with a single generic
`0x80` on SUBACK, or with a connection that just dies. v5 attaches a reason code — and a
human-readable reason string — to every ack. Against a broker with an ACL, the difference is
not subtle:

```bash
# subscribe to a forbidden topic:
$ mosquitto_sub -V 5 -u labuser -P labpass -i t5 -t 'restricted/secret' -d
Client t5 sending SUBSCRIBE (Mid: 1, Topic: restricted/secret, QoS: 0, Options: 0x00)
Client t5 received SUBACK
Subscribed (mid: 1): 135            # 135 = Not authorized

# publish QoS 1 to the same topic:
$ mosquitto_pub -V 5 -u labuser -P labpass -q 1 -t 'restricted/secret' -m 'hello' -d
Client t-pubdenied sending PUBLISH (d0, q1, r0, m1, 'restricted/secret', ... (5 bytes))
Client t-pubdenied received PUBACK (Mid: 1, RC:135)
```

Same run, same broker, v3.1.1 client:

```bash
$ mosquitto_sub -V 311 -u labuser -P labpass -i t311 -t 'restricted/secret' -d
Subscribed (mid: 1): 128           # 0x80 = failure, no reason given

$ mosquitto_pub -V 311 -u labuser -P labpass -q 1 -t 'restricted/secret' -m 'hello' -d
Client t-pub311 received PUBACK (Mid: 1, RC:0)      # "success"…

# …meanwhile the broker log says:
Denied PUBLISH from t-pub311 (d0, q1, r0, m1, 'restricted/secret', ... (5 bytes))
```

That last line is the worst failure mode in MQTT: the v3.1.1 client is told its message was
accepted while the broker silently drops it. With v5 the same attempt is acknowledged with
135, so the client can log, alert, or retry elsewhere. Reason codes also show up on
the happy paths: a QoS 1 publish that matched no subscriber comes back as `RC:16`
("No matching subscribers") — a free sanity check that your topics are spelled the way you
think they are. The codes that matter in practice: 135 not authorized, 143 invalid topic
filter, 149 packet too large, 155 QoS not supported, 158 shared subscriptions not supported,
161 subscription identifiers not supported.

The broker side of my test used mosquitto's dynamic-security plugin, where a deny rule is one
ACL line:

```bash
plugin /usr/lib/mosquitto_dynamic_security.so
plugin_opt_config_file /mosquitto/config/dynsec.json

# create user/role, then the rule that produces the 135s:
mosquitto_ctrl -u admin -P adminpass dynsec addRoleACL lab \
    subscribeLiteral restricted/secret deny 1
mosquitto_ctrl -u admin -P adminpass dynsec addRoleACL lab \
    publishClientSend 'restricted/#' deny 1
```

## Topic aliases: fewer bytes per message on constrained links

Every PUBLISH normally repeats the full topic string — wasteful for a device that reports
every few seconds on one topic. A topic alias is a 16-bit handle registered on a connection:
send the topic once with an alias number, then send the number alone. Both directions support
it, negotiated through `topic-alias-maximum` in CONNECT:

```bash
# subscriber advertises that it accepts aliases from the broker:
$ mosquitto_sub -V 5 -u labuser -P labpass -i alias-watch -t sensors/lab1/temperature \
    -D CONNECT topic-alias-maximum 5 -F "%t alias=%A props=[%P] %p"

# publisher registers alias 7 on its own connection:
$ printf 'reading-1\nreading-2\n' | mosquitto_pub -V 5 -u labuser -P labpass \
    -t sensors/lab1/temperature -l -D PUBLISH topic-alias 7 \
    -D PUBLISH user-property unit celsius

sensors/lab1/temperature alias=1 props=[unit:celsius] reading-1
sensors/lab1/temperature alias=1 props=[unit:celsius] reading-2
```

The subscriber resolves the alias and still prints the full topic; `alias=1` shows the broker
created a handle on this connection, and from the second message on the topic string is off
the wire entirely. On an NB-IoT link with a 20-byte topic, that is most of a meter's
payload budget saved per reading. The alias lives and dies with the connection — reconnect
and it is gone.

## Sessions and keep alive: the same ideas, sharper corners

v3.1.1's clean session was a boolean: your subscriptions either survive a disconnect or they
don't — there was no way to say "keep my session five minutes". v5 splits it into clean start
(per connect) plus a session expiry interval (in seconds):

```bash
# create a durable session and exit while it stays alive:
$ mosquitto_sub -V 5 -u labuser -P labpass -c -x 300 -q 1 -i durable-1 -t 'cmd/durable-1/#' -E

# publish a QoS 1 command while durable-1 is offline:
$ mosquitto_pub -V 5 -u labuser -P labpass -q 1 -t cmd/durable-1/led -m 'on'

# reconnect — the broker resumes the session and hands over the queued command:
$ mosquitto_sub -V 5 -u labuser -P labpass -c -x 300 -q 1 -i durable-1 -t 'cmd/durable-1/#' -C 1 -W 5 -v

cmd/durable-1/led on
```

The broker log for the reconnect shows the mechanism in one line —
`Sending CONNACK to durable-1 (1, 0)`: the first number is the session-present flag, telling
the client "I still remember you, here is what you missed". Keep alive itself is unchanged —
a 60-second default and a PINGREQ timer — except that a v5 broker may override it with a
server keep alive, so devices learn the real cadence instead of guessing at NAT timeouts.

## What stayed the same

The core did not move, and that is the point of the version bump:

- **QoS 0/1/2** — same definitions, same wire flows; a QoS 1 publish is still acked with
  `PUBACK` (`RC:0` on success).
- **Retained messages** — same broker-side "last known value" per topic, now optionally with
  an expiry.
- **Last will and testament** — register a message at connect, and the broker publishes it if
  you vanish. The run below killed a subscriber with `kill -9` and a watcher on its will topic
  received the payload:

```bash
# watcher already subscribed; the victim registered --will-topic status/device
$ kill -9 <mosquitto_sub pid>     # unclean disconnect; broker fires the will
status/device offline
```

  v5 adds a will delay interval, so the will can wait a few seconds and be cancelled by a
  reconnect that was only slow.
- **Topics and wildcards** — identical `+`/`#` matching.

The [MQTT-on-a-microcontroller post](/posts/mqtt-on-a-microcontroller/) covers QoS, retain
and will on real hardware, and the [smart-home post](/posts/smart-home-without-cloud/) shows
the same protocol as a local home-automation backbone — neither depends on anything here.

## Do you actually need v5?

Honest answer: often not, and the honest version of the feature list is short.

- **You need v5 if** you want shared subscriptions (the one killer feature), structured
  metadata on messages, message expiry, or errors you can debug at 3 a.m. If your backend is a
  pool of workers draining a topic, v5 is not a nice-to-have — v3.1.1 structurally cannot
  express your design.
- **Your broker and clients must both support it.** Mosquitto, EMQX, HiveMQ and NanoMQ all
  speak v5, and paho-mqtt, the ESP-IDF client and most modern libraries do too. Mixed fleets
  are fine too: a v5 broker serves v3.1.1 on the same port with no extra configuration, and
  those clients simply never see any of this.
- **Shared subscriptions are broker-dependent in the details.** Round robin is what mosquitto
  implements; other brokers offer sticky, random or hash distribution. Test what yours
  actually gives you before building fairness into your workload.
- **Do not upgrade for its own sake.** If your devices publish telemetry and subscribe to
  commands, v3.1.1 is genuinely fine; running a two-byte-header protocol unchanged is worth
  more than any property. But when the next design meeting draws a pool of workers behind a
  queue, you know which version to reach for.
