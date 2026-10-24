#!/system/bin/sh

# 环境变量兜底（部分管理器不导出 MODPATH）
[ -z "$MODPATH" ] && MODPATH=${0%/*}

# 加载包名映射与路径解析
[ -f "$MODPATH/pkg_map.sh" ] && . "$MODPATH/pkg_map.sh"

APPS_CONF="$MODPATH/webroot/apps.conf"
RECORD_FILE="$MODPATH/.debloat_record"
APPS_DB="$MODPATH/apps.db"

# 从 apps.db 同步 apps.conf（新增应用默认保留，已有应用保留用户设置）
if [ -f "$APPS_DB" ]; then
  # 读取旧配置的状态（按包名索引，包名为空时按候选路径）
  OLD_STATUS=""
  if [ -f "$APPS_CONF" ]; then
    while IFS='|' read -r _p _n _pkg _st _g _m _w; do
      _p="${_p%$(printf '\r')}"
      [ -z "$_p" ] && continue; case "$_p" in \#*) continue ;; esac
      _key="$_pkg"; [ -z "$_key" ] && _key="$_p"
      OLD_STATUS="$OLD_STATUS
$_key=$_st"
    done < "$APPS_CONF"
  fi

  # 从 apps.db 生成新配置，保留旧状态
  TMP_CONF="$MODPATH/webroot/apps.conf.tmp"
  conf_header "$TMP_CONF"

  DB_PKGS=$(db_pkg_list)
  while IFS= read -r line; do
    pkg=$(cfg_field "$line" 3)
    path=$(cfg_field "$line" 1)
    # 查找旧状态，默认 0（保留）
    status=0
    _key="$pkg"; [ -z "$_key" ] && _key="$path"
    old=$(echo "$OLD_STATUS" | grep "^$_key=" | tail -1)
    [ -n "$old" ] && status="${old#*=}"
    conf_emit "$line" "$status" >> "$TMP_CONF"
  done <<EOF
$(cfg_rows)
EOF

  # 保留旧 apps.conf 中的自定义应用（按包名精确去重）
  conf_append_custom "$APPS_CONF" "$DB_PKGS" >> "$TMP_CONF"

  mv "$TMP_CONF" "$APPS_CONF"
fi

# apps.conf 不存在则跳过
[ -f "$APPS_CONF" ] || exit 0

# 缓存上次的遮蔽目录（用于判断路径是否被本模块自身遮蔽）
OLD_RECORD=""
[ -f "$RECORD_FILE" ] && OLD_RECORD=$(cat "$RECORD_FILE")

# 路径是否在本次开机前被本模块遮蔽（此时挂载视图里目标目录不可见）
was_replaced() {
  [ -n "$OLD_RECORD" ] || return 1
  echo "$OLD_RECORD" | grep -qxF "$MODPATH$(module_rel "$1")"
}

# 开机阶段解析候选路径：真实存在、模块内已有遮蔽目录、或上次已遮蔽都算有效
resolve_boot() {
  for _c in $(echo "$1" | tr ';' ' '); do
    case "$_c" in
      apex:*|pm:*) echo "$_c"; return 0 ;;
    esac
    _r=$(resolve_base "$_c")
    if [ -e "$_r" ] || [ -e "$MODPATH$(module_rel "$_r")" ] || was_replaced "$_r"; then
      echo "$_r"
      return 0
    fi
  done
  return 1
}

# 清除上次创建的 REPLACE 目录（只清理模块内的目录）
if [ -f "$RECORD_FILE" ]; then
  while IFS= read -r dir; do
    case "$dir" in
      "$MODPATH"/*) [ -d "$dir" ] && { umount -l "$dir" >/dev/null 2>&1; rm -rf "$dir" 2>/dev/null; } ;;
    esac
  done < "$RECORD_FILE"
fi

# 读取 apps.conf，创建 REPLACE 目录（卸载/恢复由 service.sh 在开机后执行）
: > "$RECORD_FILE"
while IFS='|' read -r path name pkg status group mode warn; do
  path="${path%$(printf '\r')}"
  [ -z "$path" ] && continue
  case "$path" in \#*) continue ;; esac

  real=$(resolve_boot "$path") || continue

  # APEX/pm: 应用不生成目录
  case "$real" in
    apex:*|pm:*) continue ;;
  esac

  [ "$status" = "1" ] || continue

  mod_dir="$MODPATH$(module_rel "$real")"
  mkdir -p "$mod_dir"
  touch "$mod_dir/.replace"
  echo "$mod_dir" >> "$RECORD_FILE"
done < "$APPS_CONF"
