import { createHash } from 'node:crypto'

// 已发布完整模板的指纹；仅归一化换行和模板中的会话名称，不接受正文改动。
// 来源：src/workspace.js 的以下历史提交，包括旧版自动追加共享段的组合。
const templates = new Map([
  ['311a97f5ee438210a44676d156148bdda6483492f0d91b753fcb1af9785bb6de', 'c3ea240'],
  ['22a8fd98724f91937f622c5ab82204bb2c531300e9b84ce410decd5fe6e5008c', '6039104'],
  ['f5e37d3231dd1465f3bb23dec4a7faa65e43b8f3194a847e9a13de7a8d94d444', '472bb15'],
  ['cdfb646534a1ed2e6a76e1be1bc03919f552880aea100061430ca6d902923413', '433928a'],
  ['4d8aa1e3fdf93b209c75b454cfc0429fb512706fa7f8d98e297cd7d49bd52b97', '05e338c'],
  ['8133623fe09719d60e53be73e2cfcab9e57fa550925dff3d1c6eb43ca8007328', '559e2d1'],
  ['0483971a000bd14ffd23adc95206452df9b762810643d3baee151f3f38b384ac', '559e2d1 shared'],
  ['74d24ba7da69a9afe7430d1115b049d8b47491390c2ff97d822a6dde010a51fc', '7df77aa'],
  ['a8cb4250f3530e9e29747c5da0cccf32b30a3309191c420fb1888ab28fb54088', '7df77aa shared'],
  ['50ed94beaaeae2b09c24bf3487915abe2a3006eed003c8e4c3b61073583b72eb', 'c3ea240 appended shared'],
  ['8f5367c68c10487f985ed65933ff504542a9174c9e32b32c6b760205b92d4800', '6039104 appended shared'],
  ['febf5ff005e4ad6fd221b55b7dec4706cea884e36b6e3c0f757247e3f035020b', '472bb15 appended shared'],
  ['8dbd87e036090996aadf9d73eccec1e408facc74620a605101c7976087da4412', '433928a appended shared'],
])

export function legacyWorkspaceVersion(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(
    /^这里是 \*\*[^\n]+\*\* 自己的目录，只属于这一段对话。别的 QQ 会话有它们自己的目录，$/m,
    '这里是 **{{peer}}** 自己的目录，只属于这一段对话。别的 QQ 会话有它们自己的目录，',
  )
  return templates.get(createHash('sha256').update(normalized).digest('hex')) ?? null
}
