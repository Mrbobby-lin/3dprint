#!/usr/bin/env bash
#
# B&O 订单管理系统 —— 给这台只有 IP 的机器上 HTTPS
#
# 用法（在服务器上，root）：
#
#   bash /opt/print3d/app/deploy/setup-https.sh              # 正式签发
#   bash /opt/print3d/app/deploy/setup-https.sh --staging     # 演练，不装 443
#
# 做四件事：
#   1. 装 certbot（必须是 5.4+，Debian 源里的 4.0.0 不认 IP 证书）
#   2. 用 HTTP-01 挑战签一张 150.158.18.245 的证书（shortlived profile，160 小时）
#   3. 证书到手后才装 443 的 Nginx 配置 —— 顺序反了 nginx 会起不来
#   4. 装续期定时任务
#
# 本脚本**不会**做这两件事，它们要等腾讯云安全组放行 443 之后单独做：
#   - 把 80 改成跳转 443（见 nginx-print3d.conf 里注释掉的那段）
#   - 把 .env 的 COOKIE_SECURE 改成 true
# 提前做了而外网 443 不通，结果就是谁都打不开站 —— 见 README 第 7 节。

set -euo pipefail

IP=150.158.18.245
EMAIL="${CERTBOT_EMAIL:-2479915051@qq.com}"
APP_DIR=/opt/print3d/app
CERTBOT=/opt/certbot/bin/certbot
WEBROOT=/var/www/certbot
CERT_NAME="$IP"
LIVE_DIR="/etc/letsencrypt/live/$CERT_NAME"
TLS_DST=/etc/nginx/conf.d/print3d-tls.conf
NGINX_SITE=/etc/nginx/conf.d/print3d.conf
PIP_MIRROR=https://mirrors.tencentyun.com/pypi/simple/

STAGING=0
[ "${1:-}" = "--staging" ] && STAGING=1

# 演练模式必须用另一个证书名。否则 staging 的证书会落在
# /etc/letsencrypt/live/150.158.18.245/ —— 也就是正式路径，
# 之后正式跑一次会看到"证书已存在"直接跳过签发，然后把 443 配上这张
# 浏览器不信任的证书。这个错误不会报错，只会让所有人看到证书警告。
if [ "$STAGING" -eq 1 ]; then
  CERT_NAME="$IP-staging"
  LIVE_DIR="/etc/letsencrypt/live/$CERT_NAME"
fi

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行"

# ---------------------------------------------------------------------------
log "1/6 检查 certbot（IP 证书需要 5.4+）"
# ---------------------------------------------------------------------------
need_certbot=1
if [ -x "$CERTBOT" ]; then
  ver=$("$CERTBOT" --version 2>/dev/null | awk '{print $2}')
  # 只比较主次版本：5.4 才支持 webroot + IP，直接用字符串比较会踩 "5.10" < "5.4"
  major=${ver%%.*}
  minor=$(echo "$ver" | cut -d. -f2)
  if [ "$major" -gt 5 ] || { [ "$major" -eq 5 ] && [ "$minor" -ge 4 ]; }; then
    echo "已有 certbot $ver"
    need_certbot=0
  else
    echo "certbot $ver 太老（需要 5.4+），重装"
  fi
fi

if [ "$need_certbot" -eq 1 ]; then
  # Debian 13 源里是 4.0.0，没有 --ip-address，用不了。
  # 走官方推荐的 venv + pip 安装；PyPI 直连在大陆节点上时通时不通，
  # 用腾讯云内网镜像。
  command -v python3 >/dev/null || die "没有 python3"
  if [ ! -d /opt/certbot ]; then
    apt-get update -qq
    apt-get install -y -qq python3-venv
    python3 -m venv /opt/certbot
  fi
  "$CERTBOT" --version >/dev/null 2>&1 || true
  /opt/certbot/bin/pip install -q --index-url "$PIP_MIRROR" \
    --trusted-host mirrors.tencentyun.com --upgrade pip certbot
  ln -sf "$CERTBOT" /usr/local/bin/certbot
  echo "已安装 certbot $("$CERTBOT" --version | awk '{print $2}')"
