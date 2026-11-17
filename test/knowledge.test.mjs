import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm, readFile, symlink, link, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { createKnowledge } from '../src/knowledge.js'
import { registerTools } from '../src/tools.js'
import { installSettingsApi } from '../src/settings.js'
import { buildChatPrompt } from '../src/prompts.js'
import { GIJINKA } from '../src/gijinka.js'

const logger = { info() {}, warn() {}, debug() {} }
const owner = { selfId: '90001', scope: 'private', peerId: '10001', sessionId: 'owner' }
const group = { selfId: '90001', scope: 'group', peerId: '70001', sessionId: 'group' }
const other = { selfId: '90001', scope: 'group', peerId: '70002', sessionId: 'other' }
const bot = { ...group, selfId: '90002' }
const locator = hit => ({ sourceId: hit.sourceId, documentId: hit.documentId, version: hit.version })
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'qq-knowledge-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = { replyToPrivate: true, privateMode: 'open', groupMode: 'open', ownerIds: ['10001'] }
  const manager = { selfId: '90001', find: id => [owner, group, other].find(record => record.sessionId === id) }
  const knowledge = createKnowledge({ home, logger }), tools = new Map(), conditions = new Map()
  registerTools({ get: name => name === 'tools' ? { register: (tool, options) => { tools.set(tool.name, tool); conditions.set(tool.name, options.when) } } : null },
    { knowledge, home, manager, config, logger, client: {} })
  const invoke = (name, args, record = owner) => tools.get(name).execute(args, { agent: { session: { id: record.sessionId } } })
  const visible = (name, record = owner) => conditions.get(name)({ agent: { session: { id: record.sessionId } } })
  const source = (path, extra = {}) => ({ selfId: '90001', scope: 'chat', chat: group, kind: 'file', path, ...extra })
  const file = join(home, 'reference.md')
  await writeFile(file, '# 泡泡机\n别名：团子\n关键词：仪器\n泡泡机是一种虚构仪器，编号 ABC-42。\n')
  return { home, file, knowledge, config, manager, tools, invoke, visible, source }
}

test('私有资料按机器人和聊天隔离，公共资料只向明确启用的聊天开放', async t => {
  const h = await fixture(t)
  await h.knowledge.save(h.source(h.file))
  for (const record of [owner, other, bot]) assert.equal((await h.knowledge.search(record, '泡泡机')).results.length, 0)
  assert.equal((await h.knowledge.search(group, '泡泡机')).results.length, 1)
  await h.knowledge.save(h.source(h.file, { scope: 'public', chats: [other] }))
  assert.equal((await h.knowledge.search(other, '团子')).results.length, 1)
  assert.equal((await h.knowledge.search(bot, '团子')).results.length, 0)
  assert.equal((await h.knowledge.search(owner, '团子')).results.length, 0)
})

test('中英文、标题、别名检索有片段和行号，结果大小受限，不匹配时不伪造命中', async t => {
  const h = await fixture(t)
  await h.knowledge.save(h.source(h.file))
  for (const query of ['团子', '仪器', 'abc-42', '泡泡机']) {
    const result = await h.knowledge.search(group, query)
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].name, 'reference.md')
    assert.equal(result.results[0].start, 1)
    assert.ok(result.results[0].end >= 4)
    assert.ok(JSON.stringify(result).length <= 16000)
    assert.equal(result.results[0].partial, false)
    assert.ok(!JSON.stringify(result).includes(h.home))
  }
  assert.equal((await h.knowledge.search(group, '完全不存在的术语')).results.length, 0)
  await assert.rejects(h.knowledge.search(group, ''), /1–200/)
  await assert.rejects(h.knowledge.search(group, 'a', 50), /最多/)
})

test('中英文连写保留完整英文词，正文、别名和查询使用同一分词方式', async t => {
  const h = await fixture(t)
  await writeFile(h.file, '# 连接说明\n别名：通过Read_Image读取图片\n插件通过WebSocket连接协议端，使用ABC-42设备，在café见面。')
  await h.knowledge.save(h.source(h.file))
  for (const query of ['WebSocket', 'websocket', 'read_image', 'ABC-42', 'café', '协议端', '通过WebSocket连接']) {
    assert.equal((await h.knowledge.search(group, query)).results.length, 1, query)
  }
})

