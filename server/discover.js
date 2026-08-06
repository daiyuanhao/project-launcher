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

function runCommand(pm, scriptName) {
  if (pm === 'yarn') return `yarn ${scriptName}`
  if (pm === 'pnpm') return `pnpm ${scriptName}`
  if (pm === 'bun') return `bun run ${scriptName}`
  return `npm run ${scriptName}`
}

function isRunnableEnvScript(key) {
  const EXPLICIT = new Set([
    'dev',
    'test',
    'pre',
    'prod',
    'online',
    'start',
    'serve',
    'electron:serve',
    'beta',
    'dev:mp',
    'test:mp',
    'pre:mp',
    'prod:mp',
    'build:mp',
    'dev:mp-weixin',
    'build:mp-weixin',
  ])
  if (EXPLICIT.has(key)) return true
  return /^(dev|start|serve):(test|pre|prod|online|beta)$/i.test(key)
}

const PRIMARY_ORDER = ['dev', 'start', 'serve', 'electron:serve', 'build:mp', 'dev:mp']
const ENV_ORDER = [
  'dev',
  'start',
  'serve',
  'electron:serve',
  'build:mp',
  'dev:mp',
  'test',
  'dev:test',
  'test:mp',
  'pre',
  'pre:mp',
  'prod',
  'prod:mp',
  'online',
  'dev:online',
  'beta',
  'build:mp-weixin',
  'dev:mp-weixin',
]

function readPackageScripts(dir) {
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) return { scripts: {}, pm: detectPackageManager(dir) }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    return { scripts: pkg.scripts || {}, pm: detectPackageManager(dir) }
  } catch {
    return { scripts: {}, pm: detectPackageManager(dir) }
  }
}

/** 解析单条命令：脚本名（build:mp）或完整命令（npm run build:mp） */
export function parseCommandSpec(spec, scripts, pm) {
  if (!spec || typeof spec !== 'string') return null
  const trimmed = spec.trim()
  if (!trimmed) return null

  if (scripts[trimmed]) {
    return { key: trimmed, label: trimmed, command: runCommand(pm, trimmed), script: trimmed }
  }

  const matched = trimmed.match(/^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(\S+)/)
  if (matched) {
    const script = matched[1]
    if (scripts[script]) {
      return { key: script, label: script, command: trimmed, script }
    }
  }

  const key = trimmed.replace(/\s+/g, '-').slice(0, 40) || 'custom'
  return { key: `custom:${key}`, label: trimmed, command: trimmed, script: null }
}

/**
 * 规范化项目命令配置
 * - string → { default, shortcuts: undefined }（shortcuts 未设置时用自动推荐）
 * - object → { default, shortcuts }
 */
export function normalizeProjectCommands(raw) {
  if (!raw) return null
  if (typeof raw === 'string') {
    return { default: raw.trim(), shortcuts: undefined, customized: false }
  }
  if (typeof raw === 'object') {
    const def = typeof raw.default === 'string' ? raw.default.trim() : ''
    const command = typeof raw.command === 'string' ? raw.command.trim() : ''
    return {
      default: def || command || '',
      shortcuts: Array.isArray(raw.shortcuts)
        ? raw.shortcuts.map((s) => String(s).trim()).filter(Boolean)
        : undefined,
      customized: Array.isArray(raw.shortcuts),
    }
  }
  return null
}

function resolveProjectCommandsRaw(dir, config) {
  const commands = config.commands || {}
  const legacy = config.projects || {}
  const name = path.basename(dir)
  const resolved = path.resolve(dir)
  return (
    commands[resolved] ||
    commands[dir] ||
    commands[name] ||
    legacy[name]?.command ||
    null
  )
}

export function resolveProjectCommands(dir, config) {
  return normalizeProjectCommands(resolveProjectCommandsRaw(dir, config))
}

function sortEnvironments(envs) {
  return [...envs].sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1
    const ai = ENV_ORDER.indexOf(a.key)
    const bi = ENV_ORDER.indexOf(b.key)
    if (ai === -1 && bi === -1) return a.key.localeCompare(b.key)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

function detectEnvironments(dir, projectCmds) {
  const { scripts, pm } = readPackageScripts(dir)
  const autoKeys = Object.keys(scripts).filter(isRunnableEnvScript)

  let defaultSpec = projectCmds?.default || ''
  if (!defaultSpec) {
    defaultSpec = PRIMARY_ORDER.find((k) => scripts[k]) || autoKeys[0] || ''
  }

  if (!defaultSpec && !autoKeys.length) return []

  const primary =
    parseCommandSpec(defaultSpec, scripts, pm) ||
    (autoKeys[0] ? parseCommandSpec(autoKeys[0], scripts, pm) : null)
  if (!primary) return []

  let shortcutSpecs
  if (projectCmds?.customized && Array.isArray(projectCmds.shortcuts)) {
    shortcutSpecs = projectCmds.shortcuts
  } else {
    shortcutSpecs = autoKeys.filter((k) => k !== primary.script && k !== primary.key)
  }

  const envs = [
    {
      key: primary.key,
      label: primary.label,
      command: primary.command,
      primary: true,
    },
  ]

  const seen = new Set([primary.key])
  for (const spec of shortcutSpecs) {
    const entry = parseCommandSpec(spec, scripts, pm)
    if (!entry || seen.has(entry.key)) continue
    seen.add(entry.key)
    envs.push({
      key: entry.key,
      label: entry.label,
      command: entry.command,
      primary: false,
    })
  }

  return sortEnvironments(envs)
}

/** 列出项目可用 scripts，供设置面板使用 */
export function listProjectScripts(dir, config) {
  const resolved = path.resolve(dir)
  const { scripts, pm } = readPackageScripts(resolved)
  const projectCmds = resolveProjectCommands(resolved, config)
  const environments = detectEnvironments(resolved, projectCmds)
  const primary = environments.find((e) => e.primary) || environments[0]

  return {
    path: resolved,
    name: path.basename(resolved),
    packageManager: pm,
    scripts: Object.keys(scripts)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        command: runCommand(pm, name),
      })),
    default: projectCmds?.default || primary?.key || '',
    defaultCommand: primary?.command || '',
    shortcuts: environments.filter((e) => !e.primary).map((e) => e.label || e.key),
    customized: Boolean(projectCmds?.customized),
    environments,
  }
}

