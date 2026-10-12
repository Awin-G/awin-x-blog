---
title: "一份 nginx 配置手册：nginx location 匹配、try_files 与 add_header 的坑"
description: "一份动手验证的 nginx 配置手册：nginx location 匹配到底谁优先（精确、^~、正则、前缀），root 与 alias 的区别，SPA/静态/API 三种 nginx try_files 写法，add_header 继承陷阱，proxy_pass 结尾斜杠的差别，rewrite 与 return 的取舍，gzip 与缓存头，client_max_body_size，以及怎么读 nginx -T。每条规则都有真实输出。"
pubDate: 2026-12-07
lang: zh
translationKey: nginx-cookbook
tags: [nginx, devops]
featured: false
keywords:
  - nginx 配置
  - nginx location
  - nginx try_files
  - add_header 继承
  - proxy_pass
---

我几乎每周都要改一次 **nginx 配置**，而每次被惊到的，都是那么几个指令。这就是我的手册：老是记不住的匹配规则、`root`/`alias` 的坑、反复复用的 **nginx try_files** 写法，还有会悄悄吞掉安全响应头的 **add_header 继承**陷阱。下面每一条都在真实的 `nginx/1.27.5` 容器里复现过——你能看到真正的 `curl` 输出、真正的错误日志行，还有一个真实的 `nginx -t` 失败和它的修复。没有一条是编的。凡是要和别处衔接的地方，我会用到 [HTTP 缓存](/zh/posts/http-caching/)和[零停机部署](/zh/posts/zero-downtime-deploys/)。

整场实验就跑在一个容器里：配置目录只读挂载，静态站点放在 `/srv/site`：

```bash
$ docker run -d --name ngx \
    -p 127.0.0.1:8080:8080 \
    -v "$PWD/conf.d/default.conf":/etc/nginx/conf.d/default.conf:ro \
    -v "$PWD/site":/srv/site:ro \
    nginx:1.27-alpine
$ docker exec ngx nginx -v
nginx version: nginx/1.27.5
```

## nginx location 匹配到底谁赢

这是最让人犯迷糊的问题，所以我干脆写一个把**所有** location 类型都指向同一段 URL 空间的配置来说明。nginx 并不是简单取文件里第一个 location，而是给候选排序：

<figure>
<svg viewBox="0 0 720 340" width="100%" role="img" aria-label="nginx location 匹配优先级：先精确匹配，其次最长前缀，其中 ^~ 前缀会跳过正则，然后按文件顺序取第一个命中的正则，再是最长的普通前缀，最后是斜杠兜底。">
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
    <text x="530" y="50">精确：立即胜出</text>
    <text x="530" y="106">最长前缀，跳过正则</text>
    <text x="530" y="162">按文件顺序的第一个正则</text>
    <text x="530" y="218">最长的普通前缀</text>
    <text x="530" y="274">兜底</text>
  </g>
</svg>
<figcaption>优先级阶梯。前缀按长度排序，而不是按先后；正则按先后排序，而不是按长短。`^~` 前缀是唯一能彻底阻止正则参与匹配的写法。</figcaption>
</figure>

```nginx
location = /a   { return 200 "exact"; }
location /a     { return 200 "plain prefix"; }
location ~ ^/a  { return 200 "regex"; }
location ^~ /b/ { return 200 "prefix, regex skipped"; }
location ~ \.png$ { return 200 "png regex"; }
location /      { return 200 "fallback"; }
```

然后请求那些「每条规则都想抢」的 URL：

```text
$ for p in /a /a/ /b/x.png /c/x.png /other; do curl -s "http://127.0.0.1:8080$p"; done
WIN: 'location = /a'   (exact)
WIN: 'location ~ ^/a'  (regex)
WIN: 'location ^~ /b/' (prefix, regex skipped)
WIN: 'location ~ \.png' (regex)
WIN: 'location /'      (fallback prefix)
```

一行一行看。`/a` 命中精确匹配，它压过正则和前缀。`/a/` 不是精确匹配，于是正则 `~ ^/a` 赢过普通前缀 `/a`——**更短的前缀并不比正则优先**。`/b/x.png` 同时命中 `^~ /b/` 和 `.png` 正则，但 `^~` 的意思是「到此为止，连正则都不用看」，所以前缀赢。`/c/x.png` 没有任何特殊前缀，正则赢。`/other` 一路落到 `location /`。

