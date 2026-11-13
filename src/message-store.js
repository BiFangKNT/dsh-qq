import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readMessage } from './onebot/segment.js'

const keyOf = meta => JSON.stringify([String(meta.selfId), meta.scope, String(meta.peerId)])
const decode = row => row ? { ...JSON.parse(row.item), seq: row.seq, status: row.status } : null

/** 原文和处理记录独立于聊天流水；磁盘实例按操作关闭连接，不在内存保存完整历史。 */
export function createMessageStore(home = '', logger) {
  if (home) mkdirSync(home, { recursive: true })
  const file = home ? join(home, 'messages.sqlite') : ':memory:'
  const memory = home ? null : new DatabaseSync(file)
  function use(fn) {
    const db = memory ?? new DatabaseSync(file)
    try { db.exec('PRAGMA busy_timeout=5000'); return fn(db) }
    finally { if (!memory) db.close() }
  }
  function transaction(fn) {
    return use(db => {
      db.exec('BEGIN IMMEDIATE')
      try { const result = fn(db); db.exec('COMMIT'); return result }
      catch (error) { db.exec('ROLLBACK'); throw error }
    })
  }
  use(db => db.exec(`
    CREATE TABLE IF NOT EXISTS chats (key TEXT PRIMARY KEY, meta TEXT NOT NULL, session TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT NOT NULL, id TEXT NOT NULL,
      item TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', delivery TEXT,
      decision TEXT, prepared INTEGER NOT NULL DEFAULT 0, received REAL NOT NULL,
      UNIQUE(chat,id));
    CREATE INDEX IF NOT EXISTS pending_messages ON messages(chat,status,seq);
    CREATE INDEX IF NOT EXISTS history_messages ON messages(chat,received DESC,seq DESC);
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, chat TEXT NOT NULL, session TEXT NOT NULL, status TEXT NOT NULL,
      selected TEXT NOT NULL, omitted TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sends (
      id TEXT PRIMARY KEY, chat TEXT NOT NULL, session TEXT, action TEXT NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS token_counts (version TEXT NOT NULL, hash TEXT NOT NULL,
      tokens INTEGER NOT NULL, PRIMARY KEY(version,hash));
    CREATE TABLE IF NOT EXISTS blocked_deliveries (chat TEXT PRIMARY KEY, signature TEXT NOT NULL, reason TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS migration_errors (name TEXT PRIMARY KEY, reason TEXT NOT NULL);
  `))
  function ensure(db, meta) {
    const key = keyOf(meta)
    db.prepare('INSERT OR IGNORE INTO chats VALUES (?,?,?)').run(key,
      JSON.stringify({ selfId: String(meta.selfId), scope: meta.scope, peerId: String(meta.peerId), label: meta.label }), `qq-address-${randomUUID()}`)
    return key
  }
  function put(db, meta, item, status = 'pending') {
    const key = ensure(db, meta)
    db.prepare(`INSERT INTO messages(chat,id,item,status,decision,prepared,received) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(chat,id) DO UPDATE SET item=excluded.item,decision=excluded.decision,
      prepared=excluded.prepared WHERE messages.status='pending'`).run(key, item.id, JSON.stringify(item), status,
      item.decision ?? null, item.body === null ? 0 : 1, item.receivedAt)
  }
  function putSend(db, row) {
    const meta = JSON.parse(row.chat), payload = JSON.parse(row.payload), result = JSON.parse(row.result ?? '{}').result
    const body = row.action.endsWith('_file') ? `[文件 ${payload.name ?? ''}]` : row.action.endsWith('_forward_msg') ? '[合并转发]' :
      readMessage(payload.message ?? payload.text, { selfId: meta[0] }).text || '[非文字消息]'
    put(db, { selfId: meta[0], scope: meta[1], peerId: meta[2] }, {
      id: `send:${row.id}`, sendId: row.id, direction: 'outgoing', body,
      messageId: result?.message_id == null ? null : String(result.message_id),
      message: { senderId: meta[0], senderName: '机器人' }, source: {}, receivedAt: row.created,
    }, row.status)
  }
  // 旧发送计划转为可查询消息；不会重新发送，也不会进入待交付队列。
  transaction(db => {
    if (!db.prepare('SELECT 1 FROM migrations WHERE name=?').get('history-sends-v1')) {
      for (const row of db.prepare('SELECT * FROM sends ORDER BY created,id').all()) putSend(db, row)
      db.prepare('INSERT INTO migrations VALUES (?,?)').run('history-sends-v1', '')
    }
    db.prepare('INSERT OR IGNORE INTO migrations VALUES (?,?)').run('history-cutoff-v1', String(Date.now()))
  })
  // 旧文件不删除；事务中的导入标记防止重启重复导入，坏文件保留并拒绝继续。
  const legacy = home ? join(home, 'address-classifier') : ''
  if (legacy) {
    let names = []
    try { names = readdirSync(legacy).filter(name => name.endsWith('.json')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const name of names) {
      try {
      const text = readFileSync(join(legacy, name), 'utf8')
      if (use(db => db.prepare('SELECT 1 FROM migrations WHERE name=?').get(name))) continue
      const saved = JSON.parse(text), meta = saved.meta
      const key = keyOf(meta ?? {})
      if (saved.version !== 1 || !meta?.selfId || !meta.peerId || !['private', 'group'].includes(meta.scope) ||
        `${createHash('sha256').update(key).digest('hex')}.json` !== name ||
        typeof saved.sessionId !== 'string' || !Array.isArray(saved.pending) || !Array.isArray(saved.seen) ||
        saved.pending.some(item => typeof item?.id !== 'string' || !item.source ||
          !Number.isFinite(item.receivedAt) || !(item.body === null || typeof item.body === 'string') ||
          ![null, 'yes', 'no'].includes(item.decision) ||
          (item.body === null ? item.source.post_type !== 'message' : typeof item.message?.text !== 'string'))) throw new Error(`旧消息记录格式错误，原文件保留：${name}`)
      transaction(db => {
        ensure(db, meta)
        db.prepare('UPDATE chats SET session=? WHERE key=?').run(saved.sessionId, key)
        for (const item of saved.pending) put(db, meta, item)
        const pending = new Set(saved.pending.map(item => item.id))
        for (const id of saved.seen) {
          if (typeof id !== 'string') throw new Error('旧消息 ID 格式错误')
          if (!pending.has(id)) put(db, meta, { id, body: null, source: {}, receivedAt: 0, legacy: true }, 'legacy-accepted')
        }
        db.prepare('INSERT INTO migrations VALUES (?,?)').run(name, createHash('sha256').update(text).digest('hex'))
      })
      logger?.info?.(`已迁移旧分类消息记录：${name}；旧文件保留`)
      use(db => db.prepare('DELETE FROM migration_errors WHERE name=?').run(name))
      } catch (error) {
        use(db => db.prepare('INSERT OR REPLACE INTO migration_errors VALUES (?,?)').run(name, error.message))
        logger?.warn?.(`旧消息记录无法迁移，仅停止对应聊天，原文件保留：${name}`, error.message)
      }
    }
  }
  const api = {
    file,
    assertReadable(meta) {
      const name = `${createHash('sha256').update(keyOf(meta)).digest('hex')}.json`
      const row = use(db => db.prepare('SELECT reason FROM migration_errors WHERE name=?').get(name))
      if (row) throw new Error(`该聊天的旧消息记录无法迁移，请修复后重启：${row.reason}`)
    },
    chat(meta) { return transaction(db => { const key = ensure(db, meta); return db.prepare('SELECT * FROM chats WHERE key=?').get(key) }) },
    get(meta, id) { return use(db => decode(db.prepare('SELECT * FROM messages WHERE chat=? AND id=?').get(keyOf(meta), id))) },
    put(meta, item) { return transaction(db => put(db, meta, item)) },
    pending(meta, end = Number.MAX_SAFE_INTEGER) {
      return use(db => db.prepare("SELECT * FROM messages WHERE chat=? AND status='pending' AND seq<=? ORDER BY seq").all(keyOf(meta), end).map(decode))
    },
    summary(meta, classify = false, mentionOnly = false) {
      return use(db => {
        const key = keyOf(meta)
        const end = db.prepare(`SELECT MAX(seq) AS seq FROM messages WHERE chat=? AND status='pending' ${classify ? "AND decision='yes'" : ''}
          ${mentionOnly ? "AND json_extract(item,'$.message.atMe')=1" : ''}`).get(key).seq
        if (end === null) return null
        const rows = db.prepare("SELECT item FROM messages WHERE chat=? AND status='pending' AND seq<=? ORDER BY seq LIMIT 1").get(key, end)
        const unprepared = db.prepare("SELECT 1 FROM messages WHERE chat=? AND status='pending' AND seq<=? AND prepared=0 LIMIT 1").get(key, end)
        const mentioned = db.prepare("SELECT 1 FROM messages WHERE chat=? AND status='pending' AND seq<=? AND json_extract(item,'$.message.atMe')=1 LIMIT 1").get(key, end)
        return { end, first: JSON.parse(rows.item), unprepared: Boolean(unprepared), mentioned: Boolean(mentioned) }
      })
    },
    pendingSequences(meta, end) { return use(db => db.prepare("SELECT seq FROM messages WHERE chat=? AND seq<=? AND status='pending' ORDER BY seq").all(keyOf(meta), end).map(row => row.seq)) },
    hasTrigger(meta, words) { return use(db => words.some(word => db.prepare("SELECT 1 FROM messages WHERE chat=? AND status='pending' AND instr(json_extract(item,'$.message.triggerText'),?)>0 LIMIT 1").get(keyOf(meta), word))) },
    page(meta, { end = Number.MAX_SAFE_INTEGER, before = Number.MAX_SAFE_INTEGER, limit = 100, status = 'pending' } = {}) {
      return use(db => db.prepare('SELECT * FROM messages WHERE chat=? AND status=? AND seq<=? AND seq<? ORDER BY seq DESC LIMIT ?')
        .all(keyOf(meta), status, end, before, limit).map(decode))
    },
    chats() { return use(db => db.prepare("SELECT DISTINCT chats.meta FROM chats JOIN messages ON messages.chat=chats.key WHERE messages.status IN ('pending','reserved','admitted')").all().map(row => JSON.parse(row.meta))) },
    unprepared(meta) {
      return use(db => db.prepare(`SELECT messages.*,chats.meta FROM messages JOIN chats ON chats.key=messages.chat
        WHERE status='pending' AND prepared=0 ${meta ? 'AND chat=?' : ''} ORDER BY seq`).all(...(meta ? [keyOf(meta)] : []))
        .map(row => ({ ...decode(row), meta: JSON.parse(row.meta) })))
    },
    discard(meta, id) { use(db => db.prepare("UPDATE messages SET status='control' WHERE chat=? AND id=? AND prepared=0 AND status='pending'").run(keyOf(meta), id)) },
    protectedPaths() {
      return use(db => new Set(db.prepare("SELECT item FROM messages WHERE status IN ('pending','reserved','admitted','failed','omitted')").all()
        .flatMap(row => JSON.parse(row.item).attachmentPaths ?? [])))
    },
    begin(meta, session, selected, omitted = []) {
      return transaction(db => {
        const id = randomUUID(), key = ensure(db, meta)
        const seqs = selected.map(item => item.seq)
        db.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,?,?)').run(id, key, session, 'prepared', JSON.stringify(seqs), JSON.stringify(omitted), '{}')
        for (const seq of seqs) {
          const result = db.prepare("UPDATE messages SET status='reserved',delivery=? WHERE chat=? AND seq=? AND status='pending'").run(id, key, seq)
          if (result.changes !== 1) throw new Error('消息范围已改变，拒绝重复投递')
        }
        return id
      })
    },
    finish(id, status, detail = {}) {
      transaction(db => {
        const row = db.prepare('SELECT * FROM deliveries WHERE id=?').get(id)
        if (!row) throw new Error('消息投递记录不存在')
        db.prepare('UPDATE deliveries SET status=?,detail=json_patch(detail,?) WHERE id=?').run(status, JSON.stringify(detail), id)
        const messageStatus = status === 'processed' ? 'processed' : status === 'pending' ? 'pending' : status === 'failed' ? 'failed' : 'admitted'
        db.prepare("UPDATE messages SET status=? WHERE delivery=? AND status!='omitted'").run(messageStatus, id)
        if (['processed', 'admitted', 'failed'].includes(status)) {
          for (const seq of JSON.parse(row.omitted)) db.prepare("UPDATE messages SET status='omitted',delivery=? WHERE seq=? AND chat=? AND status='pending'").run(id, seq, row.chat)
        }
      })
    },
    delivery(id) { return use(db => db.prepare('SELECT * FROM deliveries WHERE id=?').get(id)) },
    recover(record) {
      const rows = use(db => db.prepare("SELECT * FROM deliveries WHERE chat=? AND status IN ('prepared','admitted')").all(keyOf(record)))
      if (!rows.length) return
      const events = record.agent.session.snapshotEvents()
      for (const row of rows) {
        if (row.session !== record.sessionId) {
          // 查不到旧 session 的证据时保守保留，不向新 session 重放不确定范围。
          api.finish(row.id, 'failed', { reason: 'session_changed', session: row.session })
          continue
        }
        // Inbox 的持久接纳也算已进入宿主；不能在重启窗口重复 append。
        const admission = events.find(event => event.type === 'user/message' &&
          (event.data.message?.source ?? event.data.source)?.qqDeliveryId === row.id)
        const inbox = events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted?.some(message => message.source?.qqDeliveryId === row.id))
        const turn = admission && events.findLast(event => event.seq < admission.seq && event.type === 'turn/start')
        const end = admission && events.find(event => event.seq > admission.seq && event.type === 'turn/end' &&
          (turn?.data.turn === undefined || event.data.turn === turn.data.turn))
        if (end) api.finish(row.id, end.data.reason?.kind === 'completed' ? 'processed' : 'failed', { reason: end.data.reason })
        else if (admission || inbox || row.status === 'admitted') api.finish(row.id, 'failed', { reason: 'interrupted_after_admission', session: row.session })
        else api.finish(row.id, 'pending', { reason: 'not_admitted' })
      }
    },
    block(meta, signature, reason) { use(db => db.prepare('INSERT OR REPLACE INTO blocked_deliveries VALUES (?,?,?)').run(keyOf(meta), signature, reason)) },
    blocked(meta) { return use(db => db.prepare('SELECT signature,reason FROM blocked_deliveries WHERE chat=?').get(keyOf(meta))) },
    query(meta, { before, limit = 20, seq, since = 0 } = {}) {
      return use(db => {
        const key = keyOf(meta), args = [key, since]
        let where = ''
        if (seq !== undefined) { where = 'AND seq=?'; args.push(seq) }
        else if (before !== undefined) {
          const cursor = db.prepare('SELECT received,seq FROM messages WHERE chat=? AND seq=?').get(key, before)
          if (!cursor) throw new Error('分页位置不属于所查询的聊天')
          where = 'AND (received<? OR (received=? AND seq<?))'; args.push(cursor.received, cursor.received, cursor.seq)
        }
        return db.prepare(`SELECT * FROM messages WHERE chat=? AND received>=? ${where} ORDER BY received DESC,seq DESC LIMIT ?`)
          .all(...args, Math.min(50, Math.max(1, limit))).map(decode)
      })
    },
    historyCutoff() { return use(db => Number(db.prepare('SELECT hash FROM migrations WHERE name=?').get('history-cutoff-v1').hash)) },
    historyImported(meta, path) {
      return use(db => {
        const saved = db.prepare('SELECT hash FROM migrations WHERE name=?').get(`history-md:${path}`)
        if (saved && saved.hash !== keyOf(meta)) throw new Error('旧流水已归属其他机器人账号，不能重复导入')
        return Boolean(saved)
      })
    },
    importHistory(meta, path, entries) {
      transaction(db => {
        const saved = db.prepare('SELECT hash FROM migrations WHERE name=?').get(`history-md:${path}`)
        if (saved && saved.hash !== keyOf(meta)) throw new Error('旧流水已归属其他机器人账号，不能重复导入')
        if (saved) return
        const cutoff = Number(db.prepare('SELECT hash FROM migrations WHERE name=?').get('history-cutoff-v1').hash)
        const firstSend = db.prepare('SELECT MIN(created) AS time FROM sends WHERE chat=?').get(keyOf(meta)).time
        const exists = db.prepare('SELECT status,item FROM messages WHERE chat=? AND id=?')
        for (const entry of entries) {
          if (entry.receivedAt >= cutoff) continue
          // 新库已记录的源消息、发送记录以新库为准，不再导入 Markdown 副本。
          if (entry.direction === 'outgoing' && firstSend !== null && entry.receivedAt >= Math.floor(firstSend / 1000) * 1000) continue
          const previous = exists.get(keyOf(meta), entry.id)
          if (previous) {
            if (previous.status === 'legacy-accepted' && JSON.parse(previous.item).body === null) {
              db.prepare("UPDATE messages SET item=?,received=?,prepared=1 WHERE chat=? AND id=?")
                .run(JSON.stringify(entry), entry.receivedAt, keyOf(meta), entry.id)
            }
            continue
          }
          put(db, meta, entry, 'archived')
        }
        db.prepare('INSERT INTO migrations VALUES (?,?)').run(`history-md:${path}`, keyOf(meta))
      })
    },
    stats(meta) { return use(db => db.prepare("SELECT status,COUNT(*) AS count FROM messages WHERE chat=? AND status!='archived' AND COALESCE(json_extract(item,'$.direction'),'incoming')!='outgoing' GROUP BY status").all(keyOf(meta))) },
    tokenGet(version, hash) { return use(db => db.prepare('SELECT tokens FROM token_counts WHERE version=? AND hash=?').get(version, hash)?.tokens) },
    tokenSave(version, values) { transaction(db => { const statement = db.prepare('INSERT OR REPLACE INTO token_counts VALUES (?,?,?)'); for (const [hash, count] of values) statement.run(version, hash, count) }) },
    sentStart(record, action, payload, status = 'sending') {
      const id = randomUUID()
      transaction(db => {
        db.prepare('INSERT INTO sends VALUES (?,?,?,?,?,?,?,?)').run(id, ensure(db, record), record.sessionId ?? '', action, JSON.stringify(payload), status, JSON.stringify({ deliveryId: record.activeDeliveryId }), Date.now())
        putSend(db, db.prepare('SELECT * FROM sends WHERE id=?').get(id))
      })
      return id
    },
    sentEnd(id, status, result) {
      transaction(db => {
        const row = db.prepare('SELECT chat FROM sends WHERE id=?').get(id)
        if (!row) throw new Error('发送记录不存在')
        db.prepare("UPDATE sends SET status=?,result=json_patch(COALESCE(result,'{}'),?) WHERE id=?")
          .run(status, JSON.stringify({ result: result ?? null }), id)
        db.prepare("UPDATE messages SET status=?,item=json_set(item,'$.messageId',COALESCE(?,json_extract(item,'$.messageId'))) WHERE chat=? AND id=?")
          .run(status, result?.message_id == null ? null : String(result.message_id), row.chat, `send:${id}`)
        if (status === 'sending') {
          const time = Date.now()
          db.prepare("UPDATE messages SET received=?,item=json_set(item,'$.receivedAt',?) WHERE chat=? AND id=?").run(time, time, row.chat, `send:${id}`)
        }
      })
    },
    sends(meta) { return use(db => db.prepare('SELECT * FROM sends WHERE chat=? ORDER BY created DESC LIMIT 50').all(keyOf(meta))) },
    close() { memory?.close() },
  }
  return api
}
