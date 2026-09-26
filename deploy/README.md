# 部署手册

目标机器：腾讯云 `150.158.18.245`（中国大陆节点）
当前形态：**只有 IP，没有域名**；HTTPS 用 Let's Encrypt 的 IP 证书（6 天有效期）。

> ⚠️ 这个形态是过渡方案，不是终点。
> IP 证书能挡住链路窃听，但**没有域名意味着换机器就得重新签、证书也没法做品牌**。
> 终点是买个域名 + 备案，见第 7.4 节。
> 另外 IP 证书只有 160 小时，续期链路（certbot + 定时任务 + ACME 挑战目录）
> 任何一环坏掉，一周内证书就过期 —— 见第 7.3 节的失效表现。

## 目录布局

代码和数据**分开存放**，这样重新发布代码永远碰不到数据：

| 路径 | 内容 |
|---|---|
| `/opt/print3d/app` | 代码（每次发布整体覆盖） |
| `/opt/print3d/app/.env` | 配置与密钥，权限 600 |
| `/var/lib/print3d/app.db` | 数据库 |
| `/var/lib/print3d/storage/` | 上传的附件 |
| `/var/lib/print3d/backups/` | 每日备份，保留 14 份 |

## 前置条件

1. **腾讯云控制台 → 安全组放行 80 端口**。这一步在网页控制台做，不在服务器上。
   绝大多数「部署完了但打不开」都是漏了这一步。
2. **同样要放行 443**，否则 HTTPS 部署完外部访问不到。80 和 443 一起放行最省事。
   验证：在自己电脑上 `curl -m 8 -sS -o /dev/null -w '%{http_code}\n' https://150.158.18.245/`。
   返回超时 = 安全组没放行；连接被拒 = 放行了但服务器上没人监听。
3. SSH 私钥：`C:\Users\MrBobby\Downloads\aaa.pem`
4. 服务器上 Node 22.5+、Nginx —— 由 `server-setup.sh` 自动装。

---

## 1. 打包并上传

在 Windows 的 Git Bash 里，于项目根目录执行。

**注意**：不要把包写到 `/tmp` —— Git Bash 会把 `/tmp/x` 翻译成 `E:\tmp\x`，
路径会莫名其妙地不存在。写在项目目录里。

```bash
cd /e/3d打印

tar czf .deploy.tar.gz \
  --exclude=node_modules --exclude=data --exclude=storage \
  --exclude=.env --exclude='*.log' --exclude=.deploy.tar.gz \
  app.js package.json package-lock.json db src public scripts deploy

KEY=~/Downloads/aaa.pem
HOST=150.158.18.245
USER=root                      # 若镜像默认用户是 ubuntu，改成 ubuntu 并加 sudo

scp -i "$KEY" .deploy.tar.gz "$USER@$HOST:/tmp/print3d-upload.tar.gz"
rm -f .deploy.tar.gz
```

## 2. 解包

```bash
ssh -i "$KEY" "$USER@$HOST" '
  set -e
  # 先停服务再覆盖代码。解包过程中文件是逐个被替换的，服务还活着的话
  # 会在这几秒里读到写了一半的 JS/CSS 并把它发给用户（静态文件是每次请求现读的）。
  # 解包失败时更糟：磁盘上留下半新半旧的代码，而进程还在跑。
  systemctl stop print3d
  mkdir -p /opt/print3d/app
  tar xzf /tmp/print3d-upload.tar.gz -C /opt/print3d/app
  rm -f /tmp/print3d-upload.tar.gz
  # 解包是 root 做的，文件属主会变成 root，而服务是 print3d 用户在跑。
  # 不 chown 的话应用读得到、写不了，出问题时报的错和权限八竿子打不着。
  chown -R print3d:print3d /opt/print3d/app

  # 把三个配置文件单独放到暂存目录，给 server-setup.sh 取用
  mkdir -p /tmp/print3d-deploy
  cp /opt/print3d/app/deploy/print3d.service          /tmp/print3d-deploy/
  cp /opt/print3d/app/deploy/nginx-print3d.conf       /tmp/print3d-deploy/
  cp /opt/print3d/app/deploy/nginx-print3d-proxy.conf /tmp/print3d-deploy/
  echo 解包完成
'
```

