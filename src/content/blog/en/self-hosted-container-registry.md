---
title: "A self-hosted container registry: private docker push on your own box"
description: "Run your own self-hosted container registry with registry:2: real docker push and pull output, the v2 API by hand (catalog, tags, manifests), htpasswd auth, TLS, and garbage collection."
pubDate: 2027-02-03
lang: en
translationKey: self-hosted-container-registry
tags: [self-hosting, devops]
featured: false
keywords:
  - self-hosted container registry
  - docker push
  - registry:2
  - v2 API
  - htpasswd
---

Every `docker push` you have ever run talked to a registry. A registry is not
a product — it is an HTTP API that stores **blobs** (layer tarballs and image
configs) and **manifests** (small JSON documents saying which blobs a tag
points at). Docker Hub is just one registry, the default one in your config,
and a **self-hosted container registry** is the same API on a box you own:
one container, one volume, private images that never leave the building.
Everything below ran against throwaway `registry:2` containers on a scratch
machine; every command and every block of output is real.

## Why self-host a registry at all

Four situations where it earns its keep:

- **Private images without a per-seat bill.** Build artifacts, internal base
  images, anything not fit for a public hub.
- **No pull rate limits.** CI farms and fresh hosts pull as much as they want.
- **Data stays home.** For NDA work or an air-gapped network, the registry
  *is* the deployment channel.
- **A local pull-through cache.** Point it at Docker Hub upstream and cold
  nodes on your LAN pull warm and fast.

<figure>
<svg viewBox="0 0 640 220" width="100%" role="img" aria-label="Diagram: docker push and pull talk HTTP to the registry on port 5000, which stores two kinds of objects, manifests that map tags to blob digests, and blobs holding layers and configs as sha256 files on disk.">
  <g fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.7">
    <rect x="16" y="70" width="120" height="80" rx="10"/>
    <rect x="200" y="70" width="130" height="80" rx="10" stroke="#0f766e" stroke-width="2"/>
    <rect x="392" y="20" width="150" height="64" rx="10"/>
    <rect x="392" y="136" width="150" height="64" rx="10"/>
    <path d="M136 96 H200"/><path d="M136 128 H200"/>
    <path d="M330 96 H392"/><path d="M330 128 H392"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="30" y="104">docker push</text><text x="30" y="122">docker pull</text>
    <text x="214" y="100">registry:2</text><text x="214" y="118" opacity="0.75">127.0.0.1:5000 /v2</text>
    <text x="406" y="46">manifests</text><text x="406" y="64" opacity="0.75">tag → digest JSON</text>
    <text x="406" y="162">blobs</text><text x="406" y="180" opacity="0.75">layers, config sha256</text>
  </g>
</svg>
<figcaption>One HTTP API, two kinds of objects: manifests are tiny JSON, blobs
are the bytes, both addressed by sha256.</figcaption>
</figure>

## The minimal run: registry:2 in one command

The official distribution image is the whole registry. A volume for state, a
port, done:

```bash
docker run -d --name private-registry \
  -p 5000:5000 \
  -v /srv/registry/data:/var/lib/registry \
  registry:2
```

On my box the logs came up as plain as promised (version 2.8.3):

```
level=info msg="using inmemory blob descriptor cache" ... version=2.8.3
level=info msg="Starting upload purge in 12m0s" ... version=2.8.3
level=info msg="listening on [::]:5000" ... version=2.8.3
```

The API answers on `/v2/` — the version handshake every client does first:

```bash
$ curl http://127.0.0.1:5000/v2/
{}
```

That empty JSON object means "v2 API, come in". Everything else is files under
the volume, which I will prove shortly. On a real server I would bind the port
to a private interface rather than `0.0.0.0`.

## The real docker push → docker pull round trip

A tiny image to push — three lines of Dockerfile on alpine:

```dockerfile
FROM alpine:3.20
RUN echo "hello from a private registry" > /message.txt
CMD ["cat", "/message.txt"]
```

Build it with a full registry address; the registry hostname is part of the
image name, not a flag:

