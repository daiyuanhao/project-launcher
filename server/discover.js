import fs from 'node:fs'
import path from 'node:path'

function matchGlob(name, pattern) {
  if (pattern === name) return true
  if (!pattern.includes('*')) return false
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
  )
  return re.test(name)
}

function isExcluded(name, exclude = []) {
  return exclude.some((pattern) => matchGlob(name, pattern))
}

function detectPackageManager(dir) {
  if (
    fs.existsSync(path.join(dir, 'pnpm-lock.yaml')) ||
    fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))
  ) {
    return 'pnpm'
  }
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn'
  if (fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun'
  return 'npm'
}

function detectCommand(dir, overrideCommand) {
  if (overrideCommand) return overrideCommand

  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) return null

  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch {
    return null
  }

  const scripts = pkg.scripts || {}
  const scriptName = ['dev', 'start', 'serve', 'electron:serve'].find((k) => k in scripts)
  if (!scriptName) return null

  const pm = detectPackageManager(dir)
  if (pm === 'yarn') return `yarn ${scriptName}`
  if (pm === 'pnpm') return `pnpm ${scriptName}`
  if (pm === 'bun') return `bun run ${scriptName}`
  return `npm run ${scriptName}`
}

/** 扫描 root 下所有可启动项目（不受 watch 过滤） */
export function discoverAllProjects(config) {
  const root = config.root
  const exclude = config.exclude || []
  const commands = config.commands || {}
  // 兼容旧版 projects.<name>.command / enabled
  const legacy = config.projects || {}

  if (!fs.existsSync(root)) return []

  const entries = fs.readdirSync(root, { withFileTypes: true })
  const projects = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (isExcluded(entry.name, exclude)) continue

    const dir = path.join(root, entry.name)
    const legacyItem = legacy[entry.name] || {}
    if (legacyItem.enabled === false) continue

    const overrideCommand = commands[entry.name] || legacyItem.command
    const command = detectCommand(dir, overrideCommand)
    if (!command) continue

    projects.push({
      id: entry.name,
      name: entry.name,
      path: dir,
      command,
      packageManager: detectPackageManager(dir),
      hasNodeModules: fs.existsSync(path.join(dir, 'node_modules')),
    })
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name))
}

/** 仅返回已选入 watch 的项目；未配置 watch 字段时兼容为全部 */
export function discoverProjects(config) {
  const all = discoverAllProjects(config)
  if (!Object.prototype.hasOwnProperty.call(config, 'watch')) {
    return all
  }
  const watch = new Set(config.watch || [])
  return all.filter((p) => watch.has(p.id))
}
