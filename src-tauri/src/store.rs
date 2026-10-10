use crate::{archive, models::*, rules};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
};
#[derive(Clone)]
pub struct Store {
    pub root: PathBuf,
    /// 存档读取根顺序：内部根优先，其后是外置存档根（冷库）
    pub archive_roots: std::sync::Arc<std::sync::RwLock<Vec<PathBuf>>>,
    pub(crate) archive_gate: Arc<RwLock<()>>,
    pub(crate) conversation_cache: Arc<Mutex<Option<(i64, Arc<crate::conversation::Index>)>>>,
}
impl Store {
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root).map_err(err)?;
        let s = Self {
            root,
            archive_roots: Arc::new(RwLock::new(Vec::new())),
            archive_gate: Arc::new(RwLock::new(())),
            conversation_cache: Arc::new(Mutex::new(None)),
        };
        let db = s.db()?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,hash TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(account_id,hash)); CREATE TABLE IF NOT EXISTS sources(account_id TEXT,folder TEXT,remote_id TEXT,mail_id TEXT,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(account_id,folder,remote_id)); CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY,position INTEGER,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY,time TEXT,message TEXT); CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,status TEXT,data TEXT,raw BLOB); CREATE INDEX IF NOT EXISTS messages_account ON messages(account_id);").map_err(err)?;
        let has_active: bool = db
            .prepare("PRAGMA table_info(sources)")
            .map_err(err)?
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(err)?
            .any(|r| r.as_deref() == Ok("active"));
        if !has_active {
            db.execute(
                "ALTER TABLE sources ADD COLUMN active INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(err)?;
        }
        let has_parser_version = db
            .prepare("PRAGMA table_info(messages)")
            .map_err(err)?
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(err)?
            .any(|r| r.as_deref() == Ok("parser_version"));
        if !has_parser_version {
            db.execute(
                "ALTER TABLE messages ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(err)?;
        }
        db.execute_batch("CREATE TABLE IF NOT EXISTS folder_mappings(account_id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS remote_folders(account_id TEXT NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(account_id,name)); CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL COLLATE NOCASE UNIQUE); CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,data TEXT NOT NULL);")
            .map_err(err)?;
        for (column, definition) in [
            ("error", "TEXT NOT NULL DEFAULT ''"),
            ("updated_at", "TEXT NOT NULL DEFAULT ''"),
            ("scheduled_at", "TEXT NOT NULL DEFAULT ''"),
            ("raw_hash", "TEXT NOT NULL DEFAULT ''"),
        ] {
            let exists = db
                .prepare("PRAGMA table_info(outbox)")
                .map_err(err)?
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(err)?
                .any(|r| r.as_deref() == Ok(column));
            if !exists {
                db.execute(
                    &format!("ALTER TABLE outbox ADD COLUMN {column} {definition}"),
                    [],
                )
                .map_err(err)?;
            }
        }
        db.execute("UPDATE outbox SET status='uncertain',error='应用在发送完成前退出，请先检查服务端已发送邮件' WHERE status='sending'", []).map_err(err)?;
        // Maintain a small listing projection atomically with every archive write,
        // including rule application, restore and parser migrations. Bodies remain
        // in messages and the original MIME archive; list refreshes never load them.
        db.execute_batch("BEGIN IMMEDIATE;
            CREATE INDEX IF NOT EXISTS sources_mail_active ON sources(mail_id, active, folder COLLATE NOCASE, account_id);
            CREATE TABLE IF NOT EXISTS message_listing(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS listing_account ON message_listing(account_id);
            CREATE TABLE IF NOT EXISTS conversation_revision(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
            INSERT OR IGNORE INTO conversation_revision VALUES(1,0);
            INSERT OR IGNORE INTO message_listing SELECT id,account_id,json_set(data,'$.body','') FROM messages;
            CREATE TRIGGER IF NOT EXISTS listing_insert AFTER INSERT ON messages BEGIN
                INSERT INTO message_listing VALUES(NEW.id,NEW.account_id,json_set(NEW.data,'$.body',''));
                UPDATE conversation_revision SET version=version+1;
            END;
            CREATE TRIGGER IF NOT EXISTS listing_update AFTER UPDATE OF data ON messages BEGIN
                UPDATE message_listing SET account_id=NEW.account_id,data=json_set(NEW.data,'$.body','') WHERE id=NEW.id;
                UPDATE conversation_revision SET version=version+1;
            END;
            CREATE TRIGGER IF NOT EXISTS listing_delete AFTER DELETE ON messages BEGIN
                DELETE FROM message_listing WHERE id=OLD.id;
                UPDATE conversation_revision SET version=version+1;
            END;
            COMMIT;").map_err(err)?;
        crate::operations::initialize(&db)?;
        crate::folder_health::initialize(&db)?;
        crate::directory_operations::initialize(&db)?;
        crate::sent_uploads::initialize(&db)?;
        crate::rule_operations::initialize(&db)?;
        crate::retention::initialize(&db)?;
        crate::archive_jobs::initialize(&db)?;
        s.migrate_folder_roles()?;
        s.recover_archive_deletion()?;
        s.refresh_archive_roots()?; // 必须先于元数据刷新：读取存档依赖根列表
        s.refresh_archive_metadata()?;
        Ok(s)
    }
    /// 按当前偏好重算存档读取根：内部根优先，其后是外置存档根。
    pub fn refresh_archive_roots(&self) -> Result<()> {
        let mut roots = vec![self.root.clone()];
        if let Some(ext) = self
            .preferences()?
            .external_archive_dir
            .filter(|p| !p.trim().is_empty())
        {
            let ext = PathBuf::from(ext.trim());
            if ext != self.root {
                roots.push(ext);
            }
        }
        *self.archive_roots.write().map_err(|e| e.to_string())? = roots;
        Ok(())
    }
    /// 按根顺序读取存档（内部优先、外置兜底）
    pub fn read_archive(&self, rel_path: Option<&str>, hash: &str) -> Result<Vec<u8>> {
        let roots = self
            .archive_roots
            .read()
            .map_err(|e| e.to_string())?
            .clone();
        archive::read_raw(&roots, rel_path, hash)
    }
    // Write transactions use IMMEDIATE so the busy timeout applies before any
    // snapshot is read. DEFERRED read-to-write upgrades can fail with BUSY_SNAPSHOT.
    /// 分层年龄判定：以邮件日期为准，日期缺失或不可解析时回退本地存档时间。
    fn older_than_cutoff(
        date: &str,
        saved_at: &str,
        cutoff: &chrono::DateTime<chrono::Utc>,
    ) -> bool {
        let ts = chrono::DateTime::parse_from_rfc3339(date)
            .or_else(|_| chrono::DateTime::parse_from_rfc3339(saved_at))
            .ok();
        match ts {
            Some(t) => t.with_timezone(&chrono::Utc) < *cutoff,
            None => false, // 时间不可靠的不搬迁
        }
    }
    /// 预览：当前有多少封/多少字节待搬迁，以及外置根是否可达。
    pub fn tier_pending(&self) -> Result<(u64, u64, bool)> {
        let prefs = self.preferences()?;
        let ext = match prefs.external_archive_dir.filter(|p| !p.trim().is_empty()) {
            Some(e) => PathBuf::from(e.trim()),
            None => return Ok((0, 0, false)),
        };
        let reachable = ext.is_dir();
        let days = prefs.archive_retention_days;
        if days == 0 || !reachable {
            return Ok((0, 0, reachable));
        }
        let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
        let db = self.db()?;
        let mut stmt = db
            .prepare(
                "SELECT COALESCE(json_extract(data,'$.relPath'),''), json_extract(data,'$.date'),
                        json_extract(data,'$.savedAt')
                 FROM messages WHERE COALESCE(json_extract(data,'$.savedLocally'),1)=1",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        let mut count = 0u64;
        let mut bytes = 0u64;
        for (rel, date, saved_at) in rows {
            if rel.is_empty() || !self.root.join(&rel).exists() {
                continue; // 已搬迁或在线邮件
            }
            if Self::older_than_cutoff(&date, &saved_at, &cutoff) {
                count += 1;
                bytes += std::fs::metadata(self.root.join(&rel))
                    .map(|m| m.len())
                    .unwrap_or(0);
            }
        }
        Ok((count, bytes, reachable))
    }
    /// 规范存档目录名：把旧版 encoded 文件夹名（&bfFuL2XlaMA-）重命名为解码后的
    /// 真实名称（深港日检），逐文件搬迁并更新 relPath。幂等，可重复执行。
    pub fn normalize_archive_paths(&self) -> Result<u64> {
        let _archive = self.archive_gate.write().map_err(|e| e.to_string())?;
        let db = self.db()?;
        let mut stmt = db
            .prepare(
                "SELECT id, hash, json_extract(data,'$.accountEmail'),
                        json_extract(data,'$.sourceFolder'), COALESCE(json_extract(data,'$.relPath'),'')
                 FROM messages WHERE COALESCE(json_extract(data,'$.savedLocally'),1)=1",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        let mut moved = 0u64;
        let roots = self
            .archive_roots
            .read()
            .map_err(|e| e.to_string())?
            .clone();
        for (id, hash, account, folder, old_rel) in rows {
            if old_rel.is_empty() {
                continue;
            }
            let new_rel = match archive::rel_path(&account, &folder, &hash) {
                Some(r) => r,
                None => continue,
            };
            if new_rel == old_rel {
                continue;
            }
            // 找到现存文件所在根，搬到新相对路径
            let mut done = false;
            for root in &roots {
                let from = root.join(&old_rel);
                if !from.exists() {
                    continue;
                }
                let to = root.join(&new_rel);
                if to.exists() {
                    let _ = std::fs::remove_file(&from); // 目标已存在同内容
                } else if let Some(parent) = to.parent() {
                    if std::fs::create_dir_all(parent).is_err() {
                        continue;
                    }
                    if std::fs::rename(&from, &to).is_err() {
                        continue;
                    }
                }
                done = true;
                break;
            }
            if done {
                let mut mail: Mail = serde_json::from_str(
                    &db.query_row("SELECT data FROM messages WHERE id=?1", [&id], |r| {
                        r.get::<_, String>(0)
                    })
                    .map_err(err)?,
                )
                .map_err(err)?;
                mail.rel_path = Some(new_rel);
                db.execute(
                    "UPDATE messages SET data=?2 WHERE id=?1",
                    params![id, serde_json::to_string(&mail).map_err(err)?],
                )
                .map_err(err)?;
                moved += 1;
            }
        }
        Ok(moved)
    }
    /// 彻底删除本地记录与存档文件（服务器删除确认后调用）。
    /// 先删数据库行、后删文件：任何一步失败都不会留下"有记录无文件"的坏状态。
    pub fn purge_mail(&self, id: &str) -> Result<()> {
        let mail = self.mail(id)?;
        let rel = mail
            .rel_path
            .clone()
            .unwrap_or_else(|| format!("archive/{}.eml", mail.hash));
        {
            let mut db = self.db()?;
            let tx = db
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(err)?;
            tx.execute("DELETE FROM sources WHERE mail_id=?1", [id])
                .map_err(err)?;
            // server_operations 无 mail_id 列，mailId 存在 data JSON 里
            tx.execute(
                "DELETE FROM server_operations WHERE json_extract(data,'$.mailId')=?1",
                [id],
            )
            .map_err(err)?;
            tx.execute("DELETE FROM messages WHERE id=?1", [id])
                .map_err(err)?;
            tx.commit().map_err(err)?;
        }
        let roots = self
            .archive_roots
            .read()
            .map_err(|e| e.to_string())?
            .clone();
        for root in &roots {
            let p = root.join(&rel);
            if p.exists() {
                let _ = std::fs::remove_file(p);
            }
        }
        Ok(())
    }
    /// 取回：把外置根的存档文件搬回内部根（外置盘不在时跳过）。
    pub fn tier_recall(&self) -> Result<u64> {
        let prefs = self.preferences()?;
        let ext = match prefs.external_archive_dir.filter(|p| !p.trim().is_empty()) {
            Some(e) => PathBuf::from(e.trim()),
            None => return Ok(0),
        };
        if ext == self.root || !ext.is_dir() {
            return Ok(0);
        }
        let _archive = self.archive_gate.write().map_err(|e| e.to_string())?;
        let db = self.db()?;
        let mut stmt = db
            .prepare(
                "SELECT hash, COALESCE(json_extract(data,'$.relPath'),'')
                 FROM messages WHERE COALESCE(json_extract(data,'$.savedLocally'),1)=1",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        let mut recalled = 0u64;
        for (hash, rel) in rows {
            if rel.is_empty() {
                continue;
            }
            let from = ext.join(&rel);
            let to = self.root.join(&rel);
            if !from.exists() || to.exists() {
                continue;
            }
            if let Some(parent) = to.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    continue;
                }
            }
            match std::fs::copy(&from, &to) {
                Ok(_) => {
                    let ok = std::fs::read(&to)
                        .map(|b| archive::digest(&b) == hash)
                        .unwrap_or(false);
                    if ok {
                        let _ = std::fs::remove_file(&from);
                        recalled += 1;
                    } else {
                        let _ = std::fs::remove_file(&to);
                    }
                }
                Err(_) => continue,
            }
        }
        Ok(recalled)
    }
    /// 分层归档：把超过保留天数的存档文件从内部根搬迁到外置存档根。
    /// 跨设备用"复制+校验+删除"（rename 跨文件系统会失败）；外置根未配置时跳过。
    pub fn tier_archives(&self) -> Result<TierReport> {
        let prefs = self.preferences()?;
        let mut report = TierReport::default();
        let ext = match prefs.external_archive_dir.filter(|p| !p.trim().is_empty()) {
            Some(e) => PathBuf::from(e.trim()),
            None => {
                report.skipped = true;
                return Ok(report);
            }
        };
        if ext == self.root {
            report.skipped = true;
            return Ok(report);
        }
        let days = prefs.archive_retention_days;
        if days == 0 {
            report.skipped = true; // 永久保留本地
            return Ok(report);
        }
        let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
        let _archive = self.archive_gate.write().map_err(|e| e.to_string())?;
        let db = self.db()?;
        let mut stmt = db
            .prepare(
                "SELECT id, hash, COALESCE(json_extract(data,'$.relPath'),''),
                        json_extract(data,'$.date'), json_extract(data,'$.savedAt')
                 FROM messages WHERE COALESCE(json_extract(data,'$.savedLocally'),1)=1",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        for (id, hash, rel, date, saved_at) in rows {
            if rel.is_empty() {
                continue;
            }
            if !Self::older_than_cutoff(&date, &saved_at, &cutoff) {
                report.pending += 1;
                continue;
            }
            let from = self.root.join(&rel);
            if !from.exists() {
                continue; // 已在外置根或在线邮件
            }
            let to = ext.join(&rel);
            if to.exists() {
                // 外置已有同内容文件：校验后删除本地副本
                match std::fs::read(&to) {
                    Ok(bytes) if archive::digest(&bytes) == hash => {
                        let _ = std::fs::remove_file(&from);
                        report.moved += 1;
                    }
                    _ => report.errors.push(format!(
                        "{}：外置目标校验失败，保留本地",
                        &id[..8.min(id.len())]
                    )),
                }
                continue;
            }
            if let Some(parent) = to.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    report
                        .errors
                        .push(format!("{}：{e}", &id[..8.min(id.len())]));
                    continue;
                }
            }
            match std::fs::copy(&from, &to) {
                Ok(_) => {
                    let ok = std::fs::read(&to)
                        .map(|b| archive::digest(&b) == hash)
                        .unwrap_or(false);
                    if ok {
                        let _ = std::fs::remove_file(&from);
                        report.moved += 1;
                        report.moved_bytes += std::fs::metadata(&to).map(|m| m.len()).unwrap_or(0);
                    } else {
                        let _ = std::fs::remove_file(&to);
                        report
                            .errors
                            .push(format!("{}：复制校验失败", &id[..8.min(id.len())]));
                    }
                }
                Err(e) => report
                    .errors
                    .push(format!("{}：{e}", &id[..8.min(id.len())])),
            }
        }
        if prefs.archive_index_enabled {
            report.index_written = self.write_portable_index(&ext).is_ok();
        }
        Ok(report)
    }
    /// 在外置存档根生成随盘索引 index.html：按账号/文件夹分组，
    /// 列出日期/发件人/主题并链接到对应 .eml（任何机器浏览器可读）。
    pub fn write_portable_index(&self, ext: &Path) -> Result<usize> {
        let db = self.db()?;
        let mut stmt = db
            .prepare(
                "SELECT json_extract(data,'$.accountEmail'), json_extract(data,'$.relPath'),
                        json_extract(data,'$.date'), json_extract(data,'$.sender'),
                        json_extract(data,'$.subject')
                 FROM messages WHERE COALESCE(json_extract(data,'$.savedLocally'),1)=1",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        // 只收录物理上在外置根里的文件，保证链接可点
        let mut groups: BTreeMap<String, BTreeMap<String, Vec<(String, String, String, String)>>> =
            BTreeMap::new();
        let mut total = 0usize;
        for (account, rel, date, sender, subject) in rows {
            if rel.is_empty() || !ext.join(&rel).exists() {
                continue;
            }
            let folder = std::path::Path::new(&rel)
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            groups
                .entry(account)
                .or_default()
                .entry(folder)
                .or_default()
                .push((date, sender, subject, rel));
            total += 1;
        }
        let escape = |s: &str| {
            s.replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;")
        };
        let link = |rel: &str| {
            rel.split('/')
                .map(|part| {
                    part.bytes().fold(String::new(), |mut acc, b| {
                        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                            acc.push(b as char);
                        } else {
                            acc.push_str(&format!("%{b:02X}"));
                        }
                        acc
                    })
                })
                .collect::<Vec<_>>()
                .join("/")
        };
        let mut html = String::from(
            "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">             <title>雁信存档索引</title><style>             body{font-family:-apple-system,\"PingFang SC\",sans-serif;margin:24px;color:#1d1d1f}             h1{font-size:20px}h2{margin:20px 0 4px}h3{margin:12px 0 2px;color:#555;font-size:14px}             table{border-collapse:collapse;width:100%;margin-bottom:18px}             td{padding:5px 8px;border-bottom:1px solid #eee;font-size:13px}             a{color:#06c;text-decoration:none}td.d{color:#666;white-space:nowrap}             </style></head><body><h1>雁信存档索引</h1><p>点击邮件将下载并用邮件客户端打开。</p>",
        );
        for (account, folders) in &groups {
            html.push_str(&format!("<h2>{}</h2>", escape(account)));
            for (folder, mails) in folders {
                html.push_str(&format!("<h3>{}</h3><table>", escape(folder)));
                for (date, sender, subject, rel) in mails {
                    html.push_str(&format!(
                        "<tr><td class=\"d\">{}</td><td>{}</td><td><a href=\"{}\" download>{}</a></td></tr>",
                        escape(&date.chars().take(10).collect::<String>()),
                        escape(sender),
                        link(rel),
                        escape(subject),
                    ));
                }
                html.push_str("</table>");
            }
        }
        html.push_str("</body></html>");
        std::fs::write(ext.join("index.html"), html).map_err(err)?;
        Ok(total)
    }
    /// MOVE 完成后把本地存档文件搬到新服务器文件夹名下，并更新 relPath。
    /// 在数据库提交之后调用：文件失败只记录日志——relPath 不变，读取始终指向
    /// 真实文件，磁盘布局滞后但不会读坏；成功则磁盘/界面/服务器三方一致。
    pub(crate) fn relocate_archive_after_move(&self, target_folder: &str, mail_id: &str) {
        let _archive = match self.archive_gate.read() {
            Ok(g) => g,
            Err(_) => return,
        };
        let db = match self.db() {
            Ok(d) => d,
            Err(_) => return,
        };
        let data: String =
            match db.query_row("SELECT data FROM messages WHERE id=?1", [mail_id], |r| {
                r.get(0)
            }) {
                Ok(d) => d,
                Err(_) => return,
            };
        let mut mail: Mail = match serde_json::from_str(&data) {
            Ok(m) => m,
            Err(_) => return,
        };
        let new_rel = match archive::rel_path(&mail.account_email, target_folder, &mail.hash) {
            Some(r) => r,
            None => return, // 账号/文件夹信息不足，保持原路径
        };
        let old_rel = mail
            .rel_path
            .clone()
            .unwrap_or_else(|| format!("archive/{}.eml", mail.hash));
        if old_rel == new_rel {
            return;
        }
        let from = self.root.join(&old_rel);
        let to = self.root.join(&new_rel);
        if !from.exists() {
            return; // 没有本地文件（在线阅读邮件）
        }
        if to.exists() {
            // 目标已有同内容文件（另一文件夹存过）：校验后移除源文件
            match std::fs::read(&to) {
                Ok(bytes) if archive::digest(&bytes) == mail.hash => {
                    let _ = std::fs::remove_file(&from);
                }
                _ => return, // 目标不是同内容：保持原状
            }
        } else if let Err(e) = (|| -> std::result::Result<(), String> {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::rename(&from, &to).map_err(|e| e.to_string())
        })() {
            let _ = self.log(&format!(
                "存档文件移动到「{target_folder}」失败（{}）：{e}",
                &mail.hash.get(..8).unwrap_or("")
            ));
            return;
        }
        mail.rel_path = Some(new_rel);
        if let Err(e) = self.update_mail(&mail) {
            let _ = self.log("存档路径更新失败，文件已在新位置，请重启核对");
        }
    }
    /// 本地存档树：按账号与服务器文件夹聚合已完整存档的邮件数。
    /// 分组口径与列表过滤一致（trusted_sources 的当前文件夹 + savedLocally）。
    pub fn local_archive_tree(&self) -> Result<Vec<LocalArchiveGroup>> {
        let db = self.db()?;
        let mut stmt = db
            .prepare(
                "SELECT s.account_id, MAX(json_extract(m.data,'$.accountEmail')), s.folder,
                        MAX(COALESCE(json_extract(rf.data,'$.displayName'),'')), COUNT(DISTINCT s.mail_id)
                 FROM trusted_sources s JOIN messages m ON m.id = s.mail_id
                 LEFT JOIN remote_folders rf ON rf.account_id = s.account_id AND rf.name = s.folder
                 WHERE s.active=1 AND COALESCE(json_extract(m.data,'$.savedLocally'),1)=1
                       AND COALESCE(json_extract(m.data,'$.trashed'),0)=0
                 GROUP BY s.account_id, s.folder",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    r.get::<_, u64>(4)?,
                ))
            })
            .map_err(err)?;
        let mut groups: BTreeMap<String, LocalArchiveGroup> = BTreeMap::new();
        for row in rows {
            let (account_id, email, folder, display_name, count) = row.map_err(err)?;
            groups
                .entry(account_id.clone())
                .or_insert_with(|| LocalArchiveGroup {
                    account_id,
                    account_email: email,
                    folders: Vec::new(),
                })
                .folders
                .push(LocalArchiveFolder {
                    name: folder,
                    display_name,
                    count,
                });
        }
        let mut out: Vec<_> = groups.into_values().collect();
        for g in &mut out {
            g.folders
                .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        }
        Ok(out)
    }
    /// 把当前数据库做一致快照到目标路径（迁移/备份共用）。
    pub fn vacuum_into(&self, destination: &Path) -> Result<()> {
        let _archive = self.archive_gate.read().map_err(err)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        let db = self.db()?;
        db.execute("VACUUM INTO ?1", [destination.to_string_lossy().as_ref()])
            .map_err(err)?;
        Ok(())
    }
    pub fn db(&self) -> Result<Connection> {
        let c = Connection::open(self.root.join("mail.sqlite3")).map_err(err)?;
        c.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(err)?;
        Ok(c)
    }
    pub fn accounts(&self) -> Result<Vec<Account>> {
        let db = self.db()?;
        let mut q = db
            .prepare("SELECT data FROM accounts ORDER BY rowid")
            .map_err(err)?;
        let rows = q.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        rows.map(|r| serde_json::from_str(&r.map_err(err)?).map_err(err))
            .collect()
    }
    pub fn account(&self, id: &str) -> Result<Account> {
        crate::remote::ReceiveLookup::new(self)?.account(id)
    }
    pub fn save_account(&self, a: &Account) -> Result<()> {
        a.validate()?;
        self.db()?.execute("INSERT INTO accounts(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![a.id,serde_json::to_string(a).map_err(err)?]).map_err(err)?;
        Ok(())
    }
    // Local preferences do not require credentials or a server connection test.
    pub fn edit_account_preferences(&self, account: &Account) -> Result<()> {
        account.validate()?;
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        let data: String = tx
            .query_row(
                "SELECT data FROM accounts WHERE id=?1",
                [&account.id],
                |r| r.get(0),
            )
            .map_err(err)?;
        let mut current: Account = serde_json::from_str(&data).map_err(err)?;
        if !current.same_connection(account) {
            return Err("连接配置已变化，请重新验证并保存".into());
        }
        current.name = account.name.clone();
        current.save_locally = account.save_locally;
        tx.execute(
            "UPDATE accounts SET data=?2 WHERE id=?1",
            params![current.id, serde_json::to_string(&current).map_err(err)?],
        )
        .map_err(err)?;
        tx.commit().map_err(err)
    }
    // A completed sync may have begun before local preferences were edited.
    pub fn save_sync_status(&self, account: &Account) -> Result<()> {
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        let data: Option<String> = tx
            .query_row(
                "SELECT data FROM accounts WHERE id=?1",
                [&account.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        if let Some(data) = data {
            let mut current: Account = serde_json::from_str(&data).map_err(err)?;
            if current.same_connection(account) {
                // A long sweep may fail after a newer inbox job succeeds. Its
                // old checkpoint must not move the latest success backwards.
                if let Some(incoming) = account
                    .last_sync
                    .as_deref()
                    .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
                {
                    let prior = current
                        .last_sync
                        .as_deref()
                        .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok());
                    if prior.is_none_or(|prior| incoming >= prior) {
                        current.last_sync = account.last_sync.clone();
                    }
                }
                current.error = account.error.clone();
                tx.execute(
                    "UPDATE accounts SET data=?2 WHERE id=?1",
                    params![current.id, serde_json::to_string(&current).map_err(err)?],
                )
                .map_err(err)?;
            }
        }
        tx.commit().map_err(err)
    }
    pub fn edit_account(&self, a: &Account) -> Result<()> {
        let old = self.account(&a.id)?;
        if a.email != old.email {
            return Err("修改邮箱地址请添加新账号，已有存档仍保留原账号来源".into());
        }
        a.validate()?;
        let source_changed = old.protocol != a.protocol
            || old.incoming_host != a.incoming_host
            || old.incoming_port != a.incoming_port
            || old.username != a.username;
        let mut next = a.clone();
        next.enabled = old.enabled;
        next.last_sync = if source_changed {
            None
        } else {
            old.last_sync.clone()
        };
        next.error = None;
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        tx.execute(
            "UPDATE accounts SET data=json_set(?2,'$.serverRetentionDays',json_extract(data,'$.serverRetentionDays')) WHERE id=?1",
            params![a.id, serde_json::to_string(&next).map_err(err)?],
        )
        .map_err(err)?;
        if crate::operations::identity(&old) != crate::operations::identity(a) {
            tx.execute("UPDATE folder_health SET identity=?2,reason='账号配置已修改，旧来源须经完整收取重新核对' WHERE account_id=?1", params![a.id,crate::operations::identity(a)]).map_err(err)?;
            tx.execute("UPDATE server_operations SET status='blocked',revision=revision+1,error='账号连接配置已变化，请重新收取后再操作' WHERE account_id=?1 AND status!='completed'", [&a.id]).map_err(err)?;
        }
        if source_changed {
            let removed = tx
                .execute("DELETE FROM folder_health WHERE account_id=?1", [&a.id])
                .map_err(err)?;
            if removed > 0 {
                tx.execute(
                    "UPDATE conversation_revision SET version=version+1 WHERE id=1",
                    [],
                )
                .map_err(err)?;
            }
            tx.execute("DELETE FROM sources WHERE account_id=?1", [&a.id])
                .map_err(err)?;
            tx.execute("DELETE FROM remote_folders WHERE account_id=?1", [&a.id])
                .map_err(err)?;
            tx.execute("DELETE FROM folder_mappings WHERE account_id=?1", [&a.id])
                .map_err(err)?;
            tx.execute("DELETE FROM folder_retention WHERE account_id=?1", [&a.id])
                .map_err(err)?;
        }
        tx.commit().map_err(err)
    }
    pub fn remove_account(&self, id: &str) -> Result<()> {
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        tx.execute(
            "DELETE FROM messages WHERE account_id=?1 AND json_extract(data,'$.savedLocally')=0",
            [id],
        )
        .map_err(err)?;
        tx.execute("DELETE FROM folder_health WHERE account_id=?1", [id])
            .map_err(err)?;
        tx.execute("DELETE FROM folder_mappings WHERE account_id=?1", [id])
            .map_err(err)?;
        tx.execute("DELETE FROM remote_folders WHERE account_id=?1", [id])
            .map_err(err)?;
        tx.execute("DELETE FROM folder_retention WHERE account_id=?1", [id])
            .map_err(err)?;
        tx.execute("UPDATE archive_jobs SET status='cancelled',revision=revision+1,error='账号已移除，本地存档保留' WHERE json_extract(data,'$.accountId')=?1 AND status!='completed'",[id]).map_err(err)?;
        tx.execute("UPDATE server_operations SET status='blocked',revision=revision+1,error='账号已移除，本地存档保留' WHERE account_id=?1 AND status!='completed'", [id]).map_err(err)?;
        tx.execute("DELETE FROM accounts WHERE id=?1", [id])
            .map_err(err)?;
        tx.commit().map_err(err)?;
        self.log("已移除账号，所有本地存档均已保留")
    }
    pub fn rules(&self) -> Result<Vec<Rule>> {
        let db = self.db()?;
        let mut q = db
            .prepare("SELECT data FROM rules ORDER BY position")
            .map_err(err)?;
        let rows = q.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        rows.map(|r| serde_json::from_str(&r.map_err(err)?).map_err(err))
            .collect()
    }
    pub fn save_rules(&self, rs: &[Rule]) -> Result<()> {
        for r in rs {
            rules::validate(r)?;
        }
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        tx.execute("DELETE FROM rules", []).map_err(err)?;
        for (i, r) in rs.iter().enumerate() {
            tx.execute(
                "INSERT INTO rules VALUES(?1,?2,?3)",
                params![r.id, i, serde_json::to_string(r).map_err(err)?],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }
    pub fn mail(&self, id: &str) -> Result<Mail> {
        let raw: String = self
            .db()?
            .query_row("SELECT data FROM messages WHERE id=?1", [id], |r| r.get(0))
            .map_err(err)?;
        serde_json::from_str(&raw).map_err(err)
    }
    pub fn update_mail(&self, m: &Mail) -> Result<()> {
        self.db()?
            .execute(
                "UPDATE messages SET data=?2 WHERE id=?1",
                params![m.id, serde_json::to_string(m).map_err(err)?],
            )
            .map_err(err)?;
        Ok(())
    }
    #[cfg(test)]
    pub fn has_source(&self, account: &str, folder: &str, remote: &str) -> Result<bool> {
        self.db()?.query_row("SELECT EXISTS(SELECT 1 FROM sources WHERE account_id=?1 AND folder=?2 AND remote_id=?3)",params![account,folder,remote],|r|r.get(0)).map_err(err)
    }
    pub fn ingest(
        &self,
        a: &Account,
        folder: &str,
        remote: &str,
        raw: &[u8],
        read: bool,
    ) -> Result<bool> {
        self.ingest_with_flags(a, folder, remote, raw, read, false)
    }
    pub(crate) fn ingest_with_flags(
        &self,
        a: &Account,
        folder: &str,
        remote: &str,
        raw: &[u8],
        read: bool,
        starred: bool,
    ) -> Result<bool> {
        let _archive = self.archive_gate.read().map_err(err)?;
        // A cleanup can disable retention while a FETCH is in flight. Do not
        // republish an old request as a local archive after it finishes.
        let mut a = a.clone();
        // Only a confirmed local SMTP record can bypass receiving retention.
        // A real server folder also named Sent must obey the latest scope.
        let local_sent = folder == "Sent" && self.db()?.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE id=?1 AND status='sent' AND json_extract(data,'$.accountId')=?2)", params![remote,a.id], |r|r.get::<_,bool>(0)).map_err(err)?;
        if !local_sent {
            if let Ok(current) = self.account(&a.id) {
                a.save_locally &= self.should_save_folder(&current, folder)?;
            }
        }
        let a = &a;
        let (mut mail, _, _) = archive::parse(raw, a, folder)?;
        if !mail.parse_warnings.is_empty() {
            self.log(&format!(
                "文件夹「{folder}」邮件 {remote} 部分内容编码异常；{}：{}",
                if a.save_locally {
                    "完整原件将保留"
                } else {
                    "服务器原件未修改"
                },
                mail.parse_warnings.join("；")
            ))?;
        }
        let save = a.save_locally;
        let hash = archive::digest(raw);
        let rel_path = if save {
            Some(archive::store_raw(
                &self.root,
                &mail.account_email,
                &mail.source_folder,
                raw,
            )?)
        } else {
            None
        }; // durable, complete MIME before DB success or rule execution
        mail.hash = hash.clone();
        mail.rel_path = rel_path;
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM messages WHERE account_id=?1 AND hash=?2",
                params![a.id, hash],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        let is_new = existing.is_none();
        let mut upgraded = false;
        if let Some(id) = existing {
            mail.id = id;
            let data: String = tx
                .query_row("SELECT data FROM messages WHERE id=?1", [&mail.id], |r| {
                    r.get(0)
                })
                .map_err(err)?;
            let old: Mail = serde_json::from_str(&data).map_err(err)?;
            if save && !old.saved_locally {
                mail.is_read = old.is_read;
                mail.starred = old.starred;
                mail.local_read_override = old.local_read_override;
                mail.local_star_override = old.local_star_override;
                mail.trashed = old.trashed;
                mail.local_folder = old.local_folder;
                mail.server_date = old.server_date;
                if mail.date.is_empty() {
                    mail.date = mail.server_date.clone();
                }
                tx.execute(
                    "UPDATE messages SET data=?2,parser_version=3 WHERE id=?1",
                    params![mail.id, serde_json::to_string(&mail).map_err(err)?],
                )
                .map_err(err)?;
                upgraded = true;
            }
        } else {
            // Preserve identity and local actions when an online-only message
            // later gains a complete archive after the account setting changes.
            let previous: Option<String> = tx.query_row("SELECT m.data FROM sources s JOIN messages m ON m.id=s.mail_id WHERE s.account_id=?1 AND s.folder=?2 AND s.remote_id=?3", params![a.id,folder,remote], |r| r.get(0)).optional().map_err(err)?;
            if let Some(data) = previous {
                let old: Mail = serde_json::from_str(&data).map_err(err)?;
                if !old.saved_locally {
                    mail.id = old.id;
                    mail.is_read = old.is_read;
                    mail.starred = old.starred;
                    mail.local_read_override = old.local_read_override;
                    mail.local_star_override = old.local_star_override;
                    mail.trashed = old.trashed;
                    mail.local_folder = old.local_folder;
                    mail.server_date = old.server_date;
                }
            } else {
                mail.is_read = read;
                mail.starred = starred;
            }
            mail.saved_locally = save;
            if !save {
                mail.body.clear();
            }
            if mail.date.is_empty() {
                mail.date = mail.server_date.clone();
            }
            tx.execute("INSERT INTO messages(id,account_id,hash,data,parser_version) VALUES(?1,?2,?3,?4,3) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,data=excluded.data,parser_version=3", params![mail.id,a.id,hash,serde_json::to_string(&mail).map_err(err)?]).map_err(err)?;
        }
        tx.execute("INSERT INTO sources(account_id,folder,remote_id,mail_id) VALUES(?1,?2,?3,?4) ON CONFLICT(account_id,folder,remote_id) DO UPDATE SET mail_id=excluded.mail_id,active=1",params![a.id,folder,remote,mail.id]).map_err(err)?;
        tx.commit().map_err(err)?;
        // A deduplicated MIME can acquire its rule source on a later folder scan.
        if is_new || upgraded {
            self.apply_rules(&mail.id)?;
        } else {
            self.apply_rules_inner(&mail.id, true)?;
        }
        Ok(is_new)
    }
    pub fn apply_rules(&self, id: &str) -> Result<u32> {
        self.apply_rules_inner(id, false)
    }
    fn apply_rules_inner(&self, id: &str, remote_only: bool) -> Result<u32> {
        let configured = self.rules()?;
        if remote_only && !configured.iter().any(|r| r.enabled && rules::remote(r)) {
            return Ok(0);
        }
        self.apply_configured_rules(self.mail(id)?, &configured, remote_only)
    }
    fn apply_configured_rules(
        &self,
        mut m: Mail,
        configured: &[Rule],
        remote_only: bool,
    ) -> Result<u32> {
        if m.saved_locally && !remote_only {
            self.read_archive(m.rel_path.as_deref(), &m.hash)?;
        }
        let mut count = 0;
        for r in configured {
            if remote_only && !rules::remote(&r) {
                if rules::matches(&r, &m) && r.stop {
                    break;
                }
                continue;
            }
            if rules::matches(&r, &m) {
                if rules::remote(&r) {
                    if self.apply_remote_rule(&r, &m, false)? {
                        count += 1;
                    } else {
                        continue;
                    }
                    if r.stop {
                        break;
                    }
                    continue;
                }
                match r.action.as_str() {
                    "folder" => m.local_folder = r.destination.clone(),
                    "read" => {
                        m.is_read = true;
                        m.local_read_override = Some(true);
                    }
                    "unread" => {
                        m.is_read = false;
                        m.local_read_override = Some(false);
                    }
                    "star" => {
                        m.starred = true;
                        m.local_star_override = Some(true);
                    }
                    "trash" => m.trashed = true,
                    _ => return Err("未知动作".into()),
                };
                self.update_mail(&m)?;
                self.log(&format!("规则「{}」已执行 · {}", r.name, m.subject))?;
                count += 1;
                if r.stop {
                    break;
                }
            }
        }
        Ok(count)
    }
    pub fn reconcile_folder(
        &self,
        account: &str,
        folder: &str,
        remote_ids: &[String],
    ) -> Result<()> {
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        tx.execute(
            "UPDATE sources SET active=0 WHERE account_id=?1 AND folder=?2",
            params![account, folder],
        )
        .map_err(err)?;
        for id in remote_ids {
            tx.execute(
                "UPDATE sources SET active=1 WHERE account_id=?1 AND folder=?2 AND remote_id=?3",
                params![account, folder, id],
            )
            .map_err(err)?;
        }
        tx.execute("DELETE FROM messages WHERE account_id=?1 AND json_extract(data,'$.savedLocally')=0 AND NOT EXISTS(SELECT 1 FROM sources WHERE mail_id=messages.id AND active=1) AND NOT EXISTS(SELECT 1 FROM directory_operations d WHERE d.account_id=messages.account_id AND json_extract(d.data,'$.mailId')=messages.id AND d.status NOT IN ('completed','cancelled'))", [account]).map_err(err)?;
        tx.commit().map_err(err)
    }
    pub fn preview_rule(&self, rule: &Rule) -> Result<Vec<String>> {
        rules::validate(rule)?;
        let mut rule = rule.clone();
        rule.enabled = true;
        let db = self.db()?;
        let mut q = db.prepare("SELECT data FROM messages").map_err(err)?;
        let mut matches = Vec::new();
        for row in q.query_map([], |r| r.get::<_, String>(0)).map_err(err)? {
            let m: Mail = serde_json::from_str(&row.map_err(err)?).map_err(err)?;
            if rules::matches(&rule, &m)
                && (!rules::remote(&rule) || self.rule_has_source(&rule, &m)?)
            {
                matches.push(m.subject);
            }
        }
        Ok(matches)
    }
    pub fn run_rules(&self) -> Result<u32> {
        // Freeze the ordered configuration once per historical scan. Use the
        // body-free projection unless a condition actually needs stored text;
        // unrelated archives must not be opened or hashed by a scoped rule.
        let configured = self.rules()?;
        if !configured.iter().any(|r| r.enabled) {
            return Ok(0);
        }
        let needs_body = configured.iter().any(|r| {
            r.enabled
                && r.conditions
                    .iter()
                    .any(|condition| condition.field == "body")
        });
        let db = self.db()?;
        let mut q = db
            .prepare(if needs_body {
                "SELECT data FROM messages ORDER BY rowid"
            } else {
                "SELECT data FROM message_listing ORDER BY rowid"
            })
            .map_err(err)?;
        let candidates = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        let mut n = 0;
        for data in candidates {
            let mail: Mail = serde_json::from_str(&data).map_err(err)?;
            if configured.iter().any(|rule| rules::matches(rule, &mail)) {
                // Load the current full record only for candidates. Conditions
                // and stop ordering are evaluated again before any mutation.
                n += self.apply_configured_rules(self.mail(&mail.id)?, &configured, false)?;
            }
        }
        Ok(n)
    }
    pub fn log(&self, msg: &str) -> Result<()> {
        let db = self.db()?;
        db.execute(
            "INSERT INTO logs(time,message) VALUES(?1,?2)",
            params![chrono::Local::now().format("%m-%d %H:%M").to_string(), msg],
        )
        .map_err(err)?;
        db.execute(
            "DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 500)",
            [],
        )
        .map_err(err)?;
        Ok(())
    }
    pub fn snapshot(&self, q: &Query) -> Result<Snapshot> {
        let db = self.db()?;
        let where_sql="(?1='' OR account_id=?1) AND (?2='' OR instr(lower(CASE ?8 WHEN 'subject' THEN json_extract(data,'$.subject') WHEN 'sender' THEN json_extract(data,'$.sender') WHEN 'recipients' THEN json_extract(data,'$.recipients') WHEN 'body' THEN (SELECT json_extract(original.data,'$.body') FROM messages original WHERE original.id=listing.id) ELSE json_extract(data,'$.subject') || ' ' || json_extract(data,'$.sender') || ' ' || json_extract(data,'$.recipients') || ' ' || (SELECT json_extract(original.data,'$.body') FROM messages original WHERE original.id=listing.id) END), lower(?2))>0) AND (?3='' OR json_extract(data,'$.localFolder')=?3) AND CASE ?4 WHEN 'trash' THEN json_extract(data,'$.trashed')=1 ELSE json_extract(data,'$.trashed')=0 END AND CASE ?4 WHEN 'all' THEN EXISTS(SELECT 1 FROM trusted_sources s JOIN accounts a ON a.id=s.account_id WHERE s.mail_id=listing.id AND s.folder='INBOX' COLLATE NOCASE AND s.active=1) WHEN 'unread' THEN json_extract(data,'$.isRead')=0 WHEN 'starred' THEN json_extract(data,'$.starred')=1 WHEN 'sent' THEN (EXISTS(SELECT 1 FROM trusted_sources s JOIN remote_folders f ON f.account_id=s.account_id AND f.name=s.folder WHERE s.mail_id=listing.id AND s.active=1 AND EXISTS(SELECT 1 FROM json_each(f.data,'$.roles') WHERE value='sent')) OR (json_extract(data,'$.sourceFolder')='Sent' AND (NOT EXISTS(SELECT 1 FROM remote_folders f WHERE f.account_id=listing.account_id AND f.name='Sent') OR EXISTS(SELECT 1 FROM trusted_sources s JOIN outbox o ON o.id=s.remote_id WHERE s.mail_id=listing.id AND s.folder='Sent' AND o.status='sent')))) ELSE 1 END AND (?5=0 OR json_extract(data,'$.isRead')=0) AND (?6=0 OR json_extract(data,'$.starred')=1) AND (?7=0 OR json_extract(data,'$.hasAttachments')=1) AND (?9='' OR EXISTS(SELECT 1 FROM trusted_sources s WHERE s.mail_id=listing.id AND s.account_id=listing.account_id AND s.folder=?9 AND s.active=1)) AND (?4!='local' OR COALESCE(json_extract(data,'$.savedLocally'),1)=1)";
        let mut st=db.prepare(&format!("SELECT data FROM readable_listing listing WHERE {where_sql} ORDER BY json_extract(data,'$.date') DESC")).map_err(err)?;
        let rows = st
            .query_map(
                params![
                    q.account_id,
                    q.search,
                    q.folder,
                    q.view,
                    q.unread_only,
                    q.starred_only,
                    q.attachments_only,
                    q.search_field,
                    q.remote_folder
                ],
                |r| r.get::<_, String>(0),
            )
            .map_err(err)?;
        let messages = rows
            .map(|r| serde_json::from_str(&r.map_err(err)?).map_err(err))
            .collect::<Result<Vec<Mail>>>()?;
        let mut messages = match q.list_mode {
            ListMode::Conversations => {
                let index = self.conversation_index(&q.account_id)?;
                crate::conversation::summaries(messages, &index)
            }
            ListMode::Messages => messages
                .into_iter()
                .map(|mut mail| {
                    mail.conversation_id.clear();
                    mail.conversation_count = 1;
                    mail
                })
                .collect(),
        };
        let matched = messages.len() as u64;
        messages.truncate(q.limit.clamp(1, 5000) as usize);
        let stats=db.query_row("SELECT COUNT(*),COALESCE(SUM(CASE WHEN json_extract(data,'$.isRead')=0 AND json_extract(data,'$.trashed')=0 AND EXISTS(SELECT 1 FROM trusted_sources s WHERE s.mail_id=message_listing.id AND s.folder='INBOX' COLLATE NOCASE AND s.active=1) THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN COALESCE(json_extract(data,'$.savedLocally'),1)=1 THEN json_extract(data,'$.size') ELSE 0 END),0),COALESCE(SUM(COALESCE(json_extract(data,'$.savedLocally'),1)),0) FROM message_listing",[],|r|Ok(Stats{total:r.get(0)?,saved:r.get(3)?,unread:r.get(1)?,bytes:r.get(2)?})).map_err(err)?;
        let mut fs=db.prepare("SELECT DISTINCT json_extract(data,'$.localFolder') FROM message_listing WHERE json_extract(data,'$.localFolder')!='全部存档' ORDER BY 1").map_err(err)?;
        let folders = fs
            .query_map([], |r| r.get(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<String>, _>>()
            .map_err(err)?;
        let mut ls = db
            .prepare("SELECT time || '  ' || message FROM logs ORDER BY id DESC LIMIT 30")
            .map_err(err)?;
        let logs = ls
            .query_map([], |r| {
                r.get::<_, String>(0)
                    .map(|message| crate::remote::display_activity(&message))
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<String>, _>>()
            .map_err(err)?;
        Ok(Snapshot {
            accounts: self
                .accounts()?
                .into_iter()
                .map(|mut account| {
                    account.error = account
                        .error
                        .as_deref()
                        .map(crate::remote::display_activity);
                    account
                })
                .collect(),
            rules: self.rules()?,
            messages,
            folders,
            stats,
            logs,
            data_dir: self.root.to_string_lossy().into(),
            matched,
            remote_folders: self.remote_folders(None)?,
            folder_unread: {
                let mut q = db
                    .prepare(
                        "SELECT s.account_id, s.folder, COUNT(DISTINCT s.mail_id)
                         FROM trusted_sources s JOIN messages m ON m.id = s.mail_id
                         WHERE s.active=1 AND json_extract(m.data,'$.isRead')=0
                               AND COALESCE(json_extract(m.data,'$.trashed'),0)=0
                         GROUP BY s.account_id, s.folder",
                    )
                    .map_err(err)?;
                let rows = q
                    .query_map([], |r| {
                        Ok(FolderUnread {
                            account_id: r.get(0)?,
                            folder: r.get(1)?,
                            count: r.get(2)?,
                        })
                    })
                    .map_err(err)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(err)?;
                rows
            },
            folder_totals: {
                let mut q = db
                    .prepare(
                        "SELECT s.account_id, s.folder, COUNT(DISTINCT s.mail_id)
                         FROM trusted_sources s JOIN messages m ON m.id = s.mail_id
                         WHERE s.active=1 AND COALESCE(json_extract(m.data,'$.trashed'),0)=0
                         GROUP BY s.account_id, s.folder",
                    )
                    .map_err(err)?;
                let rows = q
                    .query_map([], |r| {
                        Ok(FolderUnread {
                            account_id: r.get(0)?,
                            folder: r.get(1)?,
                            count: r.get(2)?,
                        })
                    })
                    .map_err(err)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(err)?;
                rows
            },
        })
    }
    pub fn detail(&self, id: &str) -> Result<Detail> {
        let mut mail = self.mail(id)?;
        let index = self.conversation_index(&mail.account_id)?;
        mail.conversation_id = index
            .roots
            .get(id)
            .cloned()
            .unwrap_or_else(|| id.to_string());
        mail.conversation_count = *index
            .counts
            .get(&(mail.conversation_id.clone(), mail.trashed))
            .unwrap_or(&1);
        let raw = self.message_raw(&mail)?;
        let (parsed, html, attachments) =
            archive::parse(&raw, &self.account_for_mail(&mail), &mail.source_folder)?;
        mail.body = parsed.body;
        mail.has_attachments = parsed.has_attachments;
        let (reply_to, to, cc) = archive::reply_addresses(&raw)?;
        Ok(Detail {
            mail,
            html,
            attachments,
            reply_to,
            to,
            cc,
        })
    }
    fn reparse(&self, mail: &Mail) -> Result<(Mail, String, Vec<AttachmentInfo>)> {
        let raw = self.read_archive(mail.rel_path.as_deref(), &mail.hash)?;
        let fake = self.account_for_mail(mail);
        archive::parse(&raw, &fake, &mail.source_folder)
    }
    pub(crate) fn account_for_mail(&self, mail: &Mail) -> Account {
        Account {
            id: mail.account_id.clone(),
            email: mail.account_email.clone(),
            name: String::new(),
            provider: String::new(),
            protocol: "imap".into(),
            incoming_host: String::new(),
            incoming_port: 993,
            incoming_tls: "tls".into(),
            smtp_host: String::new(),
            smtp_port: 465,
            smtp_tls: "tls".into(),
            username: String::new(),
            smtp_username: String::new(),
            auth: "password".into(),
            oauth_client_id: String::new(),
            enabled: false,
            save_locally: true,
            server_retention_days: None,
            last_sync: None,
            error: None,
        }
    }
    fn refresh_archive_metadata(&self) -> Result<()> {
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        let rows = tx
            .prepare("SELECT data FROM messages WHERE parser_version < 3")
            .map_err(err)?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        let mut failed = 0;
        for data in rows {
            let mut mail: Mail = serde_json::from_str(&data).map_err(err)?;
            let Ok((parsed, _, _)) = self.reparse(&mail) else {
                // Missing/corrupt archives remain unchanged and retry next startup.
                failed += 1;
                continue;
            };
            mail.date = if parsed.date.is_empty() {
                mail.server_date.clone()
            } else {
                parsed.date
            };
            mail.sender = parsed.sender;
            mail.recipients = parsed.recipients;
            mail.subject = parsed.subject;
            mail.body = parsed.body;
            mail.preview = parsed.preview;
            mail.message_id = parsed.message_id;
            mail.in_reply_to = parsed.in_reply_to;
            mail.references = parsed.references;
            tx.execute(
                "UPDATE messages SET data=?2,parser_version=3 WHERE id=?1",
                params![mail.id, serde_json::to_string(&mail).map_err(err)?],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        if failed > 0 {
            self.log(&format!(
                "{failed} 封存档因文件缺失、校验或解析失败，未更新显示信息；原记录已保留"
            ))?;
        }
        Ok(())
    }
    pub fn drafts(&self) -> Result<Vec<Compose>> {
        let db = self.db()?;
        let mut q = db
            .prepare("SELECT data FROM drafts ORDER BY rowid DESC")
            .map_err(err)?;
        let rows = q.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        rows.map(|r| serde_json::from_str(&r.map_err(err)?).map_err(err))
            .collect()
    }
    pub fn save_draft(&self, d: &Compose) -> Result<()> {
        let db = self.db()?;
        let locked: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE id=?1 AND status IN ('scheduled','overdue','paused','sending','sent'))", [&d.id], |r| r.get(0)).map_err(err)?;
        if locked {
            return Err("邮件已进入发送记录，请在那里修改计划或取消后编辑".into());
        }
        db.execute(
            "INSERT INTO drafts VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            params![d.id, serde_json::to_string(d).map_err(err)?],
        )
        .map_err(err)?;
        Ok(())
    }
    pub fn backup(&self, destination: &Path) -> Result<String> {
        let _archive = self.archive_gate.read().map_err(err)?;
        let folder = destination.join(format!(
            "Mail-backup-{}-{}",
            chrono::Local::now().format("%Y%m%d-%H%M%S"),
            &uuid::Uuid::new_v4().to_string()[..8]
        ));
        fs::create_dir_all(folder.join("archive")).map_err(err)?;
        let db = self.db()?;
        db.execute(
            "VACUUM INTO ?1",
            [folder.join("snapshot.sqlite3").to_string_lossy().as_ref()],
        )
        .map_err(err)?;
        let snap = Connection::open(folder.join("snapshot.sqlite3")).map_err(err)?;
        let mut stmt = snap
            .prepare("SELECT DISTINCT hash, COALESCE(json_extract(data,'$.relPath'),'') FROM messages WHERE COALESCE(json_extract(data,'$.savedLocally'),1)=1")
            .map_err(err)?;
        for h in stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(err)?
        {
            let (hash, rel) = h.map_err(err)?;
            let rel = if rel.is_empty() {
                None
            } else {
                Some(rel.as_str())
            };
            archive::atomic_write(
                &folder.join("archive").join(format!("{hash}.eml")),
                &self.read_archive(rel, &hash)?,
            )?;
        }
        drop(stmt);
        snap.execute_batch("DELETE FROM accounts; DELETE FROM folder_retention; DELETE FROM archive_jobs; DELETE FROM drafts; DELETE FROM outbox; DELETE FROM sent_uploads; DELETE FROM logs; DELETE FROM server_operations; DELETE FROM folder_health; DELETE FROM directory_operations; DELETE FROM rule_executions; VACUUM;").map_err(err)?;
        archive::atomic_write(
            &folder.join("manifest.json"),
            br#"{"format":"mail-desktop-archive","version":1}"#,
        )?;
        Ok(folder.to_string_lossy().into())
    }
    pub fn restore(&self, folder: &Path) -> Result<usize> {
        let _archive = self.archive_gate.read().map_err(err)?;
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(folder.join("manifest.json")).map_err(err)?)
                .map_err(err)?;
        if manifest["format"] != "mail-desktop-archive" || manifest["version"] != 1 {
            return Err("不支持的备份格式".into());
        }
        let source = Connection::open_with_flags(
            folder.join("snapshot.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(err)?;
        let mut q = source.prepare("SELECT data FROM messages").map_err(err)?;
        let rows = q.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        let mut messages = Vec::new();
        for row in rows {
            let m: Mail = serde_json::from_str(&row.map_err(err)?).map_err(err)?;
            if !m.saved_locally {
                continue;
            }
            let raw = archive::read_raw(&[folder.to_path_buf()], None, &m.hash)?;
            let rel = archive::store_raw(&self.root, &m.account_email, &m.source_folder, &raw)?;
            let mut m = m;
            m.rel_path = Some(rel);
            if m.saved_locally {
                messages.push(m);
            }
        }
        let has_table = |name: &str| -> Result<bool> {
            source
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [name],
                    |r| r.get(0),
                )
                .map_err(err)
        };
        let mut restored_rules = Vec::<Rule>::new();
        if has_table("rules")? {
            let mut q = source
                .prepare("SELECT data FROM rules ORDER BY position")
                .map_err(err)?;
            for row in q.query_map([], |r| r.get::<_, String>(0)).map_err(err)? {
                let rule: Rule = serde_json::from_str(&row.map_err(err)?).map_err(err)?;
                rules::validate(&rule)?;
                restored_rules.push(rule);
            }
        }
        let mut restored_contacts = Vec::<Contact>::new();
        if has_table("contacts")? {
            let mut q = source
                .prepare("SELECT id,name,email FROM contacts ORDER BY rowid")
                .map_err(err)?;
            for row in q
                .query_map([], |r| {
                    Ok(Contact {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        email: r.get(2)?,
                    })
                })
                .map_err(err)?
            {
                let contact = row.map_err(err)?;
                if contact.id.is_empty()
                    || contact.email.parse::<lettre::Address>().is_err()
                    || contact.name.contains(['\r', '\n'])
                {
                    return Err("备份中的联系人信息无效".into());
                }
                restored_contacts.push(contact);
            }
        }
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        let mut count = 0;
        for m in messages {
            count += tx
                .execute(
                    "INSERT OR IGNORE INTO messages(id,account_id,hash,data) VALUES(?1,?2,?3,?4)",
                    params![
                        m.id,
                        m.account_id,
                        m.hash,
                        serde_json::to_string(&m).map_err(err)?
                    ],
                )
                .map_err(err)?;
        }
        let mut position: i64 = tx
            .query_row("SELECT COALESCE(MAX(position),-1)+1 FROM rules", [], |r| {
                r.get(0)
            })
            .map_err(err)?;
        let mut rule_count = 0;
        for rule in restored_rules {
            let n = tx
                .execute(
                    "INSERT OR IGNORE INTO rules(id,position,data) VALUES(?1,?2,?3)",
                    params![
                        rule.id,
                        position,
                        serde_json::to_string(&rule).map_err(err)?
                    ],
                )
                .map_err(err)?;
            position += n as i64;
            rule_count += n;
        }
        let mut contact_count = 0;
        for contact in restored_contacts {
            contact_count += tx
                .execute(
                    "INSERT OR IGNORE INTO contacts(id,name,email) VALUES(?1,?2,?3)",
                    params![contact.id, contact.name, contact.email],
                )
                .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        self.refresh_archive_metadata()?;
        self.log(&format!(
            "备份恢复：新增 {count} 封邮件、{rule_count} 条规则、{contact_count} 位联系人"
        ))?;
        Ok(count)
    }
}