test('文件修改、删除和目录新增均在下一次查询生效，失败不使用缓存片段', async t => {
  const h = await fixture(t)
  await h.knowledge.save(h.source(h.file))
  assert.equal((await h.knowledge.search(group, '泡泡机')).results.length, 1)
  await writeFile(h.file, '# 月球车\n月球车是另一种仪器。')
  assert.equal((await h.knowledge.search(group, '泡泡机')).results.length, 0)
  assert.equal((await h.knowledge.search(group, '月球车')).results.length, 1)
  await rm(h.file)
  const failed = await h.knowledge.search(group, '月球车')
  assert.equal(failed.results.length, 0)
  assert.equal(failed.warnings.length, 1)
  const dir = join(h.home, 'selected')
  await mkdir(dir)
  await h.knowledge.save(h.source(dir, { kind: 'directory' }))
  await writeFile(join(dir, 'new.txt'), '飞艇是虚构的交通工具')
  assert.equal((await h.knowledge.search(group, '飞艇')).results.length, 1)
  await rm(join(dir, 'new.txt'))
  assert.equal((await h.knowledge.search(group, '飞艇')).results.length, 0)
})

test('新建实例保留来源，更新范围即时撤销，移除保留原文件', async t => {
  const h = await fixture(t)
  const saved = await h.knowledge.save(h.source(h.file))
  const restarted = createKnowledge({ home: h.home, logger })
  assert.equal((await restarted.search(group, '团子')).results.length, 1)
  await restarted.save({ ...saved, chat: other })
  assert.equal((await h.knowledge.search(group, '团子')).results.length, 0)
  assert.equal((await h.knowledge.search(other, '团子')).results.length, 1)
  restarted.remove(saved.id, '90001')
  assert.equal(h.knowledge.hasSources(other), false)
  assert.match(await readFile(h.file, 'utf8'), /泡泡机/)
})

test('查询期间撤销来源不能返回旧片段', async t => {
  const h = await fixture(t)
  const saved = await h.knowledge.save(h.source(h.file))
  const pending = h.knowledge.search(group, '泡泡机')
  h.knowledge.remove(saved.id, '90001')
  assert.equal((await pending).results.length, 0)
})

test('目录容量、文件替换失败和跨机器人编辑不能改变已有来源', async t => {
  const h = await fixture(t)
  const saved = await h.knowledge.save(h.source(h.file))
  await assert.rejects(h.knowledge.save({ ...saved, selfId: '90002' }), /不属于/)
  await assert.rejects(h.knowledge.save({ ...saved, path: join(h.home, 'missing.md') }))
  assert.equal((await h.knowledge.search(group, '团子')).results.length, 1)
  const dir = join(h.home, 'too-many')
  await mkdir(dir)
  await Promise.all(Array.from({ length: 129 }, (_, i) => writeFile(join(dir, `${i}.txt`), '测试内容')))
  await assert.rejects(h.knowledge.save(h.source(dir, { kind: 'directory' })), /128/)
  assert.equal(h.knowledge.list().length, 1)
  const sameIdPrivate = { ...group, scope: 'private' }
  assert.equal((await h.knowledge.search(sameIdPrivate, '团子')).results.length, 0)
})

test('只索引明确选入的文件，不扫描工作目录、旧共享目录或旧配置', async t => {
  const h = await fixture(t)
  Object.assign(h.config, { cwd: h.home, memoryRoot: h.home, memeDb: h.file, aiGirls: true })
  assert.equal(h.visible('qq_search', group), false)
  assert.equal(h.tools.has('qq_meme'), false)
  assert.equal(h.tools.has('qq_memo'), false)
  assert.equal((await h.knowledge.search(group, '泡泡机')).results.length, 0)
  assert.doesNotMatch(buildChatPrompt(h.config, { isGroup: true }), /AI 娘图鉴|GPT 娘|\bqq_memo\b|\bqq_meme\b/)
})

test('可选角色包只在指定范围按需返回，system不随资料变化', async t => {
  const h = await fixture(t), system = buildChatPrompt(h.config, { isGroup: true })
  await h.knowledge.save(h.source('', { kind: 'pack', pack: 'ai-girls' }))
  const result = await h.knowledge.search(group, '龙娘')
  assert.match(result.results[0].text, /GPT 娘/)
  assert.match(result.results[0].text, /genderswapai.com/)
  assert.equal((await h.knowledge.search(other, '龙娘')).results.length, 0)
  assert.equal(buildChatPrompt(h.config, { isGroup: true }), system)
})