```bash
$ docker build -t 127.0.0.1:5000/tinydemo:v1 .
#5 [2/2] RUN echo "hello from a private registry" > /message.txt
#5 DONE 0.5s
#6 exporting to image
#6 exporting manifest sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6 0.0s done
#6 naming to 127.0.0.1:5000/tinydemo:v1 done
#6 DONE 0.2s
```

The `docker push` uploads only the blobs the registry lacks and answers with
the digest — the sha256 of the manifest, the content address of the image:

```bash
$ docker push 127.0.0.1:5000/tinydemo:v1
The push refers to repository [127.0.0.1:5000/tinydemo]
25f1d6b1951a: Pushed
44136fa355b3: Pushed
2bc0aae78406: Pushed
0e8447578a07: Pushed
v1: digest: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6 size: 855
```

Now the proof the registry serves it, not my local cache. Delete the image,
pull it back, run it:

```bash
$ docker rmi 127.0.0.1:5000/tinydemo:v1
Untagged: 127.0.0.1:5000/tinydemo:v1
Deleted: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6

$ docker pull 127.0.0.1:5000/tinydemo:v1
v1: Pulling from tinydemo
0e8447578a07: Download complete
2bc0aae78406: Pull complete
Digest: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6
Status: Downloaded newer image for 127.0.0.1:5000/tinydemo:v1

$ docker run --rm 127.0.0.1:5000/tinydemo:v1
hello from a private registry
```

Same digest after a full delete and re-pull. That is the whole product.

## A registry is just files on disk: the v2 API by hand

`curl` is a fine registry client, and walking the **v2 API** by hand is the
fastest way to see what it stores. First the catalog:

```bash
$ curl http://127.0.0.1:5000/v2/_catalog
{"repositories":["tinydemo"]}
```

Then a manifest. It needs an `Accept` header, and here modern Docker
hand-pushed me a lesson: my image was pushed as an OCI *index* (BuildKit adds
attestation manifests), so asking for the Docker v2 manifest type fails loudly:

```bash
$ curl -s -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    http://127.0.0.1:5000/v2/tinydemo/manifests/v1
{"errors":[{"code":"MANIFEST_UNKNOWN","message":"OCI index found, but accept header does not support OCI indexes"}]}
```

Ask for what is there — an OCI index — and the tag resolves to a list of
platform manifests:

```bash
$ curl -s -H 'Accept: application/vnd.oci.image.index.v1+json' \
    http://127.0.0.1:5000/v2/tinydemo/manifests/v1
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.index.v1+json",
  "manifests": [
    {
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "digest": "sha256:d03f8ed413b2575d6179ed6adffdd7ffb8591e77a221231b2394ff29f8bdb987",
      "size": 669,
      "platform": { "architecture": "amd64", "os": "linux" }
    },
    {
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "digest": "sha256:df5906856c1361fa64146d1f608cd3490f6f5560402eb42c789aba22d0f0d1f8",
      "size": 836,
      "annotations": { "vnd.docker.reference.type": "attestation-manifest" }
    }
  ]
}
```

Digests also address a manifest directly. This is what every image is: one
config blob plus a list of layer blobs:

```bash
$ curl -s -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    http://127.0.0.1:5000/v2/tinydemo/manifests/sha256:d03f8ed413b2575d6179ed6adffdd7ffb8591e77a221231b2394ff29f8bdb987
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.oci.image.config.v1+json",
    "digest": "sha256:4f0b7a7716fcdef4654b26d9af2b72eae84802e591c204bf7a84f7ecec6c3ace",
    "size": 1056
  },
  "layers": [
    { "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      "digest": "sha256:25f1d6b1951ac8eb3740558fe94cb83d377bdadf95fd9f98b50d2e1b96130471",
      "size": 3630321 },
    { "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      "digest": "sha256:2bc0aae784062adbc2ee3316342803159e3c931362853fee074c86d5196cbd1e",
      "size": 132 }
  ]
}
```

And `docker image inspect` shows the client-side view of the same object:

```bash
$ docker image inspect 127.0.0.1:5000/tinydemo:v1 --format \
    'Digest: {{.RepoDigests}}
ID: {{.Id}}
Size: {{.Size}} bytes
Arch: {{.Architecture}}/{{.Os}}'
Digest: [127.0.0.1:5000/tinydemo@sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6]
ID: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6
Size: 12110898 bytes
Arch: amd64/linux
```

