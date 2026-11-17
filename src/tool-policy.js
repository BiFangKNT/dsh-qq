import fs from 'node:fs'
import { canAccessChat } from './access.js'
import { listOf } from './config.js'
import { DEFAULT_MEME_DB } from './meme.js'

const interactions = new Set(['qq_poke', 'qq_react', 'qq_like', 'qq_face'])
const stickers = new Set(['qq_faces', 'qq_mface'])

export function memeDbPath(config) {
  return String(config.memeDb ?? '').trim() || DEFAULT_MEME_DB
}

/** 同一规则用于宿主每步选择和执行复查，不修改其他 Agent 的工具或预设。 */
export function createToolPolicy({ config, manager, logger, platform = process.platform }) {
  const sharedRoot = String(config.memoryRoot ?? '').trim()
  let lastMemeError = ''
  function memeAvailable() {
    const path = memeDbPath(config)
    if (!path) {
      lastMemeError = ''
      return false
    }
    try {
      const available = fs.statSync(path).isFile()
      lastMemeError = ''
      return available
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
        lastMemeError = ''
      } else {
        const key = `${path}\0${error.code}\0${error.message}`
        if (key !== lastMemeError) logger?.warn?.(`qq_meme 词库检查失败，暂不提供该工具：${error.message}`)
        lastMemeError = key
      }
      return false
    }
  }
  function recordFor(agent) {
    return manager.find(String(agent?.session?.id ?? agent?.session?.header?.id ?? ''))
  }
  function available(name, record) {
    if (!record || !canAccessChat(config, record) ||
      manager.selfId != null && String(record.selfId) !== String(manager.selfId)) return false
    if (interactions.has(name)) return config.qqInteractionEnabled !== false
    if (stickers.has(name)) return config.stickerEnabled !== false
    if (name === 'qq_send_voice') return config.voiceEnabled === true && platform === 'win32'
    if (name === 'qq_qzone_send') return config.qzoneEnabled === true && record.scope === 'private' &&
      listOf(config.ownerIds).includes(String(record.peerId))
    if (name === 'qq_meme') return memeAvailable()
    if (name === 'qq_memo') return !!sharedRoot && sharedRoot === String(config.memoryRoot ?? '').trim()
    return true
  }
  function assertAvailable(name, record) {
    if (!record || !canAccessChat(config, record) ||
      manager.selfId != null && String(record.selfId) !== String(manager.selfId)) throw new Error('当前聊天未获准使用 QQ 工具')
    if (name === 'qq_qzone_send' && (record.scope !== 'private' || !listOf(config.ownerIds).includes(String(record.peerId)))) {
      throw new Error('只有授权账号私聊可以发布空间说说')
    }
    if (!available(name, record)) throw new Error(`${name} 当前不可用：请检查聊天权限、功能开关和运行条件`)
  }
  function register(tools, definition) {
    return tools.register({ ...definition, async execute(args, exec) {
      assertAvailable(definition.name, recordFor(exec?.agent))
      return definition.execute(args, exec)
    } }, { when: ({ agent }) => available(definition.name, recordFor(agent)) })
  }
  return { available, assertAvailable, register }
}
