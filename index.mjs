import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const coreHost = require('./index.cjs')

export const CoreHost = coreHost.CoreHost
export const WorkerHost = coreHost.WorkerHost
export const findDefaultCoreRoot = coreHost.findDefaultCoreRoot
export const findDefaultWorkerRoot = coreHost.findDefaultWorkerRoot
export const resolveCoreEntry = coreHost.resolveCoreEntry
export const resolveCorePackageRoot = coreHost.resolveCorePackageRoot
export const sendCoreConfigToProcess = coreHost.sendCoreConfigToProcess
export const sendWorkerConfigToProcess = coreHost.sendWorkerConfigToProcess
export const makeCoreRequestId = coreHost.makeCoreRequestId
export const makeWorkerRequestId = coreHost.makeWorkerRequestId
export const validateCoreConfigPayload = coreHost.validateCoreConfigPayload

export default coreHost
