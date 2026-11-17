import { createHash } from 'node:crypto'
import { parser, Table } from '@lezer/markdown'

const markdown = parser.configure(Table)
const hash = value => createHash('sha256').update(value).digest('hex')

/** 解析只记录位置，正文始终从原始字符串读取，不重新拼接或插入换行。 */
export function document(body, key, name, title = '', aliases = '', isMarkdown = true) {
  name = String(name).trim().slice(0, 512)
  title = String(title).trim().slice(0, 160) || name.slice(0, 160)
  const nodes = []
  if (isMarkdown) {
    // Table 扩展要求 LF。仅规范化解析输入，所有位置映射回含 BOM/CRLF 的原文。
    const base = body.startsWith('\uFEFF') ? 1 : 0
    const removed = []
    const input = body.slice(base).replace(/\r\n|\r/g, (newline, offset) => {
      if (newline.length === 2) removed.push(offset - removed.length + 1)
      return '\n'
    })
    const original = offset => {
      let low = 0, high = removed.length
      while (low < high) {
        const mid = (low + high) >>> 1
        if (removed[mid] <= offset) low = mid + 1
        else high = mid
      }
      return offset + low + base
    }
    for (let node = markdown.parse(input).topNode.firstChild; node; node = node.nextSibling) {
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name)
      nodes.push({ from: node.from === 0 ? 0 : original(node.from), to: original(node.to), type: node.name, level: heading ? Number(heading[1]) : 0 })
    }
  } else {
    let from = 0
    for (const match of body.matchAll(/\r?\n[\t ]*\r?\n|\r(?!\n)[\t ]*\r(?!\n)/g)) {
      if (body.slice(from, match.index).trim()) nodes.push({ from, to: match.index, type: 'Paragraph', level: 0 })
      from = match.index + match[0].length
    }
    if (body.slice(from).trim()) nodes.push({ from, to: body.length, type: 'Paragraph', level: 0 })
  }
  const sections = new Map(), stack = []
  for (const node of nodes) {
    if (!node.level) continue
    while (stack.length && stack.at(-1).level >= node.level) sections.set(stack.pop().from, node.from)
    stack.push(node)
  }
  for (const node of stack) sections.set(node.from, body.length)
  const introductionEnd = nodes.find(node => node.level)?.from ?? body.length
  const blocks = []
  let heading = null
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i], next = nodes[i + 1]
    if (node.level) {
      heading = { ...node, title: body.slice(node.from, node.to).split(/\r\n|\r|\n/)[0].trim().replace(/^#{1,6}\s+|\s+#+\s*$/g, '').trim().slice(0, 160) }
      if (next && !next.level) continue
    }
    const sectionEnd = heading ? sections.get(heading.from) : introductionEnd
    const previous = nodes[i - 1]
    blocks.push({ type: node.type, offset: i === 0 ? 0 : !node.level && previous?.level ? previous.from : node.from,
      endOffset: next?.from ?? body.length, title: heading?.title || title,
      section: { offset: heading?.from ?? 0, endOffset: sectionEnd } })
  }
  const lines = [0]
  for (const match of body.matchAll(/\r\n|\r|\n/g)) lines.push(match.index + match[0].length)
  return { id: hash(key), version: hash(body), name, title, aliases: String(aliases).trim().slice(0, 1000), body, blocks, lines }
}

function lineAt(doc, offset) {
  let low = 0, high = doc.lines.length
  while (low + 1 < high) {
    const mid = (low + high) >>> 1
    if (doc.lines[mid] <= offset) low = mid
    else high = mid
  }
  return low + 1
}

// UTF-16 位置与 JS/Markdown 解析器一致；截取边界不能落在代理对中间。
export function boundary(body, offset) {
  return offset > 0 && offset < body.length && /[\uDC00-\uDFFF]/.test(body[offset]) && /[\uD800-\uDBFF]/.test(body[offset - 1]) ? offset - 1 : offset
}

export function excerpt(source, doc, offset, endOffset, rangeEnd = endOffset) {
  return { sourceId: source.id, source: source.label, documentId: doc.id, version: doc.version,
    name: doc.name, title: doc.title, start: lineAt(doc, offset), end: lineAt(doc, Math.max(offset, endOffset - 1)),
    offset, endOffset, rangeEnd, length: doc.body.length, text: doc.body.slice(offset, endOffset),
    partial: endOffset < rangeEnd, nextOffset: endOffset < rangeEnd ? endOffset : null }
}

/** 在完整 JSON 预算内选择连续原文，转义和元数据也计入预算。 */
export function fitExcerpt(item, doc, fits) {
  if (fits(item)) return item
  const start = item.offset, end = item.endOffset
  let low = 0, high = end - start
  const resize = length => {
    const to = boundary(doc.body, start + length)
    return { ...item, endOffset: to, end: lineAt(doc, Math.max(start, to - 1)), text: doc.body.slice(start, to),
      partial: item.partial || to < end, nextOffset: to < item.rangeEnd ? to : null }
  }
  if (!fits(resize(0))) return null
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(resize(mid))) low = mid
    else high = mid - 1
  }
  const result = resize(low)
  return result.endOffset > start || start === item.rangeEnd ? result : null
}
