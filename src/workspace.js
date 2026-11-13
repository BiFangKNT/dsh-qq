import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, lstat, unlink, realpath } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { legacyWorkspaceVersion } from './legacy-workspace.js'

/** QQ 工作文件按聊天分目录；统一记忆由 memory-store 单独保存。 */
export function peerDirName(scope, peerId) {
  const kind = scope === 'group' ? '群' : '私聊'
  const safe = String(peerId ?? 'unknown').replace(/[\\/:*?"<>|]/g, '_')
  return `${kind}_${safe}`
}

/** null 表示不隔离，沿用宿主 cwd。 */
export function resolvePeerWorkspace(config, scope, peerId) {
  if (!config || config.isolateByPeer === false) return null
  const root = String(config.workspaceRoot ?? '').trim() ||
    join(String(config.cwd ?? '').trim() || process.cwd(), '会话')
  return join(root, peerDirName(scope, peerId))
}

async function statIfPresent(path) {
  try { return await lstat(path) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

// 不沿符号链接或 Windows junction 接管别处的指令文件。
async function assertUnlinkedPath(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if ((await statIfPresent(current))?.isSymbolicLink()) throw new Error(`路径包含链接：${current}`)
    if (dirname(current) === current) break
  }
}

async function retireLegacyInstructions(dir, info, config, { backupRoot, logger }) {
  const file = join(dir, 'AGENTS.md')
  if (!(await statIfPresent(file))) return
  const expected = resolvePeerWorkspace(config, info.scope, info.peerId)
  if (!expected || resolve(dir) !== resolve(expected)) throw new Error('不是当前 QQ 独立工作目录')
  await assertUnlinkedPath(dir)
  const actual = await realpath(dir)
  if (actual === await realpath(process.cwd()) ||
    actual === await realpath(String(config.cwd || process.cwd())) ||
    await statIfPresent(join(dir, '.git'))) throw new Error('不接管公共工作目录或仓库根目录')
  const stat = await lstat(file)
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('指令文件不是独立普通文件')
  const content = await readFile(file)
  const version = legacyWorkspaceVersion(content.toString('utf8'))
  if (!version) throw new Error('无法确认是未修改的插件模板，请人工检查')

  const root = backupRoot || join(dir, '.dsh-qq-migration')
  await assertUnlinkedPath(root)
  await mkdir(root, { recursive: true })
  const id = createHash('sha256').update(resolve(file)).update(content).digest('hex')
  const backup = join(root, `${id}.bak`)
  try { await writeFile(backup, content, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const saved = await lstat(backup)
    if (!saved.isFile() || saved.nlink !== 1 || !(await readFile(backup)).equals(content)) {
      throw new Error('已有备份不匹配，拒绝停用原文件')
    }
  }
  // 写备份期间若文件被改过，留下原文件；下次仍需人工检查。
  await assertUnlinkedPath(file)
  const latest = await lstat(file)
  if (latest.ino !== stat.ino || latest.dev !== stat.dev || latest.nlink !== 1 ||
    !(await readFile(file)).equals(content)) throw new Error('备份期间指令文件发生变化')
  await unlink(file)
  logger?.info?.(`[dsh-qq] 已停用旧 AGENTS.md（${version}），原文备份：${backup}。旧会话历史不作改写，system 按现有同步规则更新。`)
}

/** 只创建工作目录；不再生成指令文件、日记索引或旧记忆骨架。 */
export async function ensurePeerWorkspace(dir, info, config = {}, options = {}) {
  await mkdir(dir, { recursive: true })
  try { await retireLegacyInstructions(dir, info, config, options) }
  catch (error) {
    options.logger?.warn?.(`[dsh-qq] AGENTS.md 迁移未完成，原文件保留：${join(dir, 'AGENTS.md')}；${error.message}`)
  }
  return dir
}
