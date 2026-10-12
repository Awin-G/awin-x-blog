---
title: "Object storage without the cloud: S3-compatible storage with MinIO"
description: "How object storage really works — flat keys, whole-object writes — why the S3 API won, and how to run MinIO locally. Real commands and output for buckets, uploads, a bucket policy, a presigned URL, versioning, lifecycle rules, and the S3 SDK — plus the honest limits, and when to reach for it."
pubDate: 2026-12-17
lang: en
translationKey: minio-and-s3
tags: [self-hosting, devops, nginx]
featured: false
keywords:
  - MinIO
  - S3-compatible storage
  - object storage
  - presigned URL
  - bucket policy
  - versioning
  - S3 SDK
---

Object storage is one of the few cloud primitives worth learning even if you never rent a cloud. Almost every app accumulates bytes that are not a row and not a file on a working disk: uploads, media, backups, logs, model artifacts. **Object storage** is the shape that pile wants; **S3-compatible storage** is how you get it on hardware you own. I run **MinIO**, a small S3-compatible server, on my own box. This post is what I wish I had read first.

So I stood up a throwaway MinIO on `127.0.0.1` and ran everything end to end: a bucket, uploads, a byte-for-byte download check, a **bucket policy**, a **presigned URL**, **versioning**, a lifecycle rule, and the same operations from Python with an **S3 SDK**. Every block below is real output from that run.

## What object storage actually is

Object storage is a flat namespace of **buckets**, and inside each bucket a flat namespace of **objects**. An object is a **key** (its name, a string), a **value** (the bytes), and a small bag of **metadata** (content type, size, ETag, and whatever else you attach).

That flatness is the whole design: there are no nested directories in the API. When you see `app-backups/2026-12-17/db.dump`, that is one key; the slashes are a convention clients use to *draw* a hierarchy, but the server stores none. That buys listing a prefix, sharding a namespace, and serving any key from any node — because the key is the only identity.

The other half is how you write: you do not seek into an object and change 30 bytes; you upload and replace a whole object. Writes are atomic at the key level — a reader sees the old version or the new one, never a half-written one. Great for immutable things (a photo, a dump, a log segment), awkward for anything you edit in place (a SQLite file, a Git pack you keep rewriting).

## How it differs from a filesystem or a block device

Three layers get confused constantly.

- A **block device** is raw storage: fixed-size blocks addressed by number, with no idea what a file is. A filesystem or database sits on top and decides what those blocks mean. Lowest, fastest, most dangerous — someone must own the layout.
- A **filesystem** (ext4, ZFS, APFS) puts a tree of files and directories on a block device, with permissions, `fsync`, random access, and in-place edits. It speaks POSIX, and processes expect it.
- **Object storage** throws all of that away on purpose: no partial writes, no file handles, no `seek`, no rename. In exchange you get an HTTP API, near-unlimited scale, and no inode to run out of.

<figure>
<svg viewBox="0 0 640 190" width="100%" role="img" aria-label="A client talks to the S3 HTTP API, which stores objects inside buckets. Objects are addressed by key; the key's slashes are only a label, not real directories.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="14" y="66" width="126" height="56" rx="8"/>
    <rect x="238" y="66" width="150" height="56" rx="8"/>
    <rect x="486" y="24" width="140" height="52" rx="8"/>
    <rect x="486" y="104" width="140" height="52" rx="8"/>
    <path d="M140 94 h90" marker-end="url(#a)"/>
    <path d="M388 82 h60 l0 -32 h30" marker-end="url(#a)"/>
    <path d="M388 106 h60 l0 24 h30" marker-end="url(#a)"/>
  </g>
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="77" y="90">client</text>
    <text x="77" y="108" opacity="0.75">SDK / mc / curl</text>
    <text x="313" y="90">S3 API</text>
    <text x="313" y="108" opacity="0.75">PUT · GET · LIST (HTTP)</text>
    <text x="556" y="45">bucket: app-backups</text>
    <text x="556" y="63" opacity="0.75">2026-12-17/db.dump</text>
    <text x="556" y="125">bucket: media</text>
    <text x="556" y="143" opacity="0.75">uploads/avatar.png</text>
  </g>
</svg>
<figcaption>One HTTP API, flat buckets, keys as the only identity. The slashes are a label, not a directory tree.</figcaption>
</figure>

## Why S3's API became the standard

Amazon shipped S3 in 2006 and the API leaked everywhere. Today "S3-compatible" is a checkbox on dozens of products — MinIO, Ceph RGW, SeaweedFS, Garage, Cloudflare R2, Backblaze B2, and the object stores inside every big cloud. They agree on the wire protocol (verbs, signing, error XML), which is why the same client code talks to all of them.

That agreement is about portability, not brand. When your app uses an **S3 SDK** against an S3 endpoint, the endpoint is just a URL you can change: develop against MinIO on your laptop, deploy against MinIO on your server, migrate to a cloud bucket next year without touching the storage layer. Vendors spent years pushing proprietary SDKs; the market chose the boring open one.

