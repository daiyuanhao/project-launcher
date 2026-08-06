import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function chooseFolder(prompt) {
  const safe = String(prompt).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `try
  POSIX path of (choose folder with prompt "${safe}")
on error number -128
  return ""
end try`

  const { stdout } = await execFileAsync('osascript', ['-e', script])
  const picked = stdout.trim().replace(/\/$/, '')
  return picked || null
}
