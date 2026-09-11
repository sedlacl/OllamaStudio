import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fakeUpdater } = vi.hoisted(() => {
  class FakeUpdater {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    autoDownload = true
    autoInstallOnAppQuit = false
    checkForUpdates = vi.fn(async () => null)
    downloadUpdate = vi.fn(async () => [])
    quitAndInstall = vi.fn()

    on(event: string, listener: (...args: never[]) => void): this {
      const current = this.listeners.get(event) ?? []
      current.push(listener as (...args: unknown[]) => void)
      this.listeners.set(event, current)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }

    removeAllListeners(): void {
      this.listeners.clear()
    }
  }
  return { fakeUpdater: new FakeUpdater() }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.9.0'
  }
}))
vi.mock('electron-updater', () => ({ autoUpdater: fakeUpdater }))

import { StudioAppUpdater } from './app-updater'

describe('StudioAppUpdater', () => {
  beforeEach(() => {
    fakeUpdater.removeAllListeners()
    fakeUpdater.checkForUpdates.mockClear()
    fakeUpdater.downloadUpdate.mockClear()
    fakeUpdater.quitAndInstall.mockClear()
    process.env.APPIMAGE = '/tmp/OllamaStudio.AppImage'
  })

  it('nabídne novější GitHub release bez automatického stahování', async () => {
    fakeUpdater.checkForUpdates.mockImplementationOnce(async () => {
      fakeUpdater.emit('update-available', {
        version: '1.10.0',
        releaseName: 'OllamaStudio 1.10.0'
      })
      return null
    })
    const manager = new StudioAppUpdater(fakeUpdater as never)

    await expect(manager.check()).resolves.toMatchObject({
      status: 'available',
      currentVersion: '1.9.0',
      latestVersion: '1.10.0',
      releaseUrl:
        'https://github.com/sedlacl/OllamaStudio/releases/tag/v1.10.0'
    })
    expect(fakeUpdater.autoDownload).toBe(false)
  })

  it('po stažení čeká na explicitní restart', async () => {
    const manager = new StudioAppUpdater(fakeUpdater as never)
    manager.getState()
    fakeUpdater.emit('update-available', { version: '1.10.0' })
    fakeUpdater.downloadUpdate.mockImplementationOnce(async () => {
      fakeUpdater.emit('download-progress', { percent: 42.4 })
      fakeUpdater.emit('update-downloaded', { version: '1.10.0' })
      return []
    })

    await expect(manager.install()).resolves.toMatchObject({
      status: 'ready',
      progressPercent: 100
    })
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled()

    expect(manager.restartAndInstall().status).toBe('installing')
    await new Promise((resolve) => setImmediate(resolve))
    expect(fakeUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('vrátí bezpečně chybu kontroly', async () => {
    fakeUpdater.checkForUpdates.mockRejectedValueOnce(
      new Error('network unavailable')
    )
    const manager = new StudioAppUpdater(fakeUpdater as never)

    await expect(manager.check()).resolves.toMatchObject({
      status: 'error',
      error: 'network unavailable'
    })
  })
})
