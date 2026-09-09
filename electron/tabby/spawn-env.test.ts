import { describe, expect, it } from 'vitest'
import { buildTabbySpawnEnv, tabbySpawnArgs } from './spawn-env'

describe('tabby spawn env', () => {
  it('forces unbuffered UTF-8 Python and drops Electron/Node flags', () => {
    const env = buildTabbySpawnEnv({
      PATH: 'C:\\Windows',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--require leak',
      PYTHONUNBUFFERED: '0'
    })
    expect(env.PYTHONUNBUFFERED).toBe('1')
    expect(env.PYTHONUTF8).toBe('1')
    expect(env.PYTHONIOENCODING).toBe('utf-8')
    expect(env.PATH).toBe('C:\\Windows')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  it('passes -u before main.py', () => {
    expect(tabbySpawnArgs('D:\\AI\\Tabby\\main.py')).toEqual(['-u', 'D:\\AI\\Tabby\\main.py'])
  })
})
