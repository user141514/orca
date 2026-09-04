import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { DetachedMissionRunService } from './detached-mission-run-service'

describe('DetachedMissionRunService', () => {
  it('starts only the ready DAG wave and advances after worker completion', async () => {
    const db = new OrchestrationDb(':memory:')
    const started: string[] = []
    const service = new DetachedMissionRunService({
      db,
      startWorker: async ({ taskId }) => {
        started.push(taskId)
        return { state: 'ready', dispatchId: createRootDispatch(db, taskId, `term_${taskId}`).id }
      }
    })
    const run = service.create({
      objective: 'DAG',
      worktreeId: 'wt_a',
      plannerSelection: { agent: 'codex' },
      workerSelection: { agent: 'codex' },
      tasks: [
        { key: 'a', spec: 'first', deps: [] },
        { key: 'b', spec: 'second', deps: ['a'] },
        { key: 'c', spec: 'parallel', deps: [] }
      ],
      maxConcurrency: 2,
      ownerFingerprint: 'owner',
      stopSecretHash: 'hash'
    })

    await service.supervise(run.id)
    expect(started).toHaveLength(2)
    expect(db.listTasks({ runId: run.id }).map((task) => task.status)).toEqual([
      'dispatched',
      'dispatched',
      'pending'
    ])

    const first = db.listTasks({ runId: run.id })[0]
    db.updateTaskStatus(first.id, 'completed')
    await service.supervise(run.id)
    expect(started).toHaveLength(3)
    expect(db.listTasks({ runId: run.id })[2]?.status).toBe('dispatched')
    db.close()
  })

  it('reruns supervision when a wakeup arrives during an active supervision pass', async () => {
    const db = new OrchestrationDb(':memory:')
    const started: string[] = []
    let releaseFirstStart!: () => void
    const firstStartBlocked = new Promise<void>((resolve) => {
      releaseFirstStart = resolve
    })
    const service = new DetachedMissionRunService({
      db,
      startWorker: async ({ taskId }) => {
        started.push(taskId)
        const dispatch = createRootDispatch(db, taskId, `term_${taskId}`)
        if (started.length === 1) {
          await firstStartBlocked
        }
        return { state: 'ready', dispatchId: dispatch.id }
      }
    })
    const run = service.create({
      objective: 'lost wakeup',
      worktreeId: 'wt_a',
      plannerSelection: { agent: 'codex' },
      workerSelection: { agent: 'codex' },
      tasks: [
        { key: 'a', spec: 'first', deps: [] },
        { key: 'b', spec: 'second', deps: ['a'] }
      ],
      maxConcurrency: 1,
      ownerFingerprint: 'owner',
      stopSecretHash: 'hash'
    })

    const firstPass = service.supervise(run.id)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    const firstTask = db.listTasks({ runId: run.id })[0]!
    db.updateTaskStatus(firstTask.id, 'completed')

    const wakeupDuringFirstPass = service.supervise(run.id)
    releaseFirstStart()
    await Promise.all([firstPass, wakeupDuringFirstPass])

    expect(started).toHaveLength(2)
    expect(db.listTasks({ runId: run.id })[1]?.status).toBe('dispatched')
    db.close()
  })

  it('restores collaboration configuration when a running mission is rehydrated', async () => {
    const db = new OrchestrationDb(':memory:')
    const firstConfigure = vi.fn()
    const firstService = new DetachedMissionRunService({
      db,
      configureCollaboration: firstConfigure,
      startWorker: async ({ taskId }) => ({
        state: 'ready', dispatchId: createRootDispatch(db, taskId, 'term_first').id
      })
    })
    const run = firstService.create({
      objective: 'restart collaboration',
      worktreeId: 'wt_a',
      plannerSelection: { agent: 'codex' },
      workerSelection: { agent: 'codex' },
      tasks: [
        {
          key: 'publisher',
          spec: 'publish',
          deps: [],
          publishesTo: ['/facts']
        }
      ],
      maxConcurrency: 1,
      ownerFingerprint: 'owner',
      stopSecretHash: 'hash'
    })
    await firstService.supervise(run.id)
    expect(firstConfigure).toHaveBeenCalledTimes(1)
    expect(db.readDetachedMissionRun(run.id)?.lifecycle).toBe('running')

    const restartedConfigure = vi.fn()
    const restartedService = new DetachedMissionRunService({
      db,
      configureCollaboration: restartedConfigure,
      startWorker: async () => {
        throw new Error('rehydration must not duplicate an active worker start')
      }
    })
    await restartedService.rehydrate()

    expect(restartedConfigure).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('stops a worker that becomes ready after the mission was stopped', async () => {
    const db = new OrchestrationDb(':memory:')
    let announceStart!: () => void
    const startEntered = new Promise<void>((resolve) => {
      announceStart = resolve
    })
    let releaseStart!: () => void
    const startBlocked = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const stopWorker = vi.fn().mockResolvedValue(undefined)
    const service = new DetachedMissionRunService({
      db,
      stopWorker,
      startWorker: async ({ taskId }) => {
        announceStart()
        await startBlocked
        return {
          state: 'ready',
          dispatchId: createRootDispatch(db, taskId, 'term_late').id
        }
      }
    })
    const run = service.create({
      objective: 'stop race',
      worktreeId: 'wt_a',
      plannerSelection: { agent: 'codex' },
      workerSelection: { agent: 'codex' },
      tasks: [{ key: 'a', spec: 'first', deps: [] }],
      maxConcurrency: 1,
      ownerFingerprint: 'owner',
      stopSecretHash: 'hash'
    })

    const supervision = service.supervise(run.id)
    await startEntered
    await service.stop(run.id)
    releaseStart()
    await supervision

    expect(db.readDetachedMissionRun(run.id)?.lifecycle).toBe('stopped')
    expect(stopWorker).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('does not launch a fallback candidate after stop fences the supervisor generation', async () => {
    const db = new OrchestrationDb(':memory:')
    const agents: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let announceFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      announceFirst = resolve
    })
    const service = new DetachedMissionRunService({
      db,
      startWorker: async ({ agent }) => {
        agents.push(agent)
        if (agent === 'pi') {
          announceFirst()
          await firstBlocked
          return {
            state: 'failed',
            dispatchId: 'ctx_pi',
            failedStage: 'agent_readiness',
            lastError: 'Pi unavailable'
          }
        }
        return {
          state: 'failed',
          dispatchId: 'ctx_codex',
          failedStage: 'agent_readiness',
          lastError: 'Codex unavailable'
        }
      }
    })
    const run = service.create({
      objective: 'generation fence',
      worktreeId: 'wt_a',
      plannerSelection: { agent: 'pi' },
      workerSelection: { agent: 'pi', agentCandidates: ['pi', 'codex'] },
      tasks: [{ key: 'a', spec: 'first', deps: [] }],
      maxConcurrency: 1,
      ownerFingerprint: 'owner',
      stopSecretHash: 'hash'
    })

    const supervision = service.supervise(run.id)
    await firstEntered
    const generationBeforeStop = db.readDetachedMissionRun(run.id)!.supervisor_generation
    await service.stop(run.id)
    const generationAfterStop = db.readDetachedMissionRun(run.id)!.supervisor_generation
    releaseFirst()
    await supervision.catch(() => undefined)

    expect(generationAfterStop).toBe(generationBeforeStop + 1)
    expect(agents).toEqual(['pi'])
    db.close()
  })

  it('records a terminal mission failure when worker startup exhausts safe candidates', async () => {
    const db = new OrchestrationDb(':memory:')
    const service = new DetachedMissionRunService({
      db,
      startWorker: async () => ({
        state: 'failed',
        dispatchId: 'ctx_failed',
        failedStage: 'agent_readiness',
        lastError: 'agent never became ready'
      })
    })
    const run = service.create({
      objective: 'startup failure',
      worktreeId: 'wt_a',
      plannerSelection: { agent: 'codex' },
      workerSelection: { agent: 'codex' },
      tasks: [{ key: 'a', spec: 'first', deps: [] }],
      maxConcurrency: 1,
      ownerFingerprint: 'owner',
      stopSecretHash: 'hash'
    })

    await expect(service.supervise(run.id)).rejects.toMatchObject({
      code: 'mission_worker_start_failed'
    })
    expect(db.readDetachedMissionRun(run.id)).toMatchObject({
      lifecycle: 'failed',
      terminal_outcome: 'failed',
      last_error: 'agent never became ready'
    })
    db.close()
  })

  it('does not lose an escalation that follows a question in the same delivery', async () => {
    const db = new OrchestrationDb(':memory:')
    const service = new DetachedMissionRunService({
      db,
      startWorker: async ({ taskId }) => ({
        state: 'ready',
        dispatchId: createRootDispatch(db, taskId, 'term_worker').id
      })
    })
    const run = service.create({
      objective: 'mixed delivery',
      worktreeId: 'wt_a',
      plannerSelection: { agent: 'codex' },
      workerSelection: { agent: 'codex' },
      tasks: [{ key: 'a', spec: 'first', deps: [] }],
      maxConcurrency: 1,
      ownerFingerprint: 'owner',
      stopSecretHash: 'hash'
    })
    await service.supervise(run.id)
    const task = db.listTasks({ runId: run.id })[0]!
    const dispatch = db.getDispatchContext(task.id)!
    db.createQuestion({
      runId: run.id,
      dispatchId: dispatch.id,
      askerHandle: 'worker',
      question: 'continue?'
    })
    db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: 'cannot continue',
      body: 'fatal escalation',
      type: 'escalation',
      runId: run.id
    })

    await service.supervise(run.id)

    expect(db.readDetachedMissionRun(run.id)).toMatchObject({
      lifecycle: 'failed',
      terminal_outcome: 'failed',
      last_error: 'fatal escalation'
    })
    db.close()
  })

  it('replays a delivery, fences stale consumers, and awaits an answer to a question', async () => {
    const db = new OrchestrationDb(':memory:')
    const service = new DetachedMissionRunService({
      db,
      startWorker: async ({ taskId }) => ({
        state: 'ready', dispatchId: createRootDispatch(db, taskId, 'term_worker').id
      })
    })
    const run = service.create({
      objective: 'mail', worktreeId: null, plannerSelection: {}, workerSelection: { agent: 'codex' },
      tasks: [{ key: 'a', spec: 'first', deps: [] }], maxConcurrency: 1,
      ownerFingerprint: 'owner', stopSecretHash: 'hash'
    })
    await service.supervise(run.id)
    const task = db.listTasks({ runId: run.id })[0]!
    const dispatch = db.getDispatchContext(task.id)!
    const question = db.createQuestion({ runId: run.id, dispatchId: dispatch.id, askerHandle: 'worker', question: 'continue?' })

    await service.supervise(run.id)
    expect(db.readDetachedMissionRun(run.id)?.lifecycle).toBe('awaiting_input')
    await service.answer(run.id, question.question.message_id, 'yes')
    expect(db.readDetachedMissionRun(run.id)?.lifecycle).toBe('running')
    db.close()
  })
})
