export type WorkerCommand = {
  type: string
  requestId?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

export type WorkerEvent = {
  type: string
  requestId?: string
  success?: boolean
  error?: string | null
  data?: unknown
  [key: string]: unknown
}

export type WorkerConfig = {
  nostr_pubkey_hex: string
  nostr_nsec_hex: string
  nostr_npub?: string
  userKey: string
}

export type CoreStartConfig = {
  coreRoot?: string
  workerRoot?: string
  coreEntry?: string
  workerEntry?: string
  storageDir: string
  config: WorkerConfig
  env?: Record<string, string | undefined>
  cwd?: string
}

export type StartResult = {
  success: boolean
  alreadyRunning?: boolean
  configSent: boolean
  error?: string
  coreRoot?: string
  coreEntry?: string
}

export type WorkerRequestResult<T = unknown> = {
  success: boolean
  data?: T | null
  error?: string | null
  requestId?: string
}

export type Unsubscribe = () => void

export declare class CoreHost {
  start(config: CoreStartConfig): Promise<StartResult>
  stop(): Promise<void>
  send(message: WorkerCommand): Promise<{ success: boolean; error?: string }>
  request<T>(message: WorkerCommand, timeoutMs?: number): Promise<T>
  onMessage(listener: (event: WorkerEvent) => void): Unsubscribe
  onExit(listener: (code: number) => void): Unsubscribe
  onStdout(listener: (line: string) => void): Unsubscribe
  onStderr(listener: (line: string) => void): Unsubscribe
  isRunning(): boolean
}

export declare const WorkerHost: typeof CoreHost
export declare function findDefaultCoreRoot(cwd: string): string
export declare function findDefaultWorkerRoot(cwd: string): string
export declare function resolveCorePackageRoot(options?: { cwd?: string }): string
export declare function resolveCoreEntry(options?: {
  cwd?: string
  coreRoot?: string
  coreEntry?: string
}): string
export declare function sendCoreConfigToProcess(
  proc: { send?: (message: unknown) => void; killed?: boolean; connected?: boolean },
  payload: WorkerConfig
): { success: boolean; error?: string }
export declare const sendWorkerConfigToProcess: typeof sendCoreConfigToProcess
export declare function makeCoreRequestId(prefix?: string): string
export declare const makeWorkerRequestId: typeof makeCoreRequestId
export declare function validateCoreConfigPayload(payload: WorkerConfig): string | null
