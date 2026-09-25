#!/usr/bin/env bash
#
# 服务器一次性初始化。以 root 在目标机器上执行：
#
#   bash /tmp/print3d-deploy/server-setup.sh
#
# 前提：应用代码已经放在 /opt/print3d/app，且 print3d.service 与
#       nginx-print3d.conf 已一并上传到 /tmp/print3d-deploy/。
#
# 本脚本是幂等的，可以重复执行。它不会覆盖已存在的 .env ——
# 重新执行不会把 SESSION_SECRET 换掉（换了所有登录会话都会失效）。

set -euo pipefail

APP_DIR=/opt/print3d/app
DATA_DIR=/var/lib/print3d
STAGE_DIR=/tmp/print3d-deploy
ENV_FILE="$APP_DIR/.env"
SERVICE_NAME=print3d
NGINX_SITE=/etc/nginx/conf.d/print3d.conf

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行"
[ -d "$APP_DIR" ] || die "$APP_DIR 不存在，请先上传代码"

# ---------------------------------------------------------------------------
log "1/8 创建系统用户"
# ---------------------------------------------------------------------------
# 系统用户（--system），无登录 shell。服务不以 root 跑 ——
# 万一边界被突破，攻击者拿到的也只是这个什么都干不了的账号。
if id print3d >/dev/null 2>&1; then
  echo "用户 print3d 已存在，跳过"
else
  # nologin 的位置各家发行版不一样（Debian 在 /usr/sbin，RHEL 在 /sbin）
  NOLOGIN=/bin/false
  for c in /usr/sbin/nologin /sbin/nologin /bin/false; do
    if [ -x "$c" ]; then NOLOGIN=$c; break; fi
  done
  useradd --system --shell "$NOLOGIN" --home-dir /nonexistent print3d
  echo "已创建用户 print3d（shell=$NOLOGIN）"
fi

# ---------------------------------------------------------------------------
log "2/8 安装 Node.js 22"
# ---------------------------------------------------------------------------
if command -v node >/dev/null 2>&1 && node -e 'process.exit(process.versions.node.split(".")[0] >= 22 ? 0 : 1)'; then
  echo "已安装 $(node -v)，跳过"
else
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  else
    die "不认识的发行版，请手动安装 Node 22 后重跑本脚本"
  fi
  echo "已安装 $(node -v)"
fi

# node:sqlite 需要 22.5+，低版本会在启动时才报错，这里提前拦住。
# 主次版本要一起判：只看次版本的话 20.10 会被误判成合规。
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1);
' || die "Node 版本过低（node:sqlite 需要 >= 22.5，当前 $(node -v)）"

# ---------------------------------------------------------------------------
log "3/8 创建数据目录"
# ---------------------------------------------------------------------------
# 数据放在 /var/lib/print3d，和代码目录分开。
# 这样以后重新发布代码（覆盖 /opt/print3d/app）永远碰不到数据库和附件。
mkdir -p "$DATA_DIR/storage/tmp" "$DATA_DIR/backups"
chown -R print3d:print3d "$DATA_DIR"
chmod 750 "$DATA_DIR"
echo "数据目录：$DATA_DIR"

# ---------------------------------------------------------------------------
log "4/8 生成 .env"
# ---------------------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  echo ".env 已存在，保留不动（换 SESSION_SECRET 会让所有登录会话失效）"
else
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cat > "$ENV_FILE" <<EOF
# 由 deploy/server-setup.sh 生成于 $(date -Is)
NODE_ENV=production
PORT=3000
HOST=127.0.0.1

DB_FILE=$DATA_DIR/app.db
STORAGE_DIR=$DATA_DIR/storage

SESSION_SECRET=$SECRET

# 首次注册完管理员后，务必改成 false 并重启 —— 见 deploy/README.md 第 5 步。
# 改成 false 后 /api/auth/register 直接返回 404。
ALLOW_ADMIN_REGISTRATION=true

