---
title: "Rust 所有权：用编译器自己的错误来教"
description: "通过真实的借用检查错误讲解 Rust 所有权：E0382 移动后使用、E0502 借用冲突、E0597 悬垂引用、E0106 缺少生命周期。所有错误信息均为 rustc 原样输出，附带可编译通过的修复方案。"
pubDate: 2027-01-02
lang: zh
translationKey: rust-ownership
tags: [rust]
featured: false
keywords:
  - Rust 所有权
  - 借用检查器
  - 生命周期
  - E0382
  - 移动语义
  - Rc
  - RefCell
---

Rust 所有权是唯一能区分「我写过 Rust」和「我理解 Rust」的概念。你可以靠模仿骗过语法，但**借用检查器**会找出你思维模型中的每一个漏洞——而且通常在你最不希望的时候，比如凌晨两点部署前的 `cargo build`。

我不再和编译器对抗，而是开始把它的错误信息当作教材来读。每一个 `error[E0xxxx]` 都是一堂关于 **Rust 所有权** 的课，由一位见过数千个初学者犯同样错误的人写成。这篇文章就是那份教材：三条规则、它们产生的错误、以及能编译通过的修复。

如果你想了解 Rust 的实际应用，请看
[阅读代码库](/zh/posts/reading-a-codebase/) 和
[Rust 写命令行工具](/zh/posts/rust-for-cli-tools/)。

## Rust 所有权的三条规则

一切都源于三条规则：

1. **每个值有且仅有一个所有者。** 一个 `String`、一个 `Vec`、一个文件句柄——在任意时刻，只有一个变量拥有它。
2. **移动即转移所有权。** 赋值或把值传给函数会移动它。旧的绑定就死了。
3. **值在其所有者离开作用域时被丢弃。** 没有垃圾回收器，没有手动 `free`。析构函数确定性地运行。

