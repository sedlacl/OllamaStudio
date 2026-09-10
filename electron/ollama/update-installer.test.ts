import { describe, expect, it, vi } from 'vitest'

import {
  buildLinuxUpdateCommand,
  buildWindowsUpdateCommand,
  detectOllamaUpdateInstaller,
  OLLAMA_WINGET_PACKAGE_ID,
  openOllamaUpdateTerminal
} from './update-installer'

describe('Ollama update installer', () => {
  it('staví pevný WinGet příkaz pro ověřený package ID', () => {
    const command = buildWindowsUpdateCommand()

    expect(command.args).toEqual([
      '/d',
      '/k',
      'winget upgrade --id Ollama.Ollama --exact --source winget --force --accept-source-agreements --accept-package-agreements'
    ])
    expect(OLLAMA_WINGET_PACKAGE_ID).toBe('Ollama.Ollama')
  })

  it('staví APT příkaz pouze pro allowlistovaný terminál', () => {
    const command = buildLinuxUpdateCommand('gnome-terminal')

    expect(command.file).toBe('/usr/bin/gnome-terminal')
    expect(command.args.slice(0, 3)).toEqual(['--', '/bin/bash', '-lc'])
    expect(command.args.join(' ')).toContain('sudo apt-get install --reinstall ollama')
    expect(() =>
      buildLinuxUpdateCommand('renderer-value' as 'gnome-terminal')
    ).toThrow('UNSUPPORTED_TERMINAL')
  })

  it('nabídne WinGet jen pokud existuje klient i přesný balíček', async () => {
    const probe = vi.fn(async (_file: string, args: readonly string[]) => ({
      ok: args[0] === '--version' || args.includes('Ollama.Ollama'),
      stdout: ''
    }))

    await expect(
      detectOllamaUpdateInstaller({ platform: 'win32', probe })
    ).resolves.toMatchObject({
      available: true,
      manager: 'winget',
      platform: 'win32'
    })
    expect(probe).toHaveBeenNthCalledWith(2, 'winget.exe', [
      'show',
      '--id',
      'Ollama.Ollama',
      '--exact',
      '--source',
      'winget',
      '--accept-source-agreements',
      '--disable-interactivity'
    ])
  })

  it('na Linuxu nenabídne APT bez kandidáta balíčku ollama', async () => {
    const probe = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === '/usr/bin/apt-cache' && args[0] === 'policy') {
        return {
          ok: true,
          stdout: 'ollama:\n  Installed: (none)\n  Candidate: (none)\n'
        }
      }
      return { ok: true, stdout: '' }
    })

    await expect(
      detectOllamaUpdateInstaller({
        platform: 'linux',
        probe,
        fileExists: () => true
      })
    ).resolves.toEqual({
      platform: 'linux',
      manager: 'apt',
      available: false,
      reason: 'package-not-found',
      command: 'sudo apt-get install --reinstall ollama'
    })
  })

  it('na Linuxu vyžaduje kandidáta, sudo a podporovaný terminál', async () => {
    const probe = vi.fn(async (file: string, args: readonly string[]) => ({
      ok: true,
      stdout:
        file === '/usr/bin/apt-cache' && args[0] === 'policy'
          ? 'ollama:\n  Installed: 1.0\n  Candidate: 1.1\n'
          : ''
    }))
    const fileExists = (path: string): boolean =>
      path === '/usr/bin/sudo' || path === '/usr/bin/xterm'

    await expect(
      detectOllamaUpdateInstaller({
        platform: 'linux',
        probe,
        fileExists
      })
    ).resolves.toMatchObject({
      available: true,
      manager: 'apt',
      platform: 'linux'
    })
  })

  it('spustí pouze interně sestavený příkaz bez argumentů z rendereru', async () => {
    const probe = vi.fn(async (_file: string, args: readonly string[]) => ({
      ok: args[0] === '--version' || args.includes('Ollama.Ollama'),
      stdout: ''
    }))
    const unref = vi.fn()
    const spawnProcess = vi.fn(() => ({ unref }))

    await expect(
      openOllamaUpdateTerminal({
        platform: 'win32',
        probe,
        spawnProcess
      })
    ).resolves.toEqual({ ok: true })
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]System32[\\/]cmd\.exe$/),
      [
        '/d',
        '/k',
        'winget upgrade --id Ollama.Ollama --exact --source winget --force --accept-source-agreements --accept-package-agreements'
      ],
      { detached: true, stdio: 'ignore', windowsHide: false }
    )
    expect(unref).toHaveBeenCalled()
  })
})