> 只发代码、不重跑初始化脚本时，别忘了把服务起回来：
> `ssh -i "$KEY" "$USER@$HOST" 'systemctl start print3d'`
```

## 3. 初始化

```bash
ssh -i "$KEY" "$USER@$HOST" 'bash /opt/print3d/app/deploy/server-setup.sh'
```

脚本做的事：建 `print3d` 系统用户 → 装 Node 22 和 Nginx → 建数据目录 →
生成 `.env`（含随机 `SESSION_SECRET`）→ 装 systemd 服务 → 装 Nginx 站点
（含 HTTP/HTTPS 共用的 `snippets/print3d-proxy.conf`）→ 建 ACME 挑战目录 →
启动 → 配置每日备份 cron。

**只装 80 端口**：443 的配置要等证书签出来才能装（见第 7 节）。

脚本是**幂等**的，可以重复执行；已存在的 `.env` 不会被覆盖
（换掉 `SESSION_SECRET` 会让所有登录会话立即失效）。

## 4. 验证

```bash
curl -i http://150.158.18.245/api/health
```

应返回 `{"status":"ok"}`。

再确认 Node 没有直接暴露在公网 —— 这条会超时/被拒才是对的：

```bash
curl -m 5 http://150.158.18.245:3000/api/health   # 期望：连不上
```

## 5. 注册管理员（**紧接着做，不要拖**）

`.env` 里 `ALLOW_ADMIN_REGISTRATION=true` 期间，**任何知道这个 IP 的人都能抢先
注册掉唯一的管理员账号**。所以第 3 步做完就立刻注册，然后马上关掉开关。

浏览器打开 `http://150.158.18.245/admin/register` 完成注册，然后：

```bash
ssh -i "$KEY" "$USER@$HOST" '
  sed -i "s/^ALLOW_ADMIN_REGISTRATION=true/ALLOW_ADMIN_REGISTRATION=false/" /opt/print3d/app/.env
  systemctl restart print3d
  systemctl is-active print3d
  curl -s -o /dev/null -w "注册接口现在返回：%{http_code}\n" -X POST http://127.0.0.1:3000/api/auth/register
'
```

最后一条应为 `404`。

## 6. 验收清单

数据库层面只可能有一个管理员，注册开关关掉后确认接口 404；
建一个测试订单，拿订单号在**手机**上查一次（走一遍真实客户的路径）；
双方各上传一个文件；`systemctl restart print3d` 后再确认数据还在。

## 7. HTTPS

### 7.1 现在用的是 IP 证书

这台机器没有已备案的域名（大陆节点上，没备案的域名解析过来 80/443 会被拦），
所以走 Let's Encrypt 的 **IP 地址证书**：

| | |
|---|---|
| 有效期 | 160 小时（约 6.7 天）。实测签发出来是 9-26 02:32 → 10-02 18:32 GMT |
| profile | `shortlived` —— IP 证书**只能**用这个 profile，不加这个参数会被直接拒绝 |
| 续期 | 每天 04:23 / 16:23 各检查一次，只在真的该续时才续 |
| 客户端 | certbot **5.4+**。Debian 13 源里是 4.0.0，没有 `--ip-address`，用不了 |

**续期靠 ARI 驱动，不是靠定时任务自己算时间。** Let's Encrypt 会通过 ARI
（ACME Renewal Information）告诉客户端"什么时候来续"；实测返回的窗口是
`2026-09-29T09:26Z ~ 12:37Z`，也就是到期前约 2/3 处。走 ARI 的续期
**不受速率限制约束** —— 这一点很关键，因为"同一组标识符每周 5 张"的配额
在 6 天有效期的证书上很容易踩到，按天续期必然会撞上限。
所以别把 `certbot renew` 改成 `--force-renewal`，那会绕过 ARI 直接吃配额。

一键配置（幂等，可以重复跑）：

```bash
ssh -i "$KEY" "$USER@$HOST" 'bash /opt/print3d/app/deploy/setup-https.sh'
```

脚本会：装 certbot（走腾讯云 PyPI 镜像）→ 先自己取一次挑战文件确认 ACME 路径通
（不白白花掉一次签发配额）→ 签发 → **证书到手后**才装 443 配置 → 配续期定时任务 → 自检。

想先演练一遍而不消耗正式配额：加 `--staging`。staging 的证书浏览器不信任，
只用来验证流程，跑完不会装 443 配置。

### 7.2 顺序不能反：先放行 443，再打开强制跳转

`setup-https.sh` **不会**打开强制跳转，也不会把 cookie 标成 Secure。这两件事
必须等腾讯云安全组放行 443 之后再做：

```bash
# 0. 腾讯云控制台 → 安全组放行 443（网页控制台操作，不在服务器上）
#    在你自己的电脑上验证。**不能在服务器上跑这条** —— 实测腾讯云上
#    从机器访问自己的公网 IP 仍然要过安全组，443 没放行时一律超时，
#    会把"配置没问题"误报成失败。
curl -m 8 -sS -o /dev/null -w '%{http_code}\n' https://150.158.18.245/
# 期望 200。超时 = 安全组还没放行。
#
# 要在服务器上单独确认 nginx 和证书本身没问题（不经过公网）：
#   curl --resolve 150.158.18.245:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://150.158.18.245/

# 1. 打开 80 → 443 的跳转（把那一行的行首 # 去掉，只改这一个字符）
ssh -i "$KEY" "$USER@$HOST" '
  sed -i "s|^    #if (\$request_uri|    if (\$request_uri|" /etc/nginx/conf.d/print3d.conf
  grep -n "request_uri" /etc/nginx/conf.d/print3d.conf   # 确认这行现在没有 # 了
  nginx -t && systemctl reload nginx
'

# 2. 把会话 cookie 标成 Secure
ssh -i "$KEY" "$USER@$HOST" '
  sed -i "s/^COOKIE_SECURE=false/COOKIE_SECURE=true/" /opt/print3d/app/.env
  systemctl restart print3d
'
```

