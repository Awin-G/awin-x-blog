---
title: "Frida tutorial: dynamic instrumentation for mobile app testing"
description: "A hands-on Frida tutorial for mobile app testing: what dynamic instrumentation is, running frida-tools, attaching vs spawning, hooking with Interceptor.attach, Java.perform on Android, reading and writing memory, replacing return values, and how real apps push back."
pubDate: 2026-11-17
lang: en
translationKey: frida-basics
tags: [reverse-engineering, security]
featured: false
keywords:
  - Frida tutorial
  - dynamic instrumentation
  - Frida hooking
  - mobile app testing
  - Interceptor.attach
---

Static analysis tells you what a binary *could* do. **Dynamic instrumentation** tells
you what it actually does while it runs: which function gets called, with what
arguments, and what it hands back. Frida is the tool most people reach for first, and
this **Frida tutorial** is the starting point I wish I had — enough to attach to an app
on your own device, hook a function, read a return value, and understand why the
harder parts are hard.

One thing before any code. Frida is a legitimate tool with a narrow legitimate
scope: testing apps you own or are contracted to test, security review of software
you are authorised to review, and malware analysis inside a lab you control. I use it
on my own apps and on training targets. That boundary is not decoration — it is the
whole reason the rest of this article is allowed to exist.

> **Authorised use only.** Attach Frida to binaries you wrote, binaries you have
> written permission to test, or samples isolated in a lab VM/emulator with no real
> user data. Instrumenting someone else's app on a device you do not own is not
> "research" — it is unauthorised access. Check the terms and the law where you live
> before you run anything below.

## What Frida actually is

Frida is a **dynamic instrumentation** toolkit. At its core there is a small runtime —
`frida-server` on Android, `frida-gadget` when you embed it, `frida` on desktop — that
injects a JavaScript engine into a live process. Your script runs *inside* the target,
in the same address space, and can call APIs that hook native functions, inspect
memory, and reach into managed runtimes like ART on Android.

That "same process" detail is why Frida is so capable. You are not observing from the
outside like a packet capture; you are code living next to the code you are studying.

<figure>
<svg viewBox="0 0 620 210" width="100%" role="img" aria-label="A target app process contains the app code and an injected Frida agent. The agent sets a hook on a target function, so when the app calls it, control passes through the hook which can log arguments, modify them, or replace the return value before the app continues.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="20" y="30" width="300" height="150" rx="10"/>
    <rect x="360" y="30" width="240" height="150" rx="10"/>
    <rect x="45" y="60" width="120" height="40" rx="6"/>
    <rect x="190" y="60" width="110" height="40" rx="6"/>
    <rect x="45" y="125" width="255" height="38" rx="6"/>
    <rect x="385" y="60" width="190" height="34" rx="6"/>
    <rect x="385" y="125" width="190" height="38" rx="6"/>
    <path d="M300 80 H360"/>
    <path d="M165 80 H190"/>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none">
    <path d="M470 94 V125"/>
    <path d="M462 117 l8 8 l8 -8"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="170" y="50" text-anchor="middle">app process (PID)</text>
    <text x="480" y="50" text-anchor="middle">injected Frida agent</text>
    <text x="105" y="85" text-anchor="middle" opacity="0.85">app code</text>
    <text x="245" y="85" text-anchor="middle" opacity="0.85">target()</text>
    <text x="172" y="148" text-anchor="middle" opacity="0.85">Interceptor.attach(target, …)</text>
    <text x="480" y="82" text-anchor="middle" opacity="0.85">onEnter: log args</text>
    <text x="480" y="148" text-anchor="middle" opacity="0.85">onLeave: replace retval</text>
  </g>
</svg>
<figcaption>The agent is injected into the running process. A hook sits between the call site and the target function, so it sees arguments on entry and the return value on exit — and can change either.</figcaption>
</figure>

## Setting up frida-tools

Everything here is Python-driven on the host side. The client talks to a runtime on
the target, and on Android that runtime is `frida-server`, which you push to a rooted
device or an emulator.

```bash
# host: the CLI, the REPL, the Python bindings
python3 -m pip install --user frida-tools

# confirm both sides of the version line up
frida --version
```

On Android, match the `frida-server` architecture to the device (`arm64` for most
modern phones, `x86_64` for emulators) and run it as root:

```bash
# push the server for the device ABI and start it as root
adb push frida-server-16.x.y-android-arm64 /data/local/tmp/frida-server
adb shell "chmod 755 /data/local/tmp/frida-server"
adb shell "/data/local/tmp/frida-server &"

# confirm the client sees the device and its processes
frida-ps -U          # -U = USB device
frida-ps -Uai        # installed applications
```

`frida-ps -U` is your first sanity check: if it lists processes, the client, the USB
bridge, and the server on the device all agree with each other. If it hangs, you have
a version mismatch or the server is not running — fix that before writing any hooks.
On a non-rooted daily phone you will not get far, which is exactly why emulators and
test devices exist; keep instrumentation off the phone that holds your real accounts.

## Attach vs spawn

There are two ways to get your script into a process, and the difference matters.

- **Attach** to an app that is already running with `frida -U -n <name>`. Fast, but
  anything that ran during startup — certificate pinning setup, an anti-debug check,
  a key schedule — has already happened, so you may be too late to see it.
- **Spawn** a fresh process under Frida with `frida -U -f <package>`. The runtime
  pauses the app at entry, loads your script, then resumes it, so early logic is
  intercepted. This is the one to use for startup-time behaviour.

```bash
frida -U -f com.example.myapp -l hook.js --no-pause
frida -U -n MyApp -l hook.js        # attach to something already open
```

