#!/usr/bin/env bash
# 喵喵零和小鱼的仓库 一键部署 / 更新脚本
#
#   curl -fsSL https://raw.githubusercontent.com/focalors215/miaomiao-pan/main/install.sh | bash
#
# 可以用环境变量调整（写在 bash 前面，如 curl ... | PAN_PORT=8090 bash）：
#   PAN_DIR          安装目录，默认 ~/miaomiao-pan
#   PAN_PORT         对外端口，默认 8080（只在首次安装时写进 .env）
#   ADMIN_USER       管理员用户名，默认 admin（只在首次安装时写进 .env）
#   ADMIN_PASSWORD   管理员密码，默认随机生成（只在首次安装时写进 .env）
#   PAN_BRANCH       使用的分支，默认 main
#
# 再次运行就是更新：拉取最新代码并重建容器，不动 .env 和 data/。
set -euo pipefail

REPO="focalors215/miaomiao-pan"
BRANCH="${PAN_BRANCH:-main}"
DIR="${PAN_DIR:-$HOME/miaomiao-pan}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m注意：\033[0m%s\n' "$*" >&2; }
die() { printf '\033[1;31m错误：\033[0m%s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# 通过 curl | bash 运行时标准输入是脚本本身，提问要从终端读
ask() {
  local reply=""
  if [ -r /dev/tty ]; then
    printf '%s [y/N] ' "$1" >/dev/tty
    read -r reply </dev/tty || true
  fi
  case "$reply" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

SUDO=""
if [ "$(id -u)" -ne 0 ] && have sudo; then SUDO="sudo"; fi

# ---------- Docker ----------
if ! have docker; then
  [ "$(uname -s)" = "Linux" ] || die "没有找到 Docker，请先安装 Docker Desktop：https://www.docker.com/products/docker-desktop/"
  warn "没有找到 Docker。"
  ask "用 Docker 官方脚本（get.docker.com）安装 Docker？需要 root 权限" || die "请先安装 Docker 后再运行本脚本：https://docs.docker.com/engine/install/"
  have curl || die "需要 curl 才能安装 Docker"
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
fi

# 当前用户不在 docker 组时借 sudo 执行
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then
    DOCKER="$SUDO docker"
  else
    die "Docker 没有运行，或当前用户没有权限访问 Docker（可以把用户加进 docker 组，或用 root 运行）"
  fi
fi

if $DOCKER compose version >/dev/null 2>&1; then
  COMPOSE="$DOCKER compose"
elif have docker-compose; then
  COMPOSE="docker-compose"
  [ "$DOCKER" = "docker" ] || COMPOSE="$SUDO docker-compose"
else
  die "没有找到 Docker Compose，请安装 docker-compose-plugin"
fi

# ---------- 代码 ----------
FRESH=1
[ -f "$DIR/.env" ] && FRESH=0

if [ -d "$DIR/.git" ] && have git; then
  info "更新代码：$DIR"
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" checkout -q -B "$BRANCH" FETCH_HEAD
elif [ ! -e "$DIR" ] && have git; then
  info "下载代码到 $DIR"
  git clone --depth 1 -b "$BRANCH" "https://github.com/$REPO.git" "$DIR"
else
  # 没有 git，或目录已存在但不是 git 仓库：下载压缩包覆盖代码（压缩包里没有 .env 和 data/，不会覆盖它们）
  have curl || die "需要 git 或 curl 才能下载代码"
  info "下载代码到 $DIR"
  mkdir -p "$DIR"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$DIR" --strip-components=1
fi
cd "$DIR"

# ---------- .env ----------
PASSWORD_SHOWN=""
if [ "$FRESH" = 1 ]; then
  PORT="${PAN_PORT:-8080}"
  if have ss && ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$PORT\$"; then
    die "端口 $PORT 已被占用，请换一个端口重新运行，例如：curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | PAN_PORT=8090 bash"
  fi
  USER_NAME="${ADMIN_USER:-admin}"
  PASSWORD="${ADMIN_PASSWORD:-$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)}"
  [ -z "${ADMIN_PASSWORD:-}" ] && PASSWORD_SHOWN="$PASSWORD"
  umask 077
  cat >.env <<EOF
ADMIN_USER=$USER_NAME
ADMIN_PASSWORD=$PASSWORD
# 忘记网页里改过的密码时，设为 true 重启即可用上面的账号密码重置，重置后改回 false
ADMIN_RESET=false
PAN_PORT=$PORT
EOF
  umask 022
  info "已生成 .env"
else
  PORT="$(sed -n 's/^PAN_PORT=//p' .env | tail -n 1)"
  PORT="${PORT:-8080}"
  USER_NAME="$(sed -n 's/^ADMIN_USER=//p' .env | tail -n 1)"
  info "保留现有的 .env 和 data/"
fi

# ---------- 启动 ----------
info "构建并启动容器（首次构建需要几分钟）"
$COMPOSE up -d --build

info "等待服务启动"
ok=0
have curl || ok=1
for _ in $(seq 1 60); do
  [ "$ok" = 1 ] && break
  if curl -fs "http://127.0.0.1:$PORT/api/site" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || warn "60 秒内没有等到服务响应，可以用 cd $DIR && $COMPOSE logs 查看日志"

IP=""
if have hostname; then IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
IP="${IP:-服务器IP}"

echo
info "部署完成"
echo "  访问地址：http://$IP:$PORT"
if [ "$FRESH" = 1 ]; then
  echo "  管理员：  ${USER_NAME:-admin}"
  if [ -n "$PASSWORD_SHOWN" ]; then
    echo "  密码：    $PASSWORD_SHOWN"
    echo "  （密码保存在 $DIR/.env，登录后可以在网页右上角修改）"
  fi
else
  echo "  已更新到最新版本，账号和数据不变"
fi
echo "  安装目录：$DIR"