就这些。借用、生命周期和借用检查器都是这三条规则的必然结果。编译器不是在刁难你——它是在执行唯一能让规则 3 在没有 GC 的情况下安全的体系。

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240" role="img" aria-label="移动 vs 借用：所有权转移">
  <defs>
    <style>
      .box { fill: none; stroke: currentColor; stroke-width: 2; rx: 8; }
      .label { font-family: system-ui, sans-serif; font-size: 14px; fill: currentColor; }
      .code { font-family: ui-monospace, monospace; font-size: 13px; fill: currentColor; }
      .arrow { stroke: #0f766e; stroke-width: 2.5; fill: none; marker-end: url(#tealArrow); }
      .arrow-borrow { stroke: #0f766e; stroke-width: 2.5; fill: none; stroke-dasharray: 6 4; marker-end: url(#tealArrow); }
    </style>
    <marker id="tealArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="#0f766e" />
    </marker>
  </defs>
  <!-- Move -->
  <text x="160" y="28" text-anchor="middle" class="label" font-weight="bold">Move（转移）</text>
  <rect x="60" y="50" width="120" height="50" class="box" />
  <text x="120" y="80" text-anchor="middle" class="code">s1: String</text>
  <rect x="300" y="50" width="120" height="50" class="box" />
  <text x="360" y="80" text-anchor="middle" class="code">s2: String</text>
  <path d="M180,75 L290,75" class="arrow" />
  <text x="235" y="65" text-anchor="middle" class="label">s2 = s1</text>
  <text x="120" y="130" text-anchor="middle" class="label" opacity="0.5">s1 已死</text>
  <!-- Borrow -->
  <text x="480" y="28" text-anchor="middle" class="label" font-weight="bold">Borrow（引用）</text>
  <rect x="380" y="50" width="120" height="50" class="box" />
  <text x="440" y="80" text-anchor="middle" class="code">data: Vec</text>
  <rect x="380" y="150" width="120" height="50" class="box" />
  <text x="440" y="180" text-anchor="middle" class="code">first: &amp;T</text>
  <path d="M440,100 L440,140" class="arrow-borrow" />
  <text x="455" y="125" class="label">&amp;data[0]</text>
  <text x="440" y="225" text-anchor="middle" class="label">所有者不变</text>
</svg>
<figcaption>移动转移所有权（旧绑定死亡）；借用创建不转移所有权的引用。</figcaption>
</figure>

## 移动语义：E0382 移动后使用

下面是最简单的违反规则 2 的程序：

```rust
fn main() {
    let s1 = String::from("hello");
    let s2 = s1; // move: s1 不再有效
    println!("{s1}"); // ERROR: use of moved value
}
```

编译它，rustc 会精确地告诉你发生了什么：

```
error[E0382]: borrow of moved value: `s1`
 --> 01_use_after_move.rs:4:16
  |
2 |     let s1 = String::from("hello");
  |         -- move occurs because `s1` has type `String`, which does not implement the `Copy` trait
3 |     let s2 = s1; // move: s1 is no longer valid
  |              -- value moved here
4 |     println!("{s1}"); // ERROR: use of moved value
  |                ^^ value borrowed here after move
  |
  = note: this error originates in the macro `$crate::format_args_nl` which comes from the expansion of the macro `println` (in Nightly builds, run with -Z macro-back for more info)
help: consider cloning the value if the performance cost is acceptable
  |
3 |     let s2 = s1.clone(); // move: s1 is no longer valid
  |                ++++++++error: aborting due to 1 previous error

For more information about this error, try `rustc --explain E0382`.
```

编译器给出了错误代码（**E0382**）、指向精确的行、解释*为什么*会发生移动（`String` 没有实现 `Copy` trait），甚至建议了修复方案：`clone()`。这不是编译器在挑剔。这是编译器用二十行字教你**移动语义**。

当你确实需要两个值都有效时，修复方法是：

```rust
fn main() {
    let s1 = String::from("hello");
    let s2 = s1.clone(); // 深拷贝：s1 和 s2 都有效
    println!("{s1} {s2}");
}
```

输出：

```
hello hello
```

`clone()` 是逃逸舱，但它有代价：一次完整的堆分配和内存拷贝。当你需要两个独立的值时使用它，而不是把它当作条件反射。

## 借用与 E0502 冲突

借用让你无需获取所有权就能使用值。你得到一个引用（`&T` 共享，`&mut` 独占）。规则是：你可以有*任意数量*的共享借用*或*一个可变借用，但不能同时存在。

```rust
fn main() {
    let mut data = vec![1, 2, 3];
    let first = &data[0];      // 不可变借用开始
    data.push(4);              // ERROR: 不可变借用存活时可变借用
    println!("{first}");
}
```

编译器输出：

```
error[E0502]: cannot borrow `data` as mutable because it is also borrowed as immutable
 --> 02_borrow_conflict.rs:4:5
  |
3 |     let first = &data[0];      // immutable borrow starts
  |                  ---- immutable borrow occurs here
4 |     data.push(4);              // ERROR: mutable borrow while immutable is live
  |     ^^^^^^^^^^^^ mutable borrow occurs here
5 |     println!("{first}");
  |                ----- immutable borrow later used here

error: aborting due to 1 previous error

For more information about this error, try `rustc --explain E0502`.
```

**E0502** 是借用检查器最著名的错误。不可变借用 `first` 在第 5 行仍然存活，所以第 4 行的可变借用是非法的。编译器甚至告诉你不可变借用*稍后在哪里被使用*——这就是借用检查器跨行跟踪生命周期的能力。

修复方法通常是缩短借用的生命周期。把值拷贝出来，或者限制借用的作用域：

```rust
fn main() {
    let mut data = vec![1, 2, 3];
    let first = data[0]; // 拷贝值，而非借用
    data.push(4);
    println!("{first}");
}
```

输出：

```
1
```

## 生命周期：E0597 与 E0106

引用绝不能比它指向的数据活得更长。这就是**生命周期**所强制的。两个错误覆盖了几乎所有初学者会犯的错。

### 悬垂引用（E0597）

```rust
fn main() {
    let r;
    {
        let x = 5;
        r = &x; // ERROR: x does not live long enough
    }
    println!("{r}");
}
```

```
error[E0597]: `x` does not live long enough
 --> 03_dangling_ref.rs:5:13
  |
4 |         let x = 5;
  |             - binding `x` declared here
5 |         r = &x; // ERROR: x does not live long enough
  |             ^^ borrowed value does not live long enough
6 |     }
  |     - `x` dropped here while still borrowed
7 |     println!("{r}");
  |                - borrow later used here

error: aborting due to 1 previous error

For more information about this error, try `rustc --explain E0597`.
```

编译器向你展示了 `x` 被丢弃的确切作用域，以及借用被使用的位置。修复方法是让数据比引用活得更长：

```rust
fn main() {
    let x = 5;
    let r = &x; // x 现在活得足够长了
    println!("{r}");
}
```

输出：

```
5
```

### 返回局部变量的引用（E0106）

```rust
fn make_ref() -> &String {
    let s = String::from("local");
    &s // ERROR: cannot return reference to local variable
}

fn main() {
    let r = make_ref();
    println!("{r}");
}
```

```
error[E0106]: missing lifetime specifier
 --> 04_return_local_ref.rs:1:18
  |
1 | fn make_ref() -> &String {
  |                  ^ expected named lifetime parameter
  |
  = help: this function's return type contains a borrowed value, but there is no value for it to be borrowed from
help: consider using the `'static` lifetime, but this is uncommon unless you're returning a borrowed value from a `const` or a `static`
  |
1 | fn make_ref() -> &'static String {
  |                   +++++++
help: instead, you are more likely to want to return an owned value
  |
1 - fn make_ref() -> &String {
1 + fn make_ref() -> String {
  |

error: aborting due to 1 previous error

For more information about this error, try `rustc --explain E0106`.
```

当编译器无法确定引用应该活多久时，**E0106** 就会触发。这里的帮助文本异常出色：它建议了 `'static`（大概率是错的），然后建议返回一个有所有权的值（大概率是对的）。修复方法：

```rust
fn make_string() -> String {
    String::from("local") // 返回所有权，而非引用
}

fn main() {
    let r = make_string();
    println!("{r}");
}
```

输出：

```
local
```

### 多个引用，一个返回值

E0106 更难的版本是函数接收两个引用并返回其中一个时：

```rust
fn longest(x: &str, y: &str) -> &str {
    if x.len() > y.len() { x } else { y }
    // ERROR: missing lifetime specifier
}

fn main() {
    let s1 = String::from("long");
    let result;
    {
        let s2 = String::from("hi");
        result = longest(&s1, &s2);
    }
    println!("{result}");
}
```

```
error[E0106]: missing lifetime specifier
 --> 05_lifetime_annotation.rs:1:33
  |
1 | fn longest(x: &str, y: &str) -> &str {
  |               ----     ----     ^ expected named lifetime parameter
  |
  = help: this function's return type contains a borrowed value, but the signature does not say whether it is borrowed from `x` or `y`
help: consider introducing a named lifetime parameter
  |
1 | fn longest<'a>(x: &'a str, y: &'a str) -> &'a str;
  |           ++++     ++          ++          ++

error: aborting due to 1 previous error

For more information about this error, try `rustc --explain E0106`.
```

编译器直接替你写出了修复方案：`fn longest<'a>(x: &'a str, y: &'a str) -> &'a str`。`'a` 是一个**生命周期标注**——它表示「返回的引用的有效期与*两个*输入中较短的那个相同」。修复方法：

```rust
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}

fn main() {
    let s1 = String::from("long");
    let result;
    {
        let s2 = String::from("hi");
        result = longest(&s1, &s2);
        println!("{result}");
    }
}
```

输出：

```
long
```

## 为什么借用检查器是特性而非障碍

上面每个错误都是编译器在阻止一个在 C 或 C++ 中会成为安全漏洞的 bug：

- **E0382** 防止释放后使用。移动后的值已经不存在；使用它就是一个悬垂指针。
- **E0502** 防止数据竞争。在不可变借用存活时进行可变借用就是数据竞争。
- **E0597** 防止悬垂引用。数据已经被丢弃；引用会指向已释放的内存。
- **E0106** 防止返回指向已不存在的栈内存的指针。

借用检查器不是障碍。它是一个静态分析工具，在编译时、以零运行时成本证明你的程序没有数据竞争和释放后使用。有 GC 的语言通过暂停程序来获得安全。手动内存管理语言通过信任你来获得速度。Rust 通过让编译器检查人类最不擅长的事情——跟踪谁拥有什么、拥有多久——来同时获得两者。

## 逃逸舱及其代价

有时借用检查器是错的——不是因为规则不好，而是因为编译器无法证明你的设计是安全的。这时候你就需要逃逸舱。

### `clone()`

最简单的方案。付出深拷贝的代价，得到两个独立的值。代价：堆分配 + 内存拷贝。当拷贝代价很低或很少发生时用它。

### `Rc<RefCell<T>>` 共享所有权

当你代码的多个部分需要读写同一份数据时，`Rc`（引用计数）提供共享所有权，`RefCell` 提供内部可变性：

```rust
use std::cell::RefCell;
use std::rc::Rc;

fn main() {
    let shared = Rc::new(RefCell::new(vec![1, 2, 3]));
    let a = Rc::clone(&shared);
    let b = Rc::clone(&shared);

    a.borrow_mut().push(4);
    b.borrow_mut().push(5);

    println!("{:?}", shared.borrow());
}
```

输出：

```
[1, 2, 3, 4, 5]
```

代价：`Rc` 是运行时引用计数（非原子操作，但非线程安全）。`RefCell` 把借用检查推迟到运行时——如果另一个借用存活，`borrow_mut()` 会 panic。你用编译时错误换取了运行时 panic。在单线程共享修改场景下使用它，比如 GUI 树或游戏状态。

### `Arc<Mutex<T>>` 多线程

当你需要跨线程共享可变状态时，`Arc`（原子引用计数）替代 `Rc`，`Mutex` 替代 `RefCell`：

```rust
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    let counter = Arc::new(Mutex::new(0));
    let mut handles = vec![];

    for _ in 0..4 {
        let c = Arc::clone(&counter);
        handles.push(thread::spawn(move || {
            let mut num = c.lock().unwrap();
            *num += 1;
        }));
    }

    for h in handles {
        h.join().unwrap();
    }

    println!("count = {}", *counter.lock().unwrap());
}
```

输出：

```
count = 4
```

代价：`Arc` 使用原子操作（比 `Rc` 更昂贵）。`Mutex` 串行化访问——同一时间只有一个线程能持有锁。你用并行性换取了安全。当线程确实需要修改共享状态时使用它；否则，优先选择消息传递或不可变数据。

## 思维清单：谁拥有这个？

当借用检查器对我报错时，我会逐一检查：

1. **谁拥有这个值？** 一个变量。如果我要把它传给别人，是移动还是借用？
2. **这一行之后我还需要它吗？** 如果需要，我不能移动它。借用它，或克隆它。
3. **这个引用需要活多久？** 如果它比当前作用域活得更长，数据也必须如此——或者我需要返回一个有所有权的值。
4. **我需要共享可变吗？** 如果需要，单线程用 `Rc<RefCell<T>>`，多线程用 `Arc<Mutex<T>>`。如果不需要，普通引用更安全、更廉价。
5. **我在和编译器对抗吗？** 如果我加了三个 `clone()` 和一个 `RefCell`，我的设计大概率是错的。借用检查器通常是正确的。

借用检查器不是看门人。它是一个读过一百万遍 Rust 所有权规则的结对程序员，会在每一个违规变成生产事故之前捕获它。学会阅读它的错误——它们是语言中最好的文档。

## 编译器就是教材

这篇文章中的每一个错误都是由 `rustc` 1.93.1 在真实程序上产生的。没有修饰，没有改写。错误代码、帮助文本、建议的修复——全部原话。

这就是秘密所在：你不需要一本书来学 **Rust 所有权**。你需要一个编译器和阅读它告诉你的信息的耐心。错误就是课程。修复就是理解。下一次你再看到 `error[E0382]`，你就会知道编译器在试图教你什么。
