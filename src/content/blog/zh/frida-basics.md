---
title: "Frida 教程：面向移动应用测试的动态插桩入门"
description: "一份动手向的 Frida 教程：动态插桩是什么，安装 frida-tools，attach 与 spawn 的区别，用 Interceptor.attach 挂钩，Android 上的 Java.perform，读写内存，替换返回值，以及真实应用如何检测与对抗。"
pubDate: 2026-11-17
lang: zh
translationKey: frida-basics
tags: [reverse-engineering, security]
featured: false
keywords:
  - Frida 教程
  - 动态插桩
  - Frida 挂钩
  - 移动应用测试
  - Interceptor.attach
---

静态分析告诉你一个二进制*可能*做什么，**动态插桩**告诉你它运行时*实际*做了什么：
哪个函数被调用、参数是什么、返回了什么。Frida 是大多数人第一个拿起的工具，而这篇
**Frida 教程**就是我希望当初能有人给我的起点——足够让你在自己的设备上 attach 上一个
应用、挂上一个函数、读回一个返回值，并理解为什么更难的部分就是难。

在写任何代码之前先说一句。Frida 是一个正当工具，但适用范围很窄：测试你自己拥有或
受委托测试的应用、对你有权审查的软件做安全评估，以及在你可控的实验室里做恶意软件
分析。我在自己的应用和训练靶标上用它。这条边界不是装饰——它是这篇文章其余部分得以
存在的根本原因。

> **仅限授权使用。** 只对你编写的二进制、你获得书面许可去测试的二进制，或隔离在没有任何
> 真实用户数据的实验虚拟机/模拟器里的样本使用 Frida。在没有授权的设备上对别人的应用做
> 插桩，不是「研究」，而是未授权访问。运行下面任何内容之前，先确认当地法律与相关条款。

## Frida 到底是什么

Frida 是一套**动态插桩**工具包。它的核心是一个小运行时——Android 上的
`frida-server`、嵌入时用的 `frida-gadget`、桌面上的 `frida`——它把一个 JavaScript
引擎注入到运行中的进程里。你的脚本运行在*目标内部*，处于同一地址空间，可以调用各种
API 去挂钩原生函数、检查内存，并深入到 Android 上像 ART 这样的托管运行时里。

「同一进程」这个细节，正是 Frida 如此强大的原因。你不是像抓包那样从外部观察；你是
活在你要研究的代码旁边的代码。

<figure>
<svg viewBox="0 0 620 210" width="100%" role="img" aria-label="目标应用进程内包含应用代码和注入的 Frida agent。agent 在目标函数上设置挂钩，因此当应用调用它时，控制流会经过挂钩，挂钩可以记录参数、修改参数，或在应用继续之前替换返回值。">
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
    <text x="170" y="50" text-anchor="middle">应用进程（PID）</text>
    <text x="480" y="50" text-anchor="middle">注入的 Frida agent</text>
    <text x="105" y="85" text-anchor="middle" opacity="0.85">应用代码</text>
    <text x="245" y="85" text-anchor="middle" opacity="0.85">target()</text>
    <text x="172" y="148" text-anchor="middle" opacity="0.85">Interceptor.attach(target, …)</text>
    <text x="480" y="82" text-anchor="middle" opacity="0.85">onEnter：记录参数</text>
    <text x="480" y="148" text-anchor="middle" opacity="0.85">onLeave：替换返回值</text>
  </g>
</svg>
<figcaption>agent 被注入到运行中的进程里。挂钩位于调用点与目标函数之间，因此在进入时能看到参数、在返回时能看到返回值——并且可以修改任意一方。</figcaption>
</figure>

## 安装 frida-tools

主机这一侧的一切都由 Python 驱动。客户端与目标上的运行时通信，而在 Android 上，
这个运行时就是 `frida-server`，你要把它推送到已 root 的设备或模拟器上。

```bash
# 主机：CLI、REPL 与 Python 绑定
python3 -m pip install --user frida-tools

# 确认两端版本对得上
frida --version
```