test('长行保持原样，文本和角色包的后半段可定位并读回完整原文', async t => {
  const h = await fixture(t)
  const body = '长'.repeat(4200) + '说明结束'
  await writeFile(h.file, body)
  await h.knowledge.save(h.source(h.file))
  const original = GIJINKA[0].note
  t.after(() => {
    if (original === undefined) delete GIJINKA[0].note
    else GIJINKA[0].note = original
  })
  GIJINKA[0].note = body
  await h.knowledge.save(h.source('', { kind: 'pack', pack: 'ai-girls' }))
  const result = await h.knowledge.search(group, '说明结束')
  assert.equal(result.results.length, 2, '两个来源的长行末尾均可查询')
  for (const hit of result.results) {
    assert.match(hit.text, /说明结束/)
    assert.equal(hit.partial, true)
    const full = await h.knowledge.read(group, locator(hit))
    assert.equal(full.partial, false)
    assert.ok(full.text.includes(body), '不能向用户原始长行插入换行')
  }
  assert.equal(await readFile(h.file, 'utf8'), body)
})

test('Markdown按结构定位代码、表格与章节，保留CRLF、BOM和原始空白', async t => {
  const h = await fixture(t)
  const body = '\uFEFF# 第一章\r\n\r\n  第一段。  \r\n\r\n```js\r\nconst code_only = 1\r\n\r\n# 代码里不是标题\r\n```\r\n\r\n## 子节\r\n\r\n| 项目 | 值 |\r\n| --- | --- |\r\n| table_only | 2 |\r\n\r\n# 第二章\r\n结束。\r\n'
  await writeFile(h.file, body)
  await h.knowledge.save(h.source(h.file))
  const code = (await h.knowledge.search(group, 'code_only')).results[0]
  assert.equal(code.block.type, 'FencedCode')
  assert.equal(code.start, 5)
  const codeRead = await h.knowledge.read(group, { ...locator(code), ...code.block })
  assert.equal(codeRead.text, body.slice(body.indexOf('```js'), body.indexOf('## 子节')))
  assert.match(codeRead.text, /\r\n\r\n# 代码里不是标题/)
  const section = await h.knowledge.read(group, { ...locator(code), ...code.section })
  assert.equal(section.text, body.slice(0, body.indexOf('# 第二章')))
  const table = (await h.knowledge.search(group, 'table_only')).results[0]
  assert.equal(table.block.type, 'Table')
  const tableRead = await h.knowledge.read(group, { ...locator(table), ...table.block })
  assert.match(tableRead.text, /\| 项目 \| 值 \|\r\n\| --- \| --- \|\r\n\| table_only \| 2 \|/)
  const whole = await h.knowledge.read(group, locator(code))
  assert.equal(whole.text, body)
  assert.equal(whole.nextOffset, null)
})

test('超长单行JSON预览不限行长，按总量续读可无损拼回全文或指定范围', async t => {
  const h = await fixture(t), file = join(h.home, 'data.txt')
  const body = '{"needle":"' + 'x'.repeat(30000) + '😀'.repeat(5) + '\u0001'.repeat(6000) + '","url":"https://example.invalid/' + 'p'.repeat(12000) + '"}'
  await writeFile(file, body)
  await h.knowledge.save(h.source(file))
  const hit = (await h.knowledge.search(group, 'needle')).results[0]
  assert.ok(hit.text.length > 1000, '单行不再受1000字符限制')
  assert.equal(hit.text.includes('\n'), false)
  assert.equal(hit.partial, true)
  const readAll = async (offset, endOffset) => {
    let combined = '', calls = 0
    while (true) {
      const result = JSON.parse((await h.invoke('qq_search', { action: 'read', ...locator(hit), offset, endOffset }, group)).text)
      assert.ok(JSON.stringify(result).length <= 16000)
      assert.equal(result.text, body.slice(result.offset, result.endOffset))
      assert.ok(!/[\uD800-\uDBFF]$/.test(result.text), '不能切断Unicode代理对')
      combined += result.text
      calls++
      if (result.nextOffset === null) { assert.equal(result.partial, false); break }
      assert.equal(result.partial, true)
      assert.ok(result.nextOffset > offset)
      offset = result.nextOffset
      endOffset = result.rangeEnd
    }
    assert.ok(calls > 1)
    return combined
  }
  assert.equal(await readAll(0, body.length), body)
  assert.equal(await readAll(100, body.length - 10), body.slice(100, -10))
  const continuation = await h.knowledge.read(group, { ...locator(hit), offset: hit.nextOffset, endOffset: hit.rangeEnd })
  assert.equal(hit.text + continuation.text, body.slice(hit.offset, continuation.endOffset))
})

test('读取绑定文档版本和聊天范围，原文更新、来源撤销或异步撤权后拒绝旧定位', async t => {
  const h = await fixture(t)
  const source = await h.knowledge.save(h.source(h.file))
  const hit = (await h.knowledge.search(group, '泡泡机')).results[0]
  for (const record of [owner, other, bot]) await assert.rejects(h.knowledge.read(record, locator(hit)), /无权/)
  for (const range of [{ offset: -1 }, { offset: 10, endOffset: 1 }, { endOffset: hit.length + 1 }]) {
    await assert.rejects(h.knowledge.read(group, { ...locator(hit), ...range }), /范围无效/)
  }
  await writeFile(h.file, '# 泡泡机\n更新了的原文。')
  await assert.rejects(h.invoke('qq_search', { action: 'read', ...locator(hit) }, group), { message: 'STALE_REFERENCE' })
  const fresh = (await h.knowledge.search(group, '泡泡机')).results[0]
  const reading = h.knowledge.read(group, locator(fresh))
  h.knowledge.remove(source.id, '90001')
  await assert.rejects(reading, /授权已变更/)
  await h.knowledge.save(h.source(h.file))
  const finalHit = (await h.knowledge.search(group, '泡泡机')).results[0]
  const pending = h.invoke('qq_search', { action: 'read', ...locator(finalHit) }, group)
  h.config.groupMode = 'disabled'
  await assert.rejects(pending, /未获准/)
})

test('来源校验拒绝网址、错误格式、过大文件和不存在的更新ID', async t => {
  const h = await fixture(t)
  for (const input of [h.source('https://example.invalid'), h.source(h.file, { scope: 'public' }),
    h.source(h.file, { selfId: '' }), h.source(h.file, { kind: 'pack', pack: 'unknown' })]) await assert.rejects(h.knowledge.save(input))
  const binary = join(h.home, 'binary.txt')
  await writeFile(binary, Buffer.from([0xff, 0xfe]))
  await assert.rejects(h.knowledge.save(h.source(binary)), /encoded data/)
  await writeFile(binary, 'x'.repeat(512 * 1024 + 1))
  await assert.rejects(h.knowledge.save(h.source(binary)), /512 KiB/)
  await assert.rejects(h.knowledge.save(h.source(h.file, { id: 'unknown' })), /不存在/)
  assert.equal(h.knowledge.list().length, 0)
})

test('目录链接、硬链接和链接祖先不能让选中目录读到外部内容', async t => {
  const h = await fixture(t), dir = join(h.home, 'directory')
  await mkdir(dir)
  await link(h.file, join(dir, 'linked.md'))
  await assert.rejects(h.knowledge.save(h.source(dir, { kind: 'directory' })), /独立普通文件/)
  await rm(join(dir, 'linked.md'))
  const junction = join(dir, 'external')
  await symlink(h.home, junction, 'junction')
  await assert.rejects(h.knowledge.save(h.source(dir, { kind: 'directory' })), /链接/)
  await assert.rejects(h.knowledge.save(h.source(join(junction, 'reference.md'))), /链接/)
})

test('旧memes数据库显式导入统一检索，原库不修改，无需继续配置旧工具', async t => {
  const h = await fixture(t), file = join(h.home, 'legacy.sqlite')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE memes(title TEXT,slug TEXT,tags TEXT,usage TEXT,origin TEXT,other TEXT)')
  db.prepare('INSERT INTO memes VALUES(?,?,?,?,?,?)').run('泡泡梗', 'bubble', '泡泡', '虚构梗例子', '虚构出处', '')
  db.close()
  const before = await readFile(file)
  await h.knowledge.save(h.source(file, { kind: 'legacy-meme' }))
  const result = await h.knowledge.search(group, '泡泡梗')
  assert.match(result.results[0].text, /虚构出处/)
  assert.deepEqual(await readFile(file), before)
  assert.equal(h.visible('qq_search', group), true)
})

for (const mode of ['DELETE', 'WAL']) {
  test(`旧词库 ${mode}：持续修改标签、正文、增删词条后立即更新检索和读取`, async t => {
    const h = await fixture(t), file = join(h.home, 'live.sqlite')
    const db = new DatabaseSync(file)
    try {
      assert.equal(db.prepare(`PRAGMA journal_mode=${mode}`).get().journal_mode.toUpperCase(), mode)
      db.exec('PRAGMA wal_autocheckpoint=0; CREATE TABLE memes(title TEXT,slug TEXT,tags TEXT,usage TEXT,origin TEXT,other TEXT)')
      const insert = db.prepare('INSERT INTO memes VALUES(?,?,?,?,?,?)')
      insert.run('词条一', 'entry-one', 'old_alias', 'first_body', '出处', '说明')
      if (mode === 'WAL') db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      await h.knowledge.save(h.source(file, { kind: 'legacy-meme' }))
      const query = async word => {
        const result = await h.knowledge.search(group, word)
        assert.deepEqual(result.warnings, [])
        return result.results
      }
      const original = (await query('old_alias'))[0]
      assert.ok(original)
      const stamp = await stat(file), before = await readFile(file)
      db.prepare('UPDATE memes SET tags=? WHERE slug=?').run('new_alias', 'entry-one')
      if (mode === 'WAL') {
        const after = await stat(file)
        assert.deepEqual([after.size, after.mtimeMs, after.ctimeMs], [stamp.size, stamp.mtimeMs, stamp.ctimeMs], '仅更新 WAL，不能靠主文件属性使缓存失效')
        assert.deepEqual(await readFile(file), before)
        assert.ok((await stat(file + '-wal')).size > 0)
      }
      const renamed = await query('new_alias')
      assert.equal(renamed.length, 1, '新标签必须立即可检索')
      assert.equal((await query('old_alias')).length, 0, '旧标签不能继续命中缓存')
      assert.equal(renamed[0].version, original.version, '仅标签变化不改变原文版本和读取位置')
      assert.match((await h.knowledge.read(group, locator(original))).text, /first_body/)

      db.prepare('UPDATE memes SET usage=? WHERE slug=?').run('second_body', 'entry-one')
      assert.equal((await query('first_body')).length, 0)
      const revised = (await query('second_body'))[0]
      assert.ok(revised)
      await assert.rejects(h.knowledge.read(group, locator(original)), { message: 'STALE_REFERENCE' })
      assert.match((await h.knowledge.read(group, locator(revised))).text, /second_body/)

      insert.run('词条二', 'entry-two', 'added_alias', 'added_body', '出处', '说明')
      const added = (await query('added_alias'))[0]
      assert.ok(added)
      assert.match((await h.knowledge.read(group, locator(added))).text, /added_body/)
      db.prepare('DELETE FROM memes WHERE slug=?').run('entry-two')
      assert.equal((await query('added_alias')).length, 0)
      await assert.rejects(h.knowledge.read(group, locator(added)), { message: 'STALE_REFERENCE' })
      assert.equal((await query('second_body')).length, 1, '删除其他词条后剩余内容仍可查询')

      const restarted = createKnowledge({ home: h.home, logger })
      assert.equal((await restarted.search(group, 'new_alias')).results.length, 1)
      if (mode === 'WAL') {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        assert.equal((await query('new_alias')).length, 1, 'checkpoint 不影响检索结果')
      }
    } finally { db.close() }
  })

  test(`旧词库 ${mode}：不读取未提交的修改，回滚不生效，提交后更新`, async t => {
    const h = await fixture(t), file = join(h.home, 'transaction.sqlite')
    const db = new DatabaseSync(file)
    try {
      db.exec(`PRAGMA journal_mode=${mode}; PRAGMA wal_autocheckpoint=0; CREATE TABLE memes(title TEXT,slug TEXT,tags TEXT,usage TEXT,origin TEXT,other TEXT)`)
      db.prepare('INSERT INTO memes VALUES(?,?,?,?,?,?)').run('事务测试', 'transaction', 'committed_alias', 'committed_body', '出处', '说明')
      await h.knowledge.save(h.source(file, { kind: 'legacy-meme' }))
      const hit = (await h.knowledge.search(group, 'committed_alias')).results[0]
      assert.ok(hit)
      db.exec('BEGIN IMMEDIATE')
      db.prepare('UPDATE memes SET tags=?, usage=?').run('pending_alias', 'pending_body')
      assert.equal((await h.knowledge.search(group, 'pending_alias')).results.length, 0)
      const during = await h.knowledge.search(group, 'committed_alias')
      assert.deepEqual(during.warnings, [])
      assert.equal(during.results.length, 1)
      assert.match((await h.knowledge.read(group, locator(hit))).text, /committed_body/)
      db.exec('ROLLBACK')
      assert.equal((await h.knowledge.search(group, 'pending_alias')).results.length, 0)
      db.exec('BEGIN IMMEDIATE')
      db.prepare('UPDATE memes SET tags=?, usage=?').run('pending_alias', 'pending_body')
      db.exec('COMMIT')
      assert.equal((await h.knowledge.search(group, 'pending_alias')).results.length, 1)
      assert.equal((await h.knowledge.search(group, 'committed_alias')).results.length, 0)
      await assert.rejects(h.knowledge.read(group, locator(hit)), { message: 'STALE_REFERENCE' })
    } finally { db.close() }
  })
}

test('旧词库空表可导入，后续新增和清空不沿用旧结果', async t => {
  const h = await fixture(t), file = join(h.home, 'empty.sqlite')
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE memes(title TEXT,slug TEXT,tags TEXT,usage TEXT,origin TEXT,other TEXT)')
    await h.knowledge.save(h.source(file, { kind: 'legacy-meme' }))
    const empty = await h.knowledge.search(group, 'empty_alias')
    assert.deepEqual(empty.results, [])
    assert.deepEqual(empty.warnings, [])
    db.prepare('INSERT INTO memes VALUES(?,?,?,?,?,?)').run(null, 'empty-entry', 'empty_alias', null, null, null)
    const hit = (await h.knowledge.search(group, 'empty_alias')).results[0]
    assert.ok(hit)
    assert.match((await h.knowledge.read(group, locator(hit))).text, /empty-entry/)
    db.exec('DELETE FROM memes')
    const cleared = await h.knowledge.search(group, 'empty_alias')
    assert.deepEqual(cleared.results, [])
    assert.deepEqual(cleared.warnings, [])
    await assert.rejects(h.knowledge.read(group, locator(hit)), { message: 'STALE_REFERENCE' })
  } finally { db.close() }
})