## Frida hooking: Interceptor.attach

The workhorse API is `Interceptor.attach`. It patches a function so your callbacks
fire on entry and exit. Start with something harmless in your own app — a function that
logs in the app you wrote.

```js
// hook.js — log the argument and swap the return value
const target = Module.getExportByName(null, "check_license");

Interceptor.attach(target, {
  onEnter(args) {
    this.arg0 = args[0].toInt32();        // capture before the call mutates it
    console.log("[*] check_license(" + this.arg0 + ")");
  },
  onLeave(retval) {
    console.log("[*] returned " + retval.toInt32());
    retval.replace(1);                    // pretend it succeeded
  },
});
```

Two details worth internalising. First, `onEnter` runs before the target body, so
`args[i]` is readable there but not in `onLeave` — stash what you need on `this`.
Second, `retval.replace(...)` only changes the value the *caller* sees; it does not
undo work the function already did. If a function wrote a file before returning, it
still wrote the file.

To find a symbol without a debugger attached, list what is exported:

```js
// discover candidate functions at runtime
Process.enumerateModules()
  .filter(m => m.name.includes("mylib"))
  .forEach(m => m.enumerateExports().forEach(e => console.log(e.name, e.address)));
```

## Reading and writing memory

Frida exposes raw memory through `Memory` and typed pointers. This is where dynamic
instrumentation stops feeling like logging and starts feeling like surgery.

```js
// read a C string, then a buffer, then patch a byte
const p = Module.getExportByName(null, "get_secret");
const fn = new NativeFunction(p, "pointer", []);
const s = fn().readUtf8String();
console.log("[*] secret = " + s);

// hexdump an arbitrary region
const buf = ptr("0x7f0000000000");           // your own process, your own address
console.log(hexdump(buf, { length: 64 }));

// patch: force a branch to always be taken
Memory.protect(buf, 4, "rwx");
buf.writeByteArray([0x01, 0x00, 0xa0, 0xe3]); // example: mov r0, #1
```

`NativeFunction` lets you call an existing function directly with typed arguments —
useful for re-running a routine with controlled inputs instead of triggering it
through the UI. Everything here is scoped to the process you injected into; you are
not scanning the whole machine, and on a modern OS you could not if you tried.

## Java.perform on Android

Native hooks cover C and C++. Most of an Android app's business logic lives in Java
or Kotlin on ART, and that is what `Java.perform` and `Java.use` are for.

```js
Java.perform(function () {
  const License = Java.use("com.example.myapp.License");

  License.isValid.implementation = function () {
    const real = this.isValid();               // call the original first
    console.log("[*] isValid() real = " + real);
    return true;                               // override for testing
  };

  // watch every call to a crypto helper
  const Cipher = Java.use("javax.crypto.Cipher");
  Cipher.doFinal.overload("[B").implementation = function (input) {
    console.log("[*] doFinal in: " + input.length + " bytes");
    return this.doFinal(input);
  };
});
```

`Java.use` gives you a wrapper whose methods you can replace with
`.implementation`. Note the pattern: call the original, log it, *then* decide what to
return. Logging the real value first is what makes the hook a measurement rather than
a lie.

### TLS pinning bypass as a testing example

The classic example everyone searches for is bypassing TLS certificate pinning on
your own app. The point of doing it is to read your *own* traffic through mitmproxy
while you debug a broken client — not to read someone else's. The shape is: find the
pinning check, hook it, and force it to pass.

```js
Java.perform(function () {
  // Common Android pinning helpers — hook the ones your app uses.
  try {
    const X509 = Java.use("com.android.org.conscrypt.TrustManagerImpl");
    X509.checkTrustedRecursive.implementation = function () {
      console.log("[*] pinning check reached — returning empty chain (test build)");
      return Java.use("java.util.ArrayList").$new();
    };
  } catch (e) {
    console.log("[-] trust manager not present: " + e);
  }
});
```

This only works because it is *your* app on *your* device. Pinning exists to stop a
network attacker from reading traffic; defeating it is a debugging convenience for
the person who already controls both endpoints, and an attack when you do not.

If you want the methodology around what you capture once pinning is out of the way,
that is a separate discipline — I wrote it up in
[reverse-engineering a private API](/posts/reverse-engineering-a-private-api/), and
the same "observe before you act" loop applies whether the app is HTTP or a
[serial protocol](/posts/decoding-a-serial-protocol/).

## How apps detect and resist

If you try this on anything real, expect a fight. Detection is layered, and each layer
has a cost for the developer too.

- **Root detection.** Apps check for `su`, Magisk, unlocked bootloaders, or run
  `SafetyNet`/`Play Integrity`. Your instrumented device often fails these checks
  before Frida is even involved.
- **Frida detection.** A process can look for the string `frida` in its memory map,
  scan for the default server port, or check loaded libraries. Renaming
  `frida-server` helps; it does not make you invisible.
- **Anti-debug.** `ptrace` guards, timing checks, and self-checks that verify a
  function's bytes are unchanged will all trip when a hook patches code.
- **Obfuscation.** R8/ProGuard renames, string encryption, and control-flow
  flattening mean there is no `checkLicense` symbol to hook. You get `a.b.c` and a
  decompiler that no longer type-checks.

## Where this leaves you

That is the honest starting point: install the tools, pick a test device, attach or
spawn, hook a function, read and write memory, and accept that real apps are built to
make all of it harder. Frida is a lens, not a crowbar.

The habit that keeps you useful — and out of trouble — is the same one from every
other kind of reverse engineering on this blog: stay inside the boundary of what you
own or are authorised to test, measure before you modify, and log the real value
before you replace it. Everything past this is depth, not a different tool.
