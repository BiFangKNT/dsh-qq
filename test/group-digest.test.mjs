import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadGroupDigest, pickDigestLine } from '../src/group-digest.js'

/** 群近况的日志解析回归；访问控制由 runtime-context 的调用方负责。 */

const DAY = '2026-10-27'
const ME = '1737661812'

function mkRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-qq-digest-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function writeChat(root, gid, body, day = DAY) {
  const dir = join(root, `群_${gid}`, '聊天记录')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${day}.md`), body, 'utf8')
}

function writeDiary(root, gid, body, day = DAY) {
  const dir = join(root, `群_${gid}`, '记忆区', '日记')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${day}.md`), body, 'utf8')
}

const REAL_GROUP = `# 2026-10-27

> 一句话：刚过零点，某人在群里连说「不要电不要电」「哪个是萝莉」「随便说的一句」，那会儿群里只有他一个人在说话。
> 关键结论：没什么结论，就是三句玩笑话；前一夜 23:35 甲刚问过「高压电呢？」，两段是不是同一个话头，记录里看不出来。
> 下次要看：这个群今天白天一条记录都没有；「高压电」「萝莉」这些说法本姑娘没接，也没弄明白。

## 00:08 · 「不要电不要电」

「电」是玩笑还是别的什么，**本姑娘没弄明白**，也没敢乱解。这三句之后没有人接，本姑娘也没出声。
`

const REAL_CHAT = `# 群 123456789 · 2026-10-27

- 00:08:40 · 某人(10002)：不要电不要电
- 00:08:46 · 某人(10002)：哪个是萝莉
- 00:08:57 · 某人(10002)：随便说的一句
`

test('pickDigestLine：抓得到 `> 一句话：`，抓不到就空串', () => {
  assert.match(pickDigestLine(REAL_GROUP, '一句话'), /^刚过零点/)
  assert.equal(pickDigestLine(REAL_GROUP, '下次要看').slice(0, 5), '这个群今天')
  assert.equal(pickDigestLine('# 没有头信息\n\n正文', '一句话'), '')
  assert.equal(pickDigestLine('', '一句话'), '')
})

test('流水摘录保留来源、日期和最近的成员发言', t => {
  const root = mkRoot(t)
  writeChat(root, '123456789', REAL_CHAT)
  const out = loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME })
  const lines = out.split('\n')
  assert.equal(lines.length, 2, `实际：${out}`)
  assert.equal(lines[0], `· 群 123456789（流水摘录 ${DAY}）：00:08:57 某人 说「随便说的一句」`)
  assert.ok(lines[1].includes('00:08:46'), '前一句该带上时间')
  assert.ok(!out.includes('本姑娘'), '日记正文一个字都不许带出去')
})

test('提及记录只作为摘录，不催促回复', t => {
  const root = mkRoot(t)
  writeChat(
    root,
    '987654321',
    [
      '- 10:00:00 · 甲(111111)：在吗',
      `- 10:02:00 · 乙(222222)：@${ME} 这个你怎么看`,
      '- 10:05:00 · 甲(111111)：算了我们自己聊',
    ].join('\n'),
  )
  const out = loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME })
  assert.ok(out.includes('10:05:00 甲 说「算了我们自己聊」'), out)
  assert.ok(out.includes('提及记录 10:02:00 乙：「这个你怎么看」'), out)
  assert.doesNotMatch(out, /⚠|你没应|未回复/)
  assert.ok(!out.includes(`@${ME}`), 'QQ 号不该留在纸条里')
})

test('成员提及机器人后已有机器人回复，也不推断未回复', t => {
  const root = mkRoot(t)
  writeChat(root, '70001', `- 10:00:00 · 甲(10002)：@${ME} 帮忙看看\n- 10:01:00 · 机器人(${ME})：看过了\n`)
  const out = loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME })
  assert.match(out, /10:00:00 甲 提及机器人「帮忙看看」/)
  assert.doesNotMatch(out, /你没应|未回复|未读|⚠|最后/)
})

test('最近成员发言包含提及，只摘录一次', t => {
  const root = mkRoot(t)
  writeChat(root, '123456789', `- 10:10:00 · 丙(333333)：@${ME} 帮忙看看这个\n`)
  const out = loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME })
  assert.equal(out.split('\n').length, 1, out)
  assert.ok(out.includes('丙 提及机器人「帮忙看看这个」'), out)
  assert.doesNotMatch(out, /你没应|未回复/)
})

test('只有机器人发言时不生成成员发言摘录', t => {
  const root = mkRoot(t)
  writeChat(root, '123456789', `- 10:00:00 · 鲸鲸(深海鲸鱼娘)(${ME})：我在呢\n`)
  assert.equal(loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME }), '')
})

test('缺少或无法解析流水时，明确标记日记来源，不推断没有人说话', t => {
  const root = mkRoot(t)
  writeChat(root, '999', '旧格式、不完整或无法解析的消息\n')
  writeDiary(root, '999', '> 一句话：大家讨论过周末活动\n')
  writeDiary(root, '998', '> 一句话：活动时间待确认\n')
  const out = loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME })
  assert.equal(out, `· 群 998（日记摘要 ${DAY}）：活动时间待确认\n· 群 999（日记摘要 ${DAY}）：大家讨论过周末活动`)
  assert.doesNotMatch(out, /没人说话|没有人说话|未读|未回复/)
})

test('多群按群号排；没记录 / 目录不存在 → 空串', t => {
  const root = mkRoot(t)
  writeChat(root, '999', '- 09:00:00 · 甲(111111)：甲说了句\n')
  writeChat(root, '111', '- 09:00:00 · 乙(222222)：乙说了句\n')
  const out = loadGroupDigest({ workspaceRoot: root, today: DAY, selfId: ME })
  const heads = out.split('\n').filter((l) => l.startsWith('· 群'))
  assert.ok(heads[0].includes('111') && heads[1].includes('999'), out)

  assert.equal(loadGroupDigest({ workspaceRoot: root, today: '2026-10-01', selfId: ME }), '', '只看今天')
  assert.equal(loadGroupDigest({ workspaceRoot: '', today: DAY }), '')
  assert.equal(loadGroupDigest({ workspaceRoot: join(root, 'nope'), today: DAY }), '')
})