for (const [name, schema] of [['缺少表', 'CREATE TABLE unrelated(value TEXT)'], ['缺少列', 'CREATE TABLE memes(title TEXT)'], ['非数据库', null]]) {
  test(`旧词库${name}时拒绝导入或替换，保留已有来源`, async t => {
    const h = await fixture(t), file = join(h.home, 'invalid.sqlite')
    if (schema) {
      const db = new DatabaseSync(file)
      try { db.exec(schema) } finally { db.close() }
    } else await writeFile(file, 'not a SQLite database')
    const saved = await h.knowledge.save(h.source(h.file))
    const before = await readFile(file)
    await assert.rejects(h.knowledge.save(h.source(file, { kind: 'legacy-meme' })), /no such|not a database/)
    await assert.rejects(h.knowledge.save({ ...saved, path: file, kind: 'legacy-meme' }), /no such|not a database/)
    assert.deepEqual(h.knowledge.list(), [saved])
    assert.equal((await h.knowledge.search(group, '泡泡机')).results.length, 1)
    assert.deepEqual(await readFile(file), before)
  })
}

test('旧词库被独占锁定时不使用缓存，导入失败保留来源，解锁后正常恢复', async t => {
  const h = await fixture(t), file = join(h.home, 'locked.sqlite')
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE memes(title TEXT,slug TEXT,tags TEXT,usage TEXT,origin TEXT,other TEXT)')
    db.prepare('INSERT INTO memes VALUES(?,?,?,?,?,?)').run('锁定测试', 'lock-entry', 'lock_alias', 'lock_body', '出处', '说明')
    const saved = await h.knowledge.save(h.source(file, { kind: 'legacy-meme' }))
    const hit = (await h.knowledge.search(group, 'lock_alias')).results[0]
    assert.ok(hit)
    db.exec('BEGIN EXCLUSIVE')
    const locked = await h.knowledge.search(group, 'lock_alias')
    assert.equal(locked.results.length, 0, '锁定不能返回旧缓存冒充查询成功')
    assert.equal(locked.warnings.length, 1)
    assert.ok(!JSON.stringify(locked).includes(h.home), '错误结果不泄露运行端路径')
    await assert.rejects(h.knowledge.read(group, locator(hit)), /资料来源读取失败/)
    await assert.rejects(h.knowledge.save({ ...saved, label: '不应保存' }), /locked/)
    assert.deepEqual(h.knowledge.list(), [saved])
    db.exec('ROLLBACK')
    const recovered = await h.knowledge.search(group, 'lock_alias')
    assert.deepEqual(recovered.warnings, [])
    assert.equal(recovered.results.length, 1)
    assert.match((await h.knowledge.read(group, locator(hit))).text, /lock_body/)
  } finally { db.close() }
})