fi

"$CERTBOT" --help all 2>/dev/null | grep -q -- '--ip-address' \
  || die "这个 certbot 没有 --ip-address，签不了 IP 证书"

# ---------------------------------------------------------------------------
log "2/6 检查 ACME 挑战目录能真的被访问到"
# ---------------------------------------------------------------------------
# 关键的前置检查：如果 nginx 没有正确地把 /.well-known/acme-challenge/ 指到
# webroot，签发会失败。而失败的代价是实打实的 —— 同一组标识符每 7 天只能签 5 次。
# 所以先放一个文件、自己取一次，确认通了再去花配额。
mkdir -p "$WEBROOT/.well-known/acme-challenge"
echo "preflight-ok" > "$WEBROOT/.well-known/acme-challenge/preflight-test"

check_challenge() {
  local out
  out=$(curl -sS -m 10 -H "Host: $IP" "http://$1/.well-known/acme-challenge/preflight-test" 2>&1)
  [ "$out" = "preflight-ok" ]
}
check_challenge 127.0.0.1 || die "经 nginx 取不到挑战文件，先确认 $NGINX_SITE 里有 acme-challenge 的 location"
echo "本机经 nginx 取到挑战文件 ✓"
if check_challenge "$IP"; then
  echo "经公网 IP 取到挑战文件 ✓（80 端口外部可达）"
else
  echo "⚠ 经公网 IP 取不到 —— 若签发失败，先查腾讯云安全组的 80 端口"
fi
rm -f "$WEBROOT/.well-known/acme-challenge/preflight-test"

# ---------------------------------------------------------------------------
log "3/6 签发证书"
# ---------------------------------------------------------------------------
if [ -f "$LIVE_DIR/fullchain.pem" ] && [ "$STAGING" -eq 0 ]; then
  echo "证书已存在，跳过签发："
  openssl x509 -in "$LIVE_DIR/fullchain.pem" -noout -dates -ext subjectAltName | sed 's/^/  /'
else
  [ "$STAGING" -eq 1 ] && echo "演练模式：用 staging 环境，签出来的证书浏览器不信任，也不会装 443 配置"
  STAGING_ARG=""
  [ "$STAGING" -eq 1 ] && STAGING_ARG="--staging"

  # --preferred-profile shortlived 是必须的：Let's Encrypt 只在这个 profile 下
  # 给 IP 地址签证书（有效期 160 小时）。不加这个参数会被直接拒绝。
  # --cert-name 固定成 IP，好让下面两个证书路径是可预测的。
  "$CERTBOT" certonly \
    --webroot -w "$WEBROOT" \
    --ip-address "$IP" \
    --cert-name "$CERT_NAME" \
    --preferred-profile shortlived \
    --non-interactive --agree-tos --no-eff-email \
    --email "$EMAIL" \
    $STAGING_ARG

  echo "签发结果："
  openssl x509 -in "$LIVE_DIR/fullchain.pem" -noout -dates -ext subjectAltName | sed 's/^/  /'
fi

if [ "$STAGING" -eq 1 ]; then
  log "演练结束（--staging）"
  # 顺手删掉，免得它在 certbot certificates 里留着、日后被误当成正式证书。
  "$CERTBOT" delete --cert-name "$CERT_NAME" --non-interactive 2>/dev/null || true
  echo "演练用的证书已删除。上面流程没问题的话，去掉 --staging 正式跑一次。"
  exit 0
fi

# ---------------------------------------------------------------------------
log "4/6 安装 443 的 Nginx 配置"
# ---------------------------------------------------------------------------
# 到这一步证书已经在了，所以 ssl_certificate 指向的文件读得到。
[ -f "$APP_DIR/deploy/nginx-print3d-tls.conf" ] || die "缺少 deploy/nginx-print3d-tls.conf"
install -m 644 "$APP_DIR/deploy/nginx-print3d-tls.conf" "$TLS_DST"

