import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeClient } from './client'

const servers = new Set<Server>()
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
})

describe.skipIf(process.platform === 'win32')('RuntimeClient timeout policy', () => {
  it('extends the socket timeout for a waiting collaboration checkpoint', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-collaboration-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        setTimeout(() => {
          if (socket.destroyed) {
            return
          }
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result: { entries: [], timedOut: true, cancelled: false, connectionLost: false },
              _meta: { runtimeId: 'runtime-1' }
            })}\n`
          )
        }, 80)
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'token',
        startedAt: Date.now()
      }),
      'utf8'
    )

    const client = new RuntimeClient(userDataPath, 20)
    const response = await client.call<{ timedOut: boolean }>('collaboration.checkpoint', {
      wait: true,
      timeoutMs: 50
    })

    expect(response.result.timedOut).toBe(true)
  })

  it('uses collaboration wait default timeout plus grace when timeout-ms is omitted', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-collaboration-default-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        setTimeout(() => {
          if (socket.destroyed) {
            return
          }
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result: { entries: [], timedOut: true, cancelled: false, connectionLost: false },
              _meta: { runtimeId: 'runtime-1' }
            })}\n`
          )
        }, 80)
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'token',
        startedAt: Date.now()
      }),
      'utf8'
    )

    const client = new RuntimeClient(userDataPath, 20)
    const response = await client.call<{ timedOut: boolean }>('collaboration.checkpoint', {
      wait: true
    })

    expect(response.result.timedOut).toBe(true)
  })

  it('does not crash while resolving terminal.wait defaults without params', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: { satisfied: true },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'token',
        startedAt: Date.now()
      }),
      'utf8'
    )

    const client = new RuntimeClient(userDataPath, 100)
    const response = await client.call<{ satisfied: boolean }>('terminal.wait')

    expect(response.result).toEqual({ satisfied: true })
  })
})