test('已导入旧词库结构损坏后不返回缓存，修复后无需重新登记', async t => {
  const h = await fixture(t), file = join(h.home, 'schema.sqlite')
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE memes(title TEXT,slug TEXT,tags TEXT,usage TEXT,origin TEXT,other TEXT)')
    db.prepare('INSERT INTO memes VALUES(?,?,?,?,?,?)').run('结构测试', 'schema-entry', 'schema_alias', 'schema_body', '出处', '说明')
    const saved = await h.knowledge.save(h.source(file, { kind: 'legacy-meme' }))
    const hit = (await h.knowledge.search(group, 'schema_alias')).results[0]
    db.exec('ALTER TABLE memes RENAME TO broken_memes')
    const broken = await h.knowledge.search(group, 'schema_alias')
    assert.equal(broken.results.length, 0)
    assert.equal(broken.warnings.length, 1)
    await assert.rejects(h.knowledge.read(group, locator(hit)), /资料来源读取失败/)
    assert.deepEqual(h.knowledge.list(), [saved])
    db.exec('ALTER TABLE broken_memes RENAME TO memes')
    assert.equal((await h.knowledge.search(group, 'schema_alias')).results.length, 1)
  } finally { db.close() }
})

test('旧词库超过10000条时拒绝登记，减少到边界内后可正常导入', async t => {
  const h = await fixture(t), file = join(h.home, 'row-limit.sqlite')
  const db = new DatabaseSync(file)
  try {
    db.exec(`CREATE TABLE memes(title TEXT,slug TEXT,tags TEXT,usage TEXT,origin TEXT,other TEXT);
      WITH RECURSIVE items(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM items WHERE n<10001)
      INSERT INTO memes SELECT '条目', 'entry-' || n, 'limit_alias', '正文', '出处', '说明' FROM items`)
    await assert.rejects(h.knowledge.save(h.source(file, { kind: 'legacy-meme' })), /最多导入 10000 条/)
    assert.equal(h.knowledge.list().length, 0)
    assert.equal(db.prepare('SELECT count(*) AS n FROM memes').get().n, 10001, '拒绝导入不能修改原库')
    db.exec('DELETE FROM memes WHERE rowid=10001')
    await h.knowledge.save(h.source(file, { kind: 'legacy-meme' }))
    assert.equal(h.knowledge.list().length, 1, '允许恰好10000条')
  } finally { db.close() }
})

