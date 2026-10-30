#!/system/bin/sh

LATESTARTSERVICE=true
POSTFSDATA=true
PROPFILE=false
SKIPMOUNT=false

REPLACE=""
APEX_APPS=""

# 打印模块信息
print_modname() {
  local version=$(unzip -p "$ZIPFILE" module.prop 2>/dev/null | grep "^version=" | cut -d'=' -f2)
  [ -z "$version" ] && version="unknown"
  ui_print " "
  ui_print "=================================="
  ui_print "  📦 HyperOS 终极精简模块 $version"
  ui_print "  👤 作者：温柔浩"
  ui_print "=================================="
  ui_print " "
}

# 获取音量键输入（音量+返回0，音量-返回1）
getVolumeKey() {
  sleep 1
  while true; do
    local keyInfo=$(getevent -qlc 1 | grep KEY_VOLUME)
    if [ -n "$keyInfo" ]; then
      local isUpKey=$(echo "$keyInfo" | grep KEY_VOLUMEUP)
      [ -n "$isUpKey" ] && return 0 || return 1
    fi
  done
}

# 添加应用到精简列表
add_to_replace() {
  for path in "$@"; do
    if [ -z "$REPLACE" ]; then
      REPLACE="$path"
    else
      REPLACE="$REPLACE
$path"
    fi
  done
}

# 添加 apex 应用到精简列表
add_apex_app() {
  for pkg in "$@"; do
    if [ -z "$APEX_APPS" ]; then
      APEX_APPS="$pkg"
    else
      APEX_APPS="$APEX_APPS
$pkg"
    fi
  done
}

# 检测并移除旧版模块（模块 id 由 HyperOS3_Debloat 变更为 HyperOS_Debloat）
OLD_ID="HyperOS3_Debloat"
OLD_DIR="/data/adb/modules/$OLD_ID"
if [ -d "$OLD_DIR" ]; then
  ui_print " "
  ui_print "  ⚠️ 检测到旧版模块：$OLD_ID"
  ui_print "  🔄 正在恢复旧版精简过的应用并移除旧模块..."
  if [ -f "$OLD_DIR/uninstall.sh" ]; then
    MODID="$OLD_ID" sh "$OLD_DIR/uninstall.sh" >/dev/null 2>&1
  fi
  # 旧脚本可能因 stdin 重定向问题恢复失败，这里按其记录文件兜底再恢复一次
  for _rf in .data_apps_removed .apex_apps_removed .pm_removed; do
    [ -f "$OLD_DIR/$_rf" ] || continue
    while IFS= read -r _pkg; do
      [ -n "$_pkg" ] && pm install-existing --user 0 "$_pkg" < /dev/null >/dev/null 2>&1
    done < "$OLD_DIR/$_rf"
  done
  rm -rf "$OLD_DIR"
  if [ -d "$OLD_DIR" ]; then
    ui_print "  ❌ 无法自动移除旧版模块"
    ui_print "  👉 请先在管理器中卸载旧版，再重新安装本模块"
    abort "! 安装中止：请先卸载旧版模块"
  fi
  ui_print "  ✅ 旧版模块已移除"
  ui_print " "
fi

# 解压数据文件
unzip -o "$ZIPFILE" -d "$MODPATH" 2>/dev/null
. $MODPATH/pkg_map.sh

# 按候选路径加入精简列表（自动解析真实分区路径）
add_candidate() {
  local real=$(resolve_path "$1")
  case "$real" in
    apex:*|pm:*) add_apex_app "${real#*:}" ;;
    *) add_to_replace "$real" ;;
  esac
}

# 按候选路径从精简列表移除
remove_candidate() {
  local real=$(resolve_path "$1")
  case "$real" in
    apex:*|pm:*)
      APEX_APPS=$(echo "$APEX_APPS" | grep -vxF "${real#*:}")
      ;;
    *)
      REPLACE=$(echo "$REPLACE" | grep -vxF "$real")
      ;;
  esac
}

