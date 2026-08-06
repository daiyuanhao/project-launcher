const board = document.getElementById('board')
const meta = document.getElementById('meta')
const search = document.getElementById('search')
const restartRunningBtn = document.getElementById('restart-running')
const manageWatchBtn = document.getElementById('manage-watch')
const watchDialog = document.getElementById('watch-dialog')
const watchListEl = document.getElementById('watch-list')
const watchAllBtn = document.getElementById('watch-all')
const watchNoneBtn = document.getElementById('watch-none')
const drawer = document.getElementById('drawer')
const drawerTitle = document.getElementById('drawer-title')
const drawerClose = document.getElementById('drawer-close')
const logsEl = document.getElementById('logs')

/** @type {Map<string, any>} */
const projects = new Map()
let activeLogId = null
let query = ''
let restarting = false
let watchConfigured = true

function formatUptime(startedAt) {
  if (!startedAt) return ''
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function render() {
  const list = [...projects.values()].filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()),
  )
  const running = [...projects.values()].filter((p) => p.running).length
  meta.textContent = `${projects.size} 个监听中 · ${running} 个运行中`
  restartRunningBtn.disabled = restarting || running === 0
  restartRunningBtn.textContent = restarting ? '重启中…' : '重启运行中'

  if (!list.length) {
    board.innerHTML = `
      <div class="empty">
        ${
          watchConfigured
            ? '当前没有已监听的项目'
            : '尚未选择要监听的项目'
        }
        <div>
          <button type="button" class="ghost" id="empty-watch">选择监听</button>
        </div>
      </div>`
    document.getElementById('empty-watch')?.addEventListener('click', openWatchDialog)
    return
  }

  board.innerHTML = list
    .map((p, index) => {
      const badges = [
        `<span class="badge">${p.packageManager}</span>`,
        p.running
          ? `<span class="badge live">运行中${p.startedAt ? ' · ' + formatUptime(p.startedAt) : ''}</span>`
          : '',
        !p.hasNodeModules ? `<span class="badge warn">无 node_modules</span>` : '',
      ]
        .filter(Boolean)
        .join('')

      return `
        <article class="row ${p.running ? 'on' : ''}" style="animation-delay:${Math.min(index, 12) * 30}ms" data-id="${p.id}">
          <div class="row-main">
            <div class="name-row">
              <h2 class="name">${p.name}</h2>
              ${badges}
            </div>
            <p class="cmd" title="${p.command}">$ ${p.command}</p>
          </div>
          <div class="actions">
            <button type="button" class="ghost log-btn" data-id="${p.id}">日志</button>
            <label class="switch ${p.busy ? 'busy' : ''}" title="${p.running ? '关闭以停止' : '打开以启动'}">
              <input type="checkbox" data-id="${p.id}" ${p.running ? 'checked' : ''} ${p.busy ? 'disabled' : ''} />
              <span class="track"></span>
              <span class="thumb"></span>
            </label>
          </div>
        </article>
      `
    })
    .join('')
}

async function loadProjects() {
  const res = await fetch('/api/projects')
  const data = await res.json()
  watchConfigured = Array.isArray(data.watch) ? data.watch.length > 0 : true
  projects.clear()
  for (const p of data.projects) {
    projects.set(p.id, { ...p, busy: false })
  }
  render()
}

async function openWatchDialog() {
  const res = await fetch('/api/discover')
  const data = await res.json()
  watchListEl.innerHTML = (data.projects || [])
    .map(
      (p) => `
      <label class="watch-item">
        <input type="checkbox" value="${p.id}" ${p.watching ? 'checked' : ''} />
        <span>
          <strong>${p.name}</strong>
          <span>$ ${p.command}</span>
        </span>
      </label>
    `,
    )
    .join('')

  if (!data.projects?.length) {
    watchListEl.innerHTML = `<div class="empty">目录下没有可启动的项目，请检查 config.json 的 root</div>`
  }

  watchDialog.showModal()
}

async function saveWatch() {
  const watch = [...watchListEl.querySelectorAll('input[type="checkbox"]:checked')].map(
    (el) => el.value,
  )
  const res = await fetch('/api/watch', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ watch }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || '保存失败')
  watchConfigured = Array.isArray(data.watch) ? data.watch.length > 0 : true
  projects.clear()
  for (const p of data.projects) {
    projects.set(p.id, { ...p, busy: false })
  }
  render()
}

