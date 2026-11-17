import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'

const entryView = ({ id, kind, text, status, version, verifyAt }) => ({ id, kind, text, status, version, verifyAt })
const boundary = (text, end) => end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') ? end - 1 : end
const hash = text => createHash('sha256').update(text).digest('hex')

/** 每批保留完整依据 ID；仅超长单条切连续片段，进度随成功结果一并保存。 */
export async function memoryBatch({ job, entries, effective, capacity, options }) {
  const sourceHash = hash(JSON.stringify(job.evidence))
  const progress = structuredClone(job.progress ?? { evidence: 0, offset: 0, sourceHash })
  const position = value => Number.isSafeInteger(value) && value >= 0
  if (progress.sourceHash !== sourceHash || !position(progress.evidence) || progress.evidence >= job.evidence.length ||
    !position(progress.offset) || progress.offset >= JSON.stringify(job.evidence[progress.evidence]).length ||
    progress.batch && (!position(progress.scan) || !position(progress.endEntries) || progress.scan > progress.endEntries ||
      progress.endEntries > entries.length || !position(progress.entryOffset) ||
      !Array.isArray(progress.proposed) || !Array.isArray(progress.batch.evidence) || !progress.batch.evidence.length ||
      !position(progress.batch.nextEvidence) || progress.batch.nextEvidence > job.evidence.length || !position(progress.batch.nextOffset))) {
    throw new Error('记忆维护来源或进度无效，原数据保留')
  }
  if (progress.entryOffset && progress.entryTextHash !== hash(entries[progress.scan].text)) progress.entryOffset = 0
  const limit = capacity ? Math.min(32768, (await capacity.route(options)).hard) - 64 : Infinity
  const layout = hash(JSON.stringify([options.provider, options.model, options.system, limit]))
  if (progress.layout && progress.layout !== layout) {
    // 模型或输入上限变化时重读当前依据批，已提交的先前依据位置不回退。
    delete progress.batch
    delete progress.entryTextHash
    delete progress.fragmentNotes
  }
  progress.layout = layout
  const firstPage = !progress.batch
  if (firstPage) {
    progress.scan = 0; progress.entryOffset = 0; progress.endEntries = entries.length
    progress.proposed = []
  }
  const measure = async payload => capacity ? capacity.measure({ ...options,
    messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(payload) }] })] }) : 0
  const payload = { entries: [], observedAt: job.observedAt, evidence: [],
    proposed: progress.proposed, firstPage, lastPage: false,
    ...(progress.notes ? { previousFragmentNotes: progress.notes } : {}),
  }
  const fit = async (text, from, build, ceiling) => {
    let low = from, high = text.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (await measure(build(boundary(text, mid))) <= ceiling) low = mid
      else high = mid - 1
    }
    const end = boundary(text, low)
    if (end <= from) throw new Error('记忆维护预算不足以读取连续片段，进度已保留')
    return end
  }
  if (firstPage) {
    let index = progress.evidence, offset = progress.offset
    const base = await measure(payload)
    const evidenceLimit = base + (limit - base) / 2
    while (index < job.evidence.length) {
      const item = job.evidence[index], text = JSON.stringify(item)
      const piece = end => offset === 0 && end === text.length ? item : {
        id: item.id, type: item.type, fragment: { from: offset, to: end, length: text.length, text: text.slice(offset, end) },
      }
      let end = text.length
      const build = end => ({ ...payload, evidence: [...payload.evidence, piece(end)] })
      if (await measure(build(end)) > evidenceLimit) {
        if (payload.evidence.length) break
        end = await fit(text, offset, build, evidenceLimit)
      }
      payload.evidence.push(piece(end))
      if (end === text.length) { index++; offset = 0 }
      else { offset = end; break }
    }
    if (!payload.evidence.length) throw new Error('记忆维护没有可读取的新增依据')
    progress.batch = { evidence: payload.evidence, nextEvidence: index, nextOffset: offset }
  } else payload.evidence = progress.batch.evidence
  let scan = progress.scan, offset = progress.entryOffset
  while (scan < progress.endEntries) {
    const entry = entryView(effective(entries[scan]))
    if (job.protectedIds?.includes(entry.id)) entry.protected = true
    const piece = end => offset === 0 && end === entry.text.length ? entry : {
      ...entry, text: entry.text.slice(offset, end), fragment: { from: offset, to: end, length: entry.text.length },
    }
    let end = entry.text.length
    const build = end => ({ ...payload, entries: [...payload.entries, piece(end)] })
    if (await measure(build(end)) > limit) {
      if (payload.entries.length) break
      end = await fit(entry.text, offset, build, limit)
    }
    payload.entries.push(piece(end))
    if (end === entry.text.length) { scan++; offset = 0 }
    else { offset = end; break }
  }
  payload.lastPage = scan === progress.endEntries
  // firstPage 只在创建本批依据时为真，条目变化导致片段重读也不能再次新增。
  progress.scan = scan; progress.entryOffset = offset
  if (offset) progress.entryTextHash = hash(entries[scan].text)
  else delete progress.entryTextHash
  const request = { ...options, messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(payload) }] })] }
  if (capacity) await capacity.check(request)
  return { progress, payload, request, limit }
}
