---
title: "Rust ownership, taught by the compiler's own errors"
description: "Rust ownership explained through real borrow-checker errors: E0382 use-after-move, E0502 borrow conflicts, E0597 dangling references, E0106 missing lifetimes. Every error message pasted verbatim from rustc, with the fix that compiles."
pubDate: 2027-01-02
lang: en
translationKey: rust-ownership
tags: [rust]
featured: false
keywords:
  - Rust ownership
  - borrow checker
  - lifetimes
  - E0382
  - move semantics
  - Rc
  - RefCell
---

Rust ownership is the one concept that separates "I've written Rust" from "I understand
Rust." You can fake your way through syntax, but the **borrow checker** will find every
gap in your mental model — usually at the worst possible moment, like a `cargo build` at
2 a.m. before a deploy.

I stopped fighting the compiler and started reading its error messages as a curriculum.
Every `error[E0xxxx]` is a lesson in **Rust ownership**, written by someone who has seen
thousands of beginners make the same mistake. This post is that curriculum: the three
rules, the errors they produce, and the fixes that compile.

If you want the practical side of Rust after this, see
[Reading a codebase](/posts/reading-a-codebase/) and
[Rust for CLI tools](/posts/rust-for-cli-tools/).

## The three rules of Rust ownership

Everything falls out of three rules:

1. **Each value has exactly one owner.** A `String`, a `Vec`, a file handle — one variable
   owns it at any given moment.
2. **Moving transfers ownership.** Assigning or passing a value to a function moves it.
   The old binding is dead.
3. **A value is dropped when its owner goes out of scope.** No garbage collector, no
   manual `free`. The destructor runs deterministically.

That's it. Borrowing, lifetimes, and the borrow checker are all consequences of these
three rules. The compiler isn't being difficult — it's enforcing the only system that
makes rule 3 safe without a GC.

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240" role="img" aria-label="Move vs borrow: ownership transfer">
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
  <text x="160" y="28" text-anchor="middle" class="label" font-weight="bold">Move (transfer)</text>
  <rect x="60" y="50" width="120" height="50" class="box" />
  <text x="120" y="80" text-anchor="middle" class="code">s1: String</text>
  <rect x="300" y="50" width="120" height="50" class="box" />
  <text x="360" y="80" text-anchor="middle" class="code">s2: String</text>
  <path d="M180,75 L290,75" class="arrow" />
  <text x="235" y="65" text-anchor="middle" class="label">s2 = s1</text>
  <text x="120" y="130" text-anchor="middle" class="label" opacity="0.5">s1 is dead</text>
  <!-- Borrow -->
  <text x="480" y="28" text-anchor="middle" class="label" font-weight="bold">Borrow (reference)</text>
  <rect x="380" y="50" width="120" height="50" class="box" />
  <text x="440" y="80" text-anchor="middle" class="code">data: Vec</text>
  <rect x="380" y="150" width="120" height="50" class="box" />
  <text x="440" y="180" text-anchor="middle" class="code">first: &amp;T</text>
  <path d="M440,100 L440,140" class="arrow-borrow" />
  <text x="455" y="125" class="label">&amp;data[0]</text>
  <text x="440" y="225" text-anchor="middle" class="label">owner unchanged</text>
</svg>
<figcaption>Move transfers ownership (the old binding dies); borrowing creates a reference that does not transfer ownership.</figcaption>
</figure>

## Move semantics: the E0382 use-after-move

Here's the simplest program that breaks rule 2:

```rust
fn main() {
    let s1 = String::from("hello");
    let s2 = s1; // move: s1 is no longer valid
    println!("{s1}"); // ERROR: use of moved value
}
```

Compile it and rustc tells you exactly what happened:

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

The compiler names the error code (**E0382**), points to the exact line, explains *why*
the move happened (`String` does not implement `Copy`), and even suggests the fix:
`clone()`. This is not a compiler being pedantic. This is a compiler teaching you
**move semantics** in twenty lines.

The fix, when you genuinely need both values:

```rust
fn main() {
    let s1 = String::from("hello");
    let s2 = s1.clone(); // deep copy: both s1 and s2 are valid
    println!("{s1} {s2}");
}
```

Output:

```
hello hello
```

`clone()` is the escape hatch, but it has a cost: a full heap allocation and memcpy. Use
it when you need two independent values, not as a reflex.

## Borrowing and the E0502 conflict

Borrowing lets you use a value without taking ownership. You get a reference (`&T` for
shared, `&mut T` for exclusive). The rule: you can have *either* any number of shared
borrows *or* one mutable borrow, never both at once.

```rust
fn main() {
    let mut data = vec![1, 2, 3];
    let first = &data[0];      // immutable borrow starts
    data.push(4);              // ERROR: mutable borrow while immutable is live
    println!("{first}");
}
```

The compiler output:

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

**E0502** is the borrow checker's most famous hit. The immutable borrow `first` is still
live on line 5, so the mutable borrow on line 4 is illegal. The compiler even tells you
where the immutable borrow is *later used* — that's the borrow checker tracking liveness
across lines.

The fix is usually to shorten the borrow's lifetime. Copy the value out, or scope the
borrow:

