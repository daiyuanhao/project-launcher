const board = document.getElementById('board')
const meta = document.getElementById('meta')
const search = document.getElementById('search')
const restartRunningBtn = document.getElementById('restart-running')
const manageWatchBtn = document.getElementById('manage-watch')
const watchDialog = document.getElementById('watch-dialog')
const watchListEl = document.getElementById('watch-list')
const pickCollectionBtn = document.getElementById('pick-collection')
const pickProjectBtn = document.getElementById('pick-project')
const watchCloseBtn = document.getElementById('watch-close')
const cmdDialog = document.getElementById('cmd-dialog')
const cmdDialogTitle = document.getElementById('cmd-dialog-title')
const cmdDefault = document.getElementById('cmd-default')
const cmdDefaultCustom = document.getElementById('cmd-default-custom')
const cmdShortcutList = document.getElementById('cmd-shortcut-list')
const cmdAddSelect = document.getElementById('cmd-add-select')
const cmdAddCustom = document.getElementById('cmd-add-custom')
const cmdAddBtn = document.getElementById('cmd-add-btn')
const cmdCancel = document.getElementById('cmd-cancel')
const cmdSave = document.getElementById('cmd-save')
const drawer = document.getElementById('drawer')
const drawerTitle = document.getElementById('drawer-title')
const drawerClose = document.getElementById('drawer-close')
const logsEl = document.getElementById('logs')

/** @type {Map<string, any>} */
const projects = new Map()
/** @type {{ collections: any[], singles: any[] }} */
let sources = { collections: [], singles: [] }
/** @type {Set<string>} */
const expandedEnvs = new Set()
let activeLogId = null
let query = ''
let restarting = false
let picking = false
let boardFingerprint = ''
let eventsConnected = false

/** @type {{ id: string, scripts: any[], default: string, shortcuts: string[] } | null} */
let cmdEditor = null

