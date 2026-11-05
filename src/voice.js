import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)
const quote = value => `'${String(value).replace(/'/g, "''")}'`

/** SAPI 仅在 Windows 可用；返回音频内容，协议端无需访问宿主临时目录。 */
export async function synthesizeVoice(text, { voiceName = '' } = {}) {
  if (process.platform !== 'win32') throw new Error('语音合成需要 Windows SAPI')
  if (!text || text.length > 500) throw new Error('语音正文须为 1–500 字')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-voice-'))
  try {
    const input = join(dir, 'text.txt')
    const output = join(dir, 'voice.wav')
    await writeFile(input, text, 'utf8')
    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Speech',
      '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer',
      'try {',
      voiceName ? `$s.SelectVoice(${quote(voiceName)})` : '',
      `$s.SetOutputToWaveFile(${quote(output)})`,
      `$s.Speak([IO.File]::ReadAllText(${quote(input)},[Text.Encoding]::UTF8))`,
      '} finally { $s.Dispose() }',
    ].filter(Boolean).join('\n')
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20_000 })
    return await readFile(output)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