# 按 apps.db 的模式列生成精简列表
# 参数：最大模式（1/2/3）
apply_mode() {
  local max_level="$1"
  while IFS= read -r line; do
    local lvl=$(row_level "$line")
    case "$lvl" in ''|*[!0-9]*) continue ;; esac
    [ "$lvl" -ge 1 ] && [ "$lvl" -le "$max_level" ] || continue
    add_candidate "$(cfg_field "$line" 1)"
  done <<EOF
$(cfg_rows)
EOF
}

# 卸载 REPLACE 应用的 data 分区副本（防止用户更新过的应用绕过精简）
# 只对实际安装在 /data/app/ 下的应用执行 pm uninstall
# 物理位置在 /product、/system 下的应用只靠 .replace 遮蔽，便于 TWRP 直接删目录恢复
uninstall_replace_apps() {
  local record_file="$MODPATH/.data_apps_removed"
  : > "$record_file"
  for item in $REPLACE; do
    local pkg=$(get_pkg_name "$item")
    [ -z "$pkg" ] && continue
    pm path "$pkg" < /dev/null 2>/dev/null | grep -q "^package:/data/app/" || continue
    if pm uninstall -k --user 0 "$pkg" < /dev/null >/dev/null 2>&1; then
      echo "$pkg" >> "$record_file"
    fi
  done
}

# 生成 apps.conf 配置文件（供 WebUI 和 post-fs-data.sh 使用）
generate_apps_conf() {
  local conf="$MODPATH/webroot/apps.conf"
  local old_conf="/data/adb/modules/$MODID/webroot/apps.conf"
  mkdir -p "$MODPATH/webroot"
  conf_header "$conf"

  # apps.db 中的包名（用于自定义应用去重）
  local db_pkgs=$(db_pkg_list)
  local line
  while IFS= read -r line; do
    local pkg=$(cfg_field "$line" 3)
    local status=0
    local real=$(resolve_path "$(cfg_field "$line" 1)")
    case "$real" in
      apex:*|pm:*)
        echo "$APEX_APPS" | grep -qxF "$pkg" && status=1
        ;;
      *)
        echo "$REPLACE" | grep -qxF "$real" && status=1
        ;;
    esac
    conf_emit "$line" "$status" >> "$conf"
  done <<EOF
$(cfg_rows)
EOF

  # 保留旧 apps.conf 中的自定义应用（按包名精确去重）
  conf_append_custom "$old_conf" "$db_pkgs" >> "$conf"
}

# 记录 REPLACE 目录（供 post-fs-data.sh 清理）
record_replace_dirs() {
  local record="$MODPATH/.debloat_record"
  : > "$record"
  for item in $REPLACE; do
    echo "$MODPATH$(module_rel "$item")" >> "$record"
  done
}

# 执行 apex 应用卸载
do_uninstall_apex() {
  [ -z "$APEX_APPS" ] && return
  : > "$MODPATH/.apex_apps_removed"
  for pkg in $APEX_APPS; do
    if pm uninstall -k --user 0 "$pkg" < /dev/null >/dev/null 2>&1; then
      echo "$pkg" >> "$MODPATH/.apex_apps_removed"
    fi
  done
}

# 显示精简列表并确认
show_replace_list() {
  ui_print " "
  ui_print " ============================================"
  ui_print "  📋 本次精简列表："
  local count=0
  for item in $REPLACE; do
    local app=$(basename "$item")
    ui_print "   ❌ $app"
    count=$((count + 1))
  done
  for item in $APEX_APPS; do
    ui_print "   ❌ $item（apex）"
    count=$((count + 1))
  done
  ui_print "   共 $count 个应用"
  ui_print " ============================================"
  ui_print "  🔊音量+ 确认精简 / 🔊音量- 取消"
  ui_print " ============================================"

  if getVolumeKey; then
    ui_print "  ⏳ 正在应用精简..."
    uninstall_replace_apps
    do_uninstall_apex
    generate_apps_conf
    record_replace_dirs
  else
    ui_print "  ❎ 已取消精简"
  fi
}

