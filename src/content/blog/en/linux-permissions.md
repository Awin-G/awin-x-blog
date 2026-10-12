---
title: "Linux permissions cookbook: beyond rwx (chmod, umask, setfacl, setgid)"
description: "A hands-on Linux permissions guide with real terminal output: what rwx means for files versus directories, how umask sets default modes, setuid/setgid/sticky demos, ACLs and default ACLs with setfacl, the classic mistakes, and a security checklist."
pubDate: 2026-12-24
lang: en
translationKey: linux-permissions
tags: [linux, security]
featured: false
keywords:
  - Linux permissions
  - chmod
  - setfacl
  - umask
  - setgid
---

Permissions are the part of Linux I have explained the most, and gotten wrong the most. The `rwx` triad looks trivial until a service cannot read a file it obviously "owns", a shared directory keeps spawning files in the wrong group, or a `chmod -R 777` "fix" turns a webroot into an open write target. This is a **Linux permissions** cookbook: the mental model, the four tools that matter — `chmod`, `chown`/`chgrp`, `umask`, and `setfacl` — and real output from my own machine for every claim. The single-user examples run as a normal account on the host; the multi-user ones (setuid, setgid, sticky, ACL access) run in a throwaway container, so the `Permission denied` lines are genuine, not decorative. If you are hardening a box rather than debugging one, the [VPS hardening checklist](/posts/hardening-a-public-server/) and the [systemd sandboxing notes](/posts/systemd-hardening/) are the companions to this article.

## The Linux permissions model: files and directories are not the same

Every file carries three triples of bits: for the owner, the group, and everyone else ("other"). `stat` prints them both ways:

```text
$ stat -c "%A  %a  %n" file.txt dir .
-rw-r--r--  644  file.txt
drwxr-xr-x  755  dir
drwxr-xr-x  755  .
```

The `%A` column is symbolic; `%a` is octal. `644` is `rw- r-- r--`: the owner may read and write, the group and the world may only read. `755` is `rwx r-x r-x`. The trap is that `r`, `w`, and `x` mean different things on a directory:

<figure>
<svg viewBox="0 0 660 214" width="100%" role="img" aria-label="The same rwx bits mean different things for a regular file and for a directory. For a file, r reads contents, w writes contents, x executes. For a directory, r lists names, w creates or removes entries, x traverses to an entry.">
  <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
    <rect x="8" y="8" width="316" height="198" rx="10"/>
    <rect x="336" y="8" width="316" height="198" rx="10"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="14">
    <text x="28" y="34" font-weight="600">regular file</text>
    <text x="356" y="34" font-weight="600">directory</text>
    <g font-family="ui-monospace, monospace" font-size="15" opacity="0.9">
      <text x="28" y="72">r</text><text x="28" y="118">w</text><text x="28" y="164">x</text>
      <text x="356" y="72">r</text><text x="356" y="118">w</text><text x="356" y="164">x</text>
    </g>
    <g opacity="0.85">
      <text x="52" y="72">read its contents</text>
      <text x="52" y="118">write its contents</text>
      <text x="52" y="164">execute it</text>
      <text x="380" y="72">list the names inside</text>
      <text x="380" y="118">create / remove / rename entries</text>
      <text x="380" y="164">traverse to an entry</text>
    </g>
  </g>
</svg>
<figcaption>The same three bits, two very different meanings. On a directory, <code>x</code> is the one people forget — without it, <code>r</code> gives you names you cannot use.</figcaption>
</figure>

For a **file**, `x` means "this is executable". For a **directory**, `x` means "you may traverse into it" — open a known name, `stat` an entry, or `cd`. That distinction explains most permission bugs, and it also gives the rule everyone eventually has to learn:

> Deleting or renaming a file depends on the **write and execute bits of the directory**, not on the file's own permissions.

You can delete a read-only file if you have `wx` on its parent; you cannot delete a world-writable file if the parent does not allow it.

