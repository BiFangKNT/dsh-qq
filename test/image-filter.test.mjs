import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imagePolicy, blocksImage } from '../src/image-filter.js'
import { downloadImage } from '../src/inbound.js'
import { registerTools } from '../src/tools.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L/sAAAAASUVORK5CYII=', 'base64')
const url = 'base64://' + png.toString('base64')
const config = { groupImageBlock: ['42:7:1x1', '42:7:1920x1080', '42:8'] }
const logger = { info() {}, warn() {}, debug() {} }
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'image-filter-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('按群与成员精确选择规则，多个尺寸、全部屏蔽和方向', () => {
  const policy = imagePolicy(config, 42, 7)
  assert.equal(blocksImage(png, policy), true)
  assert.equal(blocksImage(png, imagePolicy(config, 43, 7)), false)
  assert.equal(blocksImage(png, imagePolicy(config, 42, 9)), false)
  assert.equal(blocksImage(png, imagePolicy(config, null, 7)), false)
  assert.equal(imagePolicy(config, 42, null).all, true)
  assert.equal(imagePolicy(config, 42, 8).all, true)
  const wide = Buffer.from(png)
  wide.writeUInt32BE(1920, 16); wide.writeUInt32BE(1080, 20)
  assert.equal(blocksImage(wide, policy), true)
  wide.writeUInt32BE(1080, 16); wide.writeUInt32BE(1920, 20)
  assert.equal(blocksImage(wide, policy), false)
  assert.deepEqual(imagePolicy({ groupImageBlock: '42:7:2×3,42:7:4X5' }, 42, 7).sizes,
    [{ width: 2, height: 3 }, { width: 4, height: 5 }])
  assert.equal(imagePolicy({ groupImageBlock: ['42:7:1x1', '42:7'] }, 42, 7).all, true)
})

test('下载前检查，命中或尺寸解析失败都不落缓存，非命中原样保存', async t => {
  const dir = await temporary(t)
  const policy = imagePolicy(config, 42, 7)
  assert.equal(await downloadImage(url, dir, 8, policy), null)
  assert.equal(await downloadImage('base64://bm90LWFuLWltYWdl', dir, 8, policy), null)
  assert.deepEqual(await readdir(dir), [])
  const path = await downloadImage(url, dir, 8, imagePolicy(config, 42, 9))
  assert.deepEqual(await readFile(path), png)
})

test('HTTP 图片同样在保存前过滤，整人屏蔽完全不发起下载', async t => {
  const dir = await temporary(t)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return new Response(png, { headers: { 'content-type': 'image/png' } })
  })
  assert.equal(await downloadImage('https://example.invalid/a', dir, 8, imagePolicy(config, 42, 8)), null)
  assert.equal(requests, 0)
  assert.equal(await downloadImage('https://example.invalid/a', dir, 8, imagePolicy(config, 42, 7)), null)
  assert.equal(requests, 1)
  assert.deepEqual(await readdir(dir), [])
})

test('历史取图有意不受成员全图或分辨率屏蔽限制', async t => {
  const home = await temporary(t)
  const record = { scope: 'group', peerId: '42', dir: home }
  let userId = 7
  let wrapped = false
  const tools = new Map()
  registerTools({ get: name => name === 'tools' ? { register: tool => tools.set(tool.name, tool) } : null }, {
    client: { call: async () => {
      const message = { group_id: 42, sender: { user_id: userId }, message: [{ type: 'image', data: { url } }] }
      return wrapped ? { data: message } : message
    } },
    manager: { find: () => record }, config, logger, home,
  })
  const execute = () => tools.get('qq_images').execute({ message_id: 123 }, { agent: { session: { id: 's' } } })
  for (const sender of [7, 8, 9]) {
    userId = sender
    for (const nested of [false, true]) {
      wrapped = nested
      const result = await execute()
      assert.equal(result.ok, true)
      assert.equal(result.paths.length, 1)
      assert.deepEqual(await readFile(result.paths[0]), png)
      assert.doesNotMatch(JSON.stringify(result), /1x1|1920|1080|width|height/)
    }
  }
})