# 选择模式（快速/标准/深度/自定义）
select_mode() {
  local mode=1
  local max_mode=4

  while true; do
    ui_print " "
    case $mode in
      1)
        ui_print " ✅ [1] 快速精简（推荐）"
        ui_print "     精简：广告追踪 + 游戏中心"
        ui_print "     保留：所有核心功能"
        ui_print "     👉 适合：大部分用户，安全无风险"
        ;;
      2)
        ui_print " ⚡ [2] 标准精简"
        ui_print "     精简：广告追踪 + 游戏中心"
        ui_print "     +云服务/跨屏协同/汽车互联/互联互通"
        ui_print "     👉 适合：不用小米云服务和跨设备互联"
        ;;
      3)
        ui_print " 🔥 [3] 深度精简"
        ui_print "     精简：标准精简全部内容"
        ui_print "     +AI/小爱 + 内容/工具/安全 + 系统服务 + 无障碍/宏"
        ui_print "     ⚠️ 适合：追求极致精简，可能影响功能"
        ;;
      4)
        ui_print " 🎛️ [4] 自定义模式"
        ui_print "     每组功能单独选择"
        ui_print "     可逐个应用选择精简或保留"
        ;;
    esac

    ui_print "   🔊音量+ 确认 / 🔊音量- 切换"

    if getVolumeKey; then
      ui_print " "
      ui_print "  ✅ 已选择：模式$mode"
      return $mode
    else
      mode=$((mode + 1))
      [ $mode -gt $max_mode ] && mode=1
    fi
  done
}

# 自定义模式：逐个分组选择
custom_mode() {
  ui_print "  🎛️ [OK] 自定义模式"
  ui_print "  🔊音量+ 精简此组 / 🔊音量- 进入选择"
  ui_print " ============================================"

  local groups=$(get_all_groups)
  local total_groups=$(echo "$groups" | wc -l)
  local group_idx=0

  for group_name in $groups; do
    group_idx=$((group_idx + 1))

    # 跳过危险项（由 dangerous_items 处理）
    [ "$group_name" = "危险项" ] && continue

    ui_print " "
    ui_print " 📦 [${group_idx}/${total_groups}] ${group_name}"
    ui_print "   🔊音量+ 精简此组 / 🔊音量- 进入选择"

    if getVolumeKey; then
      ui_print "   ❌ 精简此组"
      while IFS= read -r _line; do
        [ "$(cfg_field "$_line" 4)" = "$group_name" ] || continue
        add_candidate "$(cfg_field "$_line" 1)"
      done <<EOF
$(cfg_rows)
EOF
    else
      custom_group "$group_name"
    fi
  done
}

# 自定义模式：列出分组内应用并选择
# 参数：分组名
custom_group() {
  local group_name="$1"
  local items="$MODPATH/.custom_items"
  : > "$items"
  while IFS= read -r _line; do
    [ "$(cfg_field "$_line" 4)" = "$group_name" ] || continue
    echo "$(cfg_field "$_line" 1)|$(cfg_field "$_line" 2)" >> "$items"
  done <<EOF
$(cfg_rows)
EOF
  local total=$(wc -l < "$items")

  ui_print " "
  ui_print " 📦 ${group_name}（${total}项）"
  while IFS='|' read -r _c _n; do
    ui_print "   · $_n"
  done < "$items"

  local opt=1
  while true; do
    ui_print " "
    ui_print " 📦 ${group_name} - 选择方式"
    ui_print "   🔊音量+ 确认 / 🔊音量- 切换"
    case $opt in
      1) ui_print "   [1] ❌ 全部精简" ;;
      2) ui_print "   [2] ✅ 全部保留" ;;
      3) ui_print "   [3] 🔧 逐个选择" ;;
    esac

    if getVolumeKey; then
      case $opt in
        1)
          ui_print "   ❌ 全部精简"
          while IFS='|' read -r _c _n; do
            add_candidate "$_c"
            ui_print "     ❌ $_n"
          done < "$items"
          ;;
        2)
          ui_print "   ✅ 全部保留"
          ;;
        3)
          ui_print "   🔧 逐个选择"
          custom_group_one_by_one "$group_name" "$items" "$total"
          ;;
      esac
      break
    fi
    opt=$((opt + 1))
    [ $opt -gt 3 ] && opt=1
  done
  rm -f "$items"
}

