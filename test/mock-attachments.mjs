// 模拟宿主附件存储合约；只验证图片头部，不替代真实宿主的解码和归一化。
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { imageSize } from 'image-size'

export function createMockAttachments(home) {
  const dir = join(home, 'mock-attachments')
  const pathOf = ref => join(dir, String(ref.attachmentId).replace(':', '-'))
  return {
    async saveImages(inputs) {
      await mkdir(dir, { recursive: true })
      return Promise.all(inputs.map(async ({ data, mediaType }) => {
        const { width, height } = imageSize(data)
        const ref = { attachmentId: 'sha256:' + createHash('sha256').update(data).digest('hex'),
          mediaType, bytes: data.length, width, height }
        await writeFile(pathOf(ref), data)
        return ref
      }))
    },
    async readImage(ref) { return { ref, data: await readFile(pathOf(ref)) } },
    imageHostPath: pathOf,
  }
}
