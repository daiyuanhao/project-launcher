import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

const MAX_LOG_LINES = 400

export class ProcessManager extends EventEmitter {
  constructor() {
    super()
    /** @type {Map<string, Map<string, any>>} */
    this.procs = new Map()
  }

  byProject(id) {
    return this.procs.get(id) || new Map()
  }

  listStatus() {
    const status = {}
    for (const [id, byEnv] of this.procs) {
      const processes = [...byEnv.values()].map((info) => ({
        env: info.env,
        pid: info.child.pid,
        startedAt: info.startedAt,
        command: info.command,
      }))
      status[id] = {
        running: processes.length > 0,
        runningEnvs: processes.map((p) => p.env),
        processes,
        pid: processes[0]?.pid ?? null,
        startedAt: processes[0]?.startedAt ?? null,
        command: processes.map((p) => p.command).join(' · ') || null,
        env: processes.length === 1 ? processes[0].env : processes.map((p) => p.env).join(','),
      }
    }
    return status
  }

  getLogs(id) {
    const rows = []
    for (const info of this.byProject(id).values()) {
      for (const item of info.logs) {
        rows.push({ ...item, env: info.env })
      }
    }
    rows.sort((a, b) => a.t - b.t)
    return rows
  }

  isRunning(id, envKey) {
    if (envKey) return this.byProject(id).has(envKey)
    return this.procs.has(id) && this.byProject(id).size > 0
  }

  async start(project, envKey) {
    const environments = project.environments || [
      { key: 'default', label: 'default', command: project.command, primary: true },
    ]
    const selected =
      environments.find((e) => e.key === envKey) ||
      environments.find((e) => e.primary) ||
      environments[0]

    if (!selected) {
      return { ok: false, error: '未找到可启动环境' }
    }

    const current = this.byProject(project.id).get(selected.key)
    if (current) {
      return { ok: true, already: true, env: selected.key, pid: current.child.pid }
    }

    const child = spawn(selected.command, {
      cwd: project.path,
      shell: true,
      detached: true,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const info = {
      child,
      startedAt: Date.now(),
      logs: [],
      command: selected.command,
      path: project.path,
      env: selected.key,
    }

    const append = (chunk, stream) => {
      const text = chunk.toString('utf8')
      const lines = text.split(/\r?\n/).filter(Boolean)
      for (const line of lines) {
        info.logs.push({ t: Date.now(), stream, line })
      }
      if (info.logs.length > MAX_LOG_LINES) {
        info.logs.splice(0, info.logs.length - MAX_LOG_LINES)
      }
      this.emit('log', { id: project.id, stream, line: text, env: selected.key })
    }

    child.stdout?.on('data', (c) => append(c, 'stdout'))
    child.stderr?.on('data', (c) => append(c, 'stderr'))

    const drop = () => {
      const byEnv = this.procs.get(project.id)
      if (!byEnv) return
      byEnv.delete(selected.key)
      if (!byEnv.size) this.procs.delete(project.id)
    }

    child.on('exit', (code, signal) => {
      drop()
      this.emit('exit', { id: project.id, code, signal, env: selected.key })
    })

    child.on('error', (err) => {
      info.logs.push({ t: Date.now(), stream: 'stderr', line: String(err.message || err) })
      drop()
      this.emit('exit', {
        id: project.id,
        code: 1,
        signal: null,
        error: String(err.message || err),
        env: selected.key,
      })
    })

    if (!this.procs.has(project.id)) this.procs.set(project.id, new Map())
    this.procs.get(project.id).set(selected.key, info)
    this.emit('start', {
      id: project.id,
      pid: child.pid,
      env: selected.key,
      command: selected.command,
    })
    return { ok: true, pid: child.pid, env: selected.key, command: selected.command }
  }

  stop(id, envKey) {
    const byEnv = this.procs.get(id)
    if (!byEnv?.size) return Promise.resolve({ ok: true, already: true })

    const keys = envKey ? [envKey] : [...byEnv.keys()]
    return Promise.all(keys.map((key) => this.stopOne(id, key))).then((results) => results[0] || { ok: true })
  }

  stopOne(id, envKey) {
    const info = this.byProject(id).get(envKey)
    if (!info) return Promise.resolve({ ok: true, already: true })

    const { child } = info
    const pid = child.pid

    return new Promise((resolve) => {
      const done = (result) => {
        clearTimeout(forceTimer)
        resolve(result)
      }

      child.once('exit', () => done({ ok: true, pid, env: envKey }))

      try {
        if (pid) process.kill(-pid, 'SIGTERM')
      } catch {
        try {
          child.kill('SIGTERM')
        } catch {
          // ignore
        }
      }

      const forceTimer = setTimeout(() => {
        try {
          if (pid) process.kill(-pid, 'SIGKILL')
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
        }
        if (!this.byProject(id).has(envKey)) done({ ok: true, pid, env: envKey })
      }, 4000)
      forceTimer.unref?.()
    })
  }

  async restartRunning(resolveProject) {
    const jobs = []
    for (const [id, byEnv] of this.procs) {
      for (const env of byEnv.keys()) {
        jobs.push({ id, env })
      }
    }
    const restarted = []

    for (const { id, env } of jobs) {
      const project = resolveProject(id)
      if (!project) continue
      await this.stop(id, env)
      await new Promise((r) => setTimeout(r, 400))
      const result = await this.start(project, env)
      restarted.push({ id, env, ...result })
    }

    return { ok: true, count: restarted.length, restarted }
  }

  stopAll() {
    return Promise.all([...this.procs.keys()].map((id) => this.stop(id)))
  }
}
