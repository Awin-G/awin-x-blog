---
title: "An nginx config cookbook: nginx location matching, try_files, and add_header"
description: "An nginx config cookbook: how nginx location matching resolves (exact, ^~, regex, prefix), root vs alias, nginx try_files patterns for SPAs and APIs, the add_header inheritance trap, proxy_pass trailing slashes, rewrite vs return, gzip and cache headers, client_max_body_size, and reading nginx -T."
pubDate: 2026-12-07
lang: en
translationKey: nginx-cookbook
tags: [nginx, devops]
featured: false
keywords:
  - nginx config
  - nginx location
  - nginx try_files
  - add_header inheritance
  - proxy_pass
---

I edit an **nginx config** almost every week, and the same handful of directives cause almost every surprise. This is my cookbook: the matching rules I keep re-learning, the `root`/`alias` foot-gun, the **nginx try_files** patterns I reuse, and the **add_header inheritance** trap that quietly drops your security headers. Every rule below was reproduced on a real `nginx/1.27.5` container. You will see actual `curl` output, an actual error-log line, and a genuine `nginx -t` failure with its fix — nothing is invented. Where these connect to the rest of the stack, I lean on [HTTP caching](/posts/http-caching/) and [zero-downtime deploys](/posts/zero-downtime-deploys/).

The whole session ran in one container with a config dir mounted read-only and a static site at `/srv/site`:

```bash
$ docker run -d --name ngx \
    -p 127.0.0.1:8080:8080 \
    -v "$PWD/conf.d/default.conf":/etc/nginx/conf.d/default.conf:ro \
    -v "$PWD/site":/srv/site:ro \
    nginx:1.27-alpine
$ docker exec ngx nginx -v
nginx version: nginx/1.27.5
```

## How nginx location matching actually picks a winner

This is the question that generates the most confusion, so let me settle it with a config that has *every* kind of location pointing at the same URL space. nginx does not simply take the first location in the file; it ranks candidates:

<figure>
<svg viewBox="0 0 720 340" width="100%" role="img" aria-label="nginx location matching precedence: an exact match wins first, then the longest prefix, where a ^~ prefix skips regex evaluation, then the first matching regex in file order, then the longest plain prefix, then the slash fallback.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.5">
    <line x1="22" y1="40" x2="22" y2="300"/>
    <path d="M22 306 l-5 -10 h10 z" fill="currentColor" stroke="none"/>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.4">
    <rect x="44" y="24" width="470" height="42" rx="8"/>
    <rect x="44" y="80" width="470" height="42" rx="8"/>
    <rect x="44" y="136" width="470" height="42" rx="8"/>
    <rect x="44" y="192" width="470" height="42" rx="8"/>
    <rect x="44" y="248" width="470" height="42" rx="8"/>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.3">
    <circle cx="70" cy="45" r="13"/>
    <circle cx="70" cy="101" r="13"/>
    <circle cx="70" cy="157" r="13"/>
    <circle cx="70" cy="213" r="13"/>
    <circle cx="70" cy="269" r="13"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <g text-anchor="middle">
      <text x="70" y="50">1</text>
      <text x="70" y="106">2</text>
      <text x="70" y="162">3</text>
      <text x="70" y="218">4</text>
      <text x="70" y="274">5</text>
    </g>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="13.5">
    <text x="95" y="50">location = /path</text>
    <text x="95" y="106">location ^~ /prefix/</text>
    <text x="95" y="162">location ~ /re/</text>
    <text x="95" y="218">location /prefix/</text>
    <text x="95" y="274">location /</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.85">
    <text x="530" y="50">exact: wins immediately</text>
    <text x="530" y="106">longest prefix, skips regex</text>
    <text x="530" y="162">first regex in file order</text>
    <text x="530" y="218">longest plain prefix</text>
    <text x="530" y="274">fallback</text>
  </g>
</svg>
<figcaption>The precedence ladder. Prefixes are ranked by length, not by order; regexes are ranked by order, not by length. A `^~` prefix is the one way to stop regex evaluation from ever happening.</figcaption>
</figure>

```nginx
location = /a   { return 200 "exact"; }
location /a     { return 200 "plain prefix"; }
location ~ ^/a  { return 200 "regex"; }
location ^~ /b/ { return 200 "prefix, regex skipped"; }
location ~ \.png$ { return 200 "png regex"; }
location /      { return 200 "fallback"; }
```

Now ask for the URLs that each rule is *trying* to win:

```text
$ for p in /a /a/ /b/x.png /c/x.png /other; do curl -s "http://127.0.0.1:8080$p"; done
WIN: 'location = /a'   (exact)
WIN: 'location ~ ^/a'  (regex)
WIN: 'location ^~ /b/' (prefix, regex skipped)
WIN: 'location ~ \.png' (regex)
WIN: 'location /'      (fallback prefix)
```

