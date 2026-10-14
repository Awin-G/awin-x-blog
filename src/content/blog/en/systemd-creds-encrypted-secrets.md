---
title: "systemd-creds: pass secrets to services without putting them on disk"
description: "systemd-creds encrypts a secret to the host (or TPM) so only systemd can decrypt it at service start. LoadCredentialEncrypted= hands it to the service via a tmpfs $CREDENTIALS_DIRECTORY — no plaintext on disk, no env var in /proc. Real output, honest limits."
pubDate: 2027-02-09
lang: en
translationKey: systemd-creds-encrypted-secrets
tags: [systemd, security]
featured: false
keywords:
  - systemd-creds
  - LoadCredential
  - service secrets
  - CREDENTIALS_DIRECTORY
  - TPM
---

I run a handful of self-hosted services, and every one of them needs a
password, a token, or a key. The usual ways of getting a secret into a service
are all quietly bad: an environment variable that shows up in
`/proc/<pid>/environ` for any local process to read, a plaintext file that sits
on the disk until the backup tarball carries it off, or a `docker inspect`
that prints the whole environment in cleartext. I covered the broader secrets
landscape — sops, age, dotenv, rotation — in
[secrets management](/posts/secrets-management/); here I want the piece that
is native to systemd and needs no external tool: **systemd-creds** and the
`LoadCredential=` family.

The idea is small but changes the threat model. You encrypt a secret **to the
host** (or to its TPM), and only the systemd instance that owns that host can
decrypt it. At service start, systemd decrypts the blob and drops the
plaintext into a private tmpfs that only that service can read. The plaintext
never touches the real disk, never becomes an environment variable, and never
survives the service restart. This post is the unit-cookbook companion piece
to [systemd-unit-cookbook](/posts/systemd-unit-cookbook/); I focus on the
credential machinery and show real output from my own box.

## The problem: env vars, files, and `docker inspect`

Before the fix, the failures. A service reads its secret from an environment
variable. Any local process — including another user's script, or an agent I
pointed at the box — can read that variable:

```console
$ tr '\0' '\n' < /proc/<pid>/environ | grep -i token
TOKEN=supersecret
```

No special privilege needed: `/proc/<pid>/environ` is world-readable for
same-user processes and the kernel does not hide it. With a **file**, the
secret lands on the real filesystem with whatever mode I remembered to set,
and it stays there — in the backup, in the accident, in the `cat` I ran while
debugging. With **Docker**, `docker inspect` happily prints every env var in
clear:

```console
$ docker inspect --format='{{json .Config.Env}}' myapp
["TOKEN=supersecret","PATH=/usr/bin"]
```