function formatUptime(startedAt) {
  if (!startedAt) return ''
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function hasSources() {
  return (sources.collections?.length || 0) + (sources.singles?.length || 0) > 0
}

function primaryEnv(p) {
  return (p.environments || []).find((e) => e.primary) || p.environments?.[0]
}

function extraEnvs(p) {
  const primary = primaryEnv(p)
  return (p.environments || []).filter((e) => e.key !== primary?.key)
}

function projectFingerprint(p) {
  return [
    p.id,
    p.running ? 1 : 0,
    p.runningEnv || '',
    p.busy ? 1 : 0,
    p.command || '',
    p.hasNodeModules ? 1 : 0,
    expandedEnvs.has(p.id) ? 1 : 0,
    (p.environments || []).map((e) => e.key).join(','),
  ].join('|')
}

function applySnapshot(data) {
  sources = data.sources || { collections: [], singles: [] }
  const prevBusy = new Map([...projects].map(([id, p]) => [id, p.busy]))
  projects.clear()
  for (const p of data.projects || []) {
    projects.set(p.id, { ...p, busy: prevBusy.get(p.id) || false })
  }
  boardFingerprint = ''
  render()
  renderSources()
}

function renderEnvSwitch(p, env, opts = {}) {
  const on = p.running && p.runningEnv === env.key
  const label = opts.showLabel ? `<span class="env-label">${escapeHtml(env.label)}</span>` : ''
  return `
    <label class="env-switch ${p.busy ? 'busy' : ''}" title="${on ? `关闭 ${env.label}` : `启动 ${env.label}`}">
      ${label}
      <span class="switch ${p.busy ? 'busy' : ''}">
        <input type="checkbox" data-id="${escapeAttr(p.id)}" data-env="${escapeAttr(env.key)}" ${on ? 'checked' : ''} ${p.busy ? 'disabled' : ''} />
        <span class="track"></span>
        <span class="thumb"></span>
      </span>
    </label>
  `
}

function updateMeta() {
  const running = [...projects.values()].filter((p) => p.running).length
  meta.textContent = `${projects.size} 个项目 · ${running} 个运行中`
  restartRunningBtn.disabled = restarting || running === 0
  restartRunningBtn.textContent = restarting ? '重启中…' : '重启运行中'
}

function updateUptimes() {
  for (const el of board.querySelectorAll('[data-uptime]')) {
    const startedAt = Number(el.dataset.uptime)
    const env = el.dataset.env || ''
    if (!startedAt) continue
    el.textContent = `${env}${env ? ' · ' : ''}${formatUptime(startedAt)}`
  }
}

function render() {
  const list = [...projects.values()].filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()),
  )
  updateMeta()

  if (!list.length) {
    const emptyKey = `empty:${hasSources() ? 1 : 0}`
    if (boardFingerprint === emptyKey) return
    boardFingerprint = emptyKey
    board.innerHTML = `
      <div class="empty">
        ${hasSources() ? '已添加的目录下没有可启动项目' : '尚未选择要监听的目录'}
        <div>
          <button type="button" class="ghost" id="empty-watch">选择监听</button>
        </div>
      </div>`
    document.getElementById('empty-watch')?.addEventListener('click', () => openWatchDialog())
    return
  }

  const nextFingerprint = `${query}::${list.map(projectFingerprint).join(';')}`
  if (nextFingerprint === boardFingerprint) {
    updateUptimes()
    return
  }
  const isFirstPaint = !boardFingerprint
  boardFingerprint = nextFingerprint

  board.innerHTML = list
    .map((p, index) => {
      const primary = primaryEnv(p)
      const extras = extraEnvs(p)
      const expanded = expandedEnvs.has(p.id)
      const activeCmd =
        (p.environments || []).find((e) => e.key === p.runningEnv)?.command ||
        primary?.command ||
        p.command

      const badges = [
        `<span class="badge">${p.packageManager}</span>`,
        p.running && p.runningEnv
          ? `<span class="badge live" data-uptime="${p.startedAt || ''}" data-env="${escapeAttr(p.runningEnv)}">${escapeHtml(p.runningEnv)}${p.startedAt ? ' · ' + formatUptime(p.startedAt) : ''}</span>`
          : '',
        !p.hasNodeModules ? `<span class="badge warn">无 node_modules</span>` : '',
      ]
        .filter(Boolean)
        .join('')

      const extraBlock = `
        <div class="env-extra ${expanded ? 'open' : ''}">
          <button type="button" class="ghost compact env-toggle" data-id="${escapeAttr(p.id)}">
            ${expanded ? '收起其他命令' : `其他命令 (${extras.length})`}
          </button>
          ${
            expanded
              ? extras.length
                ? `<div class="env-list">${extras.map((env) => renderEnvSwitch(p, env, { showLabel: true })).join('')}</div>`
                : `<p class="dialog-hint" style="margin:8px 0 0">暂无快捷命令，点「命令」添加</p>`
              : ''
          }
        </div>`

      return `
        <article class="row ${p.running ? 'on' : ''} ${isFirstPaint ? 'enter' : ''}" style="${isFirstPaint ? `animation-delay:${Math.min(index, 12) * 30}ms` : ''}" data-id="${escapeAttr(p.id)}">
          <div class="row-main">
            <div class="name-row">
              <h2 class="name">${escapeHtml(p.name)}</h2>
              ${badges}
            </div>
            <p class="cmd" title="${escapeAttr(activeCmd)}">$ ${escapeHtml(activeCmd)}</p>
            <p class="path">${escapeHtml(p.path)}</p>
            ${extraBlock}
          </div>
          <div class="actions">
            <button type="button" class="ghost compact cmd-btn" data-id="${escapeAttr(p.id)}" title="设置默认与快捷命令">命令</button>
            <button type="button" class="ghost log-btn" data-id="${escapeAttr(p.id)}">日志</button>
            <button type="button" class="ghost remove-btn" data-id="${escapeAttr(p.id)}" title="从列表移除">移除</button>
            ${primary ? renderEnvSwitch(p, primary, { showLabel: true }) : ''}
          </div>
        </article>
      `
    })
    .join('')
}

function renderSources() {
  const rows = [
    ...(sources.collections || []).map(
      (s) => `
      <div class="watch-item source-row">
        <span>
          <strong>集合 · ${escapeHtml(s.name)}</strong>
          <span>${escapeHtml(s.path)}</span>
          <span>${s.count} 个可启动项目</span>
        </span>
        <button type="button" class="ghost compact" data-remove-kind="collection" data-remove-path="${escapeAttr(s.path)}">移除</button>
      </div>`,
    ),
    ...(sources.singles || []).map(
      (s) => `
      <div class="watch-item source-row">
        <span>
          <strong>项目 · ${escapeHtml(s.name)}</strong>
          <span>${escapeHtml(s.path)}</span>
          <span>${s.launchable ? '可启动' : '未检测到启动命令'}</span>
        </span>
        <button type="button" class="ghost compact" data-remove-kind="project" data-remove-path="${escapeAttr(s.path)}">移除</button>
      </div>`,
    ),
  ]

  watchListEl.innerHTML = rows.length
    ? rows.join('')
    : `<div class="empty">还没有添加目录，请上方选择</div>`
}

