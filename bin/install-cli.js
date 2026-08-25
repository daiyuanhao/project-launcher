#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(rootDir, 'bin/pl.js')
const dest = path.join(os.homedir(), '.local/bin/pl')

function tryPnpmLink() {
  const result = spawnSync('pnpm', ['link', '--global'], {
    cwd: rootDir,
    encoding: 'utf8',
  })
  return result.status === 0
}

if (tryPnpmLink()) {
  console.log('已通过 pnpm 安装全局命令 pl')
  process.exit(0)
}

fs.mkdirSync(path.dirname(dest), { recursive: true })
try {
  fs.unlinkSync(dest)
} catch {
  // ignore
}
fs.symlinkSync(src, dest)
fs.chmodSync(src, 0o755)
console.log(`已安装命令：${dest}`)
console.log('任意目录执行：pl')