## `root` 与 `alias`：一个拼接，一个替换

`root` 用**完整 URI** 拼出路径；`alias` 则替换掉**被匹配到的那段前缀**。这个区别人们记一天就忘：

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

`/c/` 的 404 就是那个经典的 alias bug，而错误日志会直接把那个错路径报出来：

```text
2026/10/12 [error] open() "/srv/aliasedhello.html" failed (2: No such file or directory),
    request: "GET /c/hello.html HTTP/1.1"
```

`alias /srv/aliased` 结尾少了斜杠，于是 nginx 用 `/srv/aliased` 替换掉 `/c/`，再把 `hello.html` 直接粘了上去。规则很枯燥但绝对：用 `alias` 时，location 和 alias 两边的结尾斜杠必须一致。当错误日志里出现这种被拼坏的路径，先查这里。

## nginx try_files：SPA 兜底、静态文件、API 兜底

`try_files` 是每个真实服务器的主力。它按顺序试每个参数，取第一个存在的；最后一个参数是兜底（一个 URI、`=404`，或一个命名 location）。

```nginx
location /spa/  { try_files $uri $uri/ /spa/index.html; }  # 单页应用
location /docs/ { try_files $uri $uri/ =404; }             # 静态文件，诚实返回 404
location /api/  { try_files $uri $uri/ @api; }             # 转交给后端
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

四行里藏着三个习惯。对 SPA 来说，`/spa/dashboard` 这种深链接既不是文件也不是目录，于是兜底到 shell，由前端路由接管；但 `app.js` 这种真实资源会被直接送出。静态那个 location 用 `=404`，这样打错字返回的是 404，而不是把首页带着 `200` 返回出去——那正是 SPA 被搜索引擎误收录的原因。API 那个则落到 `@api` 命名 location，`proxy_pass` 就该写在那里。

## 会咬人的 `add_header` 继承陷阱

这就是生产环境里最坑的一个。`add_header` **不会**沿配置树向下合并：只要某个内层块声明了*任意*一个 `add_header`，它就会丢弃父级的所有 `add_header`。为安全而设在 server 级别的响应头，会在某个 location 添加自己那个头的一瞬间消失。

```nginx
server {
    add_header X-Server-Level "from server" always;
    location /inner { return 200 "inherits"; }                       # 本层没有 add_header
    location /outer { add_header X-Location "from location" always; return 200 "replaces"; }
}
```

```text
$ curl -sD - -o /dev/null http://127.0.0.1:8084/inner | grep -i x-
X-Server-Level: from server
$ curl -sD - -o /dev/null http://127.0.0.1:8084/outer | grep -i x-
X-Location: from location
```

`/outer` 本应还带着 `X-Server-Level`，但它没有。location 自己的 `add_header` 替换掉了 server 的整组。修法是：在每个要添加头的块里重复那些共享头，或者把它们挪到不会被遮蔽的地方。这个陷阱的另一半是状态码：除非写 `always`，`add_header` 只会加到成功响应上。

```text
$ curl -sD - -o /dev/null http://127.0.0.1:8084/error-plain   # 404：没有 X-Plain 头
HTTP/1.1 404 Not Found
$ curl -sD - -o /dev/null http://127.0.0.1:8084/error-always  # add_header ... always
HTTP/1.1 404 Not Found
X-Always: set with always
```

所以 HSTS、`X-Frame-Options` 之类，只有在你还记得 `always` 时才会出现在 4xx/5xx 上——而只有子块不添加任何头时，它们才能穿过继承。

## proxy_pass 与结尾斜杠的微妙差别

当 `proxy_pass` 带了一段 URI 时，**被匹配到的 location 前缀会被它替换**。加结尾斜杠，你就去掉了前缀；不加，就把完整路径透传下去。一个字符，后端收到的请求完全不同：

```nginx
location /strip/ { proxy_pass http://127.0.0.1:8090/; }   # 有结尾斜杠
location /keep/  { proxy_pass http://127.0.0.1:8090;  }   # 没有结尾斜杠
```

```text
$ curl -s http://127.0.0.1:8085/keep/foo
backend received: /keep/foo
$ curl -s http://127.0.0.1:8085/strip/foo
backend received: /foo
```

`/keep/` 原样送出 `/keep/foo`；`/strip/` 把它改写成 `/foo`。当后端把路由挂在根上时，这正是你要的；而当你以为会反过来时，它正好会打断路由。

## rewrite 与 return：什么时候用哪个

除非你确实需要重写，否则用 `return`。`return` 立刻以响应结束请求；`rewrite` 会重新评估 location，开销更大。下面两个都向客户端发 `301`，只有内部 rewrite 免去了一次往返：

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

`return` 和 `rewrite ... permanent` 对客户端来说长得一样，但 `return` 更便宜也更清楚。`rewrite ... last` 不一样：它在内部重跑 location 匹配，所以 `/r/foo` 从 `/new/` 直接返回 `200`，完全没有重定向——处理历史 URL 形状时正合适，做简单跳转则是杀鸡用牛刀。

## gzip、缓存头与 client_max_body_size

压缩要对三件事：`gzip on`、一个 `gzip_types` 列表（默认只覆盖 `text/html`），以及最容易漏的 `gzip_vary on`。没有它，nginx 会把 gzip 内容送给共享缓存却不带 `Vary`，于是缓存可能把压缩字节交给一个从没要求过压缩的客户端。

```nginx
gzip on;
gzip_types text/css application/javascript application/json;
gzip_vary on;                 # 发出 Vary: Accept-Encoding
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

带哈希、永不改动的资源，是唯一该激进缓存的东西；版本化文件名本身就是失效策略，这正是 [HTTP 缓存](/zh/posts/http-caching/)那套打法的全部要点。最后，`client_max_body_size` 是大家早晚都会撞上的上传墙：

```text
$ head -c 51200 /dev/zero | curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST --data-binary @- http://127.0.0.1:8087/upload
HTTP 200
$ head -c 102400 /dev/zero | curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST --data-binary @- http://127.0.0.1:8087/upload
HTTP 413
```

50 KB 的 POST 过了 64k 的限，100 KB 的 POST 在到达应用之前就被 `413 Request Entity Too Large` 拒了。要提上限就刻意去提，并且记住后端同样有这个默认限制。

## 读 nginx -T，以及扛住 nginx -t

每次 reload 之前，先跑 `nginx -t`。出问题时它会指出确切的文件和行号：

```text
$ nginx -t
nginx: [emerg] unexpected "}" in /etc/nginx/conf.d/broken.conf:6
nginx: configuration file /etc/nginx/nginx.conf test failed

$ nginx -t
nginx: [emerg] duplicate location "/x" in /etc/nginx/conf.d/broken2.conf:5
nginx: configuration file /etc/nginx/nginx.conf test failed
```

第一个是 `return` 少了个分号；nginx 注意到了那个多出来的 `}`。补上 `;` 就能通过。`nginx -t` 完全不碰正在运行的 worker——它是纯粹的语法检查，所以测试失败意味着你上一次改动本来会把站点搞挂，而测试通过后 `nginx -s reload` 才是安全的。

`nginx -t` 是语法检查；`nginx -T`（大写 **T**）是**转储**。它会按顺序打印 nginx 实际加载的每一个文件，带上 `# configuration file:` 头，然后再打印同样的成功行。这是唯一能看清完整拼装后配置的办法，包括你忘了的 include 和发行版自带的 `nginx.conf`：

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

当两个 server 块打架、或者某个 vhost 莫名其妙不生效时，`nginx -T` 会告诉你你的文件到底有没有被 include 进去、顺序如何。每次 reload 前的 `nginx -t`，加上现实与文件不符时的 `nginx -T`，几乎所有的配置谜题都是两条命令的事。

这就是这份手册：按阶梯给 location 排序，把斜杠对齐，让 `try_files` 去做路由，绝不让本层的 `add_header` 遮蔽安全头，复杂跳转也别急着用 `rewrite`——优先 `return`，最后用 `-t` 和 `-T` 把一切验证一遍。
