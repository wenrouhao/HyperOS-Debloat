#!/system/bin/sh

# 开机后执行应用卸载/恢复
# /product、/system_ext 等分区无法被挂载遮蔽，统一用 pm 兜底

MODPATH=${0%/*}
CONF="$MODPATH/webroot/apps.conf"
STATE="$MODPATH/.pm_applied"
REMOVED="$MODPATH/.pm_removed"
LOG="$MODPATH/webroot/debug.log"
DEBUG_FLAG="$MODPATH/webroot/.debug_on"

[ -f "$CONF" ] || exit 0
[ -f "$MODPATH/pkg_map.sh" ] && . "$MODPATH/pkg_map.sh"

# 日志开关由 WebUI 写入的标志文件控制
dbg() {
  [ -f "$DEBUG_FLAG" ] || return 0
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

# 清除已取消精简的遮蔽目录
# 遮蔽目录在开机时已被挂载，必须先卸载再删除，否则 rm 会失败、下次开机仍被遮蔽
cleanup_dirs() {
  while IFS='|' read -r _p _n _pkg _st _g _m _w; do
    _p="${_p%$(printf '\r')}"
    [ -z "$_p" ] && continue
    case "$_p" in \#*|apex:*|pm:*) continue ;; esac
    [ "$_st" = "1" ] && continue
    _real=""
    for _c in $(echo "$_p" | tr ';' ' '); do
      case "$_c" in
        apex:*|pm:*) continue ;;
        *) _r=$(resolve_base "$_c") ;;
      esac
      if [ -e "$_r" ] || [ -d "$MODPATH$(module_rel "$_r")" ]; then
        _real="$_r"
        break
      fi
    done
    [ -z "$_real" ] && continue
    _md="$MODPATH$(module_rel "$_real")"
    [ -d "$_md" ] || continue
    umount -l "$_md" >/dev/null 2>&1
    rm -rf "$_md" 2>/dev/null
    dbg "cleanup $_md"
  done < "$CONF"
}

cleanup_dirs

# 配置未变化则跳过
hash=$(md5sum "$CONF" 2>/dev/null | cut -d' ' -f1)
[ -z "$hash" ] && hash=$(cksum "$CONF" 2>/dev/null | cut -d' ' -f1)
if [ -n "$hash" ] && [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$hash" ]; then
  exit 0
fi

# 等待系统启动完成，服务阶段过早调用 pm 会静默失败
n=0
while [ "$(getprop sys.boot_completed)" != "1" ] && [ "$n" -lt 60 ]; do
  sleep 2
  n=$((n + 1))
done

is_removed() {
  [ -f "$REMOVED" ] && grep -qxF "$1" "$REMOVED"
}

add_removed() {
  is_removed "$1" || echo "$1" >> "$REMOVED"
}

del_removed() {
  [ -f "$REMOVED" ] || return 0
  grep -vxF "$1" "$REMOVED" > "$REMOVED.tmp"
  mv "$REMOVED.tmp" "$REMOVED"
}

while IFS='|' read -r path name pkg status group mode warn; do
  path="${path%$(printf '\r')}"
  [ -z "$pkg" ] && continue
  case "$path" in \#*) continue ;; esac

  if [ "$status" = "1" ]; then
    if ! is_removed "$pkg"; then
      # 已被 .replace 遮蔽的应用不再永久卸载，避免删除模块后无法恢复
      # 注意：pm 必须重定向 stdin，否则在读取配置文件的循环中会 Failed transaction
      pm list packages --user 0 < /dev/null 2>/dev/null | grep -qxF "package:$pkg" || { dbg "skip pm uninstall $pkg (already hidden)"; continue; }
      pm uninstall -k --user 0 "$pkg" < /dev/null >/dev/null 2>&1
      rc=$?
      [ "$rc" = "0" ] && add_removed "$pkg"
      [ "$rc" = "0" ] || FAIL=1
      dbg "pm uninstall $pkg -> $rc"
    fi
  else
    if is_removed "$pkg"; then
      pm install-existing --user 0 "$pkg" < /dev/null >/dev/null 2>&1
      rc=$?
      [ "$rc" = "0" ] && del_removed "$pkg"
      [ "$rc" = "0" ] || FAIL=1
      dbg "pm install-existing $pkg -> $rc"
    fi
  fi
done < "$CONF"

# 有失败时不写入状态，下次开机重试
[ -n "$hash" ] && [ "$FAIL" != "1" ] && echo "$hash" > "$STATE"