在 Android 上，让 `frida-server` 的架构与设备匹配（多数现代手机是 `arm64`，模拟器是
`x86_64`），并以 root 身份运行它：

```bash
# 推送对应设备 ABI 的 server，并以 root 启动
adb push frida-server-16.x.y-android-arm64 /data/local/tmp/frida-server
adb shell "chmod 755 /data/local/tmp/frida-server"
adb shell "/data/local/tmp/frida-server &"

# 确认客户端能看到设备及其进程
frida-ps -U          # -U = USB 设备
frida-ps -Uai        # 已安装的应用
```

`frida-ps -U` 是你的第一个健康检查：如果它能列出进程，说明客户端、USB 桥接和
设备上的 server 三者互相认可。如果卡住，要么是版本不匹配，要么是 server 没在跑
——先把这些修好，再写任何挂钩。在未 root 的日常手机上你走不了多远，这正是模拟器
和测试机存在的理由；别把插桩对准存着你真实账号的那台手机。

## attach 还是 spawn

把脚本注入进程有两种方式，区别很重要。

- **Attach** 到一个已在运行的应用：`frida -U -n <name>`。很快，但任何在启动期间就
  执行过的东西——证书固定（pinning）的设置、反调试检查、密钥编排——都已经发生过了，
  你可能来不及看到。 
- **Spawn** 一个由 Frida 全新拉起的进程：`frida -U -f <package>`。运行时会在入口处
  暂停应用、加载你的脚本，然后恢复它，因此早期逻辑会被拦下。要看启动期行为，就用它。

```bash
frida -U -f com.example.myapp -l hook.js --no-pause
frida -U -n MyApp -l hook.js        # attach 到一个已经打开的应用
```

## Frida 挂钩：Interceptor.attach

主力 API 是 `Interceptor.attach`。它会修补一个函数，让你的回调在进入与退出时触发。
先从你自己应用里某个无害的函数开始——一个你在自己写的应用里打的日志函数。

```js
// hook.js —— 记录参数并替换返回值
const target = Module.getExportByName(null, "check_license");

Interceptor.attach(target, {
  onEnter(args) {
    this.arg0 = args[0].toInt32();        // 在调用改变它之前先捕获
    console.log("[*] check_license(" + this.arg0 + ")");
  },
  onLeave(retval) {
    console.log("[*] 返回 " + retval.toInt32());
    retval.replace(1);                    // 假装成功了
  },
});
```

两个值得记牢的细节。其一，`onEnter` 在目标函数体之前运行，所以 `args[i]` 在那里可读，
在 `onLeave` 里不可读——你需要的东西先存到 `this` 上。其二，`retval.replace(...)`
只改变*调用方*看到的值，它不会撤销函数已经做过的事。如果一个函数在返回前写了文件，
那文件还是被写了。

要在没挂调试器的情况下找一个符号，可以把导出的东西列出来：

```js
// 在运行时发现候选函数
Process.enumerateModules()
  .filter(m => m.name.includes("mylib"))
  .forEach(m => m.enumerateExports().forEach(e => console.log(e.name, e.address)));
```

## 读写内存

Frida 通过 `Memory` 和有类型的指针暴露原始内存。从这里开始，动态插桩不再像记日志，
而开始像做手术。

```js
// 读一个 C 字符串，再读一段缓冲区，然后修补一个字节
const p = Module.getExportByName(null, "get_secret");
const fn = new NativeFunction(p, "pointer", []);
const s = fn().readUtf8String();
console.log("[*] secret = " + s);

// 十六进制转储任意区域
const buf = ptr("0x7f0000000000");           // 你自己的进程，你自己的地址
console.log(hexdump(buf, { length: 64 }));

// 修补：强制某个分支永远被走到
Memory.protect(buf, 4, "rwx");
buf.writeByteArray([0x01, 0x00, 0xa0, 0xe3]); // 示例：mov r0, #1
```

`NativeFunction` 让你用有类型的参数直接调用一个已存在的函数——当你想用受控输入重跑
某个例程，而不是通过界面去触发它时，这很有用。这里的一切都限定在你注入的那个进程内；
你不是在扫描整台机器，而且在现代操作系统上，就算你想也做不到。