# 当前是纯 HTTP 部署（只有 IP，没有证书），必须关掉 cookie 的 Secure 标志，
# 否则浏览器不会回传 cookie，登录会表现为"接口成功但立刻 401"。
# 拿到 HTTPS 证书后改回 true。服务启动时会就此打警告。
COOKIE_SECURE=false

# 反代信任层级。本机 Nginx 反代，必须是 loopback，不要改成 true
TRUST_PROXY=loopback

MAX_UPLOAD_BYTES=20971520
MAX_ORDER_ATTACHMENT_BYTES=209715200
STORAGE_WATERMARK_PERCENT=90
EOF
  chown print3d:print3d "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "已生成 $ENV_FILE（权限 600）"
fi

# ---------------------------------------------------------------------------
log "5/8 安装依赖并装 systemd 服务"
# ---------------------------------------------------------------------------
[ -f "$STAGE_DIR/$SERVICE_NAME.service" ] || die "缺少 $STAGE_DIR/$SERVICE_NAME.service"

cd "$APP_DIR"
# Windows 上打包过来的脚本可能带 CRLF，bash 会报 "\r: command not found"。
# 这类错误看着完全不像换行符问题，提前统一掉。
find "$APP_DIR" -name '*.sh' -exec sed -i 's/\r$//' {} + 2>/dev/null || true

# 从项目根安装。生产环境不需要 devDependencies。
npm install --omit=dev --no-audit --no-fund \
  --registry=https://registry.npmmirror.com

chown -R print3d:print3d "$APP_DIR"

install -m 644 "$STAGE_DIR/$SERVICE_NAME.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
echo "已安装 systemd 服务"

# ---------------------------------------------------------------------------
log "6/8 安装 Nginx 站点配置"
# ---------------------------------------------------------------------------
if ! command -v nginx >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get install -y -qq nginx
  else
    dnf install -y nginx
  fi
fi

[ -f "$STAGE_DIR/nginx-print3d.conf" ] || die "缺少 $STAGE_DIR/nginx-print3d.conf"
install -m 644 "$STAGE_DIR/nginx-print3d.conf" "$NGINX_SITE"

# 发行版自带的默认站点也监听 80 且是 default_server，会和我们的兜底 server
# 冲突（nginx 会报 duplicate default server 起不来）。必须让位。
if [ -e /etc/nginx/sites-enabled/default ]; then
  rm -f /etc/nginx/sites-enabled/default
  echo "已移除发行版默认站点"
fi

nginx -t
systemctl enable nginx >/dev/null
systemctl restart nginx
echo "Nginx 已配置并重启"

# ---------------------------------------------------------------------------
log "7/8 启动应用服务"
# ---------------------------------------------------------------------------
systemctl restart "$SERVICE_NAME"
sleep 2

if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "--- 服务未能启动，最近日志 ---"
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager
  die "服务启动失败"
fi

echo "本机健康检查："
curl -fsS "http://127.0.0.1:3000/api/health" && echo

# ---------------------------------------------------------------------------
log "8/8 配置每日备份"
# ---------------------------------------------------------------------------
# 备份是唯一能在"数据库被误删/损坏"时救命的东西，必须自动化。
# 注意：备份只含数据库，附件在 storage/ 里，恢复时两者要一起还原。
cat > /etc/cron.d/print3d-backup <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# 每天 03:17 —— 刻意避开整点，免得和别的定时任务抢 IO
17 3 * * * print3d cd $APP_DIR && /usr/bin/node --disable-warning=ExperimentalWarning scripts/backup.js >> /var/log/print3d-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/print3d-backup
touch /var/log/print3d-backup.log
chown print3d:print3d /var/log/print3d-backup.log
echo "已写入 /etc/cron.d/print3d-backup"

cat <<'DONE'

────────────────────────────────────────────────────────────────────
初始化完成。接下来还有两步必须做，见 deploy/README.md：

  1. 确认腾讯云安全组放行了 80 端口（这一步在控制台，不在服务器上）
  2. 立刻注册管理员，然后把 ALLOW_ADMIN_REGISTRATION 改成 false 并重启

第 2 步之前，任何人都能抢先注册掉唯一的管理员账号。
────────────────────────────────────────────────────────────────────
DONE
