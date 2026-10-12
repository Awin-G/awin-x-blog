---
title: "A practical regex tutorial: regular expressions without the fear"
description: "A practical regex tutorial that makes regular expressions click: the mental model, the atoms, capture groups and greedy vs lazy quantifiers, alternation and precedence, word boundaries in real patterns, why catastrophic backtracking happens, and how to test regex examples against real inputs."
pubDate: 2026-12-05
lang: en
translationKey: regex-in-practice
tags: [linux, devops]
featured: false
keywords:
  - regex tutorial
  - regular expressions
  - regex examples
  - catastrophic backtracking
  - capture group
---

I have watched teammates copy a regex out of a ticket, change one character, and pray. I have done it too. But regular expressions are not a language you have to learn like C or Python — they are a tiny pattern-matcher with about a dozen moving parts. Once you see those parts, the fear mostly goes away, and what is left is a very good tool for finding and reshaping text.

This is a practical **regex tutorial**: the mental model, the atoms, the traps, and the **regex examples** I actually reach for. Every output below is real — I ran it in Python 3 and with `grep -P` in the same shell, and pasted what came back. If you want the same "read the real output, don't guess" habit for code, it pairs well with [how I read a codebase](/posts/reading-a-codebase/) and [writing a README](/posts/writing-a-readme/) — both are exercises in noticing exactly what is on the page.

## A regex is a pattern-matcher, not a language

The single biggest shift is this: a regex describes a *shape* of text, and the engine slides that shape along your input looking for a place where it fits. It is not a program with loops and variables. It is a stencil.

Most confusion comes from forgetting this and reading a regex left-to-right like a story. The engine does not read it like a story. It tries to match at the first character, and if that fails, at the second, and so on — unless you anchor it. Keep the stencil picture in your head and everything below is just "how do I describe a bigger shape."

One trick that makes new patterns readable: say the regex out loud, in plain words, left to right. `\d{4}-\d{2}-\d{2}` is "four digits, a dash, two digits, a dash, two digits." If you cannot say it cleanly, the regex is probably doing too much at once, and splitting it into two smaller patterns will be easier to debug. Regexes compose badly; short ones compose beautifully.

It is also worth knowing that "regex" is not one thing. Python, Perl, PCRE (which `grep -P` uses), JavaScript, and Go all speak dialects that agree on the basics and disagree on the edges — lookbehind, named-group syntax, and how `.` treats newlines are the usual splits. So when a pattern that worked in the language you know fails in another, check the dialect before you doubt yourself.

## The atoms: literals, `.`, classes, anchors, quantifiers

Literals match themselves. `.` matches any single character (except a newline by default). A character class `[...]` matches one character from a set. Anchors do not consume anything — they assert *position*.

```text
$ python3 -c 'import re; print(re.findall(r"\d+", "order 42 shipped 2026-12-05"))'
['42', '2026', '12', '05']
```

`\d` is shorthand for `[0-9]`, and `+` means "one or more." Quantifiers are where people first guess wrong, because they are **greedy** by default — they take as much as possible, then give back only if forced.

```text
$ python3 -c 'import re; print(re.findall(r"colou?r", "color colour"))'
['color', 'colour']
```

`?` means "zero or one," which is how you write optional letters. Anchors `^` and `$` match the start and end of a line (or the whole string — see the trap below).

## Groups and captures

Parentheses do two jobs: group a sub-pattern, and *capture* it so you can read it back. Captures are numbered left to right starting at 1; `group(0)` is always the whole match. Named groups are almost always worth it in real code, because `group("year")` survives edits and `group(3)` does not.

```text
$ python3 -c 'import re; m=re.search(r"(\d{4})-(\d{2})-(\d{2})", "date 2026-12-05 ok"); print(m.group(0), m.group(1), m.group(2), m.group(3))'
2026-12-05 2026 12 05

$ python3 -c 'import re; m=re.search(r"(?P<y>\d{4})-(?P<m>\d{2})", "2026-12-05"); print(m.group("y"), m.group("m"))'
2026 12
```

A backreference matches *the same text a group matched before*, which is perfect for finding repeated words. `\1` refers to group 1:

```text
$ python3 -c 'import re; print(re.findall(r"(\w+)\s+\1", "the the cat sat sat down"))'
['the', 'sat']
```

Use backreferences sparingly — they are usually a sign you could solve the problem in two passes — but they are the clean tool for "same word twice."

## Alternation and precedence

`|` means "or," and it binds loosely. `cat|dog` matches `cat` or `dog`. The classic mistake is forgetting that alternation stops at the smallest thing that makes sense, so you must parenthesise when you want to share context:

```text
$ python3 -c 'import re; print(re.findall(r"gr(a|e)y", "gray grey"))'
['a', 'e']
```

That returns the captured letter, not `gray`/`grey`, because `findall` returns groups when they exist. The trap is `^cat|dog$`: it does *not* mean "a whole line that is cat or dog." It means "starts with cat, OR ends with dog."

```text
$ python3 -c 'import re; print(re.search(r"^(cat|dog)$", "catfish"))'
None
```

Grouping the alternation is what makes the anchors apply to both branches.

## The four things that trip everyone up

### Greedy `.*` vs lazy `.*?`

`. *` grabs everything to the end of the line, then walks back only as far as it must. On a string with two tags, that is not what you want:

```text
$ python3 -c 'import re; s="<b>bold</b> and <b>more</b>"; print(re.search(r"<b>.*</b>", s).group(0))'
<b>bold</b> and <b>more</b>
$ python3 -c 'import re; s="<b>bold</b> and <b>more</b>"; print(re.search(r"<b>.*?</b>", s).group(0))'
<b>bold</b>
```

Adding `?` after a quantifier makes it **lazy**: it takes as little as possible. Greedy vs lazy is the single most common source of "it matched too much."

