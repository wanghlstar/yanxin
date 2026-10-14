use crate::{models::*, store::Store};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Link {
    id: String,
    account_id: String,
    #[serde(default)]
    message_id: String,
    #[serde(default)]
    server_message_id: String,
    #[serde(default)]
    in_reply_to: Vec<String>,
    #[serde(default)]
    references: Vec<String>,
    trashed: bool,
}
pub struct Index {
    pub roots: HashMap<String, String>,
    pub counts: HashMap<(String, bool), usize>,
}
fn chronological(a: &Mail, b: &Mail) -> std::cmp::Ordering {
    let instant = |mail: &Mail| chrono::DateTime::parse_from_rfc3339(&mail.date).ok();
    match (instant(a), instant(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
    .then(a.id.cmp(&b.id))
}
fn root(parents: &mut [usize], mut i: usize) -> usize {
    while parents[i] != i {
        parents[i] = parents[parents[i]];
        i = parents[i];
    }
    i
}
fn index(links: &[Link]) -> Index {
    let mut parents: Vec<_> = (0..links.len()).collect();
    let mut owners = HashMap::new();
    for (i, link) in links.iter().enumerate() {
        for token in std::iter::once(&link.message_id)
            .chain(std::iter::once(&link.server_message_id))
            .chain(&link.in_reply_to)
            .chain(&link.references)
            .filter(|t| !t.is_empty())
        {
            // Missing ancestors are still valid shared links. Account IDs form
            // part of the key, even when two mailboxes receive the same MIME.
            let key = (link.account_id.clone(), token.clone());
            if let Some(&other) = owners.get(&key) {
                let a = root(&mut parents, i);
                let b = root(&mut parents, other);
                parents[a] = b;
            } else {
                owners.insert(key, i);
            }
        }
    }
    let mut names: HashMap<usize, String> = HashMap::new();
    for (i, link) in links.iter().enumerate() {
        let group = root(&mut parents, i);
        let name = names.entry(group).or_insert_with(|| link.id.clone());
        if link.id < *name {
            *name = link.id.clone();
        }
    }
    let mut roots = HashMap::new();
    let mut counts = HashMap::new();
    let mut seen = HashSet::new();
    for (i, link) in links.iter().enumerate() {
        let name = names[&root(&mut parents, i)].clone();
        roots.insert(link.id.clone(), name.clone());
        let identity = if !link.server_message_id.is_empty() {
            link.server_message_id.clone()
        } else if link.message_id.is_empty() {
            format!("local:{}", link.id)
        } else {
            link.message_id.clone()
        };
        if seen.insert((name.clone(), link.trashed, identity)) {
            *counts.entry((name, link.trashed)).or_insert(0) += 1;
        }
    }
    Index { roots, counts }
}
pub fn summaries(messages: Vec<Mail>, index: &Index) -> Vec<Mail> {
    let mut positions = HashMap::new();
    let mut out: Vec<Mail> = Vec::new();
    for mut mail in messages {
        let key = index.roots.get(&mail.id).unwrap_or(&mail.id).clone();
        if let Some(&i) = positions.get(&key) {
            let previous: &mut Mail = &mut out[i];
            previous.is_read &= mail.is_read;
            previous.starred |= mail.starred;
            previous.has_attachments |= mail.has_attachments;
        } else {
            positions.insert(key.clone(), out.len());
            mail.conversation_count = *index.counts.get(&(key.clone(), mail.trashed)).unwrap_or(&1);
            mail.conversation_id = key;
            out.push(mail);
        }
    }
    out
}
fn links_in(db: &rusqlite::Connection) -> Result<Vec<Link>> {
    let mut query = db.prepare("SELECT json_object('id',id,'accountId',account_id,'messageId',COALESCE(json_extract(data,'$.messageId'),''),'serverMessageId',COALESCE(json_extract(data,'$.serverMessageId'),''),'inReplyTo',json(COALESCE(json_extract(data,'$.inReplyTo'),'[]')),'references',json(COALESCE(json_extract(data,'$.references'),'[]')),'trashed',json(CASE WHEN json_extract(data,'$.trashed') THEN 'true' ELSE 'false' END)) FROM readable_listing").map_err(err)?;
    let links = query
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(err)?
        .map(|r| serde_json::from_str(&r.map_err(err)?).map_err(err))
        .collect::<Result<Vec<Link>>>()?;
    Ok(links)
}
pub(crate) struct Member {
    pub id: String,
    pub root: String,
    pub trashed: bool,
}
pub(crate) fn projection(db: &rusqlite::Connection) -> Result<(Index, Vec<Member>)> {
    let links = links_in(db)?;
    let graph = index(&links);
    let members = links
        .into_iter()
        .map(|link| Member {
            root: graph.roots[&link.id].clone(),
            id: link.id,
            trashed: link.trashed,
        })
        .collect();
    Ok((graph, members))
}

impl Store {
    pub fn change_mail(&self, id: &str, action: &str, value: &str) -> Result<()> {
        if matches!(action, "read" | "star" | "trash" | "delete")
            && !matches!(value, "true" | "false")
        {
            return Err("无效状态值".into());
        }
        // 彻底删除时邮件可能已被后台同步清除（服务器确认后 purge），
        // 目标状态已经达成，按成功返回，避免整批删除被一封旧邮件中断。
        if action == "delete" {
            let archived: bool = self
                .db()?
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM messages WHERE id=?1)",
                    [id],
                    |r| r.get(0),
                )
                .map_err(err)?;
            if !archived {
                return Ok(());
            }
        }
        let selected = self.mail(id)?;
        let mut db = self.db()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        let rows = tx.prepare("SELECT data FROM messages WHERE id=?1 OR (account_id=?2 AND ((?3!='' AND json_extract(data,'$.messageId')=?3) OR (?4!='' AND COALESCE(NULLIF(json_extract(data,'$.serverMessageId'),''),json_extract(data,'$.messageId'))=?4)))").map_err(err)?
            .query_map(rusqlite::params![id, selected.account_id, selected.message_id, if selected.server_message_id.is_empty() { &selected.message_id } else { &selected.server_message_id }], |r| r.get::<_, String>(0)).map_err(err)?
            .collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        let mut row_ids: Vec<String> = Vec::new();
        for data in rows {
            let mut mail: Mail = serde_json::from_str(&data).map_err(err)?;
            row_ids.push(mail.id.clone());
            match action {
                "read" => {
                    mail.is_read = value == "true";
                    mail.local_read_override = None;
                }
                "star" => {
                    mail.starred = value == "true";
                    mail.local_star_override = None;
                }
                "trash" => mail.trashed = value == "true",
                "delete" => mail.trashed = true, // 先入废纸篓，服务器确认后清除本地
                "folder" if !value.trim().is_empty() => mail.local_folder = value.into(),
                _ => return Err("无效动作或空文件夹名称".into()),
            }
            crate::operations::enqueue(&tx, &mail, action, value == "true")?;
            tx.execute(
                "UPDATE messages SET data=?2 WHERE id=?1",
                rusqlite::params![mail.id, serde_json::to_string(&mail).map_err(err)?],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        // 彻底删除：没有活跃服务器来源的邮件无需服务端操作，直接清除本地
        if action == "delete" {
            for id in row_ids {
                let has_source: bool = self
                    .db()?
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sources WHERE mail_id=?1 AND active=1)",
                        [&id],
                        |r| r.get(0),
                    )
                    .map_err(err)?;
                if !has_source {
                    let _ = self.purge_mail(&id);
                }
            }
        }
        Ok(())
    }
    pub fn conversation_index(&self, _account: &str) -> Result<Arc<Index>> {
        let mut cached = self.conversation_cache.lock().map_err(err)?;
        let mut db = self.db()?;
        let tx = db.transaction().map_err(err)?;
        let revision: i64 = tx
            .query_row(
                "SELECT version FROM conversation_revision WHERE id=1",
                [],
                |r| r.get(0),
            )
            .map_err(err)?;
        if let Some((version, graph)) = cached.as_ref() {
            if *version == revision {
                return Ok(graph.clone());
            }
        }
        // A read transaction pins both the revision and link metadata to the
        // same snapshot while new messages continue to arrive in WAL mode.
        let links = links_in(&tx)?;
        let graph = Arc::new(index(&links));
        *cached = Some((revision, graph.clone()));
        Ok(graph)
    }
    pub fn conversation(&self, id: &str) -> Result<Vec<Mail>> {
        let selected = self.mail(id)?;
        let index = self.conversation_index(&selected.account_id)?;
        let group = index
            .roots
            .get(id)
            .ok_or("这封邮件的服务器来源尚未通过核查，请重新收取真实文件夹后再打开")?;
        let db = self.db()?;
        // Fetch bodies only for this thread, using the primary-key index.
        let mut query = db
            .prepare("SELECT data FROM messages WHERE id=?1 AND json_extract(data,'$.trashed')=?2")
            .map_err(err)?;
        let mut mails = Vec::<Mail>::new();
        for (member, root) in &index.roots {
            if root != group {
                continue;
            }
            let data = query
                .query_map(rusqlite::params![member, selected.trashed], |r| {
                    r.get::<_, String>(0)
                })
                .map_err(err)?;
            for row in data {
                mails.push(serde_json::from_str(&row.map_err(err)?).map_err(err)?);
            }
        }
        mails.sort_by(chronological);
        let mut out: Vec<Mail> = Vec::new();
        let mut positions = HashMap::new();
        for mut mail in mails {
            if index.roots.get(&mail.id) != Some(group) {
                continue;
            }
            mail.conversation_id = group.clone();
            mail.conversation_count = *index
                .counts
                .get(&(group.clone(), mail.trashed))
                .unwrap_or(&1);
            // A server Sent copy and the local SMTP archive can have different
            // bytes but the same Message-ID. Keep both archives; show one turn.
            let identity = if mail.server_message_id.is_empty() {
                &mail.message_id
            } else {
                &mail.server_message_id
            };
            if !identity.is_empty() {
                if let Some(&position) = positions.get(identity) {
                    if mail.id == id {
                        out[position] = mail;
                    }
                    continue;
                }
                positions.insert(identity.clone(), out.len());
            }
            out.push(mail);
        }
        out.sort_by(chronological);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn link(id: &str, message: &str, refs: &[&str]) -> Link {
        Link {
            id: id.into(),
            account_id: "work".into(),
            message_id: message.into(),
            server_message_id: String::new(),
            in_reply_to: vec![],
            references: refs.iter().map(|s| s.to_string()).collect(),
            trashed: false,
        }
    }
    #[test]
    fn deleting_an_already_purged_mail_is_a_success_but_other_actions_still_report_the_loss() {
        use crate::tests::{account, query, raw};
        let temp = tempfile::tempdir().unwrap();
        let s = Store::new(temp.path().into()).unwrap();
        let a = account();
        s.save_account(&a).unwrap();
        s.ingest(&a, "INBOX", "7:12", &raw(), false).unwrap();
        let id = s.snapshot(&query()).unwrap().messages[0].id.clone();
        s.change_mail(&id, "delete", "true").unwrap();
        // 后台线程在服务器确认后清除了本地记录，用户又点了一次彻底删除
        s.purge_mail(&id).unwrap();
        s.change_mail(&id, "delete", "true").unwrap();
        let lost = s.change_mail(&id, "read", "true").unwrap_err();
        assert!(lost.contains("邮件不存在"), "{lost}");
        assert!(!lost.to_lowercase().contains("no rows"), "{lost}");
        let missing = s.mail("gone").unwrap_err();
        assert!(missing.contains("邮件不存在"), "{missing}");
        assert!(!missing.to_lowercase().contains("no rows"), "{missing}");
    }
    #[test]
    fn references_join_branches_missing_ancestors_and_duplicates_but_not_accounts() {
        let mut foreign = link("foreign", "<a@local>", &[]);
        foreign.account_id = "personal".into();
        let links = vec![
            link("b", "<b@local>", &["<missing@local>"]),
            link("c", "<c@local>", &["<a@local>", "<missing@local>"]),
            link("a", "<a@local>", &[]),
            link("copy", "<b@local>", &[]),
            link("unrelated", "<other@local>", &[]),
            foreign,
        ];
        let graph = index(&links);
        assert_eq!(graph.roots["b"], graph.roots["c"]);
        assert_eq!(graph.roots["a"], graph.roots["copy"]);
        assert_eq!(graph.counts[&(graph.roots["a"].clone(), false)], 3);
        assert_ne!(graph.roots["a"], graph.roots["foreign"]);
        assert_ne!(graph.roots["a"], graph.roots["unrelated"]);
    }
}