## What `x` on a directory really means

Here is a directory at mode `400` (`r--`) — readable, but no traverse:

```text
$ chmod 400 d1
$ ls d1            # r lets us read the list of names
file
$ ls -l d1         # -l needs stat() on each entry, which needs x
ls: cannot access 'd1/file': Permission denied
$ cat d1/file      # reaching the file needs x to traverse d1
cat: d1/file: Permission denied
$ cd d1
cd: d1: Permission denied
```

`ls` prints the name because reading a directory lists names, but every entry shows as `?????????` and nothing can be opened or entered. Now flip it to `100` (`--x`) — traverse without read:

```text
$ chmod 100 d1
$ ls d1            # x does NOT let us list
ls: cannot open directory 'd1': Permission denied
$ cat d1/file      # but a name we already know is reachable
topsecret
$ cd d1 && ls
ls: cannot open directory '.': Permission denied
```

So `r` without `x` gives you names you cannot use, and `x` without `r` gives you access to paths you cannot discover. Almost every web server runs this way: `nginx` needs `x` — not `r` — on the directories leading to a file.

## umask: where the default modes come from

New files and directories do not start at `777`. The kernel starts from a base — `666` for files, `777` for directories — and subtracts the **umask**:

```text
$ umask
0022
$ umask -S
u=rwx,g=rx,o=rx
```

`022` clears the group-write and other-write bits, which is why a `touch` produces `644` and a `mkdir` produces `755`. Change the umask and the defaults follow:

```text
$ (umask 027; touch f; mkdir d; stat -c '%A %a %n' f d)
-rw-r----- 640 f
drwxr-x--- 750 d
$ (umask 077; touch f; mkdir d; stat -c '%A %a %n' f d)
-rw------- 600 f
drwx------ 700 d
$ (umask 002; touch f; mkdir d; stat -c '%A %a %n' f d)
-rw-rw-r-- 664 f
drwxrwxr-x 775 d
```

`022` is the desktop default. `027` (`640`/`750`) is what I set on servers, because it keeps files readable by their group but closed to everyone else. `077` is for anything private. `002` is deliberate on some distributions so a shared group can collaborate, but it also means "other" can read. Set the umask in `/etc/profile` or on the systemd unit (`UMask=0027`) rather than in an interactive shell you will forget.

## chmod, chown, and chgrp in practice

`chmod` accepts symbolic and octal forms; symbolic is easier to review because it states the intent:

```text
$ chmod u+x report.sh;      stat -c '%A %a %n' report.sh
-rwxr--r-- 744 report.sh
$ chmod g-w,o-rwx report.sh; stat -c '%A %a %n' report.sh
-rwxr----- 740 report.sh
$ chmod a+r report.sh;      stat -c '%A %a %n' report.sh
-rwxr--r-- 744 report.sh
$ chmod 640 report.sh;      stat -c '%A %a %n' report.sh
-rw-r----- 640 report.sh
```

Ownership is separate from mode. `chgrp` moves a file to a group you belong to; changing the **owner** is root-only:

```text
$ chgrp video shared.txt
$ stat -c '%A %a %U:%G %n' shared.txt
-rw-r--r-- 644 awinx:video shared.txt
$ chown nobody shared.txt
chown: changing ownership of 'shared.txt': Operation not permitted
```

Inside a container running as root, the same `chown` succeeds — which is exactly why `chown` is a privilege boundary, and why `CAP_CHOWN` is worth keeping out of containers. `chmod --reference=other` and `find . -type d -exec chmod 755 {} +` are the two variants I reach for most.

## The special bits: setuid, setgid, and the sticky bit

Three bits sit above the usual nine, and each changes behaviour in one specific place. Everything in this section ran as root in a throwaway container, with users `alice` (1001), `bob` (1002), and `carol` (1003).

**setuid (`4`)** on an executable makes it run as the file's owner. A three-line C program proves it:

