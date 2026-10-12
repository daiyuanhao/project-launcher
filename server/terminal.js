import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const script = `on run argv
  set projectDirectory to item 1 of argv
  tell application "Terminal"
    do script ("cd -- " & quoted form of projectDirectory)
    activate
  end tell
end run`

function terminalError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode })
}

export async function openTerminal(directory) {
  if (process.platform !== 'darwin') {
    throw terminalError('打开终端目前仅支持 macOS', 501)
  }

  let stat
  try {
    stat = await fs.stat(directory)
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw terminalError('项目目录不存在', 404)
    }
    throw terminalError(`无法访问项目目录：${err.message}`, 500)
  }
  if (!stat.isDirectory()) {
    throw terminalError('项目路径不是有效目录', 400)
  }

  try {
    await execFileAsync('osascript', ['-e', script, directory], { timeout: 15000 })
  } catch (err) {
    throw terminalError(`打开终端失败：${err.stderr?.trim() || err.message}`, 500)
  }
}