# 自定义模式：逐个应用选择（支持重选本组）
# 参数：分组名 项目文件 总数
custom_group_one_by_one() {
  local group_name="$1"
  local items="$2"
  local total="$3"
  local retry=true

  while $retry; do
    retry=false
    local i=0
    local selected=""

    ui_print " "
    ui_print " 📦 ${group_name} - 逐个选择"
    ui_print "   🔊音量+ 精简 / 🔊音量- 保留"

    while IFS='|' read -r _c _n; do
      i=$((i + 1))
      ui_print " "
      ui_print "   [${i}/${total}] ${_n}"
      if getVolumeKey; then
        add_candidate "$_c"
        selected="$selected
$_c"
        ui_print "     ❌ 精简"
      else
        ui_print "     ✅ 保留"
      fi
    done < "$items"

    # 显示本组结果
    ui_print " "
    ui_print " 📦 ${group_name} - 已选择："
    while IFS='|' read -r _c _n; do
      if echo "$selected" | grep -qxF "$_c"; then
        ui_print "   ❌ $_n"
      else
        ui_print "   ✅ $_n"
      fi
    done < "$items"

    # 确认/重选
    ui_print " "
    ui_print " 🔊音量+ 确认 / 🔊音量- 重选本组"
    if ! getVolumeKey; then
      while IFS= read -r _s; do
        [ -n "$_s" ] && remove_candidate "$_s"
      done <<EOF
$selected
EOF
      retry=true
    fi
  done

  ui_print " "
  ui_print " 📦 ${group_name} - 选择完成"
}

# 危险项确认
dangerous_items() {
  ui_print " "
  ui_print " ============================================"
  ui_print "  ⚠️ 危险项确认（可跳过）"
  ui_print " ============================================"

  while IFS= read -r _line; do
    [ "$(cfg_field "$_line" 4)" = "危险项" ] || continue
    local _name=$(cfg_field "$_line" 2)
    local _warn=$(cfg_field "$_line" 6)
    [ -z "$_warn" ] && _warn="精简后可能影响相关功能"
    ui_print " "
    ui_print "  ⚠️ ${_name} - ${_warn}"
    ui_print "  🔊音量+ 精简 / 🔊音量- 保留"
    if getVolumeKey; then
      add_candidate "$(cfg_field "$_line" 1)"
      ui_print "  ❌ 精简${_name}"
    else
      ui_print "  ✅ 保留${_name}"
    fi
  done <<EOF
$(cfg_rows)
EOF
}