test('旧词库标签也计入8MiB展开容量，拒绝导入不影响已有来源', async t => {
  const h = await fixture(t), file = join(h.home, 'text-limit.sqlite')
  const saved = await h.knowledge.save(h.source(h.file))
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE memes(title TEXT,slug TEXT,tags TEXT,usage TEXT,origin TEXT,other TEXT)')
    db.prepare('INSERT INTO memes VALUES(?,?,?,?,?,?)').run('容量测试', 'text-limit', 'x'.repeat(8 * 1024 * 1024), '正文', '出处', '说明')
    await assert.rejects(h.knowledge.save(h.source(file, { kind: 'legacy-meme' })), /文本超过 8 MiB/)
    assert.deepEqual(h.knowledge.list(), [saved])
    assert.equal(db.prepare('SELECT length(tags) AS n FROM memes').get().n, 8 * 1024 * 1024)
    assert.equal((await h.knowledge.search(group, '泡泡机')).results.length, 1)
  } finally { db.close() }
})

test('旧词库超长标题、标识和标签受到限制，包含转义字符的完整工具结果不超过总上限', async t => {
  const h = await fixture(t), file = join(h.home, 'long-metadata.sqlite')
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE memes(title TEXT,slug TEXT,tags TEXT,usage TEXT,origin TEXT,other TEXT)')
    for (let i = 0; i < 5; i++) {
      db.prepare('INSERT INTO memes VALUES(?,?,?,?,?,?)').run('budget-key' + '\u0001'.repeat(22500),
        `slug${i}` + '\u0002'.repeat(22500), 'tag-key ' + 'x'.repeat(20000) + ' far-tag', '正文', '来源', '')
    }
  } finally { db.close() }
  await h.knowledge.save(h.source(file, { kind: 'legacy-meme' }))
  const result = await h.knowledge.search(group, 'budget-key')
  assert.ok(result.results.length > 0)
  assert.equal(result.truncated, true)
  assert.ok(JSON.stringify(result).length <= 16000)
  for (const hit of result.results) {
    assert.ok(hit.name.length <= 512)
    assert.ok(hit.title.length <= 160)
    assert.ok(hit.documentId.length < 100)
  }
  assert.equal((await h.knowledge.search(group, 'far-tag')).results.length, 0, '超出别名索引上限的标签不参与匹配')
  const tool = await h.invoke('qq_search', { query: 'budget-key' }, group)
  assert.ok(tool.text.length <= 16000)
})