Now the punchline: look at the volume. A registry is a directory of
content-addressed files plus a stack of tiny link files:

```bash
$ find /srv/registry/data/docker/registry/v2/repositories -type f
tinydemo/_manifests/tags/v1/current/link
tinydemo/_manifests/revisions/sha256/b7b67170.../link
tinydemo/_manifests/revisions/sha256/d03f8ed4.../link
tinydemo/_layers/sha256/25f1d6b1.../link
tinydemo/_layers/sha256/2bc0aae7.../link
...

$ cat .../repositories/tinydemo/_manifests/tags/v1/current/link
sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6
```

A tag is a text file containing a digest. Blobs live at
`blobs/sha256/<first two hex>/<digest>/data`, and the big one is exactly the
3,630,321-byte layer from the manifest:

```bash
$ ls -l .../blobs/sha256/25/25f1d6b1.../data
3630321 blobs/sha256/25/25f1d6b1.../data
```

Back up that directory and you have backed up the registry. There is no
database to dump.

## htpasswd: who is allowed to push

The registry above is wide open — anyone who can reach the port can push
images your CI will later run. The quickest lock is basic auth via htpasswd.
Generate a bcrypt entry from a throwaway container; I never install Apache on
the host:

```bash
$ docker run --rm --entrypoint htpasswd httpd:2.4 -Bbn demo s3cret
demo:$2y$05$2YDFo9tp3TwgSR.z4O...
```

Run a second registry with that file mounted and auth turned on:

```bash
docker run -d --name auth-registry -p 5001:5000 \
  -v /srv/registry/auth-data:/var/lib/registry \
  -v /srv/registry/htpasswd:/auth/htpasswd:ro \
  -e REGISTRY_AUTH=htpasswd \
  -e REGISTRY_AUTH_HTPASSWD_REALM=basic-realm \
  -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd \
  registry:2
```

Anonymous access dies at the door:

```bash
$ curl -sI http://127.0.0.1:5001/v2/
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Docker-Distribution-Api-Version: registry/2.0
```

`docker push` without credentials fails too — it cannot even resolve the
repository:

```bash
$ docker push 127.0.0.1:5001/tinydemo:v1
tag does not exist: 127.0.0.1:5001/tinydemo:v1
```

Log in and the same push goes through. Note Docker's own warning: basic-auth
credentials sit unencrypted in `~/.docker/config.json`, one more reason a
registry with auth belongs behind TLS:

```bash
$ docker login 127.0.0.1:5001 -u demo -p s3cret
WARNING! Using --password via the CLI is insecure. Use --password-stdin.
WARNING! Your credentials are stored unencrypted in '/home/awinx/.docker/config.json'.
Login Succeeded

$ docker push 127.0.0.1:5001/tinydemo:v1
The push refers to repository [127.0.0.1:5001/tinydemo]
2bc0aae78406: Pushed
44136fa355b3: Pushed
25f1d6b1951a: Pushed
0e8447578a07: Pushed
v1: digest: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6 size: 855
```

htpasswd basic auth is fine for a one-team registry. It is *not* what real
deployments run: production registries use **token auth**, where the registry
hands the client a JWT signed by a token server after the client
authenticates, so credentials are not replayed on every blob upload. When one
shared login stops being acceptable, move to registry middleware, a hosted
private registry, or Harbor.

## TLS: never plain HTTP past localhost

The daemon treats loopback registries (`127.0.0.1`, `localhost`) as implicitly
insecure: it falls back to plain HTTP and accepts self-signed certificates.
Anywhere else it insists on HTTPS. Take the plain-HTTP registry from earlier,
reached through its non-loopback bridge address `172.17.0.1:5000`:

```bash
$ docker push 172.17.0.1:5000/tinydemo:v1
failed to do request: Head "https://172.17.0.1:5000/v2/tinydemo/blobs/sha256:0e8447578a071c4873d45dcf9d8405abbe8cf27014df2ec12243717423667b99": EOF
```

The daemon dialed `https://` against an HTTP listener and the connection died.
The fix is TLS. A self-signed certificate is one openssl command:

