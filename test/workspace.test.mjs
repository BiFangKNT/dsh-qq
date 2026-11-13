import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensurePeerWorkspace, resolvePeerWorkspace } from '../src/workspace.js'
import { legacyWorkspaceVersion } from '../src/legacy-workspace.js'
import { SessionManager } from '../src/session.js'
import { createMockDsh } from './mock-dsh.mjs'

// 保存发布版本的实际输出，不能用当前实现反向生成预期值。
const templates = JSON.parse(await readFile(new URL('./fixtures/legacy-workspace.json', import.meta.url), 'utf8'))
const info = { scope: 'private', peerId: '11001', label: '改过昵称的会话' }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'qq-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { workspaceRoot: join(root, 'chats'), cwd: root }
  const dir = resolvePeerWorkspace(config, info.scope, info.peerId)
  await mkdir(dir, { recursive: true })
  const logs = [], logger = { warn: text => logs.push(text), info: text => logs.push(text) }
  const options = { logger, backupRoot: join(root, 'plugin-home', 'workspace-migrations') }
  return { root, config, dir, file: join(dir, 'AGENTS.md'), logs, options }
}

test('已发布的两代模板及共享配置均先备份后停用；重复执行不重建文件', async t => {
  for (const template of templates) {
    const h = await fixture(t)
    // CRLF 只影响识别，不改变备份的原始字节。
    const original = Buffer.from(template.text.replace(/\n/g, '\r\n'))
    await writeFile(h.file, original)
    const data = join(h.dir, '记忆区', '日记')
    await mkdir(data, { recursive: true })
    await writeFile(join(data, 'existing.md'), '用户资料')
    await ensurePeerWorkspace(h.dir, info, h.config, h.options)
    await assert.rejects(readFile(h.file), { code: 'ENOENT' })
    const files = await readdir(h.options.backupRoot)
    assert.equal(files.length, 1)
    assert.match(files[0], /^[a-f0-9]{64}\.bak$/)
    assert.deepEqual(await readFile(join(h.options.backupRoot, files[0])), original)
    assert.equal(await readFile(join(data, 'existing.md'), 'utf8'), '用户资料')
    assert.equal(h.logs.filter(text => text.includes('已停用')).length, 1)
    await ensurePeerWorkspace(h.dir, info, h.config, h.options)
    assert.deepEqual(await readdir(h.options.backupRoot), files)
    await assert.rejects(readFile(h.file), { code: 'ENOENT' })
  }
})

test('仅完整模板匹配；手改、追加、未知归属都保留并报告冲突', async t => {
  const original = templates[0].text
  assert.ok(legacyWorkspaceVersion(original.replace('测试会话', '旧群名 (22001)')))
  for (const content of ['# 用户规则\n保留我', original + '\n自定义规则',
    original.replace('不要求每天写', '每天必须写'), original.replace('## 记忆区', '## 我自己的记忆')]) {
    const h = await fixture(t)
    await writeFile(h.file, content)
    await ensurePeerWorkspace(h.dir, info, h.config, h.options)
    assert.equal(await readFile(h.file, 'utf8'), content)
    assert.ok(h.logs.some(text => text.includes('迁移未完成') && text.includes('无法确认')))
    await assert.rejects(readdir(h.options.backupRoot), { code: 'ENOENT' })
  }
})

test('备份失败保留原文件；修复后重试成功；已有相同备份可安全续作', async t => {
  const h = await fixture(t), original = templates[0].text
  await writeFile(h.file, original)
  await mkdir(join(h.root, 'plugin-home'))
  await writeFile(h.options.backupRoot, '阻止创建备份目录')
  await ensurePeerWorkspace(h.dir, info, h.config, h.options)
  assert.equal(await readFile(h.file, 'utf8'), original)
  assert.ok(h.logs.some(text => text.includes('迁移未完成')))
  await rm(h.options.backupRoot)
  await mkdir(h.options.backupRoot)
  const id = createHash('sha256').update(h.file).update(Buffer.from(original)).digest('hex')
  const backup = join(h.options.backupRoot, `${id}.bak`)
  await writeFile(backup, '错误的旧备份')
  await ensurePeerWorkspace(h.dir, info, h.config, h.options)
  assert.equal(await readFile(h.file, 'utf8'), original)
  await writeFile(backup, original)
  await ensurePeerWorkspace(h.dir, info, h.config, h.options)
  await assert.rejects(readFile(h.file), { code: 'ENOENT' })
  assert.deepEqual(await readdir(h.options.backupRoot), [`${id}.bak`])
})