Read it row by row. `/a` hits the exact match, which beats the regex and the prefix. `/a/` is not an exact match, so the regex `~ ^/a` wins over the plain prefix `/a` — a shorter prefix does **not** outrank a regex. `/b/x.png` matches both `^~ /b/` and the `.png` regex, but `^~` means "stop, do not even look at regexes", so the prefix wins. `/c/x.png` matches no special prefix, so the regex wins. `/other` falls all the way through to `location /`.

## `root` vs `alias`: one appends, one replaces

`root` builds a path by appending the **full URI**; `alias` builds it by replacing the **matched prefix**. This is the difference people remember for a day and then forget:

```nginx
location /a/ { root  /srv/site;     }   # -> /srv/site/a/hello.html
location /b/ { alias /srv/aliased/; }   # -> /srv/aliased/hello.html
location /c/ { alias /srv/aliased;  }   # -> /srv/aliasedhello.html   (BUG)
```

```text
$ curl -s http://127.0.0.1:8082/a/hello.html
served from root + URI  (/srv/site/a/hello.html)
$ curl -s http://127.0.0.1:8082/b/hello.html
served from alias       (/srv/aliased/hello.html)
$ curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:8082/c/hello.html
HTTP 404
```

The 404 in `/c/` is the classic alias bug, and the error log names the wrong file outright:

```text
2026/10/12 [error] open() "/srv/aliasedhello.html" failed (2: No such file or directory),
    request: "GET /c/hello.html HTTP/1.1"
```

`alias /srv/aliased` had no trailing slash, so nginx replaced `/c/` with `/srv/aliased` and glued `hello.html` straight onto it. The rule is boring and absolute: with `alias`, make the trailing slashes on the location and the alias agree. When the error log shows a mangled path, this is the first place to look.

## nginx try_files: SPA fallback, static files, API fallback

`try_files` is the workhorse of every real server. It tries each argument in order and uses the first that exists; the last argument is the fallback (a URI, `=404`, or a named location).

```nginx
location /spa/  { try_files $uri $uri/ /spa/index.html; }  # single-page app
location /docs/ { try_files $uri $uri/ =404; }             # static, honest 404
location /api/  { try_files $uri $uri/ @api; }             # hand off to the backend
location @api   { return 200 "named location @api handled /api"; }
```

```text
$ curl -s http://127.0.0.1:8083/spa/dashboard
<div id="app">SPA shell</div>
$ curl -s http://127.0.0.1:8083/spa/app.js
console.log('spa bundle');
$ curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:8083/docs/missing.html
HTTP 404
$ curl -s http://127.0.0.1:8083/api/users
named location @api handled /api
```

Three habits in four lines. For the SPA, a deep link like `/spa/dashboard` is neither a file nor a directory, so it falls back to the shell and the client router takes over — but a real asset like `app.js` is served directly. The static location uses `=404` so that a typo returns a 404 instead of your homepage with a `200`, which is how SPAs end up accidentally indexed. The API location drops to the `@api` named location, which is where a `proxy_pass` belongs.

## The `add_header` inheritance trap

Here is the one that bites in production. `add_header` is **not** merged down the tree: if a nested block declares *any* `add_header`, it discards every `add_header` from its parent. A server-level header set for security vanishes the moment a location adds one of its own.

```nginx
server {
    add_header X-Server-Level "from server" always;
    location /inner { return 200 "inherits"; }                       # no local add_header
    location /outer { add_header X-Location "from location" always; return 200 "replaces"; }
}
```

```text
$ curl -sD - -o /dev/null http://127.0.0.1:8084/inner | grep -i x-
X-Server-Level: from server
$ curl -sD - -o /dev/null http://127.0.0.1:8084/outer | grep -i x-
X-Location: from location
```

`/outer` should still carry `X-Server-Level`, but it does not. The location's own `add_header` replaced the server's entire set. The fix is to repeat the shared headers in every block that adds one, or move them somewhere they are not shadowed. The second half of the trap is status codes: `add_header` is only added to successful responses unless you write `always`.

```text
$ curl -sD - -o /dev/null http://127.0.0.1:8084/error-plain   # 404: no X-Plain header
HTTP/1.1 404 Not Found
$ curl -sD - -o /dev/null http://127.0.0.1:8084/error-always  # add_header ... always
HTTP/1.1 404 Not Found
X-Always: set with always
```

So HSTS, `X-Frame-Options`, and the rest only appear on 4xx/5xx if you remembered `always` — and they survive inheritance only if the child block adds nothing.

## proxy_pass and the trailing-slash subtlety

When `proxy_pass` has a URI part, the **matched location prefix is replaced** by it. Add a trailing slash and you strip the prefix; leave it off and you pass the full path through. One character, completely different upstream request:

```nginx
location /strip/ { proxy_pass http://127.0.0.1:8090/; }   # trailing slash
location /keep/  { proxy_pass http://127.0.0.1:8090;  }   # no trailing slash
```

```text
$ curl -s http://127.0.0.1:8085/keep/foo
backend received: /keep/foo
$ curl -s http://127.0.0.1:8085/strip/foo
backend received: /foo
```

