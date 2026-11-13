import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { listOf } from './config.js'
import { canAccessChat } from './access.js'

/** 可选共享文件工具；注册时确定根目录，执行时检查当前聊天和写权限。 */
export function registerSharedFiles(tools, { config, manager, logger, needRecord }) {
  const root = String(config.memoryRoot ?? '').trim()
  if (!root) return false
  const rootPath = resolve(root)
  const outside = (base, path) => {
    const back = relative(base, path)
    return back === '..' || back.startsWith('..' + sep) || isAbsolute(back)
  }
  function location(path) {
    const target = resolve(rootPath, String(path ?? '').replace(/\\/g, '/'))
    if (outside(rootPath, target)) throw new Error('路径超出共享目录')
    let existing = target
    for (;;) {
      try { lstatSync(existing); break }
      catch (err) {
        if (err.code !== 'ENOENT' || existing === rootPath) throw err
        existing = dirname(existing)
      }
    }
    if (outside(realpathSync(rootPath), realpathSync(existing))) throw new Error('链接指向共享目录之外')
    return target
  }
  tools.register({
    name: 'qq_memo',
    description: '按需读写已启用的共享文件目录，与当前聊天的统一记忆分开。所有获准聊天可 list/read；只有授权账号私聊可 append/write。path 是相对路径，文件仅限 .md/.txt。write 覆盖整篇，修改前先 read；未读内容不能声称已知。',
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['read', 'append', 'write', 'list'] },
        path: { type: 'string', description: '相对共享目录的路径，list 可留空' },
        text: { type: 'string' },
      }, required: ['action'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, file: { type: 'string' }, message: { type: 'string' } }, required: ['ok'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      try {
        const record = needRecord(manager, exec)
        if (!canAccessChat(config, record)) throw new Error('当前聊天未获准访问共享文件')
        const action = String(args.action ?? '')
        if (!['list', 'read', 'append', 'write'].includes(action)) throw new Error('未知共享文件操作')
        if (['append', 'write'].includes(action) &&
          (record.scope !== 'private' || !listOf(config.ownerIds).includes(String(record.peerId)))) {
          throw new Error('只有授权账号私聊可以写入共享文件')
        }
        const path = String(args.path ?? '').trim()
        if (action !== 'list' && !path) throw new Error('请提供相对文件路径')
        if (isAbsolute(path)) throw new Error('路径超出共享目录或不是相对路径')
        if (action === 'append' || action === 'write') mkdirSync(rootPath, { recursive: true })
        const file = location(path)
        if (action === 'list') {
          const names = readdirSync(file, { withFileTypes: true })
            .filter(entry => entry.isDirectory() || /\.(md|txt)$/i.test(entry.name)).slice(0, 300)
            .map(entry => entry.name + (entry.isDirectory() ? '/' : ''))
          return { ok: true, file, message: names.join('\n') || '（空目录）' }
        }
        if (!/\.(md|txt)$/i.test(file)) throw new Error('只允许 .md / .txt 文件')
        if (action === 'read') return { ok: true, file, message: readFileSync(file, 'utf8').slice(0, 20000) }
        const body = String(args.text ?? '')
        if (!body.trim()) throw new Error('写入内容不能为空')
        mkdirSync(dirname(file), { recursive: true })
        if (action === 'write') writeFileSync(file, body, 'utf8')
        else appendFileSync(file, body.endsWith('\n') ? body : body + '\n', 'utf8')
        return { ok: true, file, message: `已${action === 'write' ? '覆盖' : '追加'} ${body.length} 字：${path}` }
      } catch (err) {
        logger.warn?.('qq_memo 操作失败:', err.message)
        return { ok: false, file: '', message: err.message }
      }
    },
  })
  return true
}