## Android 上的 Java.perform

原生挂钩覆盖 C 和 C++。Android 应用的大部分业务逻辑跑在 ART 上的 Java 或 Kotlin 里，
这正是 `Java.perform` 与 `Java.use` 的用武之地。

```js
Java.perform(function () {
  const License = Java.use("com.example.myapp.License");

  License.isValid.implementation = function () {
    const real = this.isValid();               // 先调用原始实现
    console.log("[*] isValid() 真实返回 = " + real);
    return true;                               // 测试时覆盖
  };

  // 观察对某个加密辅助函数的每一次调用
  const Cipher = Java.use("javax.crypto.Cipher");
  Cipher.doFinal.overload("[B").implementation = function (input) {
    console.log("[*] doFinal 输入：" + input.length + " 字节");
    return this.doFinal(input);
  };
});
```

`Java.use` 给你一个包装器，其中的方法可以用 `.implementation` 替换。注意这个模式：
先调用原始实现、先记录、*然后*再决定返回什么。先记录真实值，才能让挂钩是一次测量，
而不是一句谎言。

### 作为测试示例的 TLS pinning 绕过

大家都在搜的经典例子，是在你自己的应用上绕过 TLS 证书固定。做这件事的意义，是在
调试一个坏掉的客户端时，用 mitmproxy 读懂*你自己*的流量——而不是去读别人的。形态
就是：找到固定检查、挂上它、强制它通过。

```js
Java.perform(function () {
  // 常见的 Android 固定检查辅助类——挂上你的应用实际用的那个。
  try {
    const X509 = Java.use("com.android.org.conscrypt.TrustManagerImpl");
    X509.checkTrustedRecursive.implementation = function () {
      console.log("[*] 已到达固定检查——返回空链（测试构建）");
      return Java.use("java.util.ArrayList").$new();
    };
  } catch (e) {
    console.log("[-] 未找到该 trust manager：" + e);
  }
});
```

它能成立，只因为这是*你的*应用在*你的*设备上。证书固定存在的意义，是阻止网络攻击者
读取流量；绕过它是给那个已经同时控制两端的人提供的调试便利，而当你不控制这两端时，
它就是攻击。

固定检查一旦被绕过，接下来怎么处理抓到的流量，是另一套方法论——我写在
[逆向一个私有 API](/zh/posts/reverse-engineering-a-private-api/) 里了。无论目标是
HTTP 应用还是[串口协议](/zh/posts/decoding-a-serial-protocol/)，那套「先观察再动手」
的循环都同样适用。

## 应用如何检测与对抗

如果你真拿它去对付一个真实应用，就要做好打一架的准备。检测是分层的，而每一层对
开发者来说也都有代价。

- **Root 检测。** 应用会检查 `su`、Magisk、解锁的 bootloader，或者跑
  `SafetyNet`/`Play Integrity`。你插桩过的设备常常在 Frida 还没登场前就没通过这些检查。
- **Frida 检测。** 进程可以在自己的内存映射里找 `frida` 字符串、扫描默认的 server 端口，
  或检查已加载的库。改个 `frida-server` 的名字有帮助，但它不会让你隐形。
- **反调试。** `ptrace` 防护、时序检查，以及验证某函数字节未被改动的自校验，都会在
  挂钩修补代码时被触发。
- **混淆。** R8/ProGuard 重命名、字符串加密、控制流平坦化，意味着根本没有
  `checkLicense` 这样的符号可挂。你拿到的是 `a.b.c`，以及一个再也过不了类型检查的
  反编译器。

## 读完这些，你处在哪

这就是诚实的起点：装好工具、挑一台测试设备、attach 或 spawn、挂一个函数、读写内存，
并接受真实应用的存在就是为了让这一切更难。Frida 是一面透镜，不是一根撬棍。

让自己始终有用——并且不惹麻烦——的习惯，和本博客其他所有逆向文章里的一样：待在你
拥有或获授权测试的边界之内，修改前先测量，替换前先记录真实值。这之后的一切都是深度，
而不是另一件工具。