```rust
fn main() {
    let mut data = vec![1, 2, 3];
    let first = data[0]; // copy the value, not a borrow
    data.push(4);
    println!("{first}");
}
```

Output:

```
1
```

## Lifetimes: E0597 and E0106

A reference must never outlive the data it points to. That's what **lifetimes** enforce.
Two errors cover almost every beginner mistake.

### Dangling reference (E0597)

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

The compiler shows you the exact scope where `x` is dropped and where the borrow is used.
The fix is to make the data outlive the reference:

```rust
fn main() {
    let x = 5;
    let r = &x; // x lives long enough now
    println!("{r}");
}
```

Output:

```
5
```

### Returning a reference to a local (E0106)

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

**E0106** fires when the compiler can't tell how long a reference should live. The help
text is unusually good here: it suggests `'static` (probably wrong) and then suggests
returning an owned value (probably right). The fix:

```rust
fn make_string() -> String {
    String::from("local") // return ownership, not a reference
}

fn main() {
    let r = make_string();
    println!("{r}");
}
```

Output:

```
local
```

### Multiple references, one return value

The harder version of E0106 is when a function takes two references and returns one:

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
1 | fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
  |           ++++     ++          ++          ++

error: aborting due to 1 previous error

For more information about this error, try `rustc --explain E0106`.
```

The compiler literally writes the fix for you: `fn longest<'a>(x: &'a str, y: &'a str) -> &'a str`.
The `'a` is a **lifetime annotation** — it says "the returned reference is valid for as
long as *both* inputs are valid." The fix:

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

Output:

```
long
```

## Why the borrow checker is a feature

Every error above is the compiler preventing a bug that would be a security vulnerability
in C or C++:

- **E0382** prevents use-after-free. The moved-from value is gone; using it would be a
  dangling pointer.
- **E0502** prevents data races. A mutable borrow while an immutable borrow is live is a
  data race waiting to happen.
- **E0597** prevents dangling references. The data is dropped; the reference would point
  to freed memory.
- **E0106** prevents returning pointers to stack memory that no longer exists.

The borrow checker is not an obstacle. It is a static analysis tool that proves your
program has no data races and no use-after-free — at compile time, with zero runtime
cost. Languages with a GC get safety by pausing your program. Languages with manual
memory management get speed by trusting you. Rust gets both by making the compiler
check the one thing humans are bad at: tracking who owns what, and for how long.

## The escape hatches and their costs

Sometimes the borrow checker is wrong — not because the rules are bad, but because the
compiler can't prove your design is safe. That's when you reach for the escape hatches.

### `clone()`

The simplest. Pay for a deep copy, get two independent values. Cost: heap allocation +
memcpy. Use it when the copy is cheap or rare.

### `Rc<RefCell<T>>` for shared ownership

When multiple parts of your code need to read *and* write the same data, `Rc` (reference
counting) gives shared ownership and `RefCell` gives interior mutability:

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

Output:

```
[1, 2, 3, 4, 5]
```

Cost: `Rc` is a runtime reference count (atomic-free, but not thread-safe). `RefCell`
moves the borrow check to runtime — `borrow_mut()` will panic if another borrow is live.
You trade a compile-time error for a runtime panic. Use it for single-threaded shared
mutation, like a GUI tree or a game state.

### `Arc<Mutex<T>>` for threads

When you need shared mutation across threads, `Arc` (atomic reference counting) replaces
`Rc` and `Mutex` replaces `RefCell`:

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

Output:

```
count = 4
```

Cost: `Arc` uses atomic operations (more expensive than `Rc`). `Mutex` serializes
access — only one thread can hold the lock at a time. You trade parallelism for safety.
Use it when threads genuinely need to mutate shared state; otherwise, prefer message
passing or immutable data.

## A mental checklist: who owns this?

When the borrow checker yells at me, I run through this checklist:

1. **Who owns this value?** One variable. If I'm passing it somewhere, am I moving it or
   borrowing it?
2. **Do I need it after this line?** If yes, I can't move it. Borrow it, or clone it.
3. **How long does this reference need to live?** If it outlives the current scope, the
   data must too — or I need to return an owned value instead.
4. **Do I need shared mutation?** If yes, `Rc<RefCell<T>>` for one thread,
   `Arc<Mutex<T>>` for many. If no, plain references are cheaper and safer.
5. **Am I fighting the compiler?** If I've added three `clone()` calls and a `RefCell`,
   my design is probably wrong. The borrow checker is usually right.

The borrow checker is not a gatekeeper. It's a pair programmer who has read the Rust
ownership rules a million times and will catch every violation before it becomes a
production incident. Learn to read its errors — they're the best documentation in the
language.

## The compiler is the curriculum

Every error in this post was produced by `rustc` 1.93.1 on a real program. No
embellishment, no paraphrasing. The error codes, the help text, the suggested fixes —
all verbatim.

That's the secret: you don't need a book to learn **Rust ownership**. You need a
compiler and the patience to read what it's telling you. The errors are the lessons.
The fixes are the understanding. And the next time you see `error[E0382]`, you'll know
exactly what the compiler is trying to teach you.