# nginx -t 不过就把文件撤掉再报错。不这么写的话，配置留在地上，
# 下次 nginx 重启（或机器重启）时才会炸 —— 那时没人能把这个文件联想到一起。
if ! nginx -t 2>&1 | sed 's/^/  /'; then
  rm -f "$TLS_DST"
  die "Nginx 配置检查失败，已回滚 $TLS_DST"
fi
systemctl reload nginx
echo "Nginx 已重载，443 已监听"

# ---------------------------------------------------------------------------
log "5/6 装续期定时任务"
# ---------------------------------------------------------------------------
# 一天跑两次，但 certbot 自己只在剩余寿命不足 1/3 时才真的续 ——
# 160 小时的证书大约每 4.4 天续一次，也就是每周约 1.3 次。
# 同一组标识符的配额是每周 5 次，所以这个频率是安全的，别再调密。
# --deploy-hook 只在真的续成功后执行，所以平时不会平白 reload nginx。
cat > /etc/cron.d/print3d-cert-renew <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# 04:23 和 16:23 —— 避开整点和备份任务，见同名备份任务里的说明
23 4,16 * * * root $CERTBOT renew --quiet --deploy-hook 'systemctl reload nginx' >> /var/log/print3d-cert.log 2>&1
EOF
chmod 644 /etc/cron.d/print3d-cert-renew
touch /var/log/print3d-cert.log
echo "已写入 /etc/cron.d/print3d-cert-renew（每天 04:23 / 16:23）"

# ---------------------------------------------------------------------------
log "6/6 自检"
# ---------------------------------------------------------------------------
echo "从本机经 HTTPS 访问首页："
# --resolve 把 IP 指到 127.0.0.1 上，这样测的是"nginx + 证书"本身，
# 不经过公网。**不能直接 curl https://$IP/** —— 实测在腾讯云上，
# 从机器访问自己的公网 IP 仍然要过安全组，443 没放行时永远超时，
# 把"配置没问题"误报成失败。外网可达性只能在你自己电脑上测。
code=$(curl -sS -m 10 --resolve "$IP:443:127.0.0.1" -o /dev/null -w '%{http_code}' "https://$IP/") || true
echo "  HTTP $code"
[ "$code" = "200" ] || die "HTTPS 自检失败（返回 $code），看 journalctl -u nginx 和 nginx -t"

# 证书链要能被系统信任库验过（0 = 通过）。这里验不过说明 fullchain 有问题，
# 浏览器会直接报证书错误。
verify=$(curl -sS -m 10 --resolve "$IP:443:127.0.0.1" -o /dev/null -w '%{ssl_verify_result}' "https://$IP/") || true
[ "$verify" = "0" ] || die "证书链校验失败（ssl_verify_result=$verify）"
echo "证书链校验通过 ✓"

echo "证书有效期："
openssl x509 -in "$LIVE_DIR/fullchain.pem" -noout -dates -ext subjectAltName | sed 's/^/  /'

cat <<'DONE'

────────────────────────────────────────────────────────────────────
HTTPS 已经在本机跑起来了。但还差最后两步，而且必须等外网 443 通：

  0. 腾讯云控制台 → 安全组放行 443（这一步在网页控制台做，不在服务器上）

  1. 把 80 改成跳转 443：
       /etc/nginx/conf.d/print3d.conf 里注释掉的那段 if (...) return 302 取消注释
       nginx -t && systemctl reload nginx

  2. 把 cookie 标记成 Secure：
       sed -i 's/^COOKIE_SECURE=false/COOKIE_SECURE=true/' /opt/print3d/app/.env
       systemctl restart print3d

这两步会有几分钟的窗口：没做完之前，站点照常走 HTTP，不影响使用。
提前做完而外网 443 不通，则谁都打不开 —— 所以顺序不能反。
详细说明和验证办法见 deploy/README.md 第 7 节。
────────────────────────────────────────────────────────────────────
DONE