test('公共 cwd、未隔离目录、仓库及其他聊天目录不接管', async t => {
  for (const kind of ['shared', 'wrong-peer', 'cwd', 'repository']) {
    const h = await fixture(t), original = templates[0].text
    await writeFile(h.file, original)
    const config = { ...h.config }
    if (kind === 'shared') config.isolateByPeer = false
    if (kind === 'wrong-peer') config.workspaceRoot = join(h.root, 'elsewhere')
    if (kind === 'cwd') config.cwd = h.dir
    if (kind === 'repository') await writeFile(join(h.dir, '.git'), 'gitdir: elsewhere')
    await ensurePeerWorkspace(h.dir, info, config, h.options)
    assert.equal(await readFile(h.file, 'utf8'), original)
    assert.ok(h.logs.some(text => text.includes('迁移未完成')))
  }
})

test('不沿目录 junction 迁移，也不删除硬链接指令文件', async t => {
  const h = await fixture(t), target = join(h.root, 'external')
  await mkdir(target)
  const original = templates[0].text
  await writeFile(join(target, 'AGENTS.md'), original)
  await rm(h.dir, { recursive: true })
  await symlink(target, h.dir, 'junction')
  await ensurePeerWorkspace(h.dir, info, h.config, h.options)
  assert.equal(await readFile(join(target, 'AGENTS.md'), 'utf8'), original)
  assert.ok(h.logs.some(text => text.includes('路径包含链接')))
  await rm(h.dir)
  await mkdir(h.dir)
  await link(join(target, 'AGENTS.md'), h.file)
  await ensurePeerWorkspace(h.dir, info, h.config, h.options)
  assert.equal(await readFile(h.file, 'utf8'), original)
  assert.ok(h.logs.some(text => text.includes('不是独立普通文件')))
})

test('备份位置链接不接管；新目录不创建日记或指令骨架', async t => {
  const h = await fixture(t), target = join(h.root, 'external')
  await mkdir(target)
  await mkdir(join(h.root, 'plugin-home'))
  await symlink(target, h.options.backupRoot, 'junction')
  await writeFile(h.file, templates[0].text)
  await ensurePeerWorkspace(h.dir, info, h.config, h.options)
  assert.equal(await readFile(h.file, 'utf8'), templates[0].text)
  assert.deepEqual(await readdir(target), [])
  const fresh = resolvePeerWorkspace(h.config, 'group', '22001')
  await ensurePeerWorkspace(fresh, { scope: 'group', peerId: '22001' }, h.config, h.options)
  assert.deepEqual(await readdir(fresh), [])
})

test('SessionManager 在挂载前迁移；迁移冲突不回退宿主目录', async t => {
  for (const conflict of [false, true]) {
    const h = await fixture(t), home = join(h.root, 'plugin-home')
    const text = templates[0].text + (conflict ? '\n手工补充' : '')
    await writeFile(h.file, text)
    const host = createMockDsh({ home: h.root })
    const manager = new SessionManager({ ctx: host.ctx, agents: host.ctx.agents,
      selfId: '10001', config: h.config, home, logger: h.options.logger })
    t.after(async () => { manager.stop(); await host.dispose() })
    const create = host.ctx.agents.create.bind(host.ctx.agents)
    host.ctx.agents.create = async options => {
      if (conflict) assert.equal(await readFile(h.file, 'utf8'), text)
      else await assert.rejects(readFile(h.file), { code: 'ENOENT' })
      return create(options)
    }
    const record = await manager.obtain(info)
    assert.equal(record.dir, h.dir)
    assert.equal(record.agent.ctx.cwd, h.dir)
    if (conflict) assert.ok(h.logs.some(text => text.includes('迁移未完成')))
    else assert.equal((await readdir(join(home, 'workspace-migrations'))).length, 1)
  }
})
