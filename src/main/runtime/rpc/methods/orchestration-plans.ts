import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  OrchestrationControlPlane,
  type OrchestrationPlan
} from '../../orchestration/orchestration-control-plane'
import { OrchestrationExecutorRouter } from '../../orchestration/orchestration-executor-router'
import { RuntimeOrchestrationRunner } from '../../orchestration/orchestration-runtime-runner'
import { defineMethod, type RpcMethod, type RpcContext } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { LocalWorkerExecutor } from './orchestration-local-worker-executor'

const ExecutionDescriptorParams = z.object({
  backend: requiredString('Missing execution backend'),
  config: z.unknown().optional()
})

const PlanTaskParams = z.object({
  key: requiredString('Missing task key'),
  spec: requiredString('Missing task spec'),
  taskTitle: OptionalString,
  displayName: OptionalString,
  deps: z.array(z.string().min(1)).optional(),
  execution: ExecutionDescriptorParams.optional()
})

const PlanCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  maxConcurrency: z.number().int().min(1),
  tasks: z.array(PlanTaskParams)
})

const PlanRunParams = z.object({
  run: requiredString('Missing --run'),
  waitTimeoutMs: z.number().int().min(1).optional()
})

function coordinationConsumerId(kind: string, ctx: RpcContext): string {
  return `${kind}:${ctx.orchestrationMutation?.requestId ?? randomUUID()}`
}

export const ORCHESTRATION_PLAN_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.planCreate',
    params: PlanCreateParams,
    handler: (params, ctx) => {
      const control = new OrchestrationControlPlane(
        ctx.runtime.getOrchestrationDb(),
        coordinationConsumerId('plan-create', ctx)
      )
      return control.startPlan(params as OrchestrationPlan)
    }
  }),
  defineMethod({
    name: 'orchestration.planRun',
    params: PlanRunParams,
    handler: async (params, ctx) => {
      const db = ctx.runtime.getOrchestrationDb()
      const executor = new OrchestrationExecutorRouter(db, {
        'local-worker': new LocalWorkerExecutor(ctx.runtime)
      })
      const runner = new RuntimeOrchestrationRunner(
        ctx.runtime,
        coordinationConsumerId('plan-run', ctx),
        executor,
        { waitTimeoutMs: params.waitTimeoutMs, signal: ctx.signal }
      )
      return runner.runExisting(params.run)
    }
  })
]