(That last block is illustrative formatting of the shape of the leak, not
output I captured here — I ran the `/proc` and systemd-creds commands on my
box, and I'll label the few things I could not run.)

## What systemd-creds actually is

`systemd-creds` is a small CLI that encrypts and decrypts **credentials**. An
encrypted credential is a self-describing blob: it carries the credential
name, an optional timestamp and expiry, and a ciphertext that is bound to a
key. The key is one of:

- `host` — a per-host secret at `/var/lib/systemd/credential.secret`, generated
  once by `systemd-creds setup` (root-only). Only this host's systemd can
  decrypt.
- `tpm2` — sealed to the TPM's PCRs, so it only decrypts on the same
  booted firmware+kernel. Stronger than the host key.
- `host+tpm2` — both, for defense in depth.
- `null` — no key at all. Works anywhere, provides **no** confidentiality. The
  tool warns you loudly.

The build I have includes TPM2 support:

```console
$ systemd-creds --version
systemd 262 (262-1-arch)
+PAM +AUDIT -SELINUX +APPARMOR ... +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD ...
```

## What I could and could not encrypt (real output)

I tried the encrypt paths on my dev box, unprivileged, and here is exactly
what happened. The **default** (`--with-key=auto`, which prefers the host
key) fails because there is no host key and the system credential service
cannot be reached from a container:

```console
$ systemd-creds encrypt --name=demo secret.txt demo.cred
Failed to encrypt: io.systemd.System

$ systemd-creds encrypt --with-key=host --name=demo secret.txt demo-host.cred
Failed to encrypt: org.varlink.service.PermissionDenied

$ systemd-creds encrypt --with-key=tpm2 --name=demo secret.txt demo-tpm.cred
Failed to encrypt: io.systemd.System

$ ls /var/lib/systemd/credential.secret
ls: cannot access '/var/lib/systemd/credential.secret': No such file or directory

$ systemd-creds setup
Failed to setup credentials host key: Permission denied
```

The TPM paths need the system credential service and a usable TPM attestation
that this container does not have, even though the device nodes exist
(`/dev/tpm0`, `/dev/tpmrm0`). So **system-scope host and TPM encryption are
the things I could not run unprivileged** — on a real VPS with systemd as PID 1
and `sudo systemd-creds setup` run once, `--with-key=host` and
`--with-key=host+tpm2` are what you would use.

Two paths **did** work. The `null` key encrypts anywhere (with a loud warning
that it provides no confidentiality), and the **user-scoped** host key works
because my user manager is running:

```console
$ systemd-creds encrypt --with-key=null --name=demo secret.txt demo-null.cred
Using a null key for encryption and signing. Confidentiality or authenticity will not be provided.

$ systemd-creds encrypt --user --with-key=host --name=demo secret.txt demo-user.cred
(no output; exit 0)
```

The user-scoped path is the one I could test end to end, and it is also the
right model for a self-hosted box where the service runs under your own user
manager rather than as root.

## The encrypted blob is not the plaintext

The credential file is base64-encoded ciphertext — `file` calls it ASCII text,
and the bytes are obviously not the secret:

```console
$ file demo-null.cred demo-user.cred
demo-null.cred: ASCII text
demo-user.cred: ASCII text

$ xxd demo-user.cred
00000000: 4b68 2b48 656b 4a31 5178 717a 2b65 3066  Kh+HekJ1Qxqz+e0f
00000010: 5859 396d 4153 4141 4141 4142 4141 4141  XY9mASAAAAABAAAA
00000020: 4441 4141 4142 4141 4141 426a 6c55 7a56  DAAAABAAAABjlUzV
00000030: 5336 3758 3741 7631 4b63 4941 4141 4141  S67X7Av1KcIAAAAA
```

No `hunter2` in sight. The plaintext is sealed inside.

## The round-trip: a `--user` unit with `LoadCredentialEncrypted=`

Here is the part that matters. I wrote a tiny user service that loads the
encrypted credential and copies it out so I can prove the content survived
the decrypt:

```ini
[Service]
ExecStart=/bin/sh -c 'cp "$CREDENTIALS_DIRECTORY/demo" /tmp/opencode/work/systemd-creds/cred-dump.bin; echo "copied; src size=$(wc -c < "$CREDENTIALS_DIRECTORY/demo")"'
LoadCredentialEncrypted=demo:/tmp/opencode/work/systemd-creds/demo-user.cred
```

Reload and start it:

```console
$ systemctl --user daemon-reload && systemctl --user start creds-demo.service
(exit 0)

$ journalctl --user -u creds-demo.service --no-pager
systemd[905]: Starting creds-demo.service...
systemd[905]: Started creds-demo.service.
sh[1266628]: copied; src size=20
```

The service ran. The user manager decrypted the blob at start and placed the
plaintext at `$CREDENTIALS_DIRECTORY/demo`. The directory itself is the whole
security story:

```console
$ systemctl --user show creds-demo.service -p LoadCredentialEncrypted
LoadCredentialEncrypted=[unprintable]

$ findmnt -T /run/user/1000/credentials -o TARGET,FSTYPE,OPTIONS
/run/user/1000  tmpfs  rw,nosuid,nodev,relatime,...,mode=700,uid=1000,gid=1000,...
```

`$CREDENTIALS_DIRECTORY` was `/run/user/1000/credentials/creds-demo.service` —
a private tmpfs, mode 700, owned by my user, and the encrypted value is masked
as `[unprintable]` in `systemctl show`. The copied-out content is exactly what
I encrypted:

```console
$ xxd cred-dump.bin
00000000: 6875 6e74 6572 322d 6465 6d6f 2d73 6563  hunter2-demo-sec
00000010: 7265 740a                                ret.
```

`hunter2-demo-secret` — 20 bytes, round-tripped through the host key. For
contrast, the **unencrypted** `LoadCredential=plain:/path/secret.txt` also
works (it served `correct horse battery staple`), but that reads the plaintext
file straight off the disk, so the secret is on the real filesystem the whole
time. The encrypted variant is the one that keeps the plaintext off disk.

I verified the unit is well-formed before trusting it:

```console
$ systemd-analyze verify ~/.config/systemd/user/creds-demo.service
(exit 0; no diagnostics)
```

One honest gap: the standalone `systemd-creds decrypt` CLI did **not** round-trip
in my environment. System-scope decrypt failed with `io.systemd.System`, and
user-scope decrypt rejected the filename (`Name in credential doesn't match
expectations`) because the CLI wants the output filename to match the embedded
credential name. So I proved decryption through the path that actually matters
in production — the manager decrypting at service start — rather than through
the ad-hoc CLI. On a normal host the CLI works; I just could not exercise it
here.

<figure>
<svg viewBox="0 0 900 250" width="100%" role="img" aria-label="A plaintext secret file is encrypted with systemd-creds into a base64 ciphertext blob bound to the host key; at service start systemd decrypts the blob and places the plaintext into a private tmpfs mounted at CREDENTIALS_DIRECTORY that only the service can read; the plaintext never touches the real disk.">
  <defs>
    <marker id="sc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="8" y="14">your terminal</text>
    <text x="330" y="14">systemd-creds encrypt</text>
    <text x="660" y="14">at service start</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="12">
    <rect x="8" y="40" width="180" height="70" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="20" y="66" font-family="ui-monospace, monospace" font-size="11">secret.txt</text>
    <text x="20" y="86" font-family="ui-monospace, monospace" font-size="10" opacity="0.7">hunter2-demo-secret</text>
    <text x="20" y="104" font-size="10" opacity="0.6">plaintext, on disk</text>
    <line x1="196" y1="75" x2="320" y2="75" stroke="#0f766e" stroke-width="1.5" marker-end="url(#sc-arrow)"/>
    <rect x="330" y="40" width="200" height="70" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="342" y="66" font-family="ui-monospace, monospace" font-size="11">demo.cred</text>
    <text x="342" y="86" font-family="ui-monospace, monospace" font-size="9" opacity="0.7">Kh+HekJ1Qxqz+e0f…</text>
    <text x="342" y="104" font-size="10" opacity="0.6">bound to host / TPM key</text>
    <line x1="538" y1="75" x2="650" y2="75" stroke="#0f766e" stroke-width="1.5" marker-end="url(#sc-arrow)"/>
    <rect x="660" y="40" width="220" height="70" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="672" y="66" font-family="ui-monospace, monospace" font-size="11">$CREDENTIALS_DIRECTORY</text>
    <text x="672" y="86" font-family="ui-monospace, monospace" font-size="10" opacity="0.7">/run/user/1000/credentials/…</text>
    <text x="672" y="104" font-size="10" opacity="0.6">private tmpfs, mode 700</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="10" opacity="0.65">
    <text x="330" y="150">systemd decrypts with the host key (or TPM) — only this host, only at start.</text>
    <text x="330" y="168">Plaintext never touches the real disk, never becomes an env var, never reaches /proc.</text>
    <text x="330" y="186">Gone when the service stops. Rotate by re-encrypting and restarting.</text>
  </g>
</svg>
<figcaption>Encrypted credential in, tmpfs secret out. The plaintext exists only inside the per-service credentials tmpfs, which systemd mounts and unmounts around the service's lifetime.</figcaption>
</figure>

## The units: `LoadCredential=`, `LoadCredentialEncrypted=`, `SetCredential=`

Three directives cover the space, and the differences are the whole point:

- **`LoadCredential=name:path`** — loads a plaintext file from `path` into
  `$CREDENTIALS_DIRECTORY/name`. The file stays on disk the whole time. Fine
  for a config file, not for a secret you want off the disk.
- **`LoadCredentialEncrypted=name:path`** — decrypts the blob at start (host /
  TPM key) and serves the plaintext the same way. This is the one that removes
  the on-disk plaintext.
- **`SetCredentialEncrypted=name:value`** — same decryption, but the blob is
  inlined in the unit or a drop-in `.conf`, so you don't manage a separate
  file. (The sibling `SetCredential=` is the plaintext inlined form.)

The service reads the secret the same way regardless of which directive you
used — it just opens `$CREDENTIALS_DIRECTORY/name`:

```ini
[Service]
ExecStart=/usr/bin/myapp --token-file=%d/token
```

`%d` is the systemd specifier for the credentials directory. Because the
directory is a private tmpfs, the file is readable only by the service's user
and is gone on stop. `systemd-creds list` confirms the model — a shell with no
service credentials sees nothing:

```console
$ systemd-creds list
No credentials passed. (i.e. $CREDENTIALS_DIRECTORY not set.)
```

## How it compares to the alternatives

I use sops + age for secrets in git and Vault-style stores for bigger setups
(see [secrets management](/posts/secrets-management/)). systemd-creds is not a
replacement for those; it is the last mile. The comparison that matters for a
small self-hosted box:

- **Plain env var** — leaks via `/proc/<pid>/environ` and `docker inspect`.
  Rejected for anything real.
- **Root-owned file, mode 0400** — better than an env var: not in `/proc`, not
  in `docker inspect`. But it sits on the real disk, so it rides along in
  backups, and any root process (or the backup job) can read it. It is the
  floor, not the ceiling.
- **secrets manager (Vault / sops / age)** — the right answer when you need
  rotation, audit, and multi-host distribution. Overkill and a new failure mode
  when you have three secrets and one host. sops/age get secrets *into* the
  host; systemd-creds gets them *into the service* without a plaintext stop.
- **systemd-creds** — the native last mile. No new daemon, no network, no
  external store. The secret is encrypted at rest on the host and decrypted
  only by systemd at start, into a tmpfs only the service can read.

The honest way to say it: a secrets manager shrinks *who can read the secret
at rest and in git*; systemd-creds shrinks *where the plaintext ever exists
at runtime*. They compose — sops/age delivers the encrypted blob to the
host, `LoadCredentialEncrypted=` delivers it to the service.

## The honest limits

- **Host-bound means no portable.** A credential encrypted to `--with-key=host`
  only decrypts on the machine whose `/var/lib/systemd/credential.secret`
  sealed it. Move the file to another host and it is dead ciphertext. For a
  single VPS that is a feature (stolen backup is useless off-host); for a
  migratory container it is a non-starter. This is the main reason it is not a
  secrets-manager replacement.
- **TPM is stronger than the host key.** `--with-key=tpm2` seals to the PCRs,
  so the blob only decrypts on the same booted firmware + kernel. If you can
  use it, do — but it is exactly the path I could not exercise in a container,
  and it ties the secret to one machine's boot state.
- **It does not protect against root.** Root can read the host key, can attach
  to the service before it chroots, and can read the tmpfs while the service
  runs. systemd-creds shrinks the *disk* and *proc* leak surface; it is not a
  root boundary. The threat model here is "secret on disk / in env / in a
  backup", not "root is malicious".
- **The `null` key is not encryption.** It is a portable envelope with no
  confidentiality — useful for testing the plumbing, never for a real secret.

## A practical recipe for a small self-hosted service

Putting it together, the setup I would actually ship on a single host:

1. **Generate the host key once** (root, one time):
   ```console
   $ sudo systemd-creds setup
   ```
   On systemd 256+ the user manager can also scope a key per user
   (`systemd-creds encrypt --user --with-key=host …`), which is what I tested
   here because I ran unprivileged.
2. **Encrypt the secret to the host (or TPM):**
   ```console
   $ systemd-creds encrypt --with-key=host+tpm2 --name=token secret.txt token.cred
   ```
   Keep `token.cred` on disk — it is ciphertext. Delete the plaintext
   `secret.txt` when you are done.
3. **Wire the unit** to load it and point the app at the credentials dir:
   ```ini
   [Service]
   ExecStart=/usr/bin/myapp --token-file=%d/token
   LoadCredentialEncrypted=token:/etc/myapp/token.cred
   ```
4. **Verify and start:**
   ```console
   $ systemd-analyze verify /etc/systemd/system/myapp.service
   $ systemctl daemon-reload && systemctl restart myapp
   ```
5. **Rotate** by re-encrypting and restarting. The old plaintext is never on
   disk, so rotation is just a new blob and a reload.

That is the whole system. No agent, no sidecar, no external store — the
plaintext exists for the few milliseconds systemd needs to mount the tmpfs,
and then it is only reachable by the process that is supposed to have it.

## What I could not run here

To keep this honest: the **system-scope** `--with-key=host` and `--with-key=tpm2`
encryption failed in my container (no host key, no system credential service),
so I demonstrated the **user-scoped** host-key path instead, which is also the
correct model for a self-hosted box running services under your own user
manager. I also could not complete the standalone `systemd-creds decrypt` CLI
round-trip here; I proved decryption through `LoadCredentialEncrypted=` at
service start, which is the real use case anyway. On a normal host with
systemd as PID 1 and `sudo systemd-creds setup` run once, the system-scope
paths work as documented.
