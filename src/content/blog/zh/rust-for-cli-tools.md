---
title: "用 Rust 写 CLI 工具：什么时候值得，什么时候一个 shell 脚本就够了"
description: "Rust 能给命令行工具带来单一静态二进制、无运行时、可预测的性能、强类型，以及 clap、anyhow、thiserror、serde、ignore 这样成熟的生态。但它也要付出构建时间、借用检查器的摩擦和更多仪式感的代价。这是我如何决定用 Rust、Python、Go，还是干脆写个 shell 脚本。"
pubDate: 2026-11-13
lang: zh
translationKey: rust-for-cli-tools
tags: [rust, devops]
featured: false
keywords:
  - Rust CLI
  - Rust vs Python
  - clap
  - 命令行工具
  - 单一二进制
---

每隔几个月，我就会发现自己伸手去 `cargo new`，只为了写一个十行 shell 脚本在第一
次 `cargo build` 跑完之前就能搞定的东西。而每隔几个月，我又会为一个「随手写写」的
工具写个 Python 脚本，结果发现要在一台没有 Python 的机器上运行它，或者要交付给一个
编译不了它的人。两个错误都是真的，而且指向相反的方向。这篇是我诚实的决策规则：一个
**Rust CLI** 什么时候配得上它的成本，什么时候一个 shell 脚本明摆着才是正确答案，以及
我维护的那些**命令行工具**实际落在这条线的哪一侧。

## 一个 Rust CLI 究竟给你带来了什么

当我真的选 Rust 时，很少是因为那些博客文章里列的理由。让我具体说说，对一个小组件而言
哪些好处是真的。

**一个静态二进制。** `cargo build --release` 产出一个文件，没有解释器、没有
virtualenv、没有共享库的意外。`scp` 到服务器，丢进 `/usr/local/bin`，完事。对我分发到
一台以上机器上的任何东西，这就是全部理由。对比一个 Python 工具，「在我机器上是好的」
会变成一个你永远得背着的打包问题。

**没有运行时，也没有预热。** 一个 Rust 二进制启动、干活、退出。没有解释器要启动，没有
模块导入要解析，没有 JIT 要预热。对于一个在循环里跑、作为 cron 任务跑、或者在 shell
管道里一天跑上千次的工具，这就是「一个感觉瞬间完成」的脚本和一个每次调用都悄悄加税的
脚本之间的差别。

**可预测的性能。** 没有垃圾回收器，就没有停顿的长尾。对 CLI 来说，这主要在你处理大输入
时才要紧——遍历一棵巨大的目录树、解析几个 GB 的日志——这时你想要的吞吐量不会随堆压力
波动。这不是关于打败 C，而是关于不要被惊到。

**强类型和穷尽的错误。** 编译器逼我处理 `Result`、匹配每一个枚举变体、对「什么可能失败」
保持诚实。对于一个会碰文件系统、网络或者其他进程的工具，这能在工具还从未运行之前，就
拦下一整类「happy path 在我笔记本上跑通了」的 bug。

### 真正的理由其实是生态（clap、anyhow、thiserror、serde、ignore）

说实话，库比语言本身更重要。撑起我每一个 CLI 的 crate：

