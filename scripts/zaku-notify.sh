#!/usr/bin/env bash
# zaku-notify.sh — DesktopPet 桌宠 Hook 通知脚本

set -euo pipefail

PENDING_FLAG="/tmp/zaku_claude_pending"
TASK_DONE_FLAG="/tmp/zaku_task_done"
TASK_DONE_MSG="目标已锁定，请指示"

SUBCMD="${1:-}"

get_tty_line() {
  local parent_pid="${1:-}"
  local tty
  tty=$(ps -o tty= -p "$parent_pid" 2>/dev/null | tr -d ' ' || true)
  echo "/dev/$tty"
}

# ── 不触发 VF-1 告警的工具白名单 ─────────────────────────────────────────
SKIP_TOOLS="TaskCreate|TaskUpdate|TaskList|TaskGet|TaskStop|TaskOutput|ScheduleWakeup|CronCreate|CronDelete|CronList|ExitPlanMode|EnterPlanMode|LSP|NotebookEdit"

case "$SUBCMD" in
  pending)
    parent_pid="${2:-$$}"

    # 读 stdin JSON, 提取关键字段:
    #   tool_name        — 工具名
    #   permission_mode  — 会话权限模式 (bypassPermissions = 全自动, 不弹框)
    #   suggestion_behavior — permission_suggestions[0].behavior ("allow" = 已建议自动放行)
    if command -v python3 &>/dev/null; then
      read -r tool_name permission_mode suggestion_behavior <<< "$(python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    tool = data.get('tool_name', '')
    pmode = data.get('permission_mode', '')
    # permission_suggestions 是数组, 取第一条的 behavior
    suggestions = data.get('permission_suggestions', [])
    sbehavior = suggestions[0].get('behavior', '') if suggestions else ''
    print(tool, pmode, sbehavior)
except:
    print('', '', '')
" 2>/dev/null || echo "  ")"
    else
      tool_name=""; permission_mode=""; suggestion_behavior=""
    fi

    # 1) 内部工具白名单 → 不需要用户介入, 跳过
    if echo "$tool_name" | grep -qE "^($SKIP_TOOLS)$"; then
      exit 0
    fi

    # 2) bypassPermissions 模式 → 全部自动通过, 不弹任何框, 跳过
    if [ "$permission_mode" = "bypassPermissions" ]; then
      exit 0
    fi

    # ℹ️ suggestion_behavior ("allow") 只是 Claude Code 建议把命令加到 allow list,
    # 不代表它已经自动放行 —— 真实确认框依然会弹. 不能用这个字段来跳过.

    get_tty_line "$parent_pid" > "$PENDING_FLAG"
    ;;

  pending-clear)
    rm -f "$PENDING_FLAG"
    ;;

  task-done)
    parent_pid="${2:-$$}"
    {
      get_tty_line "$parent_pid"
      echo "$TASK_DONE_MSG"
    } > "$TASK_DONE_FLAG"
    ;;

  *)
    echo "Usage: $0 {pending|pending-clear|task-done} [parent_pid]" >&2
    exit 1
    ;;
esac
