import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { discoverAllProjects, discoverProjects } from './discover.js'
import { ProcessManager } from './process-manager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const configPath = path.join(rootDir, 'config.json')
const exampleConfigPath = path.join(rootDir, 'config.example.json')

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    if (!fs.existsSync(exampleConfigPath)) {
      throw new Error('缺少 config.json，请先复制 config.example.json')
    }
    fs.copyFileSync(exampleConfigPath, configPath)
    console.warn('已从 config.example.json 生成 config.json，请设置 root 并选择要监听的项目')
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

function saveConfig(next) {
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n')
}

let config = loadConfig()
const app = express()
const manager = new ProcessManager()
const clients = new Set()

app.use(express.json())
app.use(express.static(path.join(rootDir, 'public')))

function projectMap() {
  return new Map(discoverProjects(config).map((p) => [p.id, p]))
}

function snapshot() {
  const projects = discoverProjects(config)
  const status = manager.listStatus()
  const watch = Array.isArray(config.watch) ? config.watch : null
  return {
    watch,
    root: config.root,
    projects: projects.map((p) => ({
      ...p,
      running: Boolean(status[p.id]),
      pid: status[p.id]?.pid ?? null,
      startedAt: status[p.id]?.startedAt ?? null,
    })),
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(payload)
}

manager.on('start', (payload) => broadcast('start', payload))
manager.on('exit', (payload) => broadcast('exit', payload))
manager.on('log', (payload) => broadcast('log', payload))

app.get('/api/projects', (_req, res) => {
  res.json(snapshot())
})

app.get('/api/discover', (_req, res) => {
  const all = discoverAllProjects(config)
  const watch = new Set(Array.isArray(config.watch) ? config.watch : all.map((p) => p.id))
  res.json({
    root: config.root,
    projects: all.map((p) => ({
      ...p,
      watching: watch.has(p.id),
    })),
  })
})

app.put('/api/watch', (req, res) => {
  const list = req.body?.watch
  if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'watch 需为字符串数组' })
    return
  }

  const valid = new Set(discoverAllProjects(config).map((p) => p.id))
  const nextWatch = [...new Set(list.filter((id) => valid.has(id)))]

  for (const id of Object.keys(manager.listStatus())) {
    if (!nextWatch.includes(id)) manager.stop(id)
  }

  config = { ...config, watch: nextWatch }
  saveConfig(config)
  res.json(snapshot())
})

app.get('/api/projects/:id/logs', (req, res) => {
  res.json({ logs: manager.getLogs(req.params.id) })
})

app.post('/api/projects/:id/start', (req, res) => {
  const project = projectMap().get(req.params.id)
  if (!project) {
    res.status(404).json({ error: '项目未在监听列表中，或不存在启动命令' })
    return
  }
  res.json(manager.start(project))
})

app.post('/api/projects/:id/stop', async (req, res) => {
  res.json(await manager.stop(req.params.id))
})

app.post('/api/restart-running', async (_req, res) => {
  const map = projectMap()
  const result = await manager.restartRunning((id) => map.get(id))
  res.json(result)
})

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`)
  clients.add(res)
  req.on('close', () => clients.delete(res))
})

const port = config.port || 3920
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Project Launcher 已启动: http://127.0.0.1:${port}`)
})

async function shutdown() {
  await manager.stopAll()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