# 主安装流程
on_install() {
  restore_data_apps

  # 检测是否为覆盖安装
  local old_conf="/data/adb/modules/$MODID/webroot/apps.conf"
  if [ -f "$old_conf" ]; then
    ui_print " "
    ui_print " ============================================"
    ui_print "  🔍 检测到已有配置"
    ui_print "  🔊音量+ 应用旧配置 / 🔊音量- 重新选择"
    ui_print " ============================================"
    if getVolumeKey; then
      ui_print "  ✅ 应用旧配置"
      # 从旧配置中读取状态为1的应用（黑名单条目除外，防止已移除的危险应用回流）
      while IFS='|' read -r path name pkg status group mode warn; do
        [ -z "$path" ] && continue
        case "$path" in \#*) continue ;; esac
        is_blacklisted "$pkg" "$path" && continue
        [ "$status" = "1" ] && add_candidate "$path"
      done < "$old_conf"
      # 生成新配置（data 副本已在上次安装时卸载，REPLACE 会遮蔽系统版本）
      generate_apps_conf
      record_replace_dirs
      return
    else
      ui_print "  🔄 重新选择"
    fi
  fi

  ui_print " "
  ui_print " ============================================"
  ui_print "  🔊音量+ 立即选择精简模式"
  ui_print "  🔊音量- 跳过，稍后通过 WebUI 配置"
  ui_print " ============================================"

  if ! getVolumeKey; then
    # 跳过：生成空配置，全部保留
    ui_print "  ⏭️ 已跳过，重启后通过 WebUI 配置"
    generate_apps_conf
    record_replace_dirs
    return
  fi

  ui_print " "
  ui_print " ============================================"
  ui_print "  📖 操作说明："
  ui_print "  🔊音量+ = 确认当前选项"
  ui_print "  🔊音量- = 切换到下一个选项"
  ui_print "  🔄 选项循环：1 -> 2 -> 3 -> 4 -> 1..."
  ui_print " "
  ui_print "  [1] [2] [3] 为预设模式，一键精简"
  ui_print "  [4] 自定义模式，每组单独选择"
  ui_print " ============================================"

  select_mode
  local choice=$?

  ui_print " "
  ui_print " ============================================"

  case $choice in
    1)
      ui_print "  ✅ [OK] 快速精简"
      ui_print "  精简：广告追踪 + 游戏中心"
      ui_print "  保留：所有核心功能"
      ui_print " ============================================"
      apply_mode 1
      ;;
    2)
      ui_print "  ⚡ [OK] 标准精简"
      ui_print "  精简：广告追踪 + 游戏中心"
      ui_print "  +云服务/跨屏协同/汽车互联/互联互通"
      ui_print " ============================================"
      apply_mode 2
      ;;
    3)
      ui_print "  🔥 [OK] 深度精简"
      ui_print "  精简：标准精简全部内容"
      ui_print "  +AI/小爱 + 内容/工具/安全 + 系统服务 + 无障碍/宏"
      ui_print " ============================================"
      apply_mode 3
      ;;
    4)
      custom_mode
      ;;
  esac

  # 危险项确认
  dangerous_items

  # 显示精简列表并确认
  show_replace_list
}

# 恢复之前精简的应用（覆盖安装时）
restore_data_apps() {
  # 恢复 data-app
  local old_record="/data/adb/modules/$MODID/.data_apps_removed"
  if [ -f "$old_record" ]; then
    while IFS= read -r pkg; do
      [ -n "$pkg" ] && pm install-existing --user 0 "$pkg" < /dev/null >/dev/null 2>&1
    done < "$old_record"
  fi

  # 恢复 apex 应用
  local apex_record="/data/adb/modules/$MODID/.apex_apps_removed"
  if [ -f "$apex_record" ]; then
    while IFS= read -r pkg; do
      [ -n "$pkg" ] && pm install-existing --user 0 "$pkg" < /dev/null >/dev/null 2>&1
    done < "$apex_record"
  fi
}

set_permissions() {
  set_perm_recursive $MODPATH 0 0 0755 0644
  # 确保 product 和 system_ext 目录有执行权限（兼容独立分区设备）
  [ -d "$MODPATH/product" ] && set_perm_recursive $MODPATH/product 0 0 0755 0644
  [ -d "$MODPATH/system/product" ] && set_perm_recursive $MODPATH/system/product 0 0 0755 0644
  [ -d "$MODPATH/system/system_ext" ] && set_perm_recursive $MODPATH/system/system_ext 0 0 0755 0644
}