```bash
$ openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
    -keyout domain.key -out domain.crt \
    -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"
$ openssl x509 -in domain.crt -noout -subject -dates
subject=CN=127.0.0.1
notBefore=Oct 14 04:40:39 2026 GMT
notAfter=Oct 16 04:40:39 2026 GMT
```

The registry serves it directly with two environment variables — its own logs
confirm TLS:

```bash
docker run -d --name tls-registry -p 5002:5000 \
  -v /srv/registry/tls:/certs:ro \
  -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/domain.crt \
  -e REGISTRY_HTTP_TLS_KEY=/certs/domain.key \
  registry:2
```

```
level=info msg="restricting TLS version to tls1.2 or higher" ... version=2.8.3
level=info msg="listening on [::]:5000, tls" ... version=2.8.3
```

curl refuses to trust a self-signed certificate until you hand it the CA file;
with `--cacert` (a self-signed cert is its own CA) the API answers:

```bash
$ curl --cacert domain.crt https://127.0.0.1:5002/v2/
{}

$ curl https://127.0.0.1:5002/v2/
curl: (60) SSL certificate OpenSSL verify result: self-signed certificate (18)
```

And docker, on loopback, accepts the same registry with no configuration at
all:

```bash
$ docker tag 127.0.0.1:5000/tinydemo:v1 127.0.0.1:5002/tinydemo:v1

$ docker push 127.0.0.1:5002/tinydemo:v1
The push refers to repository [127.0.0.1:5002/tinydemo]
2bc0aae78406: Pushed
44136fa355b3: Pushed
v1: digest: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6 size: 855
```

Convenient on a laptop — and exactly why it is not a production posture. To
pin down the boundary I issued a *second* self-signed certificate for the
bridge address and ran the identical registry there:

```bash
$ openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
    -keyout ext.key -out ext.crt \
    -subj "/CN=172.17.0.1" -addext "subjectAltName=IP:172.17.0.1"

docker run -d --name tls-registry-ext -p 172.17.0.1:5003:5000 \
  -v /srv/registry/tls:/certs:ro \
  -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/ext.crt \
  -e REGISTRY_HTTP_TLS_KEY=/certs/ext.key \
  registry:2
```

curl, given the CA file, is happy — the registry and certificate are fine:

```bash
$ curl --cacert ext.crt https://172.17.0.1:5003/v2/_catalog
{"repositories":[]}
```

The docker daemon is not. Same binary, same certificate, one hop off loopback:

```bash
$ docker push 172.17.0.1:5003/tinydemo:ext
failed to do request: Head "https://172.17.0.1:5003/v2/tinydemo/blobs/sha256:25f1d6b1951ac8eb3740558fe94cb83d377bdadf95fd9f98b50d2e1b96130471": EOF
```

The production answers, in order of preference:

1. **A real certificate.** Terminate TLS in front of the registry with nginx
   or Caddy using a certificate your clients already trust — a public CA if
   the registry is reachable, your internal PKI for a LAN.
2. **Distribute your CA to every client.** Put the CA file at
   `/etc/docker/certs.d/<host:port>/ca.crt` on every machine that pulls, then
   restart the daemon.
3. **`insecure-registries`** in `/etc/docker/daemon.json` — the documented
   escape hatch that allows plain HTTP to named hosts:

```json
{
  "insecure-registries": ["172.31.0.9:5000"]
}
```

Option 3 also disables certificate verification for that host, which is why
it belongs on a lab VLAN only: it turns "encrypted transport, questionable
certificate" into "cleartext with basic-auth credentials in it".

## Garbage collection: the tax nobody schedules

A registry grows forever if you let it. Two surprises every operator hits:

**One: `docker rmi` does not delete anything from the registry.** The client
removes its local copy; the server copy stays until you explicitly delete it.
For the experiment I pushed a second, slightly different build as `v2`, then
aimed the DELETE API at the v1 manifest — resolved from its
`Docker-Content-Digest` header, because a registry deletes by digest, never by
tag:

```bash
$ curl -sI -u demo:s3cret -H 'Accept: application/vnd.oci.image.index.v1+json' \
    http://127.0.0.1:5001/v2/tinydemo/manifests/v1 | grep -i docker-content-digest
Docker-Content-Digest: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6

$ curl -s -u demo:s3cret -X DELETE \
    http://127.0.0.1:5001/v2/tinydemo/manifests/sha256:b7b67170... -o /dev/null -w '%{http_code}\n'
405
```