async function toggle(id, wantOn) {
  const project = projects.get(id)
  if (!project) return
  project.busy = true
  render()

  try {
    const endpoint = wantOn ? 'start' : 'stop'
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/${endpoint}`, {
      method: 'POST',
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '操作失败')

    if (wantOn) {
      project.running = true
      project.pid = data.pid ?? project.pid
      project.startedAt = Date.now()
      openLogs(id)
    } else {
      project.running = false
      project.pid = null
      project.startedAt = null
    }
  } catch (err) {
    project.running = !wantOn
    alert(err.message || String(err))
  } finally {
    project.busy = false
    render()
  }
}

async function openLogs(id) {
  activeLogId = id
  drawer.hidden = false
  drawerTitle.textContent = id
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/logs`)
  const data = await res.json()
  logsEl.innerHTML = (data.logs || [])
    .map(
      (item) =>
        `<div class="${item.stream === 'stderr' ? 'stderr' : ''}">${escapeHtml(item.line)}</div>`,
    )
    .join('')
  logsEl.scrollTop = logsEl.scrollHeight
}

function appendLog(id, stream, text) {
  if (activeLogId !== id || drawer.hidden) return
  const lines = String(text).split(/\r?\n/).filter(Boolean)
  for (const line of lines) {
    const div = document.createElement('div')
    if (stream === 'stderr') div.className = 'stderr'
    div.textContent = line
    logsEl.appendChild(div)
  }
  logsEl.scrollTop = logsEl.scrollHeight
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

board.addEventListener('change', (e) => {
  const input = e.target
  if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return
  toggle(input.dataset.id, input.checked)
})

board.addEventListener('click', (e) => {
  const btn = e.target.closest('.log-btn')
  if (!btn) return
  openLogs(btn.dataset.id)
})

drawerClose.addEventListener('click', () => {
  drawer.hidden = true
  activeLogId = null
})

search.addEventListener('input', () => {
  query = search.value.trim()
  render()
})

manageWatchBtn.addEventListener('click', () => {
  openWatchDialog().catch((err) => alert(err.message || String(err)))
})

watchAllBtn.addEventListener('click', () => {
  for (const el of watchListEl.querySelectorAll('input[type="checkbox"]')) el.checked = true
})

watchNoneBtn.addEventListener('click', () => {
  for (const el of watchListEl.querySelectorAll('input[type="checkbox"]')) el.checked = false
})

watchDialog.addEventListener('close', () => {
  if (watchDialog.returnValue !== 'save') return
  saveWatch().catch((err) => alert(err.message || String(err)))
})

restartRunningBtn.addEventListener('click', async () => {
  const runningIds = [...projects.values()].filter((p) => p.running).map((p) => p.id)
  if (!runningIds.length || restarting) return

  restarting = true
  for (const id of runningIds) {
    const p = projects.get(id)
    if (p) p.busy = true
  }
  render()

  try {
    const res = await fetch('/api/restart-running', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '重启失败')
    await loadProjects()
  } catch (err) {
    alert(err.message || String(err))
    await loadProjects()
  } finally {
    restarting = false
    render()
  }
})

function connectEvents() {
  const es = new EventSource('/api/events')
  es.addEventListener('start', (ev) => {
    const data = JSON.parse(ev.data)
    const p = projects.get(data.id)
    if (!p) return
    p.running = true
    p.pid = data.pid
    p.startedAt = Date.now()
    p.busy = false
    render()
  })
  es.addEventListener('exit', (ev) => {
    const data = JSON.parse(ev.data)
    const p = projects.get(data.id)
    if (!p) return
    p.running = false
    p.pid = null
    p.startedAt = null
    p.busy = false
    render()
  })
  es.addEventListener('log', (ev) => {
    const data = JSON.parse(ev.data)
    appendLog(data.id, data.stream, data.line)
  })
  es.onerror = () => {
    es.close()
    setTimeout(connectEvents, 1500)
  }
}

setInterval(() => {
  if ([...projects.values()].some((p) => p.running)) render()
}, 15000)

await loadProjects()
connectEvents()
