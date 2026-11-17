import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutbound } from '../src/outbound.js'

// 原有按英文、行首词、相似句和称呼删正文的测试已退出；这里只按消息结构和明确标记处理。
for (const text of [
  'Hello world!\nMaybe tomorrow.\nLet me know.',
  'https://example.invalid/docs\nGET /api/status\nGood.测试正常',
  '```js\nconst value = 1\nconsole.log(value)\n```',
  '# 标题\n\n- 第一项\n- 第一项\n\n重复段落。\n\n重复段落。',
  '结束本轮测试后，继续检查结果。\n先这样处理，再进行下一步。',
  '我需要先读取文件，然后运行测试。\n下一步检查配置。',
  '[现在是 2026-11-17]\n[群友 小林] 今天忙吗？\n[组长] 这是引用示例。',
  '破折号 fine.\n字数 ok.\n(*^▽^*)',
]) {
  test(`正文不因措辞或格式改写：${text.slice(0, 25)}`, async () => {
    const sent = [], record = { scope: 'group', sessionId: 's1' }
    const outbound = createOutbound({ manager: { find: () => record }, config: {}, logger: {},
      send: async (_record, value) => { sent.push(value); return { ok: true } } })
    await outbound({ id: 's1' }, { type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: '这段推理不得发送。' }, { type: 'text', text },
    ] } } })
    assert.deepEqual(sent, [text])
  })
}