405: deletion is disabled unless the registry starts with
`REGISTRY_STORAGE_DELETE_ENABLED=true`. After a restart with it enabled, the
same request is accepted and the tag disappears from the tag list:

```bash
$ curl -s -u demo:s3cret -X DELETE \
    http://127.0.0.1:5001/v2/tinydemo/manifests/sha256:b7b67170... -o /dev/null -w '%{http_code}\n'
202

$ curl -s -u demo:s3cret http://127.0.0.1:5001/v2/tinydemo/tags/list
{"name":"tinydemo","tags":["v2"]}
```

**Two: deleting a tag does not free the bytes.** Unlinking a manifest leaves
the blobs in place; only the garbage collector reclaims them. Its marking pass
shows what is still reachable:

```bash
$ docker exec auth-registry registry garbage-collect /etc/docker/registry/config.yml
tinydemo: marking manifest sha256:4ba92a42...
tinydemo: marking blob sha256:25f1d6b1...
...
```

On my registry the blob-file count went from 14 to 13, and the second pass
found nothing more to reclaim:

```
13 blobs marked, 0 blobs and 0 manifests eligible for deletion
```

Why the leftover: the deleted image's manifest *revisions* were still linked
under `_manifests/revisions`, and revisions keep their blobs reachable — run
the collector until it reports nothing eligible, which in practice means a
cron job, not a one-shot. The tempting `--delete-untagged` flag is a trap for
index-based images; I dry-ran it before trusting it:

```bash
$ docker exec auth-registry registry garbage-collect --delete-untagged --dry-run \
    /etc/docker/registry/config.yml
blob eligible for deletion: sha256:2306693e...
blob eligible for deletion: sha256:47c9af74...
blob eligible for deletion: sha256:1fadcff3...
```

Those are the *live* config and layer of the tagged v2 image — the child
manifests of a tagged OCI index look "untagged" to the collector. Running
that for real would have deleted an image I still serve. Dry-run everything.

## The honest ledger

Running `registry:2` is genuinely easy. The work is everything adjacent:

- **Backups.** The volume is the data. Copy it with restic or rsync, and
  rehearse a restore — I stole that rule wholesale from running my own Git
  server, where the [backups you have actually restored](/posts/self-hosted-git/)
  are the only ones that count.
- **GC on a schedule**, plus an eye on `du`. Storage growth is slow, silent,
  and always discovered at the worst moment.
- **Upgrades.** A stateful service with an API your tools speak: version it,
  snapshot the volume, read the changelog.
- **Access control is a project.** htpasswd is one shared login. Token auth,
  per-team permissions, scanning and image signing are separate systems — if
  those matter, look at Harbor or a hosted registry instead of DIY.

And the honest exit: for "somewhere private to push a side project's images",
a hosted private registry (GHCR, GitLab) costs nothing and comes with someone
else's uptime. If your images build reproducibly from Dockerfiles, a Git repo
plus CI may be the real registry you need — connecting the
[self-hosted Git server](/posts/self-hosted-git/) you may already run with the
build steps that produce the images. Self-host the registry when the images
themselves are the asset: too big to rebuild quickly, containing binaries you
cannot ship publicly, or needed in an air-gapped network.

If you do run one, the security conversation continues on the *other* side —
what is inside your base images matters as much as where they live; see
[container security](/posts/container-security/).

## Checklist I would hand a teammate

1. `registry:2` with a named volume; bind the port to a private interface.
2. TLS with a real certificate, or your CA distributed to every client.
3. Auth in front — htpasswd at minimum, token auth for more than one team.
4. `REGISTRY_STORAGE_DELETE_ENABLED=true`, GC on a cron, alerts on disk.
5. Back up the volume; test the restore.
6. Delete by digest, then GC, then verify with `/v2/_catalog`.

The registry is the rare self-hosted service where the honest risk is not the
software — it is the operational debt of owning storage. Treat that debt
deliberately and the private images are yours, cheaply and quietly.
