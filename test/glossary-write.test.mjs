import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { upsertGlossaryTerm, GLOSSARY_SKELETON } from '../src/settings.js'

/**
 * 2026-10-27 给老三造的那支「笔」。
 *
 * 她的问题（11:01:16）：「换另一条手也一样，连给自己这块地授权都报错」——
 * 私聊的沙箱只圈 `QQ会话/私聊_10001`，够不到 `群_123456789/记忆区/群词典.md`。
 *
 * 所以给她一个工具，由宿主进程替她写。但**笔必须窄**：
 * 参数里只有群号，没有路径。她就算想问「写群日记」也没地方填。
 * 不靠她自觉，靠函数签名就写不了别的。
 */

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-qq-pen-'))
  mkdirSync(join(root, '群_123456789', '记忆区', '日记'), { recursive: true })
  return root
}

const WITH_PENDING = `# 群词典 · 群聊黑话与角色

> 说明行

## 待确认

- [ ] 某人：不要电不要电，哪个是萝莉
  ↳ 00:08:41 鲸鲸回「啥意思」
- [ ] 甲：高压电呢？
  ↳ 23:35 鲸鲸回「没懂」

## 已确认

| 词 / 说法 | 意思 | 谁说的 | 日期 |
| --- | --- | --- | --- |
`

test('新群第一次写：铺骨架 + 表格里多一行', () => {
  const root = mkRoot()
  const { file, text } = upsertGlossaryTerm({
    workspaceRoot: root,
    group: '123456789',
    word: '萝莉',
    meaning: '群友互相打趣时说的一种人设，不是骂人',
    who: '某人',
    date: '2026-10-27',
  })
  assert.ok(file.endsWith(join('群_123456789', '记忆区', '群词典.md')))
  assert.ok(text.includes('## 已确认'))
  assert.ok(text.includes('| 萝莉 | 群友互相打趣时说的一种人设，不是骂人 |'))
  assert.ok(text.startsWith('# 群词典'), '该铺骨架')
  assert.equal(text, readFileSync(file, 'utf8'), '落盘内容要和返回的一致')
})

test('填了「已确认」之后，对应的「待确认」那条自动清掉，别人的不动', () => {
  const root = mkRoot()
  const file = join(root, '群_123456789', '记忆区', '群词典.md')
  writeFileSync(file, WITH_PENDING, 'utf8')
  const { text } = upsertGlossaryTerm({
    workspaceRoot: root,
    group: '123456789',
    word: '不要电不要电',
    meaning: '群友玩梗，跟着喊的，没有实际意思',
    who: '某人',
    date: '2026-10-27',
  })
  assert.ok(!text.includes('- [ ] 某人：不要电不要电'), '对上的那条该没了')
  assert.ok(!text.includes('00:08:41 鲸鲸回「啥意思」'), '它下面那行 ↳ 也该一起清掉')
  assert.ok(text.includes('- [ ] 甲：高压电呢？'), '别人的待确认不能跟着一起没')
  assert.ok(text.includes('| 不要电不要电 | 群友玩梗'))
  assert.equal(text.match(/## 已确认/g).length, 1, '别把段落重开一遍')
})

test('表格里的竖线要转义，否则一本词典会被写坏', () => {
  const root = mkRoot()
  const { text } = upsertGlossaryTerm({
    workspaceRoot: root,
    group: '123456789',
    word: 'a|b',
    meaning: '意思是 x|y',
    date: '2026-10-27',
  })
  assert.ok(text.includes('a\\|b'), '竖线必须转义')
  assert.ok(!/\| a\|b \|/.test(text))
})

test('群号必须是纯数字、目录必须真的存在 —— 写不到别的地方去', () => {
  const root = mkRoot()
  for (const bad of ['', '123456789/../私聊_1', '../群_1', 'abc', '群_1']) {
    assert.throws(
      () => upsertGlossaryTerm({ workspaceRoot: root, group: bad, word: 'x', meaning: 'y' }),
      /群号|目录/,
      `群号「${bad}」不该被接受`,
    )
  }
  // 这个群没建过目录：别替它造一本（用和上面 mkRoot 不同的号）
  assert.throws(
    () => upsertGlossaryTerm({ workspaceRoot: root, group: '7777777', word: 'x', meaning: 'y' }),
    /目录不存在/,
    '没这个群就别替它造一本',
  )
})

test('空词 / 空意思 / 没配 workspaceRoot 都拒绝', () => {
  const root = mkRoot()
  assert.throws(() => upsertGlossaryTerm({ workspaceRoot: root, group: '123456789', word: '', meaning: 'y' }))
  assert.throws(() => upsertGlossaryTerm({ workspaceRoot: root, group: '123456789', word: 'x', meaning: '' }))
  assert.throws(() => upsertGlossaryTerm({ workspaceRoot: '', group: '123456789', word: 'x', meaning: 'y' }))
})

test('骨架本身是合法的一本空词典', () => {
  assert.ok(GLOSSARY_SKELETON.includes('## 待确认'))
  assert.ok(GLOSSARY_SKELETON.includes('## 已确认'))
  assert.ok(GLOSSARY_SKELETON.includes('| 词 / 说法 | 意思 | 谁说的 | 日期 |'))
})

test('旧词典工具退役；统一记忆工具不接受跨聊天路径', () => {
  const src = readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8')
  assert.ok(src.includes('registerMemoryTool('))
  assert.ok(!src.includes("name: 'qq_glossary'"))
  const tool = readFileSync(new URL('../src/memory-tools.js', import.meta.url), 'utf8')
  assert.ok(!tool.includes("path: {"))
  assert.ok(!tool.includes("group: {"))
})
