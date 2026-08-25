import { describe, expect, it, vi } from 'vitest'
import {
  noteCollaborationPublication,
  registerCollaborationPublicationObligations
} from '../collaboration-runtime/collaboration-publication-obligations'
import { OrcaRuntimeService } from '../orca-runtime'
import { syncFederatedDispatch } from './federation-sync'

type ImportedLifecycle =
  | { kind: 'worker_report'; outcome: 'succeeded' | 'failed' }
  | { kind: 'rejected'; code: string; reason: string }
  | { kind: 'none' | 'heartbeat' }

function setupFederatedCompletionHarness() {
  const runtime = new OrcaRuntimeService()
  const federated = {
    environment_id: 'environment_remote',
    environment_name: 'remote',
    peer_fingerprint: 'remote_peer',
    remote_runtime_epoch: 'remote_epoch_1',
    protocol_version: 3,
    to_home_imported_sequence: 0,
    to_home_acknowledged_sequence: 0
  }
  let importedLifecycle: ImportedLifecycle | undefined
  runtime.setOrchestrationDb({
    getFederatedDispatch: () => federated,
    getDispatchContextById: () => ({ run_id: 'run_home', task_id: 'task_home' }),
    importFederatedRelayItem: (input: {
      sequence: number
      message: { to: string; type: string }
      lifecycle: ImportedLifecycle
    }) => {
      importedLifecycle = input.lifecycle
      federated.to_home_imported_sequence = input.sequence
      return {
        message: { to_handle: input.message.to, type: input.message.type, read: 0 },
        duplicate: false,
        ...(input.lifecycle.kind === 'rejected'
          ? {
              lifecycle: {
                action: 'rejected',
                code: input.lifecycle.code,
                reason: input.lifecycle.reason
              }
            }
          : input.lifecycle.kind === 'worker_report'
            ? { lifecycle: { action: 'settled', outcome: input.lifecycle.outcome } }
            : {})
      }
    },
    recordFederatedHomeAcknowledgment: ({ sequence }: { sequence: number }) => {
      federated.to_home_acknowledged_sequence = sequence
    },
    getWorkerDispatch: () => ({ state: 'ready' }),
    listPendingFederationRelay: () => [],
    acknowledgeFederationRelay: () => {}
  } as never)
  registerCollaborationPublicationObligations(
    runtime,
    'run_home',
    {
      objective: 'federated required publish',
      maxConcurrency: 1,
      steps: [
        {
          key: 'producer',
          instruction: 'publish',
          publishesTo: ['/required'],
          requiredPublishesTo: ['/required']
        }
      ]
    },
    { producer: 'task_home' }
  )
  vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
    peerFingerprint: federated.peer_fingerprint
  } as never)
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
    async (_environmentId, method, params) => {
      if (method === 'orchestration.federationPull') {
        return {
          runtimeEpoch: 'remote_epoch_1',
          items: [
            {
              dispatch_id: 'dispatch_remote',
              direction: 'to_home',
              sequence: 1,
              message_id: 'message_done',
              kind: 'worker_done',
              payload: JSON.stringify({
                subject: 'Done',
                body: 'Finished',
                type: 'worker_done',
                payload: JSON.stringify({
                  taskId: 'task_home',
                  dispatchId: 'dispatch_remote',
                  outcome: 'succeeded'
                })
              })
            }
          ]
        }
      }
      if (method === 'orchestration.federationAck') {
        return { acknowledgedThrough: (params as { throughSequence: number }).throughSequence }
      }
      throw new Error(`Unexpected method ${method}`)
    }
  )
  return { runtime, getImportedLifecycle: () => importedLifecycle }
}

describe('federated collaboration completion guard', () => {
  it('rejects succeeded worker_done before importing a report with missing required publishes', async () => {
    const harness = setupFederatedCompletionHarness()

    await syncFederatedDispatch(harness.runtime, 'dispatch_remote')

    expect(harness.getImportedLifecycle()).toMatchObject({
      kind: 'rejected',
      code: 'collaboration_publish_incomplete'
    })
  })

  it('imports succeeded worker_done after the required publication is satisfied', async () => {
    const harness = setupFederatedCompletionHarness()
    noteCollaborationPublication(harness.runtime, 'run_home', 'task_home', '/required')

    await syncFederatedDispatch(harness.runtime, 'dispatch_remote')

    expect(harness.getImportedLifecycle()).toMatchObject({
      kind: 'worker_report',
      outcome: 'succeeded'
    })
  })
})
