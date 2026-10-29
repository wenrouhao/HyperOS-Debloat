#!/system/bin/sh

# 应用数据库文件路径
[ -z "$APPS_DB" ] && APPS_DB="$MODPATH/apps.db"

# 输出有效配置行（去 CR、去注释、去空行）
cfg_rows() {
  [ -f "$APPS_DB" ] || return 0
  tr -d '\r' < "$APPS_DB" | while IFS= read -r _line; do
    case "$_line" in \#*|"") continue ;; esac
    echo "$_line"
  done
}

# 取某一列
# 参数：行内容 列号
cfg_field() {
  echo "$1" | cut -d'|' -f"$2"
}

# 把 /system/product、/system/system_ext 归一为真实分区路径
# 参数：候选路径
resolve_base() {
  case "$1" in
    /system/product/*)
      if [ -L /system/product ]; then echo "/product${1#/system/product}"; return; fi ;;
    /system/system_ext/*)
      if [ -L /system/system_ext ]; then echo "/system_ext${1#/system/system_ext}"; return; fi ;;
  esac
  echo "$1"
}

# 在候选路径中取第一个真实存在的路径
# apex:/pm: 前缀原样返回
# 参数：候选路径（分号分隔）
resolve_path() {
  _first=""
  for _c in $(echo "$1" | tr ';' ' '); do
    case "$_c" in
      apex:*|pm:*) echo "$_c"; return ;;
    esac
    [ -z "$_first" ] && _first="$_c"
    _real=$(resolve_base "$_c")
    if [ -e "$_real" ]; then echo "$_real"; return; fi
  done
  resolve_base "$_first"
}

# 把真实分区路径转换为模块内的相对路径
# 元模块只扫描模块的 system 目录，独立分区需写成 system/product、system/system_ext 等
# 参数：真实路径（如 /product/app/Foo）
module_rel() {
  case "$1" in
    /system/*) echo "$1" ;;
    /*) echo "/system$1" ;;
    *) echo "$1" ;;
  esac
}

# 旧 4 列兼容：按分组推导模式
# 参数：分组名
cfg_level() {
  case "$1" in
    广告/追踪|游戏中心) echo 1 ;;
    设备互联/生态) echo 2 ;;
    AI/小爱|内容/工具/安全|系统服务|无障碍/宏) echo 3 ;;
    *) echo 0 ;;
  esac
}

# 取配置行的精简模式（无第 5 列时按分组推导）
# 参数：行内容
row_level() {
  _lvl=$(cfg_field "$1" 5)
  if [ -n "$_lvl" ]; then echo "$_lvl"; else cfg_level "$(cfg_field "$1" 4)"; fi
}

# 判断配置行是否匹配给定目录名
# 参数：目录名 行内容
row_match() {
  _want="$1"
  for _c in $(echo "$2" | cut -d'|' -f1 | tr ';' ' '); do
    case "$_c" in
      apex:*) _b="$_c" ;;
      *) _b=$(basename "$_c" 2>/dev/null) ;;
    esac
    [ "$_b" = "$_want" ] && return 0
    _r=$(resolve_path "$_c")
    case "$_r" in
      apex:*|pm:*) _b="$_r" ;;
      *) _b=$(basename "$_r" 2>/dev/null) ;;
    esac
    [ "$_b" = "$_want" ] && return 0
  done
  return 1
}

# 按目录名查找字段
# 参数：应用路径 列号 默认值
row_lookup() {
  _folder=$(basename "$1" 2>/dev/null)
  [ -z "$_folder" ] && { echo "$3"; return; }
  while IFS= read -r _line; do
    if row_match "$_folder" "$_line"; then
      cfg_field "$_line" "$2"
      return
    fi
  done <<EOF
$(cfg_rows)
EOF
  echo "$3"
}

# 从 apps.db 获取包名
# 参数：应用路径
get_pkg_name() {
  row_lookup "$1" 3 ""
}

# 从 apps.db 获取所有分组名（按出现顺序，去重）
get_all_groups() {
  _seen=" "
  cfg_rows | cut -d'|' -f4 | while IFS= read -r _group; do
    [ -z "$_group" ] && continue
    case "$_seen" in
      *" $_group "*) continue ;;
    esac
    _seen="$_seen$_group "
    echo "$_group"
  done
}

# 写入配置文件表头
# 参数：输出文件
conf_header() {
  echo "# HyperOS Debloat 配置" > "$1"
  echo "# 格式：候选路径|显示名|包名|状态（1=精简 0=保留）|分组|模式|警告文案" >> "$1"
}

# 输出一行规范化的配置行
# 参数：apps.db 行内容 状态（0/1）
conf_emit() {
  echo "$(cfg_field "$1" 1)|$(cfg_field "$1" 2)|$(cfg_field "$1" 3)|$2|$(cfg_field "$1" 4)|$(row_level "$1")|$(cfg_field "$1" 6)"
}

# 输出 apps.db 中所有包名，形如 " pkg1 pkg2 "（用于精确去重）
db_pkg_list() {
  _pkgs=" "
  while IFS= read -r _line; do
    _pkgs="$_pkgs$(cfg_field "$_line" 3) "
  done <<EOF
$(cfg_rows)
EOF
  echo "$_pkgs"
}

# 输出旧配置中的自定义应用（按包名或路径精确去重），结果含 7 列
# 参数：旧配置路径 包名列表（形如 " pkg1 pkg2 "）
conf_append_custom() {
  [ -f "$1" ] || return 0
  while IFS='|' read -r _p _n _pkg _st _g _m _w; do
    _p="${_p%$(printf '\r')}"
    [ -z "$_p" ] && continue; case "$_p" in \#*) continue ;; esac
    if [ -n "$_pkg" ]; then
      case "$2" in *" $_pkg "*) continue ;; esac
    else
      case "$2" in *" $_p "*) continue ;; esac
    fi
    [ -z "$_m" ] && _m=0
    [ -z "$_g" ] && _g="其他"
    echo "$_p|$_n|$_pkg|$_st|$_g|$_m|$_w"
  done < "$1"
}