- **[`clap`](https://docs.rs/clap)** —— 用 derive 宏做参数解析。子命令、标志、帮助文本
  和 shell 补全，全从一个 struct 定义里生成。
- **[`anyhow`](https://docs.rs/anyhow)** —— 应用代码里顺手的错误处理，你只想加上下文并
  往上抛。
- **[`thiserror`](https://docs.rs/thiserror)** —— 给库代码用的、带名字的类型化错误，调用
  方需要匹配「到底哪里出了错」。
- **[`serde`](https://serde.rs)** —— 读写 JSON、YAML、TOML，不用手搓解析器。
- **[`ignore`](https://docs.rs/ignore)** —— ripgrep 目录遍历背后的 crate：遵循
  `.gitignore`、处理并行、默认行为就是对的。

下面是我一个典型工具的依赖块：

```toml
# Cargo.toml
[package]
name = "scan"
version = "0.1.0"
edition = "2021"

[dependencies]
clap = { version = "4", features = ["derive"] }
anyhow = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
ignore = "0.4"
```

我只有在 crate 是个库、或者调用方需要区分错误种类时才加 `thiserror`；对一个纯应用来说，
`anyhow` 就够了，`thiserror` 是多余的仪式。

## 什么时候一个 shell 脚本就够了（而 Rust 是杀鸡用牛刀）

反方向的错误同样常见。只要程序小、单一用途、活得短，Rust 就是错的工具：

- **一个 20 行的脚本。** 如果一屏之内放得下、只干一件事，脚本写得更快、读起来更快，还
  不需要工具链。为了重命名几个文件就拉一个 `Cargo.toml` 进来，是纯成本、没有回报。
- **一次性的自动化。** 如果你只会跑一次——一次迁移、一次数据整备、一次清理——那类型带来
  的可维护性论据就蒸发了。没人会去维护一个你明天就删掉的脚本。
- **用完即弃的胶水。** 把三个现成工具在管道里缝起来的那种东西。`jq`、`awk` 和 `curl`
  已经存在了；用 Rust 去包一圈，等于用更慢的语言重新实现一个 shell。
- **任何本来就活在 shell 里的东西。** 如果这个工具的职责就是和其他工具组合——读 stdin、
  写 stdout、遵守退出码——那 shell 本来就是正确的运行时，它从来就不需要变成一个二进制。

我用来替代一个小小的 Rust 二进制的那类脚本：

```bash
#!/usr/bin/env bash
# 快速失败，变量未设置时如实报错。
set -euo pipefail

# 轮换超过 N 天的日志，并报告删了什么。
target="${1:?usage: rotate.sh <dir>}"
days="${DAYS:-14}"

find "$target" -type f -name '*.log' -mtime "+$days" -print -delete \
  | wc -l \
  | xargs -I{} echo "removed {} log files from $target"
```

任何人一眼就能看懂，在哪都能跑，而且我永远不用等它编译。

## 你实际签下的账单

Rust 不是免费的，诚实的推销必须点名这份账单。

**构建时间。** 一个带 `clap`、`serde` 和 `ignore` 的工具做一次全新的 release 构建，会拉进
一棵不小的依赖树，第一次 `cargo build` 是几十秒到几分钟的量级，而不是一瞬。增量构建很快，
但首次克隆和 CI 里你感觉得到。缓解办法是迭代时用 `cargo build`（debug），把 `--release`
留给你真正要发布的那份产物，再加上一个好用的 `sccache` 或增量配置。它仍然比 `chmod +x`
贵。

**借用检查器的摩擦。** 对一个 CLI 来说，大部分所有权上的痛苦都来自同一个地方：你想把一份
配置到处传，同时又改变状态。解法几乎总是把结构设计成配置只读、按引用分发。一旦你把这点
内化，小工具很少跟你较劲——但第一周，它会。

**仪式感。** `Cargo.toml`、`src/main.rs`、文件超过几百行后拆成模块、错误类型、放在
`tests/` 目录里的测试。对一个你要长期维护的东西，这套结构是资产；对一个你本会 `awk` 一下
就过的东西，它是纯粹的税。

## Rust vs Python（以及 Go、以及 shell）：一次公平的比较

有意思的维度不是语言偏好，而是「什么会先崩」。我从三个角度比较：启动、分发、可维护性。

### 启动时间

shell 脚本会 fork 它用到的工具，启动快，但一旦进入大循环干真活就慢——每个 `$(…)` 都要
spawn 一个进程。Python 每次调用都要付一次解释器启动的代价，交互式用没问题，在热循环里、
或者在一天跑上千次的管道里就很痛苦。Go 和 Rust 都作为编译好的二进制启动；对 CLI 工作
而言，你不会察觉到这两者之间的差别。Rust 相对 Python 的优势恰恰在「被频繁调用」的场景，
而不是「被人调用」的场景。

### 分发

shell 需要一个兼容的 shell，以及你调用过的那些工具。Python 需要一个解释器和通常一个依赖
管理器，而打包这桩事正是大家最后放弃的地方。Go 同样给你一个单一静态二进制，交叉编译还
出了名地简单。Rust 也给一个单一静态二进制，交叉编译比 Go 麻烦一些，但普通的 `--target`
构建覆盖了我大多数需求。对于「把这东西给一个用 macOS 的同事」，Go 和 Rust 都能终结这场
对话；Python 和 shell 会把它重新打开。

### 可维护性

这里按寿命分道扬镳。脚本在 50 行时是世上最好读的东西，到 500 行就成了负债。Python 写得
最快，只要你保持它小、稍微带点类型，就仍然好读。Go 以最好的方式无聊：简单、构建快、易读、
能作死的方式更少。Rust 前期要求最多——类型、生命周期、穷尽错误——并且会在那些要活好几年
的工具上连本带利地还回来，那时编译器就在替你做你已没时间做的评审。我的经验法则：**一个
工具活得越久、我越不会去看它，我就越想要 Rust 的编译器来检查我的活。**

## 一个完整的 clap CLI 骨架

下面是从头到尾的一整份，不含含糊。一个带两个子命令、类型化配置和诚实错误处理的工具。

```rust
// src/main.rs
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

/// Scan a directory tree and report on files.
#[derive(Parser, Debug)]
#[command(name = "scan", version, about)]
struct Cli {
    /// Directory to operate on.
    #[arg(short, long, default_value = ".")]
    path: PathBuf,

    /// Print more detail as we go.
    #[arg(short, long)]
    verbose: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Count files, honoring .gitignore.
    Count {
        /// Only count files with this extension.
        #[arg(long)]
        ext: Option<String>,
    },
    /// Print the absolute path of each match, one per line.
    List,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let path = cli
        .path
        .canonicalize()
        .with_context(|| format!("cannot resolve {}", cli.path.display()))?;

    match cli.command {
        Command::Count { ext } => {
            let mut n = 0usize;
            for entry in ignore::WalkBuilder::new(&path).build() {
                let entry = entry.context("failed to read directory entry")?;
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    continue;
                }
                if let Some(ref want) = ext {
                    if entry.path().extension().and_then(|e| e.to_str()) != Some(want.as_str()) {
                        continue;
                    }
                }
                n += 1;
            }
            if cli.verbose {
                eprintln!("scanned {}", path.display());
            }
            println!("{n}");
        }
        Command::List => {
            for entry in ignore::WalkBuilder::new(&path).build() {
                let entry = entry.context("failed to read directory entry")?;
                if entry.file_type().is_some_and(|t| t.is_file()) {
                    println!("{}", entry.path().display());
                }
            }
        }
    }

    Ok(())
}
```

构建并使用它：

```bash
cargo build --release
./target/release/scan --path ~/code count --ext rs
./target/release/scan list | head
```

有几点值得点出来，因为它们就是回报所在。`clap` 仅凭那个 struct 就生成了 `--help`、
`--version` 和参数校验——我一行 usage 字符串都没写。`anyhow::Context` 把每个可能失败的
调用变成一条用户能据此行动的信息。`ignore` 用一个 builder 就给了我遵循 `.gitignore` 的
遍历。而我 `scp` 到服务器上的那个二进制，没有 Python 的任何环境问题。

## 我的建议

用能撑过这份活的、最小的工具。

- **shell** —— 任何一屏就能写完的胶水、调用其他程序、或者跑完就扔的东西。优先伸手拿它，
  而不是把它当退路。
- **Python** —— 数据整备、快速分析，以及任何「生态（而不是运行时）才是重点」的场景——
  尤其当它会在你掌控的环境里从源码运行的时候。
- **Go** —— 当你想要一个二进制，同时要走阻力最小的路：构建快、语言简单、交叉编译轻松。
- **Rust** —— 当这个工具会活好几年、会作为二进制分发到你不拥有的机器上、会被频繁调用，
  或者会增长到超出「脚本还能保持可读」的规模。`clap` + `anyhow` + `serde` + `ignore`
  这套组合，正是我不断为 dotfiles 里和服务器上的工具选它的原因。

对我的决胜问题永远是同一个：**这东西会活得比写下它的那个下午更久吗？** 会，那 Rust 的前期
成本就是对可维护性的一笔首付。不会，那 shell 脚本就不是妥协——它就是正确答案。这种「只在
有回报时才买结构」的本能，贯穿我在别处挑选工具的方式：它是我让
[单人开发者的 Git 工作流](/zh/posts/git-for-solo-developers/)保持无聊的原因，也是我
[不用 Docker 自托管](/zh/posts/self-hosting-without-docker/)的原因。

先写脚本。然后，当你注意到自己每周都在打开同一个文件时，再用 Rust 重写它。