test('没有标题的长文件名也遵守来源名和标题上限', async t => {
  const h = await fixture(t), file = join(h.home, 'r'.repeat(170) + '.txt')
  await writeFile(file, 'unique_word 是测试资料。')
  await h.knowledge.save(h.source(file))
  const result = await h.knowledge.search(group, 'unique_word')
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].source.length, 80)
  assert.equal(result.results[0].title.length, 160)
})

test('读取失败提示与元数据也计入检索结果总上限', async t => {
  const h = await fixture(t)
  for (let i = 0; i < 32; i++) {
    await h.knowledge.save(h.source(h.file, { label: '\u0001'.repeat(80) }))
  }
  await rm(h.file)
  const result = await h.knowledge.search(group, '泡泡机')
  assert.equal(result.results.length, 0)
  assert.ok(result.warnings.length > 0)
  assert.ok(result.warnings.length < 32)
  assert.equal(result.truncated, true)
  assert.ok(JSON.stringify(result).length <= 16000)
})

test('QQ管理仅限授权私聊，普通Agent无工具，检索只能查当前范围', async t => {
  const h = await fixture(t)
  assert.equal(h.visible('qq_sources', owner), true)
  assert.equal(h.visible('qq_sources', group), false)
  assert.equal(h.visible('qq_sources', { sessionId: 'ordinary' }), false)
  await assert.rejects(h.invoke('qq_sources', { action: 'save', ...h.source(h.file) }, group), /不可用/)
  await h.invoke('qq_sources', { action: 'save', ...h.source(h.file) })
  assert.equal(h.visible('qq_search', owner), false)
  assert.equal(h.visible('qq_search', group), true)
  assert.match((await h.invoke('qq_search', { query: '泡泡机' }, group)).text, /虚构仪器/)
  h.config.ownerIds = []
  await assert.rejects(h.invoke('qq_sources', { action: 'list' }), /不可用/)
  h.config.groupMode = 'disabled'
  await assert.rejects(h.invoke('qq_search', { query: '泡泡机' }, group), /未获准/)
})