function renderCmdEditor() {
  if (!cmdEditor) return
  const used = new Set([cmdEditor.default, ...cmdEditor.shortcuts].filter(Boolean))

  const scriptOptions = cmdEditor.scripts
    .map(
      (s) =>
        `<option value="${escapeAttr(s.name)}" ${s.name === cmdEditor.default ? 'selected' : ''}>${escapeHtml(s.name)}</option>`,
    )
    .join('')

  const defaultInScripts = cmdEditor.scripts.some((s) => s.name === cmdEditor.default)
  cmdDefault.innerHTML =
    `<option value="">选择 scripts…</option>` +
    scriptOptions +
    (cmdEditor.default && !defaultInScripts
      ? `<option value="${escapeAttr(cmdEditor.default)}" selected>${escapeHtml(cmdEditor.default)}（当前）</option>`
      : '')

  cmdDefaultCustom.value = defaultInScripts ? '' : cmdEditor.default || ''
  cmdDefaultCustom.placeholder = '例如：npm run build:mp'

  cmdShortcutList.innerHTML = cmdEditor.shortcuts.length
    ? cmdEditor.shortcuts
        .map(
          (item, index) => `
      <div class="cmd-shortcut-item">
        <span>${escapeHtml(item)}</span>
        <button type="button" class="ghost compact" data-remove-shortcut="${index}">删除</button>
      </div>`,
        )
        .join('')
    : `<div class="empty" style="padding:14px">还没有快捷命令</div>`

  const available = cmdEditor.scripts.filter((s) => !used.has(s.name))
  cmdAddSelect.innerHTML =
    `<option value="">从 scripts 选择…</option>` +
    available.map((s) => `<option value="${escapeAttr(s.name)}">${escapeHtml(s.name)}</option>`).join('')
  cmdAddCustom.value = ''
}

async function openCmdDialog(id) {
  const project = projects.get(id)
  if (!project) return
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/scripts`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    cmdEditor = {
      id,
      scripts: data.scripts || [],
      default: data.default || '',
      shortcuts: [...(data.shortcuts || [])],
    }
    cmdDialogTitle.textContent = `命令设置 · ${project.name}`
    renderCmdEditor()
    cmdDialog.showModal()
  } catch (err) {
    alert(err.message || String(err))
  }
}

function resolveDefaultSpec() {
  const custom = cmdDefaultCustom.value.trim()
  if (custom) return custom
  return cmdDefault.value.trim()
}

async function saveCmdEditor() {
  if (!cmdEditor) return
  const defaultSpec = resolveDefaultSpec()
  if (!defaultSpec) {
    alert('请设置默认命令')
    return
  }
  const shortcuts = cmdEditor.shortcuts.filter((s) => s !== defaultSpec)
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(cmdEditor.id)}/commands`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default: defaultSpec, shortcuts }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '保存失败')
    cmdDialog.close()
    cmdEditor = null
    applySnapshot(data)
  } catch (err) {
    alert(err.message || String(err))
  }
}

async function loadProjects() {
  const res = await fetch('/api/projects')
  const data = await res.json()
  applySnapshot(data)
}

function openWatchDialog() {
  renderSources()
  watchDialog.showModal()
}

async function pickSource(kind) {
  if (picking) return
  picking = true
  pickCollectionBtn.disabled = true
  pickProjectBtn.disabled = true
  try {
    const res = await fetch('/api/sources/pick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '选择失败')
    if (data.cancelled) return
    applySnapshot(data)
  } catch (err) {
    alert(err.message || String(err))
  } finally {
    picking = false
    pickCollectionBtn.disabled = false
    pickProjectBtn.disabled = false
  }
}

async function removeSource(kind, sourcePath) {
  const res = await fetch('/api/sources', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, path: sourcePath }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || '移除失败')
  applySnapshot(data)
}

