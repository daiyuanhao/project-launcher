import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

const MAX_LOG_LINES = 400

export class ProcessManager extends EventEmitter {
  constructor() {
    super()
    /** @type {Map<string, any>} */
    this.procs = new Map()
  }

  listStatus() {
    const status = {}
    for (const [id, info] of this.procs) {
      status[id] = {
        running: true,
        pid: info.child.pid,
        startedAt: info.startedAt,
        command: info.command,
        path: info.path,
      }
    }
    return status
  }

  getLogs(id) {
    return this.procs.get(id)?.logs ?? []
  }

  isRunning(id) {
    return this.procs.has(id)
  }

  start(project) {
    if (this.procs.has(project.id)) {
      return { ok: true, already: true }
    }

    const child = spawn(project.command, {
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
      command: project.command,
      path: project.path,
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
      this.emit('log', { id: project.id, stream, line: text })
    }

    child.stdout?.on('data', (c) => append(c, 'stdout'))
    child.stderr?.on('data', (c) => append(c, 'stderr'))

    child.on('exit', (code, signal) => {
      this.procs.delete(project.id)
      this.emit('exit', { id: project.id, code, signal })
    })

    child.on('error', (err) => {
      info.logs.push({ t: Date.now(), stream: 'stderr', line: String(err.message || err) })
      this.procs.delete(project.id)
      this.emit('exit', { id: project.id, code: 1, signal: null, error: String(err.message || err) })
    })

    this.procs.set(project.id, info)
    this.emit('start', { id: project.id, pid: child.pid })
    return { ok: true, pid: child.pid }
  }

  stop(id) {
    const info = this.procs.get(id)
    if (!info) return Promise.resolve({ ok: true, already: true })

    const { child } = info
    const pid = child.pid

    return new Promise((resolve) => {
      const done = (result) => {
        clearTimeout(forceTimer)
        resolve(result)
      }

      child.once('exit', () => done({ ok: true, pid }))

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
        // exit handler will resolve; fallback if already gone
        if (!this.procs.has(id)) done({ ok: true, pid })
      }, 4000)
      forceTimer.unref?.()
    })
  }

  async restartRunning(resolveProject) {
    const ids = [...this.procs.keys()]
    const restarted = []

    for (const id of ids) {
      const project = resolveProject(id)
      if (!project) continue
      await this.stop(id)
      await new Promise((r) => setTimeout(r, 400))
      const result = this.start(project)
      restarted.push({ id, ...result })
    }

    return { ok: true, count: restarted.length, restarted }
  }

  stopAll() {
    return Promise.all([...this.procs.keys()].map((id) => this.stop(id)))
  }
}
