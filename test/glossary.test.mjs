import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clipGlossary, glossaryFileFor, loadGlossaryFor } from '../src/settings.js'
import { buildChatPrompt } from '../src/prompts.js'

/**
 * 2026-10-27 姐姐说「群词典放在老三能够着的地方」。
 *
 * 查出来的是：`learning.js` 每 20 分钟扫群记录、把卡壳点追加进
 * `QQ会话/群_<gid>/记忆区/群词典.md`，**写完没有任何地方读它**——
 * `grep 群词典 src/` 只命中写的那一头。写了没人看，等于白写。
 *
 * 所以：群聊时把本群那本词念叨一小段（截断），再给路径让它自己 read。
 */

const SAMPLE = `# 群词典 · 群聊黑话与角色

> 群鲸鲸自己卡壳的地方。**待确认** = 它没接住的；弄明白意思后自己挪到**已确认**。
> 这本是它自己的笔记，别借别人的词硬编。

## 待确认

- [ ] 某人：不要电不要电，哪个是萝莉
  ↳ 00:08:41 鲸鲸回「啥意思」

## 已确认

| 词 / 说法 | 意思 | 谁说的 | 日期 |
| --- | --- | --- | --- |
`

function mkRecord() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-gloss-'))
  mkdirSync(join(dir, '记忆区'), { recursive: true })
  return { dir, label: '群 123456789' }
}

test('clipGlossary：头部那几行 `>` 说明不念给它听', () => {
  const out = clipGlossary(SAMPLE)
  assert.ok(!out.includes('群鲸鲸自己卡壳的地方'), '说明行应该被去掉')
  assert.ok(out.includes('## 待确认'))
  assert.ok(out.includes('## 已确认'))
})

test('clipGlossary：超长断在整行，并留一句「要看全文就 read」', () => {
  const long = `## 已确认\n\n${'- 某某：这是一句很长的解释，用来把内容撑爆。'.repeat(60)}`
  const out = clipGlossary(long, 200)
  assert.ok(out.length < 260, `应该截断，实际 ${out.length}`)
  assert.ok(out.includes('要看全文就 read'))
  assert.ok(!out.endsWith('。\n（'), '不该断在半个字中间')
})

test('clipGlossary：空内容 / 只有说明 → 空串', () => {
  assert.equal(clipGlossary(''), '')
  assert.equal(clipGlossary('> 只有说明\n> 还是说明'), '')
})

test('glossaryFileFor：落在会话目录的 记忆区/群词典.md', () => {
  const rec = { dir: 'D:/x/QQ会话/群_123456789' }
  assert.equal(glossaryFileFor(rec), join('D:/x/QQ会话/群_123456789', '记忆区', '群词典.md'))
  assert.equal(glossaryFileFor({}), '')
})

test('loadGlossaryFor：文件在就读得到，文件不在返回空串', () => {
  const rec = mkRecord()
  assert.equal(loadGlossaryFor(rec), '', '还没写过的群不该念空话')
  writeFileSync(glossaryFileFor(rec), SAMPLE, 'utf8')
  const out = loadGlossaryFor(rec)
  assert.ok(out.includes('## 待确认'))
  assert.equal(loadGlossaryFor({}), '')
})

test('buildChatPrompt：旧群词典不再注入固定规则', () => {
  const inGroup = buildChatPrompt({}, { isGroup: true, glossary: '## 待确认\n- [ ] 某某：啥意思', glossaryFile: 'x/群词典.md' })
  assert.ok(!inGroup.includes('【群词典'), '可变资料不进入固定 system')
  assert.ok(!inGroup.includes('某某：啥意思'))

  const inPrivate = buildChatPrompt({}, { isGroup: false, glossary: '## 待确认\n- [ ] 某某：啥意思' })
  assert.ok(!inPrivate.includes('【群词典'), '私聊不该把某个群的词带进来')

  const empty = buildChatPrompt({}, { isGroup: true, glossary: '' })
  assert.ok(!empty.includes('【群词典'), '没内容就别占 token')
})