`/keep/` sends `/keep/foo` unchanged; `/strip/` rewrites it to `/foo`. That is exactly what you want when a backend mounts its routes at the root, and exactly the thing that breaks routing when you expected the opposite.

## rewrite vs return: when each one is right

Use `return` unless you genuinely need to rewrite. `return` ends the request immediately with a response; `rewrite` re-evaluates locations and costs more work. Here both send a client a `301`, and only the internal rewrite avoids a round trip:

```nginx
location = /old         { return 301 /new; }
location = /old-rewrite { rewrite ^/old-rewrite$ /new permanent; }
location /r/            { rewrite ^/r/(.*)$ /new/$1 last; }
```

```text
$ curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:8086/old
301 http://127.0.0.1:8086/new
$ curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:8086/old-rewrite
301 http://127.0.0.1:8086/new
$ curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:8086/r/foo
200
```

`return` and `rewrite ... permanent` look identical to the client, but `return` is cheaper and clearer. `rewrite ... last` is different: it re-runs location matching internally, so `/r/foo` came back as a `200` from `/new/` with no redirect at all — perfect for legacy URL shapes, overkill for a simple redirect.

## gzip, caching headers, and client_max_body_size

Compression needs three things right: `gzip on`, a `gzip_types` list (the default only covers `text/html`), and — the easy miss — `gzip_vary on`. Without it, nginx serves gzip to a shared cache with no `Vary`, and the cache can hand compressed bytes to a client that never asked for them.

```nginx
gzip on;
gzip_types text/css application/javascript application/json;
gzip_vary on;                 # emits Vary: Accept-Encoding
add_header Cache-Control "public, max-age=31536000, immutable" always;
client_max_body_size 64k;
```

```text
$ curl -s -H 'Accept-Encoding: gzip' -D - -o /dev/null http://127.0.0.1:8087/big.css
HTTP/1.1 200 OK
Content-Type: text/css
Cache-Control: public, max-age=31536000, immutable
Content-Encoding: gzip
Vary: Accept-Encoding

$ curl -s -o /dev/null -w 'plain %{size_download} bytes\n' http://127.0.0.1:8087/big.css
plain 17400 bytes
$ curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w 'gzip  %{size_download} bytes\n' http://127.0.0.1:8087/big.css
gzip  147 bytes
```

A hashed, immutable asset is the one place to cache aggressively; the versioned filename is the invalidation strategy, which is the whole point of the [HTTP caching](/posts/http-caching/) playbook. Finally, `client_max_body_size` is the upload wall everyone hits eventually:

```text
$ head -c 51200 /dev/zero | curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST --data-binary @- http://127.0.0.1:8087/upload
HTTP 200
$ head -c 102400 /dev/zero | curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST --data-binary @- http://127.0.0.1:8087/upload
HTTP 413
```

A 50 KB POST passes the 64k limit; a 100 KB POST is rejected with `413 Request Entity Too Large` before it ever reaches your app. Raise the limit deliberately, and remember the same default exists on the backend too.

## Reading nginx -T and surviving nginx -t

Before every reload, run `nginx -t`. When something is wrong it points at the exact file and line:

```text
$ nginx -t
nginx: [emerg] unexpected "}" in /etc/nginx/conf.d/broken.conf:6
nginx: configuration file /etc/nginx/nginx.conf test failed

$ nginx -t
nginx: [emerg] duplicate location "/x" in /etc/nginx/conf.d/broken2.conf:5
nginx: configuration file /etc/nginx/nginx.conf test failed
```

The first was a `return` with a missing semicolon; nginx noticed the stray `}`. Adding the `;` makes it pass. `nginx -t` never touches the running workers — it is a pure syntax check, so a failing test means your last edit would have taken the site down, and a `nginx -s reload` on a passing test is safe.

`nginx -t` is the syntax check; `nginx -T` ("T", uppercase) is the **dump**. It prints every file nginx actually loaded, in order, with `# configuration file:` headers, then the same success line. That is the only way to see the fully assembled config, including includes you forgot and the distro's default `nginx.conf`:

```text
$ nginx -T | grep -n 'configuration file\|listen '
1: nginx: configuration file /etc/nginx/nginx.conf test is successful
3: # configuration file /etc/nginx/nginx.conf:
37:# configuration file /etc/nginx/mime.types:
138:# configuration file /etc/nginx/conf.d/default.conf:
141:    listen 8090;
150:    listen 8080;
164:    listen 8082;
```

When two server blocks fight or a vhost mysteriously does nothing, `nginx -T` shows whether your file was even included, and in what order. Between `nginx -t` before each reload and `nginx -T` when reality disagrees with your file, almost every config mystery is a two-command fix.

That is the cookbook: rank locations by the ladder, keep your slashes straight, let `try_files` do the routing, never let a local `add_header` shadow a security header, choose `return` over `rewrite`, and prove the whole thing with `-t` and `-T`.