/**
 * 写入某项目的命令配置（按绝对路径存）
 * @param {{ default: string, shortcuts: string[] }} payload
 */
export function setProjectCommands(config, projectPath, payload) {
  const resolved = path.resolve(projectPath)
  const name = path.basename(resolved)
  const defaultSpec = String(payload?.default || '').trim()
  if (!defaultSpec) {
    throw new Error('需要设置默认命令')
  }
  const shortcuts = Array.isArray(payload?.shortcuts)
    ? [...new Set(payload.shortcuts.map((s) => String(s).trim()).filter(Boolean))]
    : []

  const nextCommands = { ...(config.commands || {}) }
  delete nextCommands[resolved]
  delete nextCommands[name]
  for (const key of Object.keys(nextCommands)) {
    if (key.includes('/') || key.includes('\\')) {
      if (path.resolve(key) === resolved) delete nextCommands[key]
    }
  }
  nextCommands[resolved] = { default: defaultSpec, shortcuts }

  return {
    ...config,
    commands: nextCommands,
  }
}

function buildProject(dir, config) {
  const projectCmds = resolveProjectCommands(dir, config)
  const environments = detectEnvironments(dir, projectCmds)
  if (!environments.length) return null

  const primary = environments.find((e) => e.primary) || environments[0]
  const name = path.basename(dir)
  return {
    id: dir,
    name,
    path: dir,
    command: primary.command,
    environments,
    commandConfig: {
      default: primary.label || primary.key,
      shortcuts: environments.filter((e) => !e.primary).map((e) => e.label || e.key),
      customized: Boolean(projectCmds?.customized),
    },
    packageManager: detectPackageManager(dir),
    hasNodeModules: fs.existsSync(path.join(dir, 'node_modules')),
  }
}

function scanCollection(root, config) {
  const exclude = config.exclude || []
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []

  const projects = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (isExcluded(entry.name, exclude)) continue
    const legacy = config.projects?.[entry.name]
    if (legacy?.enabled === false) continue

    const project = buildProject(path.join(root, entry.name), config)
    if (project) projects.push(project)
  }
  return projects
}

/** 把旧配置迁移为 collections / singles；commands 字符串保持兼容 */
export function normalizeConfig(raw) {
  const next = {
    port: raw.port || 3920,
    exclude: raw.exclude || ['project-launcher', '*-bug-worktrees', '.claude'],
    collections: Array.isArray(raw.collections) ? [...raw.collections] : [],
    singles: Array.isArray(raw.singles) ? [...raw.singles] : [],
    hidden: Array.isArray(raw.hidden) ? [...raw.hidden] : [],
    commands: raw.commands || {},
  }

  if (raw.root && !next.collections.length && !next.singles.length) {
    if (Array.isArray(raw.watch) && raw.watch.length) {
      next.singles = raw.watch.map((name) => path.join(raw.root, name))
    } else {
      next.collections = [raw.root]
    }
  }

  next.collections = [...new Set(next.collections.map((p) => path.resolve(p)))]
  next.singles = [...new Set(next.singles.map((p) => path.resolve(p)))]
  next.hidden = [...new Set(next.hidden.map((p) => path.resolve(p)))]
  return next
}

export function discoverProjects(config) {
  const map = new Map()
  const hidden = new Set(config.hidden || [])

  for (const root of config.collections || []) {
    for (const project of scanCollection(root, config)) {
      if (hidden.has(project.id)) continue
      map.set(project.id, { ...project, source: 'collection', sourcePath: root })
    }
  }

  for (const dir of config.singles || []) {
    if (hidden.has(path.resolve(dir))) continue
    const project = buildProject(dir, config)
    if (project) {
      map.set(project.id, { ...project, source: 'project', sourcePath: dir })
    }
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function listSources(config) {
  const hidden = new Set(config.hidden || [])
  return {
    collections: (config.collections || []).map((p) => ({
      type: 'collection',
      path: p,
      name: path.basename(p),
      count: scanCollection(p, config).filter((proj) => !hidden.has(proj.id)).length,
    })),
    singles: (config.singles || [])
      .filter((p) => !hidden.has(path.resolve(p)))
      .map((p) => ({
        type: 'project',
        path: p,
        name: path.basename(p),
        launchable: Boolean(buildProject(p, config)),
      })),
  }
}

export function removeProject(config, projectPath) {
  const resolved = path.resolve(projectPath)
  return {
    ...config,
    singles: (config.singles || []).filter((p) => path.resolve(p) !== resolved),
    hidden: [...new Set([...(config.hidden || []), resolved])],
  }
}
