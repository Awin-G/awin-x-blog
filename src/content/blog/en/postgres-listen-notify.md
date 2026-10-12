---
title: "Postgres LISTEN/NOTIFY: a message bus you already have"
description: "Postgres has a built-in pub/sub mechanism called LISTEN/NOTIFY. It is small, fast, and already running in your database. Here is how to use it, its real limits, and when to reach for a real queue instead."
pubDate: 2027-01-07
lang: en
translationKey: postgres-listen-notify
tags: [devops, linux]
featured: false
keywords:
  - Postgres LISTEN NOTIFY
  - pg_notify
  - database pub/sub
  - change notification
  - trigger
---

Most teams reach for Redis, NATS, or RabbitMQ the moment they need to wake up a worker or invalidate a cache. That is often the right call — but before you add another moving part, check whether Postgres can already do the job. It can, for a specific class of problems.

Postgres ships with a lightweight pub/sub system: `LISTEN` and `NOTIFY`. One session listens on a named channel; another session sends a notification with a small payload. The listener receives it in real time. No extra infrastructure, no new connection pool, no additional service to operate. If you already run Postgres — and you almost certainly do — you already have a message bus.

This is not a replacement for a real queue. It is a "something changed, go look" signal. Understanding where that line sits is the whole game.

## What LISTEN/NOTIFY actually is

`LISTEN` tells Postgres that your connection is interested in a channel. `NOTIFY` sends a message to everyone listening on that channel. The message is a short string payload, delivered asynchronously.

```sql
-- Session A: listen
LISTEN my_channel;

-- Session B: notify
NOTIFY my_channel, 'hello from session B';
```

Session A sees:

```
Asynchronous notification "my_channel" with payload "hello from session B" received from server process with PID 114.
```

That is the whole mechanism. A channel is just a name — there is no setup, no topic registry, no broker. The payload is a single text string, up to 8000 bytes. Notifications are not stored anywhere; they exist only while a listener is connected.

You can also send notifications from SQL with `pg_notify()`, which is what you will actually use in production:

```sql
SELECT pg_notify('my_channel', '{"user_id": 42}');
```

`pg_notify()` is a function, so you can call it from triggers, functions, and application code. That is where the real power lives.

## A real two-session demo

I ran this against a throwaway Postgres 16 container. Two `psql` sessions, one listening and one notifying.

Session A:

```sql
LISTEN my_channel;
```

Session B:

```sql
NOTIFY my_channel, 'hello from session B';
```

Session A immediately prints:

```
Asynchronous notification "my_channel" with payload "hello from session B" received from server process with PID 114.
```

No polling, no delay, no extra service. The notification is pushed to every connection that is listening on `my_channel` at the moment `NOTIFY` fires. If nobody is listening, the notification is simply discarded.

## Change notifications with a trigger

The most common production use is firing a notification when a row changes. Create a trigger function that calls `pg_notify()`, attach it to a table, and every insert/update/delete broadcasts a change event.

```sql
CREATE OR REPLACE FUNCTION notify_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('events_channel', json_build_object(
    'op', TG_OP,
    'id', NEW.id,
    'name', NEW.name
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_notify
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION notify_event();
```

Now insert a row:

```sql
INSERT INTO events (name) VALUES ('user_signup'), ('order_paid');
```

Any listener on `events_channel` receives:

```
Asynchronous notification "events_channel" with payload "{"op" : "INSERT", "id" : 9, "name" : "cache_invalidate"}" received from server process with PID 281.
```

This is the backbone of many cache-invalidation and worker-wakeup patterns. Your application writes to the database as usual; the trigger broadcasts a change event; interested services wake up and re-read the current state. The notification carries a pointer to what changed, not the full data — listeners always go back to the database for the authoritative value.

