# Fork 本地化改动：可配置存档位置 + 按账号/目录存档

本 Fork 在官方 0.1.2 基础上做了两处存储层改动，均只影响本地磁盘布局，不动协议与同步逻辑。

## 1. 存档位置可配置

数据根目录（`archive/` 与 `mail.sqlite3` 所在处）解析顺序：

1. 环境变量 `YANXIN_DATA_DIR`
2. 配置文件 `~/.config/yanxin/data-dir`（取首行；也支持 `~/.yanxin-data-dir`）
3. 默认 `~/Library/Application Support/dev.maildesk.desktop`

路径支持 `~` 开头。设置页“关于”中的数据目录显示的是实际生效路径。

```bash
# 示例：把存档放到外置盘
mkdir -p /Volumes/MailArc/Yanxin
echo "/Volumes/MailArc/Yanxin" > ~/.config/yanxin/data-dir
```

**迁移已有数据**：先把旧目录整体复制到新位置再启动，账号、索引、存档一起搬过去：

```bash
OLD=~/Library/Application\ Support/dev.maildesk.desktop
NEW=/Volumes/MailArc/Yanxin
mkdir -p "$NEW" && cp -R "$OLD/." "$NEW/"
echo "$NEW" > ~/.config/yanxin/data-dir
```

不复制直接指向新目录也可以，但账号需要重新添加（凭据在系统钥匙串，不受影响），邮件会按账号重新收取。

## 2. 按账号/目录的存档布局

```
<root>/archive/<账号邮箱>/<服务器文件夹(按 / 分层)>/<sha256>.eml
```

例如 `archive/wanghlg@si-tech.com.cn/INBOX/ab12….eml`、`archive/wanghlg@si-tech.com.cn/上线申请/cd34….eml`。

- 每个邮件的相对路径记录在消息数据（`relPath` 字段）中
- **旧数据自动兼容**：升级前保存的邮件没有 `relPath`，仍按原平面布局 `archive/<hash>.eml` 寻址，无需迁移
- 账号或文件夹名中的 `: \ < > " | ? *` 及控制字符替换为 `_`，首尾 `.` 去除，避免非法路径
- 同一内容被多个账号/文件夹收到时**各存一份**（不再跨账号共享同一文件）；删除某个账号的本地存档只影响该账号自己的副本

## 3. 删除与备份的行为变化

- 清理本地存档时，暂存目录 `.archive-deletion/<uuid>/` 内**镜像存档相对路径**（恢复时原样写回）；升级前中断遗留的平面暂存文件仍可正常恢复
- 应用内“备份”导出的仍是平面 `archive/<hash>.eml` 快照格式（version 1），从备份恢复时按账号/文件夹重新落盘

## 4. 构建

官方流水线不变，push 即由 GitHub Actions 产出双架构 DMG：

```bash
npm ci
npm run desktop:build   # 本地出包（需要 Xcode Command Line Tools 与 Rust stable）
```
