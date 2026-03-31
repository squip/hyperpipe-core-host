const { existsSync, readFileSync, readdirSync } = require('node:fs')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const path = require('node:path')

const STOP_WAIT_FOR_EXIT_MS = 8_000
const STOP_SIGTERM_GRACE_MS = 4_000
const STOP_SIGKILL_GRACE_MS = 1_500
const STARTUP_ORPHAN_TERM_GRACE_MS = 2_500
const STARTUP_ORPHAN_KILL_GRACE_MS = 1_500

function isHex64(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value)
}

function validateCoreConfigPayload(payload) {
  if (!payload) return null
  if (!isHex64(payload.nostr_pubkey_hex) || !isHex64(payload.nostr_nsec_hex)) {
    return 'Invalid core config: expected nostr_pubkey_hex and nostr_nsec_hex (64-char hex)'
  }
  if (!payload.userKey || typeof payload.userKey !== 'string') {
    return 'Invalid core config: userKey is required for per-account isolation'
  }
  return null
}

function makeCoreRequestId(prefix = 'core-req') {
  return `${prefix}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

function normalizeTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs)) return 30_000
  return Math.max(1_000, Math.min(Math.trunc(timeoutMs), 300_000))
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function resolveCorePackageRoot(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd())
  const searchPaths = [cwd, path.resolve(cwd, '..'), path.resolve(cwd, '../..')]

  for (const base of searchPaths) {
    try {
      const packagePath = require.resolve('@hyperpipe/core/package.json', { paths: [base] })
      return path.dirname(packagePath)
    } catch (_) {
      // continue
    }
  }

  const fallbackRoots = [
    path.resolve(cwd, 'hyperpipe-core'),
    path.resolve(cwd, '../hyperpipe-core'),
    path.resolve(cwd, '../../hyperpipe-core')
  ]

  for (const candidate of fallbackRoots) {
    if (existsSync(path.join(candidate, 'package.json'))) {
      return candidate
    }
  }

  return fallbackRoots[1]
}

function resolveCoreEntry(options = {}) {
  if (options.coreEntry) return options.coreEntry

  const coreRoot = options.coreRoot || resolveCorePackageRoot(options)
  const packageJsonPath = path.join(coreRoot, 'package.json')
  const packageJson = readJsonFile(packageJsonPath) || {}
  const binField = packageJson.bin || {}
  const relativeBinPath =
    typeof binField === 'string'
      ? binField
      : (typeof binField['hyperpipe-core'] === 'string' ? binField['hyperpipe-core'] : null)

  if (relativeBinPath) {
    return path.resolve(coreRoot, relativeBinPath)
  }

  return path.join(coreRoot, 'bin', 'hyperpipe-core.mjs')
}

function sendCoreConfigToProcess(proc, payload) {
  if (!proc || typeof proc.send !== 'function') {
    return { success: false, error: 'Core IPC channel unavailable' }
  }

  try {
    proc.send({ type: 'config', data: payload })
    setTimeout(() => {
      if (proc.killed || !proc.connected) return
      try {
        proc.send({ type: 'config', data: payload })
      } catch (_) {}
    }, 1_000)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

class CoreHost {
  constructor() {
    this.coreProcess = null
    this.currentCoreUserKey = null
    this.pendingRequests = new Map()
    this.emitter = new EventEmitter()
    this.parentExitHooksInstalled = false
    this.stopInFlight = null
  }

  installParentExitHooks() {
    if (this.parentExitHooksInstalled) return
    this.parentExitHooksInstalled = true

    const shutdownChild = () => {
      const proc = this.coreProcess
      if (!proc) return
      if (typeof proc.send === 'function' && proc.connected) {
        try {
          proc.send({ type: 'shutdown' })
        } catch (_) {}
      }
      try {
        proc.kill('SIGTERM')
      } catch (_) {}
    }

    process.on('exit', shutdownChild)
    process.on('SIGINT', shutdownChild)
    process.on('SIGTERM', shutdownChild)
  }

  async start(config) {
    this.installParentExitHooks()

    const validationError = validateCoreConfigPayload(config.config)
    if (validationError) {
      return { success: false, configSent: false, error: validationError }
    }

    const coreRoot = config.coreRoot || config.workerRoot || resolveCorePackageRoot(config)
    const coreEntry = resolveCoreEntry({
      ...config,
      coreRoot,
      coreEntry: config.coreEntry || config.workerEntry
    })

    if (!existsSync(coreEntry)) {
      return {
        success: false,
        configSent: false,
        error: `Hyperpipe Core entry not found at ${coreEntry}`
      }
    }

    if (this.coreProcess) {
      if (
        this.currentCoreUserKey
        && config.config.userKey
        && this.currentCoreUserKey !== config.config.userKey
      ) {
        await this.stop()
      } else {
        const configResult = sendCoreConfigToProcess(this.coreProcess, config.config)
        if (!configResult.success) {
          return {
            success: false,
            configSent: false,
            error: configResult.error || 'Failed to send config to running core'
          }
        }
        this.currentCoreUserKey = config.config.userKey
        return { success: true, alreadyRunning: true, configSent: true }
      }
    }

    try {
      await this.cleanupOrphanedCores(coreEntry, config.config.userKey)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.emitter.emit('stderr', `[CoreHost] Startup orphan core cleanup failed: ${detail}`)
    }

    const coreProcess = spawn(process.execPath, [coreEntry], {
      cwd: coreRoot,
      env: {
        ...process.env,
        ...(config.env || {}),
        ELECTRON_RUN_AS_NODE: '1',
        APP_DIR: coreRoot,
        STORAGE_DIR: config.storageDir,
        USER_KEY: config.config.userKey
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    })

    this.coreProcess = coreProcess
    this.currentCoreUserKey = config.config.userKey

    coreProcess.on('message', (message) => {
      if (this.resolveCoreRequest(message)) {
        return
      }
      if (message && typeof message === 'object') {
        this.emitter.emit('message', message)
      }
    })

    coreProcess.on('error', (error) => {
      this.rejectPendingCoreRequests(error?.message || 'Core process error')
      this.emitter.emit('stderr', `[CoreHost] Core error: ${error?.message || String(error)}`)
    })

    coreProcess.on('exit', (code, signal) => {
      this.rejectPendingCoreRequests(`Core exited with code=${code ?? signal ?? 'unknown'}`)
      this.coreProcess = null
      this.currentCoreUserKey = null
      this.emitter.emit('exit', code ?? 0)
    })

    coreProcess.stdout?.on('data', (chunk) => {
      this.emitter.emit('stdout', chunk.toString())
    })

    coreProcess.stderr?.on('data', (chunk) => {
      this.emitter.emit('stderr', chunk.toString())
    })

    const configResult = sendCoreConfigToProcess(coreProcess, config.config)
    if (!configResult.success) {
      try {
        coreProcess.kill()
      } catch (_) {}
      this.coreProcess = null
      this.currentCoreUserKey = null
      return {
        success: false,
        configSent: false,
        error: configResult.error || 'Failed to send config to core'
      }
    }

    return { success: true, configSent: true, coreRoot, coreEntry }
  }

  async stop() {
    if (!this.coreProcess) return
    if (this.stopInFlight) {
      await this.stopInFlight
      return
    }

    const proc = this.coreProcess

    this.stopInFlight = (async () => {
      try {
        if (typeof proc.send === 'function' && proc.connected) {
          try {
            proc.send({ type: 'shutdown' })
          } catch (_) {}
        }

        let exited = await this.waitForProcessExit(proc, STOP_WAIT_FOR_EXIT_MS)
        if (!exited) {
          try {
            proc.kill('SIGTERM')
          } catch (_) {}
          exited = await this.waitForProcessExit(proc, STOP_SIGTERM_GRACE_MS)
        }

        if (!exited) {
          try {
            proc.kill('SIGKILL')
          } catch (_) {}
          await this.waitForProcessExit(proc, STOP_SIGKILL_GRACE_MS)
        }
      } finally {
        this.coreProcess = null
        this.currentCoreUserKey = null
        this.rejectPendingCoreRequests('Core stopped')
      }
    })()

    try {
      await this.stopInFlight
    } finally {
      this.stopInFlight = null
    }
  }

  async send(message) {
    const proc = this.coreProcess
    if (!proc || typeof proc.send !== 'function') {
      return { success: false, error: 'Core not running' }
    }

    try {
      proc.send(message)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async request(message, timeoutMs = 30_000) {
    const proc = this.coreProcess
    if (!proc || typeof proc.send !== 'function') {
      throw new Error('Core not running')
    }

    const requestId =
      typeof message.requestId === 'string' && message.requestId
        ? message.requestId
        : makeCoreRequestId()

    if (this.pendingRequests.has(requestId)) {
      throw new Error(`Duplicate core requestId: ${requestId}`)
    }

    const outgoing = {
      ...message,
      requestId
    }

    const timeout = normalizeTimeout(timeoutMs)

    const response = await new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        if (!this.pendingRequests.has(requestId)) return
        this.pendingRequests.delete(requestId)
        resolve({
          success: false,
          requestId,
          error: `Core reply timeout after ${timeout}ms`
        })
      }, timeout)

      this.pendingRequests.set(requestId, { resolve, timeoutId })

      try {
        proc.send(outgoing)
      } catch (error) {
        clearTimeout(timeoutId)
        this.pendingRequests.delete(requestId)
        resolve({
          success: false,
          requestId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })

    if (!response.success) {
      throw new Error(response.error || 'Core request failed')
    }

    return response.data ?? null
  }

  onMessage(listener) {
    this.emitter.on('message', listener)
    return () => this.emitter.off('message', listener)
  }

  onExit(listener) {
    this.emitter.on('exit', listener)
    return () => this.emitter.off('exit', listener)
  }

  onStdout(listener) {
    this.emitter.on('stdout', listener)
    return () => this.emitter.off('stdout', listener)
  }

  onStderr(listener) {
    this.emitter.on('stderr', listener)
    return () => this.emitter.off('stderr', listener)
  }

  isRunning() {
    return !!this.coreProcess
  }

  waitForProcessExit(proc, timeoutMs) {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)

    const timeout = Math.max(250, Math.min(Math.trunc(timeoutMs || 0), 60_000))
    return new Promise((resolve) => {
      let settled = false

      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        proc.off('exit', onExit)
        proc.off('close', onClose)
        resolve(result)
      }

      const onExit = () => finish(true)
      const onClose = () => finish(true)

      const timer = setTimeout(() => finish(false), timeout)
      proc.once('exit', onExit)
      proc.once('close', onClose)
    })
  }

  async cleanupOrphanedCores(coreEntry, userKey) {
    if (process.platform !== 'linux') return
    if (!existsSync('/proc')) return

    const normalizedCoreEntry = path.resolve(coreEntry)
    const procEntries = readdirSync('/proc', { withFileTypes: true })

    for (const entry of procEntries) {
      if (!entry.isDirectory()) continue
      if (!/^\d+$/.test(entry.name)) continue

      const pid = Number.parseInt(entry.name, 10)
      if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue

      const cmdline = this.readProcCmdline(pid)
      if (!cmdline || !this.isCoreEntryMatch(cmdline, normalizedCoreEntry)) continue

      const candidateUserKey = this.readProcEnvVar(pid, 'USER_KEY')
      if (candidateUserKey && candidateUserKey !== userKey) continue

      const ppid = this.readProcParentPid(pid)
      if (!this.isOrphanProcess(ppid)) continue

      this.emitter.emit(
        'stderr',
        `[CoreHost] Cleaning orphaned core pid=${pid} ppid=${ppid ?? 'unknown'}`
      )
      this.terminatePid(pid, 'SIGTERM')

      let exited = await this.waitForPidExit(pid, STARTUP_ORPHAN_TERM_GRACE_MS)
      if (!exited) {
        this.terminatePid(pid, 'SIGKILL')
        exited = await this.waitForPidExit(pid, STARTUP_ORPHAN_KILL_GRACE_MS)
      }

      if (!exited) {
        this.emitter.emit('stderr', `[CoreHost] Failed to terminate orphaned core pid=${pid}`)
      }
    }
  }

  readProcCmdline(pid) {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`)
      if (!raw.length) return null
      const tokens = raw
        .toString('utf8')
        .split('\0')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
      return tokens.length > 0 ? tokens : null
    } catch {
      return null
    }
  }

  readProcEnvVar(pid, key) {
    try {
      const raw = readFileSync(`/proc/${pid}/environ`)
      if (!raw.length) return null
      const prefix = `${key}=`
      for (const entry of raw.toString('utf8').split('\0')) {
        if (!entry.startsWith(prefix)) continue
        const value = entry.slice(prefix.length)
        return value || null
      }
      return null
    } catch {
      return null
    }
  }

  readProcParentPid(pid) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      const match = status.match(/^PPid:\s+(\d+)$/m)
      if (!match) return null
      const parsed = Number.parseInt(match[1], 10)
      return Number.isFinite(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  isCoreEntryMatch(cmdline, coreEntry) {
    for (let index = 1; index < cmdline.length; index += 1) {
      const arg = cmdline[index]
      if (!arg || !path.isAbsolute(arg)) continue
      if (path.resolve(arg) === coreEntry) return true
    }
    return false
  }

  isOrphanProcess(ppid) {
    if (!ppid || ppid <= 1) return true
    return !this.isPidAlive(ppid)
  }

  isPidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  terminatePid(pid, signal) {
    try {
      process.kill(pid, signal)
    } catch (_) {}
  }

  async waitForPidExit(pid, timeoutMs) {
    const deadline = Date.now() + Math.max(250, Math.trunc(timeoutMs))
    while (Date.now() < deadline) {
      if (!this.isPidAlive(pid)) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return !this.isPidAlive(pid)
  }

  resolveCoreRequest(message) {
    if (!message || typeof message !== 'object') return false
    if (message.type !== 'worker-response') return false

    const requestId = typeof message.requestId === 'string' ? message.requestId : null
    if (!requestId) return false

    const pending = this.pendingRequests.get(requestId)
    if (!pending) return false

    this.pendingRequests.delete(requestId)
    clearTimeout(pending.timeoutId)

    pending.resolve({
      success: message.success !== false,
      data: message.data ?? null,
      error: message.error || null,
      requestId
    })
    return true
  }

  rejectPendingCoreRequests(reason = 'Core unavailable') {
    const entries = Array.from(this.pendingRequests.values())
    this.pendingRequests.clear()
    for (const pending of entries) {
      clearTimeout(pending.timeoutId)
      pending.resolve({ success: false, error: reason })
    }
  }
}

const WorkerHost = CoreHost

function findDefaultCoreRoot(cwd) {
  return resolveCorePackageRoot({ cwd })
}

const findDefaultWorkerRoot = findDefaultCoreRoot
const sendWorkerConfigToProcess = sendCoreConfigToProcess
const makeWorkerRequestId = makeCoreRequestId

module.exports = {
  CoreHost,
  WorkerHost,
  findDefaultCoreRoot,
  findDefaultWorkerRoot,
  resolveCoreEntry,
  resolveCorePackageRoot,
  sendCoreConfigToProcess,
  sendWorkerConfigToProcess,
  makeCoreRequestId,
  makeWorkerRequestId,
  validateCoreConfigPayload
}
