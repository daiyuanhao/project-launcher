import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import {
  discoverProjects,
  listProjectScripts,
  listSources,
  normalizeConfig,
  removeProject,
  setProjectCommands,
} from './discover.js'
import { chooseFolder } from './picker.js'
import { ProcessManager } from './process-manager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const configPath = path.join(rootDir, 'config.json')
const exampleConfigPath = path.join(rootDir, 'config.example.json')

function readRawConfig() {
  if (!fs.existsSync(configPath)) {
    if (!fs.existsSync(exampleConfigPath)) {
      throw new Error('缺少 config.json，请先复制 config.example.json')
    }
    fs.copyFileSync(exampleConfigPath, configPath)
    console.warn('已从 config.example.json 生成 config.json，请通过「选择监听」添加目录')
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

function saveConfig(next) {
  const toSave = {
    port: next.port,
    exclude: next.exclude,
    collections: next.collections,
    singles: next.singles,
    hidden: next.hidden || [],
    commands: next.commands || {},
  }
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2) + '\n')
}

let config = normalizeConfig(readRawConfig())
// 迁移后写回，去掉旧 root/watch 字段
saveConfig(config)

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
  return {
    sources: listSources(config),
    projects: projects.map((p) => ({
      ...p,
      running: Boolean(status[p.id]?.running),
      runningEnv: status[p.id]?.env ?? null,
      runningEnvs: status[p.id]?.runningEnvs ?? [],
      processes: status[p.id]?.processes ?? [],
      pid: status[p.id]?.pid ?? null,
      startedAt: status[p.id]?.startedAt ?? null,
      command: status[p.id]?.command ?? p.command,
    })),
  }
}

function stopRemoved(nextIds) {
  for (const id of Object.keys(manager.listStatus())) {
    if (!nextIds.has(id)) manager.stop(id)
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(payload)
}

manager.on('start', (payload) => broadcast('start', payload))
manager.on('exit', (payload) => broadcast('exit', payload))
manager.on('log', (payload) => broadcast('log', payload))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/projects', (_req, res) => {
  res.json(snapshot())
})

app.get('/api/sources', (_req, res) => {
  res.json(listSources(config))
})

app.post('/api/sources/pick', async (req, res) => {
  const kind = req.body?.kind
  if (kind !== 'collection' && kind !== 'project') {
    res.status(400).json({ error: 'kind 需为 collection 或 project' })
    return
  }

  try {
    const prompt =
      kind === 'collection' ? '选择项目集合目录（其下多个项目）' : '选择单个项目目录'
    const picked = await chooseFolder(prompt)
    if (!picked) {
      res.json({ cancelled: true, ...snapshot() })
      return
    }

    const resolved = path.resolve(picked)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      res.status(400).json({ error: '所选路径不是有效目录' })
      return
    }

    if (kind === 'collection') {
      config = {
        ...config,
        collections: [...new Set([...(config.collections || []), resolved])],
      }
    } else {
      const projects = discoverProjects({
        ...config,
        collections: [],
        singles: [resolved],
        hidden: [],
      })
      if (!projects.length) {
        res.status(400).json({ error: '该目录未检测到可启动命令（package.json scripts）' })
        return
      }
      config = {
        ...config,
        singles: [...new Set([...(config.singles || []), resolved])],
        hidden: (config.hidden || []).filter((p) => path.resolve(p) !== resolved),
      }
    }

    saveConfig(config)
    res.json({ cancelled: false, path: resolved, ...snapshot() })
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) })
  }
})

app.delete('/api/sources', (req, res) => {
  const kind = req.body?.kind
  const target = req.body?.path
  if ((kind !== 'collection' && kind !== 'project') || typeof target !== 'string') {
    res.status(400).json({ error: '需要 kind 与 path' })
    return
  }

  const resolved = path.resolve(target)
  if (kind === 'collection') {
    config = {
      ...config,
      collections: (config.collections || []).filter((p) => p !== resolved),
    }
  } else {
    config = {
      ...config,
      singles: (config.singles || []).filter((p) => p !== resolved),
    }
  }

  const nextIds = new Set(discoverProjects(config).map((p) => p.id))
  stopRemoved(nextIds)
  saveConfig(config)
  res.json(snapshot())
})

app.delete('/api/projects', async (req, res) => {
  const target = req.body?.path || req.body?.id
  if (typeof target !== 'string' || !target) {
    res.status(400).json({ error: '需要 path' })
    return
  }

  const resolved = path.resolve(target)
  config = removeProject(config, resolved)
  await manager.stop(resolved)
  saveConfig(config)
  res.json(snapshot())
})

app.get('/api/projects/:id/scripts', (req, res) => {
  const id = decodeURIComponent(req.params.id)
  if (!projectMap().has(id) && !fs.existsSync(id)) {
    res.status(404).json({ error: '项目不存在' })
    return
  }
  try {
    res.json(listProjectScripts(id, config))
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) })
  }
})

app.put('/api/projects/:id/commands', (req, res) => {
  const id = decodeURIComponent(req.params.id)
  if (!projectMap().has(id)) {
    res.status(404).json({ error: '项目未在监听列表中' })
    return
  }
  try {
    config = setProjectCommands(config, id, {
      default: req.body?.default,
      shortcuts: req.body?.shortcuts,
    })
    saveConfig(config)
    res.json(snapshot())
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) })
  }
})

app.get('/api/projects/:id/logs', (req, res) => {
  res.json({ logs: manager.getLogs(req.params.id) })
})

app.post('/api/projects/:id/start', async (req, res) => {
  const id = decodeURIComponent(req.params.id)
  const project = projectMap().get(id)
  if (!project) {
    res.status(404).json({ error: '项目未在监听列表中，或不存在启动命令' })
    return
  }
  const env = req.body?.env
  const result = await manager.start(project, env)
  if (result.ok === false) {
    res.status(400).json(result)
    return
  }
  res.json(result)
})

app.post('/api/projects/:id/stop', async (req, res) => {
  const id = decodeURIComponent(req.params.id)
  const env = req.body?.env
  res.json(await manager.stop(id, env))
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
  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`)
  }, 25000)
  req.on('close', () => {
    clearInterval(heartbeat)
    clients.delete(res)
  })
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
