#!/bin/zsh
# Reme 全链路演示一键启动：A 感知(8770) + B 决策(8100) + 前端(4174)。
# 首次运行自动装依赖；Ctrl+C 一并退出三个服务。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say_step() { echo "\n\033[1;36m==> $1\033[0m"; }

# ---------- 0. 工具检查 ----------
command -v uv >/dev/null || { echo "缺 uv：brew install uv"; exit 1; }
command -v npm >/dev/null || { echo "缺 npm：先安装 Node.js（brew install node）"; exit 1; }

# ---------- 1. 依赖 ----------
say_step "第一步：安装/同步依赖"
uv sync --quiet && echo "后端依赖 OK（uv sync）"
if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install)
else
  echo "前端依赖 OK（node_modules 已在，需强制重装请删掉它）"
fi

# ---------- 2. API 配置 ----------
say_step "第二步：MiMo API 配置"
MIMO_ENV="$HOME/.config/reme/mimo.env"
if [ -f "$MIMO_ENV" ]; then
  source "$MIMO_ENV"
  echo "已加载 $MIMO_ENV（语音意图/视觉确认可用）"
else
  echo "⚠ 未找到 $MIMO_ENV —— B 以无 key 模式运行："
  echo "  跌倒询问/倒计时/告警等规则链路全部可用；语音意图与原图确认会降级。"
  echo "  配置方法见 docs/快速启动.md 第二步。"
fi

# ---------- 3. 清理旧进程并启动 ----------
say_step "第三步：启动三个服务"
pkill -f "reme.pose.runtime_server" 2>/dev/null
pkill -f "reme-decision-server" 2>/dev/null
lsof -ti :4174 | xargs kill 2>/dev/null
sleep 1

uv run python -m reme.pose.runtime_server --host 127.0.0.1 --port 8770 >/tmp/reme-a.log 2>&1 &
A_PID=$!
uv run reme-decision-server --port 8100 --no-audit >/tmp/reme-b.log 2>&1 &
B_PID=$!
(cd frontend && npm run dev >/tmp/reme-vite.log 2>&1) &
VITE_PID=$!

cleanup() {
  echo "\n正在停止服务…"
  kill $A_PID $B_PID $VITE_PID 2>/dev/null
  pkill -f "reme.pose.runtime_server" 2>/dev/null
  pkill -f "reme-decision-server" 2>/dev/null
  lsof -ti :4174 | xargs kill 2>/dev/null
  exit 0
}
trap cleanup INT TERM

for _ in {1..30}; do
  A_OK=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8770/api/health 2>/dev/null)
  B_OK=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8100/api/health 2>/dev/null)
  F_OK=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4174/ 2>/dev/null)
  [ "$A_OK" = "200" ] && [ "$B_OK" = "200" ] && [ "$F_OK" = "200" ] && break
  sleep 1
done

echo ""
echo "  A 感知   http://127.0.0.1:8770  [$A_OK]"
echo "  B 决策   http://127.0.0.1:8100  [$B_OK]"
echo "  前端     http://127.0.0.1:4174  [$F_OK]"
echo ""
if [ "$A_OK" = "200" ] && [ "$B_OK" = "200" ] && [ "$F_OK" = "200" ]; then
  echo "✅ 全部就绪，已打开双设备演示页（场景四=真实决策流）"
  open "http://127.0.0.1:4174/typical-demo.html"
else
  echo "⚠ 有服务未就绪，日志：/tmp/reme-a.log /tmp/reme-b.log /tmp/reme-vite.log"
fi
echo "按 Ctrl+C 停止全部服务。"
wait