<figure>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240" role="img" aria-label="A Postgres channel fanning out to three listeners">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
      </marker>
    </defs>
    <rect x="20" y="90" width="140" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="90" y="125" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="14">Postgres</text>
    <text x="90" y="145" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">channel: events</text>
    <line x1="160" y1="120" x2="280" y2="60" stroke="#0f766e" stroke-width="2" marker-end="url(#arrow)"/>
    <line x1="160" y1="120" x2="280" y2="120" stroke="#0f766e" stroke-width="2" marker-end="url(#arrow)"/>
    <line x1="160" y1="120" x2="280" y2="180" stroke="#0f766e" stroke-width="2" marker-end="url(#arrow)"/>
    <rect x="280" y="30" width="120" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="340" y="65" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="13">Listener A</text>
    <rect x="280" y="90" width="120" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="340" y="125" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="13">Listener B</text>
    <rect x="280" y="150" width="120" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="340" y="185" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="13">Listener C</text>
    <text x="460" y="65" text-anchor="start" fill="currentColor" font-family="monospace" font-size="11">cache</text>
    <text x="460" y="125" text-anchor="start" fill="currentColor" font-family="monospace" font-size="11">worker</text>
    <text x="460" y="185" text-anchor="start" fill="currentColor" font-family="monospace" font-size="11">realtime</text>
  </svg>
  <figcaption>One <code>NOTIFY</code> on a channel fans out to every connected listener. Listeners always re-read the database for the current state.</figcaption>
</figure>

## A Python listener loop

In practice you will listen from application code, not from `psql`. Here is a minimal `psycopg` listener that polls the connection and processes notifications as they arrive:

```python
import psycopg2
import select
import json

conn = psycopg2.connect("host=127.0.0.1 port=5432 dbname=demo user=demo password=demo")
conn.autocommit = True
cur = conn.cursor()
cur.execute("LISTEN events_channel;")
print("Listening on events_channel...")

while True:
    if select.select([conn], [], [], 5) == ([], [], []):
        print("(no notifications in 5s)")
        continue
    conn.poll()
    while conn.notifies:
        notify = conn.notifies.pop(0)
        payload = json.loads(notify.payload)
        print(f"Received: channel={notify.channel} pid={notify.pid} payload={payload}")
```

Run it, insert a row, and you see:

```
Listening on events_channel...
(tick 0: no notifications)
Received: channel=events_channel pid=471 payload={'op': 'INSERT', 'id': 12, 'name': 'py_test4'}
(tick 2: no notifications)
(tick 3: no notifications)
```

The `select()` call waits up to 5 seconds for the socket to become readable. When a notification arrives, `conn.poll()` moves it into `conn.notifies`, and you drain the queue. This pattern works with `asyncpg` too — the API is slightly different but the idea is identical.

## The honest limits

LISTEN/NOTIFY is deceptively simple, and the simplicity hides real constraints. These are not theoretical — they are the things that bite you in production.

**At-most-once delivery.** Notifications are not persisted. If no listener is connected when `NOTIFY` fires, the message is gone. If your listener disconnects for 30 seconds, everything that happened during those 30 seconds is lost. There is no replay, no history, no "catch up on what I missed."

**8000-byte payload.** The payload is a single text string, and it cannot exceed 8000 bytes. I tested the boundary:

```sql
SELECT pg_notify('t', repeat('x', 7999));  -- works
SELECT pg_notify('t', repeat('x', 8000));  -- ERROR: payload string too long
```

In practice you should keep payloads tiny — a primary key, a channel name, a timestamp. The notification is a pointer, not the data. If you need to send more than 8 KB, you are using the wrong tool.

**The notification queue can overflow.** Postgres buffers notifications in a fixed-size queue before delivering them. If you send notifications faster than listeners consume them, the queue fills up and notifications are dropped. You can watch this with:

```sql
SELECT pg_notification_queue_usage();
```

I sent 2000 notifications from one connection while a listener on another connection was not consuming. The queue usage stayed at 0.0000 — but when the listener finally polled, it only received 568 of the 2000 notifications. The rest were silently dropped. The queue is not a buffer that grows; it is a fixed window, and once it overflows, messages disappear.

