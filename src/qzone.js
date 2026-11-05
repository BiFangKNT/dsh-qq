import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dayOf } from './chatlog.js'

const PRIVACY = { public: 1, friends: 4, private: 64 }

/** 串行预留每天两次发布额度；结果未知也保留额度，禁止隐式重发。 */
export function createQzonePublisher({ client, home }) {
  const file = join(home, 'qzone-state.json')
  let queue = Promise.resolve()
  return function publish({ text, images = [], privacy = 'public' }) {
    const task = queue.then(async () => {
      if (!text && !images.length) throw new Error('文字和图片至少提供一项')
      if (images.length > 9) throw new Error('空间说说最多 9 张图片')
      if (!Object.hasOwn(PRIVACY, privacy)) throw new Error('无效的空间可见范围')
      const today = dayOf()
      let state = { day: today, count: 0 }
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'))
        if (!Number.isInteger(saved.count) || saved.count < 0 || typeof saved.day !== 'string') {
          throw new Error('空间发布账本损坏，请检查 qzone-state.json')
        }
        if (saved.day === today) state = saved
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
      if (state.count >= 2) throw new Error('今天的空间发布额度已用完（每天最多两次尝试）')
      await mkdir(home, { recursive: true })
      const next = `${file}.tmp`
      await writeFile(next, JSON.stringify({ day: today, count: state.count + 1 }) + '\n', 'utf8')
      await rename(next, file)
      try {
        const result = await client.call('send_qzone_msg', {
          content: text, images, ugc_right: PRIVACY[privacy],
        }, 120_000)
        return { ok: true, tid: String(result?.tid ?? ''), privacy, images: images.length }
      } catch (err) {
        throw new Error(`空间发布未确认，请先检查空间再决定是否重发；本次额度已保留：${err.message}`)
      }
    })
    queue = task.catch(() => {})
    return task
  }
}