```text
$ chmod 4755 /vol/work/who
-rwsr-xr-x 4755 root:root /vol/work/who
$ su alice -c /vol/work/who
real uid=1001  effective uid=0
$ chmod 0755 /vol/work/who
$ su alice -c /vol/work/who
real uid=1001  effective uid=1001
```

`ls` shows `rws` — an `s` where the owner's `x` would be. This is how `passwd`, `sudo`, and `mount` do their job, and it is also the bit to audit: a setuid binary you did not install is a backdoor with a good alibi. On a directory, setuid is ignored on Linux.

**setgid (`2`)** on a *directory* fixes the classic shared-folder problem: files created inside inherit the directory's group instead of the creator's:

```text
$ chmod 2775 /vol/work/proj
drwxrwsr-x 2775 carol:dev /vol/work/proj
$ su alice -c "touch /vol/work/proj/alice.txt"
$ stat -c '%A %a %U:%G %n' /vol/work/proj/alice.txt
-rw-r--r-- 644 alice:dev /vol/work/proj/alice.txt
```

Alice's file is in group `dev`, not `alice`, because the setgid directory supplied it. Without setgid the same command produces `alice:alice` — the reason two people in a shared directory suddenly stop seeing each other's files. On an executable, setgid applies the same idea to the group that setuid applies to the owner.

**The sticky bit (`1`)** on a world-writable directory restricts who may delete entries: only the file's owner, the directory's owner, or root:

```text
$ stat -c '%A %a %U:%G %n' /vol/work/shared
drwxrwxrwt 1777 carol:carol /vol/work/shared
$ su bob -c "echo tampered >> /vol/work/shared/carol.txt"   # content write: allowed
$ su bob -c "rm /vol/work/shared/carol.txt"                  # delete: forbidden
rm: cannot remove '/vol/work/shared/carol.txt': Operation not permitted
```

Note what sticky does *not* do: it does not stop bob from rewriting the contents of a `666` file. It only stops him from removing or renaming the entry. That is why `/tmp` is `1777`, and why the setuid binaries on a normal box are worth listing:

```text
$ ls -ld /tmp
drwxrwxrwt 33 root root 2980 Oct 12 18:51 /tmp
$ find /usr/bin /bin -maxdepth 1 -perm -4000 -printf '%M %p\n' | head -4
-rwsr-xr-x /usr/bin/chsh
-rwsr-xr-x /usr/bin/umount
-rwsr-xr-x /usr/bin/passwd
-rwsr-xr-x /usr/bin/pkexec
```

## setfacl: ACLs when one group is not enough

Unix gives a file exactly one owner and one group. The moment you need "the `video` group *and* user 1001", you want an ACL. `setfacl` adds entries; `getfacl` shows them:

```text
$ stat -c '%A %a %U:%G %n' deploy.conf
-rw-r----- 640 awinx:video deploy.conf
$ setfacl -m u:1001:rw deploy.conf
$ getfacl deploy.conf
# file: deploy.conf
# owner: awinx
# group: video
user::rw-
user:1001:rw-
group::r--
mask::rw-
other::---
$ ls -l deploy.conf
-rw-rw----+ 1 awinx video 8 Oct 12 18:51 deploy.conf
```

The trailing `+` in `ls -l` is the tell that an ACL exists. The `mask::` line is the part people miss: it caps every named user, named group, and the owning group at once.

```text
$ setfacl -m m::r deploy.conf
$ getfacl -e deploy.conf
user::rw-
user:1001:rw-   #effective:r--
group::r--      #effective:r--
mask::r--
other::---
```

`-e` prints the *effective* rights after the mask. Plain `chmod` also rewrites the mask (not the named entries), which is a common source of "I set the ACL and then it stopped working". In the container, the ACL genuinely grants access to a user in no shared group:

