import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'

let server: AgentHookServer | undefined

afterEach(async () => {
  await server?.stop()
  server = undefined
})

function endpoint(server: AgentHookServer, path: string) {
  const env = server.buildPtyEnv()
  return {
    url: `http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}${path}`,
    token: env.ORCA_AGENT_HOOK_TOKEN
  }
}

async function postJson(url: string, token: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': token
    },
    body: JSON.stringify(body)
  })
}

describe('AgentHookServer collaboration tool checkpoint endpoint', () => {
  it('returns prepared collaboration context through the authenticated hook channel', async () => {
    server = new AgentHookServer()
    const prepare = vi.fn(async () => ({
      active: true,
      entries: [{ deliveryId: 'delivery-1', deliveryAttempt: 1, message: { body: 'finding' } }]
    }))
    server.setCollaborationToolCheckpointHandler({
      prepare,
      acknowledge: vi.fn()
    })
    await server.start({
      env: 'development',
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-hook-tool-checkpoint-'))
    })
    const target = endpoint(server, '/collaboration/tool-checkpoint/prepare')

    const response = await postJson(target.url, target.token, {
      paneKey: 'tab_a:leaf_a',
      launchToken: 'launch-a'
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      active: true,
      entries: [{ deliveryId: 'delivery-1', deliveryAttempt: 1 }]
    })
    expect(prepare).toHaveBeenCalledWith({ paneKey: 'tab_a:leaf_a', launchToken: 'launch-a' })
  })

  it('forwards explicit acknowledgement epochs through the same authenticated channel', async () => {
    server = new AgentHookServer()
    const acknowledge = vi.fn(async () => ({
      active: true,
      ackedDeliveryIds: ['delivery-1'],
      ignoredDeliveryIds: []
    }))
    server.setCollaborationToolCheckpointHandler({ prepare: vi.fn(), acknowledge })
    await server.start({
      env: 'development',
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-hook-tool-ack-'))
    })
    const target = endpoint(server, '/collaboration/tool-checkpoint/ack')

    const response = await postJson(target.url, target.token, {
      paneKey: 'tab_a:leaf_a',
      launchToken: 'launch-a',
      acknowledgements: [{ deliveryId: 'delivery-1', deliveryAttempt: 1 }]
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      active: true,
      ackedDeliveryIds: ['delivery-1'],
      ignoredDeliveryIds: []
    })
    expect(acknowledge).toHaveBeenCalledWith({
      paneKey: 'tab_a:leaf_a',
      launchToken: 'launch-a',
      acknowledgements: [{ deliveryId: 'delivery-1', deliveryAttempt: 1 }]
    })
  })

  it('rejects invalid bearer tokens before invoking collaboration handlers', async () => {
    server = new AgentHookServer()
    const prepare = vi.fn()
    server.setCollaborationToolCheckpointHandler({ prepare, acknowledge: vi.fn() })
    await server.start({
      env: 'development',
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-hook-tool-auth-'))
    })
    const target = endpoint(server, '/collaboration/tool-checkpoint/prepare')

    const response = await postJson(target.url, 'wrong-token', {
      paneKey: 'tab_a:leaf_a',
      launchToken: 'launch-a'
    })

    expect(response.status).toBe(403)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('rejects malformed checkpoint bodies without entering the collaboration handler', async () => {
    server = new AgentHookServer()
    const prepare = vi.fn()
    server.setCollaborationToolCheckpointHandler({ prepare, acknowledge: vi.fn() })
    await server.start({
      env: 'development',
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-hook-tool-invalid-'))
    })
    const target = endpoint(server, '/collaboration/tool-checkpoint/prepare')

    const response = await postJson(target.url, target.token, { paneKey: 'tab_a:leaf_a' })

    expect(response.status).toBe(400)
    expect(prepare).not.toHaveBeenCalled()
  })
})