### `^` and `$` change meaning with a flag

By default `^` is "start of the string," not "start of every line." Turn on multiline mode and it becomes per-line:

```text
$ python3 -c 'import re; print(re.findall(r"^\w+", "first line\nsecond line"))'
['first']
$ python3 -c 'import re; print(re.findall(r"^\w+", "first line\nsecond line", re.M))'
['first', 'second']
```

Same for `$`. When a regex works on one line and mysteriously fails on a file, this flag is your first suspect.

### Escaping

`.` means "any character," so a literal dot needs a backslash. Metacharacters — `. * + ? ( ) [ ] { } | ^ $ \` — all need escaping when you mean them literally:

```text
$ python3 -c 'import re; print(re.findall(r"\.", "a.b.c vs abc"))'
['.', '.']
```

A path like `/posts/\d+` splits the literal from the variable part cleanly:

```text
$ python3 -c 'import re; print(re.search(r"/posts/\d+", "/posts/42 and /posts/999").group(0))'
/posts/42
```

### Word boundaries

`\b` asserts a boundary between a word character and a non-word character without consuming anything. It is how you stop `cat` from matching inside `category`. Secondary term, huge payoff:

```text
$ python3 -c 'import re; print(re.findall(r"\bcat\b", "cat category concatenate cat."))'
['cat', 'cat']
$ python3 -c 'import re; print(re.findall(r"\bPYTHON\b", "PYTHON PYTHONIC python", re.I))'
['PYTHON', 'python']
```

## Practical patterns worth keeping

**Email and URL: get them "good enough," not perfect.** A fully correct email regex is famously awful, and you should not try. This one catches real addresses and ignores obvious junk:

```text
$ python3 -c 'import re; print(re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+", "mail me at ada+notes@example.co.uk or x@y.io"))'
['ada+notes@example.co.uk', 'x@y.io']
```

URLs are the same story; stop at whitespace and quotes and you get 95% of the value:

```text
$ python3 -c 'import re; print(re.findall(r"https?://[^\s<>\"]+", "see https://blog.awin-x.top/posts/x and http://x.io/a?b=1"))'
['https://blog.awin-x.top/posts/x', 'http://x.io/a?b=1']
```

**Log lines.** Named groups turn an unstructured line into fields you can reason about:

```text
$ python3 -c 'import re
p = r"^(?P<ts>\S+)\s+(?P<lvl>\w+)\s+(?P<svc>\S+)\s+(?P<status>\d{3})\s+(?P<method>\w+)\s+(?P<path>\S+)\s+(?P<ms>\d+)ms$"
m = re.search(p, "2026-12-05T10:22:01Z INFO  api  200 GET /posts 18ms")
print(m.groupdict())'
{'ts': '2026-12-05T10:22:01Z', 'lvl': 'INFO', 'svc': 'api', 'status': '200', 'method': 'GET', 'path': '/posts', 'ms': '18'}
```

And `grep -P` gives you the same word boundaries and looks right in shell pipelines:

```text
$ grep -Pno '\bGET\b' access.log
1:GET
```

## Catastrophic backtracking

This is the one failure that is not a wrong answer but a *hung process*. It happens when nested quantifiers can match the same text in many different ways, and the engine, on failure, tries every combination. I timed the classic villain `(a+)+$` against `a…a!` (many `a`s then a mismatch):

```text
$ python3 -c 'import re, time
bad = re.compile(r"(a+)+$")
for n in (22, 24, 26):
    s = "a"*n + "!"
    t = time.time(); bad.search(s)
    print(f"n={n:>2}  {(time.time()-t)*1000:9.1f} ms")'
n=22      690.1 ms
n=24     3221.0 ms
n=26    11155.4 ms
```

Each extra character roughly *triples* the time — that is exponential, and a 30-character input is a denial-of-service. The fix is to remove the ambiguity. `a+$` matches the same language, linearly:

```text
$ python3 -c 'import re, time
bad = re.compile(r"(a+)+$"); good = re.compile(r"a+$")
for n in (22, 24, 26):
    s = "a"*n + "!"
    t = time.time(); bad.search(s); tb = (time.time()-t)*1000
    t = time.time(); good.search(s); tg = (time.time()-t)*1000
    print(f"n={n:>2}  bad={tb:9.1f} ms  good={tg:8.4f} ms")'
n=22  bad=    690.1 ms  good=  0.0079 ms
n=24  bad=   3221.0 ms  good=  0.0103 ms
n=26  bad=  11155.4 ms  good=  0.0079 ms
```

The rules of thumb: never nest a quantifier inside another quantifier over the same characters; prefer explicit classes (`[^<>]` instead of `.*`) so each position can match only one way; anchor patterns so the engine does not rescan from every offset; and if you cannot simplify, cap the input length before matching. Newer engines also offer possessive quantifiers (`a++`) and atomic groups that cut off backtracking entirely.

## A testing habit: run it against real inputs

The last habit is the one that actually ends the fear: **test every regex against real strings before you trust it.** Not one example — the good case, the case that should fail, and the ugly real-world line. `python3 -c` and `grep -P` are right there; there is no build to run.

I keep a small scratch file of inputs and expected results for the patterns I reuse. When a regex misbehaves in production, I paste the failing line into that file, watch it break, fix it, and watch it pass. Regexes are not scary because they are hard — they are scary because we ship them untested. Test them the way you test anything else, and they become just another sharp tool you reach for without thinking.

A good habit is to test three inputs every time, not one. First the input that *should* match, so you know the pattern still works. Second an input that should fail, so you know you have not built something that matches everything. Third the nastiest real-world line you can find — the one with extra spaces, a trailing slash, or a quote in the middle. That third case is where most production bugs hide, and it takes ten seconds to try.
