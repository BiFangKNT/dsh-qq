import { canAccessChat } from './access.js'
import { listOf } from './config.js'

const interactions = new Set(['qq_poke', 'qq_react', 'qq_like', 'qq_face'])
const stickers = new Set(['qq_faces', 'qq_mface'])

/** 同一规则用于宿主每步选择和执行复查，不修改其他 Agent 的工具或预设。 */
export function createToolPolicy({ config, manager, knowledge, platform = process.platform }) {
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
    if (name === 'qq_search') return knowledge?.hasSources(record) === true
    if (name === 'qq_sources') return record.scope === 'private' && listOf(config.ownerIds).includes(String(record.peerId))
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