## Running MinIO on your own box

MinIO is a single Go binary that speaks the S3 API and stores objects on local disks. On a laptop it is a one-container install:

```bash
docker run -d --name minio \
  -p 127.0.0.1:9000:9000 -p 127.0.0.1:9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin123 \
  -v "$PWD/data:/data" \
  elestio/minio:latest server /data --console-address ":9001"
```

Port `9000` is the S3 API; `9001` is the browser console. Point the MinIO client, `mc`, at it and it tells you what it is:

```console
$ mc alias set local http://127.0.0.1:9000 minioadmin minioadmin123
Added `local` successfully.

$ mc admin info local
●  127.0.0.1:9000
   Uptime: 4 minutes
   Version: 2025-09-07T16:13:09Z
   Network: 1/1 OK
   Drives: 1/1 OK
   Pool: 1
   ...
1 drive online, 0 drives offline, EC:0
```

That `EC:0` is not an error — it is the honest truth about a single-drive, single-node setup, and it comes back later. Note the image name: in 2026 MinIO's community edition went source-only, and the `minio/minio` Docker image was pulled from Docker Hub. Repackaged images like `elestio/minio` (genuine MinIO, a frozen release) still work, and you can build from source, but pick your mirror deliberately and pin a digest.

Where does it fit? The three places object storage always fits: **backups** (a restic or rclone target, and the offsite leg of a [3-2-1 plan](/posts/backups-you-can-restore/)), **media** (photos, audio, video your app serves through a CDN), and **app blobs** (user uploads, exports, job artifacts). It also suits **logs** and ML datasets. You do not need Docker for any of this — see [self-hosting without Docker](/posts/self-hosting-without-docker/).

## A bucket, a few objects, and a round trip

Create a bucket, drop some files in, list them, pull them back:

```console
$ mc mb local/app-backups
Bucket created successfully `local/app-backups`.

$ mc cp db.dump local/app-backups/2026-12-17/db.dump
`db.dump` -> `local/app-backups/2026-12-17/db.dump`
┌──────────┬─────────────┬──────────┬─────────────┐
│ Total    │ Transferred │ Duration │ Speed       │
│ 4.00 KiB │ 4.00 KiB    │ 00m00s   │ 63.38 KiB/s │
└──────────┴─────────────┴──────────┴─────────────┘

$ mc ls --recursive local/app-backups
[2026-12-12 17:51:40 CST] 4.0KiB STANDARD 2026-12-17/db.dump
[2026-12-12 17:51:40 CST]    44B STANDARD 2026-12-17/schema.sql

$ mc stat local/app-backups/2026-12-17/db.dump
Name      : db.dump
Size      : 4.0 KiB
ETag      : fa17670e005793d1d9286e6c92a90417
Type      : file
Metadata  :
  Content-Type: application/octet-stream
```

`mc cp --recursive` back down to disk, then `cmp` against the original — byte-for-byte identical, which is the only restore test that counts.

## Access control: bucket policies and presigned URLs

By default a bucket is private; you grant access two ways. A **bucket policy** is a JSON document on the bucket saying who can do what, persistently. A **presigned URL** is a single, expiring capability — a normal URL carrying a signature that lets anyone holding it fetch one object, without seeing your credentials.

Here is a public-read policy, in the exact JSON MinIO reports:

```console
$ mc anonymous set download local/app-backups
Access permission for `local/app-backups` is set to `download`

$ mc anonymous get-json local/app-backups
{"Statement":[{"Action":["s3:GetBucketLocation","s3:ListBucket"],"Effect":"Allow","Principal":{"AWS":["*"]},"Resource":["arn:aws:s3:::app-backups"]},{"Action":["s3:GetObject"],"Effect":"Allow","Principal":{"AWS":["*"]},"Resource":["arn:aws:s3:::app-backups/*"]}],"Version":"2012-10-17"}

$ curl -s http://127.0.0.1:9000/app-backups/2026-12-17/schema.sql
CREATE TABLE users (id bigint primary key);
```

Turn the policy back to private and the same URL is refused:

```console
$ mc anonymous set none local/app-backups
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9000/app-backups/2026-12-17/schema.sql
403
<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Access Denied.</Message><Key>2026-12-17/schema.sql</Key>...
```

Now the presigned URL. No policy change, no public bucket — just a signed link that expires:

```console
$ mc share download --expire 2h local/app-backups/2026-12-17/schema.sql
Share: http://127.0.0.1:9000/app-backups/2026-12-17/schema.sql?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=minioadmin%2F20261212%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261212T095141Z&X-Amz-Expires=7200&X-Amz-SignedHeaders=host&X-Amz-Signature=b4d6727750e6fee37d7a65017553d287102704f603eee1589e729c44a08f2962

$ curl -s -o /dev/null -w '%{http_code}\n' "$SHARE_URL"
200
```