test('导入和查询异步期间撤销授权，不能保存或返回资料', async t => {
  const h = await fixture(t)
  const pending = h.invoke('qq_sources', { action: 'save', ...h.source(h.file) })
  h.config.ownerIds = []
  await assert.rejects(pending, /授权账号/)
  assert.equal(h.knowledge.list().length, 0)
  await h.knowledge.save(h.source(h.file))
  const search = h.invoke('qq_search', { query: '泡泡机' }, group)
  h.config.groupMode = 'disabled'
  await assert.rejects(search, /未获准/)
})

test('资料数据库损坏不会阻断其他工具的选择', async t => {
  const h = await fixture(t)
  await h.knowledge.save(h.source(h.file))
  await writeFile(join(h.home, 'knowledge', 'knowledge.sqlite'), 'broken sqlite')
  assert.equal(h.visible('qq_search', group), false)
  assert.equal(h.visible('qq_send', group), true)
})

test('设置API导入、修改范围和移除，与QQ查询使用同一来源，不自动迁移旧配置', async t => {
  const h = await fixture(t)
  let handler
  installSettingsApi({ ctx: { get: () => () => h.home, effect: setup => setup() }, config: { ...h.config, localApiPort: 0, memoryRoot: h.home },
    logger, knowledge: h.knowledge, webServer: { register: route => { handler = route.handler } } })
  const request = async (body, method = 'POST') => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    Object.assign(req, { method, url: '/api/dsh-qq/sources' })
    let status, result
    await handler(req, { writeHead: value => { status = value }, end: value => { result = JSON.parse(value) } })
    return { status, ...result }
  }
  const initial = await request(null, 'GET')
  assert.equal(initial.sources.length, 0)
  assert.equal(initial.legacy.memoryRoot, h.home)
  const saved = await request({ action: 'save', source: h.source(h.file) })
  assert.equal(saved.status, 200)
  const source = saved.sources[0]
  assert.equal((await h.knowledge.search(group, '团子')).results.length, 1)
  await request({ action: 'save', source: { ...source, scope: 'public', chats: [other] } })
  assert.equal((await h.knowledge.search(group, '团子')).results.length, 0)
  assert.equal((await h.knowledge.search(other, '团子')).results.length, 1)
  assert.equal((await request({ action: 'remove', id: source.id, selfId: '90002' })).status, 400)
  assert.equal((await request({ action: 'remove', id: source.id, selfId: '90001' })).sources.length, 0)
})