```text
$ getfacl -c /vol/work/acl_demo
user::rw-
user:alice:rw-
group::r--
mask::rw-
other::---
$ su alice -c "echo hi-from-alice >> /vol/work/acl_demo"
$ su bob   -c "echo hi-from-bob >> /vol/work/acl_demo"
sh: 1: cannot create /vol/work/acl_demo: Permission denied
```

A **default ACL** (`setfacl -d`) makes new entries inside a directory inherit those permissions automatically — the clean way to build a drop box:

```text
$ setfacl -d -m u:1001:rwx -m g:video:rx shared
$ getfacl -p shared
user::rwx
group::r-x
other::r-x
default:user::rwx
default:user:1001:rwx
default:group::r-x
default:group:video:r-x
default:mask::rwx
default:other::r-x
$ touch shared/newfile
$ getfacl -p shared/newfile
user::rw-
user:1001:rwx   #effective:rw-
group::r-x      #effective:r--
mask::rw-
other::r--
```

The `default:` block is copied onto new files; the `#effective:` comments show the mask trimming each entry to what the creating program actually asked for. Default ACLs are how you grant a group access to a whole tree without ever touching the files individually — and because they are stored as an extended attribute, they are also easy to lose.

## The classic mistakes

**`chmod -R 777`.** It is the canonical bad fix. Recursively, it makes every file executable and every directory world-writable:

```text
$ chmod -R 777 app
drwxrwxrwx 777 app
-rwxrwxrwx 777 app/run.sh
-rwxrwxrwx 777 app/notes.txt
$ find app -perm -o+w -printf '%M %p\n'
drwxrwxrwx app
-rwxrwxrwx app/notes.txt
-rwxrwxrwx app/run.sh
```

Every regular file is now a script anyone can rewrite. Fix the real cause — a wrong owner, a missing group, one directory missing `x` — instead.

**World-writable files and directories.** `find / -xdev -type f -perm -0002` lists files anyone can rewrite; only a handful of intentional hits should ever appear. Run the same with `-o+w` for directories and you have the audit that matters.

**Missing `x` on a directory.** The reverse of the bug above: a file is `644` and readable, yet a service still gets `Permission denied` because a parent directory lacks `x`. Check the whole path at once with `namei -l /path/to/file`.

**ACLs that vanish on copy.** ACLs live in the `system.posix_acl_access` extended attribute, and plain `cp` does not preserve them:

```text
$ getfacl -c src.conf
user::rw-
user:1001:r--
group::r--
mask::r--
other::r--
$ cp src.conf dst.conf;      getfacl -c dst.conf
user::rw-
group::r--
other::r--
$ cp -a src.conf dst_a.conf; getfacl -c dst_a.conf
user::rw-
user:1001:r--
group::r--
mask::r--
other::r--
```

Use `cp -a` (or `--preserve=all`), `rsync -A`, and `tar --acls`. A backup that restores modes but drops ACLs hands you a "successful" restore that fails the same way next week.

## A permission checklist I actually run

- Set a server umask of `027` (`UMask=0027` in the unit), not `022`.
- Give a directory `x` if a process must traverse it; never "fix" a read error by adding `777`.
- For shared directories use `setgid` (`2775`) so the group sticks, and add the sticky bit (`1777`) if many users write there.
- Prefer `setfacl` over adding everyone to a group just to grant one file.
- Audit setuid with `find / -xdev -perm -4000 -type f`, and world-writable files with `find / -xdev -type f -perm -0002`.
- Preserve permissions and ACLs in copies and backups: `cp -a`, `rsync -A`, `tar --acls`.
- Re-check the whole path with `namei -l` before you blame the file.

Permissions are not decoration; they are the access-control layer under everything else. Get the model right — `r`/`w`/`x` on a directory, one group plus ACLs, the three special bits — and the rest of the system gets easier. The natural next step is putting them to work in a hardened service, which is where the [VPS hardening checklist](/posts/hardening-a-public-server/) and the [systemd sandboxing notes](/posts/systemd-hardening/) pick up.
