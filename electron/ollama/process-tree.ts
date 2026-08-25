import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Windows: `ollama serve` spawne llama-server jako potomka, ale při násilném
 * ukončení Electronu (Stop debug / TerminateProcess) se Job Chromia neuzavře
 * tak, aby runner zemřel — llama-server zůstane sirotek.
 *
 * Řešení: vlastní Job Object s KILL_ON_JOB_CLOSE, držený helper procesem
 * napojeným na stdin. Když Electron zemře, pipe se zavře, helper skončí,
 * OS zabije celý job (serve + llama-server).
 */
const JOB_HOLDER_PS = `
$ErrorActionPreference = 'Stop'
$servePid = [int]$env:OLLAMASTUDIO_SERVE_PID
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;

namespace OllamaStudio {
  public static class JobHolder {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(
      IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    const uint PROCESS_SET_QUOTA = 0x0100;
    const uint PROCESS_TERMINATE = 0x0001;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    public static int Run(int pid) {
      IntPtr job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) return 1;

      var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr ptr = Marshal.AllocHGlobal(length);
      Marshal.StructureToPtr(info, ptr, false);
      bool ok = SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)length);
      Marshal.FreeHGlobal(ptr);
      if (!ok) return 2;

      IntPtr proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
      if (proc == IntPtr.Zero) return 3;
      ok = AssignProcessToJobObject(job, proc);
      CloseHandle(proc);
      if (!ok) return 4;

      using (var stdin = Console.OpenStandardInput()) {
        var buf = new byte[16];
        while (stdin.Read(buf, 0, buf.Length) > 0) { }
      }
      return 0;
    }
  }
}
"@
$code = [OllamaStudio.JobHolder]::Run($servePid)
if ($code -ne 0) {
  [Console]::Error.WriteLine("job-holder exit $code")
  exit $code
}
`.trim()

export interface ServeProcessTree {
  dispose: () => void
}

let trackedServePid: number | null = null
let exitHookRegistered = false

function registerExitHook(): void {
  if (exitHookRegistered) return
  exitHookRegistered = true
  process.on('exit', () => {
    const pid = trackedServePid
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 4000,
          stdio: 'ignore'
        })
      } else {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* best effort — debugger TerminateProcess hook stejně nespustí */
    }
  })
}

function startWindowsJobHolder(pid: number): { holder: ChildProcess; scriptPath: string } {
  const scriptPath = join(tmpdir(), `ollamastudio-job-${pid}.ps1`)
  writeFileSync(scriptPath, JOB_HOLDER_PS, 'utf8')
  const holder = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      env: { ...process.env, OLLAMASTUDIO_SERVE_PID: String(pid) },
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
      detached: false
    }
  )
  return { holder, scriptPath }
}

function whichSync(cmd: string): string | null {
  const paths = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  const ext = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of paths) {
    for (const e of ext) {
      const candidate = join(dir, `${cmd}${e}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Spustí `ollama serve` v process-tree rodiče (Electron).
 * Linux: pokud je k dispozici setpriv, nastaví PDEATHSIG=TERM (smrt rodiče → SIGTERM).
 */
export function spawnOllamaServe(
  binary: string,
  env: NodeJS.ProcessEnv
): ChildProcess {
  const common: SpawnOptions = {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false
  }

  if (process.platform === 'linux') {
    const setpriv = whichSync('setpriv')
    if (setpriv) {
      return spawn(setpriv, ['--pdeathsig', 'TERM', '--', binary, 'serve'], common)
    }
  }

  return spawn(binary, ['serve'], common)
}

/** Naváže serve PID na job / exit hook. Volat hned po spawn (má-li PID). */
export function attachServeProcessTree(pid: number): ServeProcessTree {
  registerExitHook()
  trackedServePid = pid

  if (process.platform !== 'win32') {
    return {
      dispose: () => {
        if (trackedServePid === pid) trackedServePid = null
      }
    }
  }

  const { holder, scriptPath } = startWindowsJobHolder(pid)
  const cleanupScript = (): void => {
    try {
      unlinkSync(scriptPath)
    } catch {
      /* already removed */
    }
  }
  holder.stderr?.on('data', (chunk: Buffer) => {
    const msg = chunk.toString('utf-8').trim()
    if (msg) console.warn('[process-tree]', msg)
  })
  holder.on('exit', (code) => {
    cleanupScript()
    if (code && code !== 0) {
      console.warn('[process-tree] Windows job holder exited with code', code)
    }
  })

  return {
    dispose: () => {
      if (trackedServePid === pid) trackedServePid = null
      try {
        holder.stdin?.end()
      } catch {
        /* already closed */
      }
      try {
        if (!holder.killed) holder.kill()
      } catch {
        /* already gone */
      }
      cleanupScript()
    }
  }
}
