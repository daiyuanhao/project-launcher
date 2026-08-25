#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const configPath = path.join(rootDir, 'config.json')
const exampleConfigPath = path.join(rootDir, 'config.example.json')
const dataDir = path.join(rootDir, 'data')
const logPath = path.join(dataDir, 'server.log')

function readPort() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return Number(raw.port) || 3920
  } catch {
    return 3920
  }
}

const port = readPort()
const base = `http://127.0.0.1:${port}`

function usage() {
  console.log(`Project Launcher  —  不用记路径，按名字启停

  pl                      启动面板并打开浏览器
  pl ls                   列出已监听项目
  pl start <名字> [命令]  启动项目（可写简称）
  pl stop [名字]          停止；不写名字且只跑着一个则直接停
  pl restart [名字]       重启；不写名字则重启全部运行中
  pl stop-all             停止全部运行中
  pl open                 打开面板

例子：
  pl start miniprogram
  pl start miniprogram build:mp
  pl stop web
`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function isReady() {
  try {
    const res = await fetch(`${base}/api/health`)
    if (!res.ok) return false
    const data = await res.json()
    return data.ok === true
  } catch {
    return false
  }
}

function ensureConfig() {
  if (fs.existsSync(configPath)) return
  if (!fs.existsSync(exampleConfigPath)) {
    throw new Error('缺少 config.example.json，无法初始化')
  }
  fs.copyFileSync(exampleConfigPath, configPath)
}

function startDaemon() {
  ensureConfig()
  fs.mkdirSync(dataDir, { recursive: true })
  const logFd = fs.openSync(logPath, 'a')
  const child = spawn(process.execPath, [path.join(rootDir, 'server/index.js')], {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })
  child.unref()
  fs.closeSync(logFd)
}

async function ensureServer() {
  if (await isReady()) return false
  startDaemon()
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await isReady()) return true
    await sleep(120)
  }
  throw new Error(`面板启动超时，日志见 ${logPath}`)
}

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = {}
  }
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`)
  }
  return data
}

function openBrowser() {
  spawn('open', [base], { detached: true, stdio: 'ignore' }).unref()
}

function matchProjects(projects, query) {
  const q = String(query).trim().toLowerCase()
  if (!q) return []
  const nameOf = (p) => String(p.name || '').toLowerCase()
  const exact = projects.filter((p) => nameOf(p) === q)
  if (exact.length) return exact
  const starts = projects.filter((p) => nameOf(p).startsWith(q))
  if (starts.length) return starts
  return projects.filter((p) => nameOf(p).includes(q))
}

function pickOne(projects, query, label) {
  const hits = matchProjects(projects, query)
  if (!hits.length) {
    throw new Error(`未找到${label}「${query}」。用 pl ls 查看名单`)
  }
  if (hits.length > 1) {
    const names = hits.map((p) => `  ${p.name}`).join('\n')
    throw new Error(`「${query}」匹配到多个${label}，写完整一点：\n${names}`)
  }
  return hits[0]
}

function matchEnv(project, envQuery) {
  const envs = project.environments || []
  if (!envQuery) {
    return envs.find((e) => e.primary) || envs[0] || { key: undefined, command: project.command }
  }
  const q = envQuery.toLowerCase()
  const exact = envs.filter((e) => e.key.toLowerCase() === q || e.label.toLowerCase() === q)
  const hits = exact.length ? exact : envs.filter((e) => e.key.toLowerCase().includes(q))
  if (!hits.length) {
    const names = envs.map((e) => e.label || e.key).join(', ') || '无'
    throw new Error(`项目 ${project.name} 没有命令「${envQuery}」。可选：${names}`)
  }
  if (hits.length > 1) {
    throw new Error(
      `命令「${envQuery}」不唯一：${hits.map((e) => e.label || e.key).join(', ')}`,
    )
  }
  return hits[0]
}

function pad(str, n) {
  const s = String(str)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

async function listProjects() {
  const data = await api('/api/projects')
  const projects = data.projects || []
  if (!projects.length) {
    console.log('还没有可启动项目。先执行 pl，在面板里「选择监听」。')
    return
  }
  const nameW = Math.min(40, Math.max(12, ...projects.map((p) => p.name.length)))
  for (const p of projects) {
    const mark = p.running ? '●' : '○'
    const state = p.running ? `运行中 ${p.runningEnv || ''}`.trim() : '未运行'
    const cmd = p.running ? p.command : (p.environments || []).find((e) => e.primary)?.command || p.command
    console.log(`${mark} ${pad(p.name, nameW)}  ${pad(state, 16)}  ${cmd}`)
  }
}

async function startProject(name, envQuery) {
  const data = await api('/api/projects')
  const project = pickOne(data.projects || [], name, '项目')
  const env = matchEnv(project, envQuery)
  const result = await api(`/api/projects/${encodeURIComponent(project.id)}/start`, {
    method: 'POST',
    body: { env: env.key },
  })
  const already = result.already ? '（已在运行）' : ''
  console.log(`已启动 ${project.name} · ${result.env || env.key}  ${already}`)
  console.log(result.command || env.command || project.command)
}

async function stopProject(name) {
  const data = await api('/api/projects')
  const projects = data.projects || []
  let project
  if (name) {
    project = pickOne(projects, name, '项目')
  } else {
    const running = projects.filter((p) => p.running)
    if (!running.length) {
      console.log('当前没有运行中的项目')
      return
    }
    if (running.length > 1) {
      throw new Error(
        `有多个运行中项目，指定名字：\n${running.map((p) => `  ${p.name}`).join('\n')}`,
      )
    }
    project = running[0]
  }
  if (!project.running) {
    console.log(`${project.name} 未在运行`)
    return
  }
  await api(`/api/projects/${encodeURIComponent(project.id)}/stop`, { method: 'POST' })
  console.log(`已停止 ${project.name}`)
}

async function stopAll() {
  const data = await api('/api/projects')
  const running = (data.projects || []).filter((p) => p.running)
  if (!running.length) {
    console.log('当前没有运行中的项目')
    return
  }
  for (const p of running) {
    await api(`/api/projects/${encodeURIComponent(p.id)}/stop`, { method: 'POST' })
    console.log(`已停止 ${p.name}`)
  }
}

async function restart(name) {
  if (!name) {
    const result = await api('/api/restart-running', { method: 'POST' })
    console.log(`已重启 ${result.count || 0} 个运行中项目`)
    return
  }
  const data = await api('/api/projects')
  const project = pickOne(data.projects || [], name, '项目')
  const envKey = project.runningEnv
  if (project.running) {
    await api(`/api/projects/${encodeURIComponent(project.id)}/stop`, { method: 'POST' })
  }
  await api(`/api/projects/${encodeURIComponent(project.id)}/start`, {
    method: 'POST',
    body: { env: envKey },
  })
  console.log(`已重启 ${project.name}`)
}

async function main() {
  const [, , cmd, ...rest] = process.argv
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    usage()
    return
  }

  const started = await ensureServer()
  if (started && (!cmd || cmd === 'open')) {
    console.log(`面板已启动  ${base}`)
  }

  if (!cmd || cmd === 'open') {
    openBrowser()
    if (cmd === 'open') console.log(base)
    else if (!started) console.log(`面板已在运行  ${base}`)
    return
  }

  if (cmd === 'ls' || cmd === 'list' || cmd === 'status') {
    await listProjects()
    return
  }

  if (cmd === 'start') {
    const [name, env] = rest
    if (!name) {
      openBrowser()
      console.log(`未指定项目，已打开面板  ${base}`)
      return
    }
    await startProject(name, env)
    return
  }

  if (cmd === 'stop') {
    await stopProject(rest[0])
    return
  }

  if (cmd === 'stop-all') {
    await stopAll()
    return
  }

  if (cmd === 'restart') {
    await restart(rest[0])
    return
  }

  usage()
  process.exitCode = 1
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
