#!/system/bin/sh

# 部分管理器不导出 MODID，从脚本自身路径兜底推导
_self_dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
MODID=${MODID:-$(basename "$_self_dir")}
MODDIR="/data/adb/modules/$MODID"

# 恢复记录文件中的应用
# 注意：pm 必须重定向 stdin，否则在读取记录文件的循环中会 Failed transaction
restore_records() {
  [ -f "$1" ] || return 0
  while IFS= read -r pkg; do
    [ -n "$pkg" ] && pm install-existing --user 0 "$pkg" < /dev/null >/dev/null 2>&1
  done < "$1"
}

# 恢复 data-app
restore_records "$MODDIR/.data_apps_removed"

# 恢复 apex 应用
restore_records "$MODDIR/.apex_apps_removed"

# 恢复 pm 卸载的应用
restore_records "$MODDIR/.pm_removed"

# 遮蔽目录可能仍被元模块挂载，先卸载再删除，否则 rm 会失败并残留
for d in $(find "$MODDIR" -type d 2>/dev/null | sort -r); do
  umount -l "$d" >/dev/null 2>&1
done

# 删除模块目录
rm -rf "$MODDIR/system"
rm -rf "$MODDIR/product"
rm -rf "$MODDIR/system_ext"
rm -rf "$MODDIR/webroot"
rm -f "$MODDIR/.data_apps_removed"
rm -f "$MODDIR/.apex_apps_removed"
rm -f "$MODDIR/.debloat_record"
rm -f "$MODDIR/.pm_removed"
rm -f "$MODDIR/.pm_applied"
