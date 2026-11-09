import { createMockEnvironment } from './mock-environment.mjs'
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const port = Number(option('--port', 0))
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port 必须为 0–65535')
const env = await createMockEnvironment({ port, verbose: args.includes('--verbose') })
console.log(`本地模拟器：${env.url}`)
console.log(`设置页预览：${env.url}/settings`)
console.log(`运行数据：${env.root}`)
console.log('不启动 DSH 或 NapCat，不调用真实模型，不发送真实 QQ 消息。Ctrl+C 退出。')
let closing = false
async function close() { if (closing) return; closing = true; await env.close(); console.log('模拟器已关闭，运行数据已保留。') }
process.on('SIGINT', close)
process.on('SIGTERM', close)