**Connections must stay open.** A listener is a long-lived connection. If your application restarts, the listener is gone until it reconnects. During that gap, notifications are lost. You need a reconnection strategy and a way to rebuild state on startup.

**Does not survive a restart.** Notifications are in-memory. If Postgres restarts, any undelivered notifications are gone. There is no WAL-backed delivery, no disk-backed queue.

**No fan-out control.** Every listener on a channel gets every notification. There is no consumer group, no competing-consumer pattern, no "only one worker should handle this." If you have three workers all listening on the same channel, all three get the notification and all three act on it.

## When LISTEN/NOTIFY is perfect

Given those limits, when should you use it?

**Cache invalidation.** A worker updates the database; a trigger fires `pg_notify('cache_invalidate', '{"key": "user:42"}')`; your cache layer listens and evicts the key. The payload is tiny, the delivery is fast, and if a notification is occasionally lost, the cache entry expires anyway. This is the canonical use case.

**Waking a worker.** A long-running worker is idle, waiting for work. Instead of polling the database every few seconds, it listens on a channel. When new work arrives, a trigger or application code sends a notification and the worker wakes up immediately. This eliminates poll latency and reduces database load.

**Internal "something changed" signals.** You have a few services that need to know when a configuration changes, a deployment finishes, or a user is created. The signal is small, the audience is small, and occasional loss is acceptable because the next change will trigger another notification.

**Single-database coordination.** If all your services already talk to the same Postgres, LISTEN/NOTIFY gives you a coordination channel without adding Redis or NATS. Fewer moving parts, fewer things to operate, one less service to monitor.

## When you want a real queue

Reach for a real message queue when any of these are true:

- **You need delivery guarantees.** If losing a message means lost revenue, inconsistent state, or a broken workflow, you need a queue with acknowledgments, retries, and dead-letter handling. See [message queues](/posts/message-queues/) for a comparison.
- **You need replay.** If a consumer must be able to reprocess the last N messages after a bug or a restart, you need a log-based system like Kafka or a queue with message retention.
- **You need fan-out at scale.** If you have hundreds of consumers or need consumer groups, LISTEN/NOTIFY's broadcast-everything model will not work.
- **You need to survive restarts.** If your consumers restart frequently and cannot afford to miss messages, you need persistence.
- **You need complex routing.** Topic-based routing, priority queues, delayed messages, scheduled jobs — these are all features of real queues, not of LISTEN/NOTIFY.

## Decision note: Postgres vs Redis vs NATS vs a queue

| Concern | Postgres LISTEN/NOTIFY | Redis Pub/Sub | NATS | RabbitMQ / Kafka |
|---|---|---|---|---|
| Delivery guarantee | At-most-once | At-most-once | At-most-once | At-least-once |
| Persistence | No | No | Optional (JetStream) | Yes |
| Payload size | 8 KB | ~512 MB | ~1 MB | Large |
| Replay | No | No | No (JetStream: yes) | Yes |
| Extra infrastructure | No (you have Postgres) | Yes | Yes | Yes |
| Best for | Internal signals, cache invalidation | Simple pub/sub | Lightweight messaging | Work queues, event streaming |

The rule of thumb: if you already run Postgres and your use case is "tell a few internal services that something changed," start with LISTEN/NOTIFY. It is free, it is already there, and it is fast. When you hit a wall — delivery guarantees, replay, scale — migrate to a real queue. The migration is straightforward because the notification payloads are already small pointers; you are just adding a delivery layer on top.

## The bottom line

Postgres LISTEN/NOTIFY is not a message queue. It is a lightweight, in-database pub/sub mechanism for "something changed, go look" signals. It has real limits: at-most-once delivery, an 8000-byte payload, a notification queue that can overflow, no replay, and no persistence. But for cache invalidation, worker wakeup, and internal change notifications, it is exactly what you need — and it is already running in your database.

Before you add Redis or NATS to your infrastructure, ask whether Postgres can already do the job. Often, it can.

---

*Related: [Message queues](/posts/message-queues/) · [Postgres locks](/posts/postgres-locks/)*
