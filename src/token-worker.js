import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { Tokenizer } from '@huggingface/tokenizers'

const tokenizers = new Map()
parentPort.on('message', ({ id, family, text }) => {
  try {
    if (!['v4', 'v41'].includes(family)) throw new Error('不支持的 DeepSeek tokenizer 系列')
    if (!tokenizers.has(family)) {
      const data = JSON.parse(readFileSync(new URL(`../assets/tokenizers/${family}.json`, import.meta.url), 'utf8'))
      // JS 库的 split_special_tokens 不影响 added-token 匹配，显式去掉特殊拼写的快捷匹配。
      // 只计算正文；消息边界由容量模块单独预留。
      data.added_tokens = data.added_tokens.filter(token => !token.special)
      tokenizers.set(family, new Tokenizer(data, {}))
    }
    // 用户文字里的特殊 token 拼写仍按普通文本处理。
    const count = tokenizers.get(family).encode(text, { add_special_tokens: false }).ids.length
    parentPort.postMessage({ id, count })
  } catch (error) { parentPort.postMessage({ id, error: error.message }) }
})