The signature is computed from your secret key over the request, the expiry, and the method. Anyone with the URL can do exactly that one thing until it expires; tamper with it, or wait past `X-Amz-Expires`, and you get a 403. That is how "download this report" links work: your app signs a URL and hands it to the browser instead of proxying bytes or exposing a credential.

## Versioning and lifecycle rules

**Versioning** turns overwrites into new versions. Enable it, overwrite a key, and both copies are still there:

```console
$ mc version enable local/app-backups
local/app-backups versioning is enabled

$ mc ls --versions local/app-backups/2026-12-17/schema.sql
[2026-12-12 17:51:41 CST] 56B STANDARD 055952a6-8aab-4ff2-afe4-8de90a20756a v2 PUT schema.sql
[2026-12-12 17:51:40 CST] 44B STANDARD null v1 PUT schema.sql
```

A **lifecycle rule** then cleans up on a schedule, so versioning does not grow forever:

```console
$ mc ilm rule add --expire-days 30 --prefix app-backups/2026-12-17/ local/app-backups
Lifecycle configuration rule added with ID `db6arbboe50boqrrig0g` to local/app-backups.

$ mc ilm rule ls local/app-backups
┌──────────────────────┬─────────┬─────────────────────────┬──────┬────────────────┐
│ ID                   │ STATUS  │ PREFIX                  │ TAGS │ DAYS TO EXPIRE │
├──────────────────────┼─────────┼─────────────────────────┼──────┼────────────────┤
│ db6arbboe50boqrrig0g │ Enabled │ app-backups/2026-12-17/ │ -    │             30 │
└──────────────────────┴─────────┴─────────────────────────┴──────┴────────────────┘
```

Versioning plus lifecycle is the whole retention story: keep every change, expire what is old, stop paying for it.

## Using it from code with the S3 SDK

The **S3 SDK** speaks the same endpoint. From Python (`boto3`):

```python
import boto3, urllib.request
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url="http://127.0.0.1:9000",
    aws_access_key_id="minioadmin",
    aws_secret_access_key="minioadmin123",
    region_name="us-east-1",
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
)

print("buckets:", [b["Name"] for b in s3.list_buckets()["Buckets"]])
s3.put_object(Bucket="app-backups", Key="2026-12-17/app.log",
              Body=b'{"level":"info","msg":"hello from boto3"}\n')
url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": "app-backups", "Key": "2026-12-17/app.log"},
    ExpiresIn=3600,
)
print(url)
print(urllib.request.urlopen(url).read().decode())
```

```console
buckets: ['app-backups']
put app.log
      42  2026-12-17/app.log
    4096  2026-12-17/db.dump
      56  2026-12-17/schema.sql
presigned url:
  http://127.0.0.1:9000/app-backups/2026-12-17/app.log?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=minioad...
GET via presigned url -> 200 {"level":"info","msg":"hello from boto3"}
content-type: binary/octet-stream | etag: "37e784f64107305eac5ea5f9ced3e43a"
```

Swap `endpoint_url` and the same code runs against a cloud bucket. That is the portability payoff in one line.

## The honest limits

The failure modes are predictable if you name them:

- **It is not a POSIX filesystem.** No partial writes, no `seek`, no atomic rename, no file locking. Mounting one as a "disk" (s3fs, JuiceFS) works but leaks the mismatch into latency and consistency surprises.
- **It is not a database.** There are no queries, no transactions, no indexes over your bytes. Keep structured data in a real database; keep the blobs in object storage.
- **Single-node is not HA.** One MinIO on one disk is a single point of failure: stop the container and everything is offline; lose the disk and everything is gone. Fine for a cache or a rebuildable copy; not a backup by itself.
- **Erasure coding needs drives.** MinIO only forgives failures with several drives to spread data and parity across. Four drives on one node report `EC:2`: two can vanish and the data survives. One drive reports `EC:0` — exactly zero redundancy:

  ```console
  4 drives online, 0 drives offline, EC:2
  ```

- **The API has sharp edges.** Listings are expensive on huge prefixes; an overwrite rewrites the whole object unless you use multipart upload; per-request and small-object overhead adds up; and consistency is not uniform across every S3-compatible backend.

## When to use it

Reach for S3-compatible object storage when the data is:

- **Large and mostly write-once** — photos, video, audio, PDFs, archives.
- **Served over HTTP** — anything a browser or CDN should fetch by URL.
- **Backed up or replicated** — the offsite/third-copy leg of a backup plan.
- **Append-only or versioned** — logs, events, model checkpoints, exports.
- **Ephemeral or regenerable** — caches, build artifacts, scratch space.

Do **not** use it as your database, your working filesystem, or your only copy of anything — the same three mistakes that burn weekends.

I keep coming back to object storage because the abstraction is small and honest: buckets and keys, one HTTP API, a portable client. MinIO gives me that on hardware I control, with a path to a cloud bucket the day I want one — and back the day I don't. If you have not tried it, stand one up, put a dump in a bucket, and pull it back to prove the round trip. That fifteen-minute test beats any architecture diagram.