**顺序反了的后果**：`COOKIE_SECURE=true` 之后浏览器不再在 HTTP 上回传 cookie，
而跳转又把人送到一个外网打不开的 443 —— 表现是"站点整个打不开、管理员登不进去"。
所以第 0 步的 curl 必须先返回 200。

用 `return 302` 而不是 `certbot --redirect` 的 `301`：证书只有 6 天，续期万一坏掉
是要把跳转撤掉的，301 会被浏览器长期缓存，撤不干净。

`COOKIE_SECURE=false` 期间服务每次启动都会打一段醒目警告，进 `journalctl`。
**警告消失的那天，才说明这台机器真的上了 HTTPS。**

### 7.3 续期失败会怎样

- 应用发出的 HSTS 是 **7 天**（`src/middleware/security.js`），不是一年。
  这是刻意的：证书断了之后，浏览器最多挡你 7 天，而不是一年。
  将来换成 90 天的域名证书，可以把它调回 `31536000`。
- 续期日志：`/var/log/print3d-cert.log`。检查有没有在续：
  `certbot certificates`
- 证书过期而没续上时，站点会退回"浏览器证书警告"状态；80 端口的跳转如果
  已经打开，需要按 7.2 反过来把跳转撤掉，用户才能继续用 HTTP。

### 7.4 以后有了备案域名

把 `deploy/nginx-print3d-tls.conf` 和 `deploy/nginx-print3d.conf` 里的
`server_name 150.158.18.245` 换成域名、证书路径换成新证书名，然后用
`certbot --nginx -d 你的域名 --redirect`（域名证书 90 天，用源里的 certbot 就行）。
届时 HSTS 可以调回一年。

## 日常运维

```bash
# 看日志（服务启动时会打印明文 HTTP 的警告，以及所有请求日志）
ssh -i "$KEY" "$USER@$HOST" 'journalctl -u print3d -f'

# 重启
ssh -i "$KEY" "$USER@$HOST" 'systemctl restart print3d'

# 立刻手动备份
ssh -i "$KEY" "$USER@$HOST" 'cd /opt/print3d/app && sudo -u print3d npm run backup'

# 看备份列表
ssh -i "$KEY" "$USER@$HOST" 'ls -lh /var/lib/print3d/backups/'
```

## 备份与恢复

备份每天 03:17 自动跑，保留 14 份，日志在 `/var/log/print3d-backup.log`。

**备份只含数据库，附件在 `storage/` 里，恢复时两者必须一起还原** ——
否则订单都还在，但点开附件全是坏的。

恢复演练（不要直接在原库上做）：

```bash
ssh -i "$KEY" "$USER@$HOST" '
  systemctl stop print3d
  cp -a /var/lib/print3d /var/lib/print3d.bak        # 先留个后路
  ls /var/lib/print3d/backups/ | tail -1             # 挑一份备份
'
```

异地备份（`rclone` 推到对象存储）尚未配置 —— 服务器整个挂掉时，
数据库和附件都在同一块盘上，这是当前最大的单点风险。

## 已知限制

- **证书只有 6 天，且续期依赖这台机器**：续期链路（certbot 装在 `/opt/certbot`、
  定时任务、ACME 挑战目录）任一环坏掉，一周内证书过期。机器长期关机同理 ——
  开机后 `certbot renew` 会补一次。检查：`certbot certificates`。
- **证书绑定 IP**：换服务器就得重新签，客户端也不会显示任何品牌标识。
  终点是域名 + 备案（第 7.4 节）。
- **certbot 不在系统包管理器里**：是 venv + pip 装的，不会跟着 `apt upgrade` 更新。
  需要手动升：`/opt/certbot/bin/pip install --upgrade certbot
  --index-url https://mirrors.tencentyun.com/pypi/simple/`。
- **附件无异地备份**：和数据库同盘，盘挂了就一起没。
- **客户丢掉订单号无法自助找回**：这是「仅凭订单号」方案的固有代价。
  补救路径是管理员用 `/api/admin/lookup-by-phone` 按电话代查后重新发给客户。
- **备份 cron 依赖服务器自身**：服务器长期关机时不会补跑。