async function toggle(id, wantOn, envKey) {
  const project = projects.get(id)
  if (!project) return
  project.busy = true
  render()

  try {
    if (wantOn) {
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env: envKey }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '启动失败')
      project.running = true
      project.runningEnv = data.env || envKey
      project.command = data.command || project.command
      project.pid = data.pid ?? project.pid
      project.startedAt = Date.now()
      openLogs(id)
    } else {
      if (project.runningEnv && envKey && project.runningEnv !== envKey) {
        return
      }
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}/stop`, {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '停止失败')
      project.running = false
      project.runningEnv = null
      project.pid = null
      project.startedAt = null
    }
  } catch (err) {
    alert(err.message || String(err))
    await loadProjects()
  } finally {
    project.busy = false
    render()
  }
}

async function openLogs(id) {
  activeLogId = id
  const project = projects.get(id)
  drawer.hidden = false
  drawerTitle.textContent = project?.name || id
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

function escapeAttr(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

board.addEventListener('change', (e) => {
  const input = e.target
  if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return
  if (!input.dataset.id) return
  toggle(input.dataset.id, input.checked, input.dataset.env)
})

board.addEventListener('click', async (e) => {
  const toggleBtn = e.target.closest('.env-toggle')
  if (toggleBtn) {
    const id = toggleBtn.dataset.id
    if (expandedEnvs.has(id)) expandedEnvs.delete(id)
    else expandedEnvs.add(id)
    render()
    return
  }

  const cmdBtn = e.target.closest('.cmd-btn')
  if (cmdBtn) {
    openCmdDialog(cmdBtn.dataset.id)
    return
  }

  const removeBtn = e.target.closest('.remove-btn')
  if (removeBtn) {
    const id = removeBtn.dataset.id
    const project = projects.get(id)
    if (!project) return
    if (!confirm(`确定从列表移除「${project.name}」？`)) return
    try {
      const res = await fetch('/api/projects', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '移除失败')
      if (activeLogId === id) {
        drawer.hidden = true
        activeLogId = null
      }
      expandedEnvs.delete(id)
      applySnapshot(data)
    } catch (err) {
      alert(err.message || String(err))
    }
    return
  }

  const btn = e.target.closest('.log-btn')
  if (!btn) return
  openLogs(btn.dataset.id)
})

cmdShortcutList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-shortcut]')
  if (!btn || !cmdEditor) return
  const index = Number(btn.dataset.removeShortcut)
  cmdEditor.shortcuts.splice(index, 1)
  renderCmdEditor()
})

cmdAddBtn.addEventListener('click', () => {
  if (!cmdEditor) return
  const custom = cmdAddCustom.value.trim()
  const selected = cmdAddSelect.value.trim()
  const value = custom || selected
  if (!value) return
  if (value === resolveDefaultSpec() || cmdEditor.shortcuts.includes(value)) {
    alert('该命令已存在')
    return
  }
  cmdEditor.shortcuts.push(value)
  renderCmdEditor()
})

cmdDefault.addEventListener('change', () => {
  if (!cmdEditor) return
  if (cmdDefault.value) {
    cmdDefaultCustom.value = ''
    cmdEditor.default = cmdDefault.value
    cmdEditor.shortcuts = cmdEditor.shortcuts.filter((s) => s !== cmdEditor.default)
    renderCmdEditor()
  }
})

cmdSave.addEventListener('click', () => saveCmdEditor())
cmdCancel.addEventListener('click', () => {
  cmdDialog.close()
  cmdEditor = null
})

watchListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-path]')
  if (!btn) return
  removeSource(btn.dataset.removeKind, btn.dataset.removePath).catch((err) =>
    alert(err.message || String(err)),
  )
})

drawerClose.addEventListener('click', () => {
  drawer.hidden = true
  activeLogId = null
})

search.addEventListener('input', () => {
  query = search.value.trim()
  render()
})

manageWatchBtn.addEventListener('click', () => openWatchDialog())
pickCollectionBtn.addEventListener('click', () => pickSource('collection'))
pickProjectBtn.addEventListener('click', () => pickSource('project'))
watchCloseBtn.addEventListener('click', () => watchDialog.close())

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
  if (eventsConnected) return
  eventsConnected = true
  const es = new EventSource('/api/events')
  es.addEventListener('start', (ev) => {
    const data = JSON.parse(ev.data)
    const p = projects.get(data.id)
    if (!p) return
    const same =
      p.running &&
      p.runningEnv === (data.env || p.runningEnv) &&
      p.pid === data.pid &&
      !p.busy
    p.running = true
    p.runningEnv = data.env || p.runningEnv
    p.command = data.command || p.command
    p.pid = data.pid
    if (!p.startedAt) p.startedAt = Date.now()
    p.busy = false
    if (!same) render()
  })
  es.addEventListener('exit', (ev) => {
    const data = JSON.parse(ev.data)
    const p = projects.get(data.id)
    if (!p) return
    if (!p.running && !p.busy) return
    p.running = false
    p.runningEnv = null
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
    eventsConnected = false
    es.close()
    setTimeout(connectEvents, 1500)
  }
}

setInterval(() => {
  if ([...projects.values()].some((p) => p.running)) updateUptimes()
}, 1000)

await loadProjects()
connectEvents()
