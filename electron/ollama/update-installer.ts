import { execFile, spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'

import type {
  OllamaUpdateInstallerStatus,
  OllamaUpdateLaunchResult
} from '../../shared/backend-contract'

export const OLLAMA_WINGET_PACKAGE_ID = 'Ollama.Ollama'
export const OLLAMA_APT_PACKAGE_NAME = 'ollama'

const WINGET_DISPLAY_COMMAND =
  'winget upgrade --id Ollama.Ollama --exact --source winget --force --accept-source-agreements --accept-package-agreements'
const APT_DISPLAY_COMMAND = 'sudo apt-get install --reinstall ollama'

type SupportedPlatform = 'win32' | 'linux'
export type LinuxTerminal =
  | 'x-terminal-emulator'
  | 'gnome-terminal'
  | 'konsole'
  | 'xterm'

interface ProbeResult {
  ok: boolean
  stdout: string
}

export interface UpdateInstallerDependencies {
  platform?: NodeJS.Platform
  probe?: (file: string, args: readonly string[]) => Promise<ProbeResult>
  fileExists?: (path: string) => boolean
  spawnProcess?: (
    file: string,
    args: readonly string[],
    options: {
      detached: true
      stdio: 'ignore'
      windowsHide: false
    }
  ) => Pick<ChildProcess, 'unref'>
}

interface LaunchCommand {
  file: string
  args: readonly string[]
}

const LINUX_TERMINALS: ReadonlyArray<{
  kind: LinuxTerminal
  path: string
}> = [
  { kind: 'x-terminal-emulator', path: '/usr/bin/x-terminal-emulator' },
  { kind: 'gnome-terminal', path: '/usr/bin/gnome-terminal' },
  { kind: 'konsole', path: '/usr/bin/konsole' },
  { kind: 'xterm', path: '/usr/bin/xterm' }
]

function defaultProbe(file: string, args: readonly string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
      },
      (error, stdout) => {
        resolve({
          ok: error == null,
          stdout: typeof stdout === 'string' ? stdout : ''
        })
      }
    )
  })
}

function unavailable(
  platform: OllamaUpdateInstallerStatus['platform'],
  reason: Exclude<
    OllamaUpdateInstallerStatus['reason'],
    'available' | 'launch-failed'
  >,
  manager: OllamaUpdateInstallerStatus['manager'] = null,
  command: string | null = null
): OllamaUpdateInstallerStatus {
  return { platform, manager, available: false, reason, command }
}

function normalizePlatform(platform: NodeJS.Platform): SupportedPlatform | null {
  if (platform === 'win32' || platform === 'linux') return platform
  return null
}

function findLinuxTerminal(
  fileExists: (path: string) => boolean
): (typeof LINUX_TERMINALS)[number] | null {
  return LINUX_TERMINALS.find((terminal) => fileExists(terminal.path)) ?? null
}

export function buildWindowsUpdateCommand(): LaunchCommand {
  return {
    file: `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\cmd.exe`,
    args: ['/d', '/k', WINGET_DISPLAY_COMMAND]
  }
}

export function buildLinuxUpdateCommand(
  terminal: LinuxTerminal
): LaunchCommand {
  const terminalPath = LINUX_TERMINALS.find((candidate) => candidate.kind === terminal)?.path
  if (!terminalPath) throw new Error('UNSUPPORTED_TERMINAL')
  const script = [
    `printf '%s\\n' '${APT_DISPLAY_COMMAND}'`,
    APT_DISPLAY_COMMAND,
    'status=$?',
    `printf '\\nCommand finished with exit code %s. Press Enter to close.\\n' "$status"`,
    'read -r _',
    'exit "$status"'
  ].join('; ')
  const shellArgs = ['/bin/bash', '-lc', script] as const

  if (terminal === 'gnome-terminal') {
    return { file: terminalPath, args: ['--', ...shellArgs] }
  }
  return { file: terminalPath, args: ['-e', ...shellArgs] }
}

export async function detectOllamaUpdateInstaller(
  dependencies: UpdateInstallerDependencies = {}
): Promise<OllamaUpdateInstallerStatus> {
  const platform = normalizePlatform(dependencies.platform ?? process.platform)
  if (!platform) return unavailable('unsupported', 'unsupported-platform')

  const probe = dependencies.probe ?? defaultProbe
  if (platform === 'win32') {
    const winget = await probe('winget.exe', ['--version'])
    if (!winget.ok) {
      return unavailable('win32', 'manager-not-found', 'winget')
    }
    const packageResult = await probe('winget.exe', [
      'show',
      '--id',
      OLLAMA_WINGET_PACKAGE_ID,
      '--exact',
      '--source',
      'winget',
      '--accept-source-agreements',
      '--disable-interactivity'
    ])
    if (!packageResult.ok) {
      return unavailable(
        'win32',
        'package-not-found',
        'winget',
        WINGET_DISPLAY_COMMAND
      )
    }
    return {
      platform: 'win32',
      manager: 'winget',
      available: true,
      reason: 'available',
      command: WINGET_DISPLAY_COMMAND
    }
  }

  const aptGet = await probe('/usr/bin/apt-get', ['--version'])
  const aptCache = await probe('/usr/bin/apt-cache', ['--version'])
  if (!aptGet.ok || !aptCache.ok || !(dependencies.fileExists ?? existsSync)('/usr/bin/sudo')) {
    return unavailable('linux', 'manager-not-found', 'apt')
  }
  const policy = await probe('/usr/bin/apt-cache', [
    'policy',
    OLLAMA_APT_PACKAGE_NAME
  ])
  const candidate = /^\s*Candidate:\s*(?!\(none\)\s*$)(\S+)/im.exec(policy.stdout)
  if (!policy.ok || !candidate) {
    return unavailable('linux', 'package-not-found', 'apt', APT_DISPLAY_COMMAND)
  }
  const terminal = findLinuxTerminal(dependencies.fileExists ?? existsSync)
  if (!terminal) {
    return unavailable('linux', 'terminal-not-found', 'apt', APT_DISPLAY_COMMAND)
  }
  return {
    platform: 'linux',
    manager: 'apt',
    available: true,
    reason: 'available',
    command: APT_DISPLAY_COMMAND
  }
}

export async function openOllamaUpdateTerminal(
  dependencies: UpdateInstallerDependencies = {}
): Promise<OllamaUpdateLaunchResult> {
  const status = await detectOllamaUpdateInstaller(dependencies)
  if (!status.available) {
    return { ok: false, reason: status.reason }
  }

  let command: LaunchCommand
  if (status.platform === 'win32') {
    command = buildWindowsUpdateCommand()
  } else {
    const terminal = findLinuxTerminal(dependencies.fileExists ?? existsSync)
    if (!terminal) return { ok: false, reason: 'terminal-not-found' }
    command = buildLinuxUpdateCommand(terminal.kind)
  }

  try {
    const child = (dependencies.spawnProcess ?? spawn)(command.file, [...command.args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.unref()
    return { ok: true }
  } catch {
    return { ok: false, reason: 'launch-failed' }
  }
}
