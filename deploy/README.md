# 部署手册

目标机器：腾讯云 `150.158.18.245`（中国大陆节点）
当前形态：**只有 IP，纯 HTTP**，没有域名和证书。

> ⚠️ 这个形态是过渡方案，不是终点。HTTP 下管理员密码和会话 cookie 明文过公网，
> 链路上任何一跳都能读到并冒充管理员。**在补上 HTTPS 之前，不要录入真实客户订单。**
> 补 HTTPS 的步骤见下面第 7 节。

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
2. SSH 私钥：`C:\Users\MrBobby\Downloads\aaa.pem`
3. 服务器上 Node 22.5+、Nginx —— 由 `server-setup.sh` 自动装。

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
  mkdir -p /opt/print3d/app
  tar xzf /tmp/print3d-upload.tar.gz -C /opt/print3d/app
  rm -f /tmp/print3d-upload.tar.gz
  # 把两个配置文件单独放到暂存目录，给 server-setup.sh 取用
  mkdir -p /tmp/print3d-deploy
  cp /opt/print3d/app/deploy/print3d.service     /tmp/print3d-deploy/
  cp /opt/print3d/app/deploy/nginx-print3d.conf  /tmp/print3d-deploy/
  echo 解包完成
'
```

## 3. 初始化

```bash
ssh -i "$KEY" "$USER@$HOST" 'bash /opt/print3d/app/deploy/server-setup.sh'
```

脚本做的事：建 `print3d` 系统用户 → 装 Node 22 和 Nginx → 建数据目录 →
生成 `.env`（含随机 `SESSION_SECRET`）→ 装 systemd 服务 → 装 Nginx 站点 →
启动 → 配置每日备份 cron。

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

## 7. 以后补上 HTTPS

拿到已备案的域名后（大陆服务器**必须备案**，没备案的域名解析过来 80/443 会被拦）：

```bash
ssh -i "$KEY" "$USER@$HOST" '
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d 你的域名 --redirect
'
```

certbot 会自动改 Nginx 配置加 443 和跳转。然后**必须**做两件事：

```bash
ssh -i "$KEY" "$USER@$HOST" '
  sed -i "s/^COOKIE_SECURE=false/COOKIE_SECURE=true/" /opt/print3d/app/.env
  systemctl restart print3d
'
```

并把 `deploy/nginx-print3d.conf` 里的 `server_name` 从 IP 改成域名，重新上传。

`COOKIE_SECURE=false` 期间服务每次启动都会打一段醒目警告，进 `journalctl`。
**警告消失的那天，才说明这台机器真的上了 HTTPS。**

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

- **纯 HTTP**：见开头警告。上 HTTPS 之前不要录真实订单。
- **附件无异地备份**：和数据库同盘，盘挂了就一起没。
- **客户丢掉订单号无法自助找回**：这是「仅凭订单号」方案的固有代价。
  补救路径是管理员用 `/api/admin/lookup-by-phone` 按电话代查后重新发给客户。
- **备份 cron 依赖服务器自身**：服务器长期关机时不会补跑。
