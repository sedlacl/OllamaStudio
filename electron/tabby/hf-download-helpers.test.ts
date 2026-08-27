import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import {
  calculateDownloadProgress,
  classifyFolderCompleteness,
  completeDownloadProgress,
  deriveFolderName,
  describeExistingFolder,
  hfApiRepoPath,
  hfErrorCodeFromStatus,
  isPathStrictlyInside,
  nextAvailableFolderName,
  normalizeRepoId,
  parseHfRefsResponse,
  parseHfTreeSize,
  parseTabbyFolderExistsError,
  redactSecrets,
  resolveDownloadFolderName,
  resolveSafeModelSubdir,
  sanitizeFolderName,
  sumHfSiblingSizes,
  sumHfTreeSizes
} from './hf-download-helpers'

describe('deriveFolderName', () => {
  it('uses repo basename when revision is empty', () => {
    expect(deriveFolderName('org/my-model', '')).toBe('my-model')
    expect(deriveFolderName('org/my-model')).toBe('my-model')
    expect(deriveFolderName('gpt2', '  ')).toBe('gpt2')
  })

  it('uses repo basename for main (any case)', () => {
    expect(deriveFolderName('org/my-model', 'main')).toBe('my-model')
    expect(deriveFolderName('org/my-model', 'MAIN')).toBe('my-model')
    expect(deriveFolderName('org/my-model', ' Main ')).toBe('my-model')
  })

  it('appends non-main revision to avoid collisions', () => {
    expect(deriveFolderName('org/my-model', '4.0bpw')).toBe('my-model-4.0bpw')
    expect(deriveFolderName('org/my-model', 'v1')).toBe('my-model-v1')
  })

  it('normalizes Hugging Face URLs', () => {
    expect(deriveFolderName('https://huggingface.co/org/my-model', 'main')).toBe(
      'my-model'
    )
    expect(deriveFolderName('https://huggingface.co/org/my-model', 'exl3')).toBe(
      'my-model-exl3'
    )
  })

  it('sanitizes Windows-illegal characters', () => {
    expect(deriveFolderName('org/my:model', 'a/b')).toBe('my-model-a-b')
  })
})

describe('resolveDownloadFolderName', () => {
  it('prefers a user override and still sanitizes it', () => {
    expect(resolveDownloadFolderName('org/my-model', 'v2', 'Custom Name')).toBe(
      'Custom Name'
    )
    expect(resolveDownloadFolderName('org/my-model', 'v2', 'foo/bar')).toBe('foo-bar')
  })

  it('falls back to derivation when override is empty', () => {
    expect(resolveDownloadFolderName('org/my-model', 'v2', '  ')).toBe('my-model-v2')
  })
})

describe('sanitizeFolderName', () => {
  it('blocks path traversal', () => {
    expect(sanitizeFolderName('..\\secret')).toBe('secret')
    expect(sanitizeFolderName('../x')).toBe('x')
  })
})

describe('normalizeRepoId / hfApiRepoPath', () => {
  it('encodes each path segment', () => {
    expect(normalizeRepoId('https://huggingface.co/org/my model/')).toBe('org/my model')
    expect(hfApiRepoPath('org/my model')).toBe('org/my%20model')
  })
})

describe('parseHfRefsResponse', () => {
  it('reads branches then tags and skips converts', () => {
    const parsed = parseHfRefsResponse({
      branches: [
        { name: 'main', ref: 'refs/heads/main', targetCommit: 'aaa' },
        { name: 'exl3', ref: 'refs/heads/exl3', targetCommit: 'bbb' }
      ],
      tags: [{ name: 'v1.0', ref: 'refs/tags/v1.0', targetCommit: 'ccc' }],
      converts: [{ name: 'convert-x', ref: 'refs/convert/x', targetCommit: 'ddd' }]
    })
    expect(parsed).toEqual([
      { name: 'main', type: 'branch' },
      { name: 'exl3', type: 'branch' },
      { name: 'v1.0', type: 'tag' }
    ])
  })

  it('accepts the live Hub shape and string names', () => {
    expect(
      parseHfRefsResponse({
        tags: [],
        branches: [
          {
            name: 'main',
            ref: 'refs/heads/main',
            targetCommit: '607a30d783dfa663caf39e06633721c8d4cfcd7e'
          }
        ],
        converts: []
      })
    ).toEqual([{ name: 'main', type: 'branch' }])

    expect(parseHfRefsResponse({ branches: ['dev'], tags: ['v2'] })).toEqual([
      { name: 'dev', type: 'branch' },
      { name: 'v2', type: 'tag' }
    ])
  })

  it('dedupes names and ignores malformed payloads', () => {
    expect(
      parseHfRefsResponse({
        branches: [{ name: 'main' }, { name: 'main' }, { name: '  ' }, {}],
        tags: [{ name: 'main' }]
      })
    ).toEqual([{ name: 'main', type: 'branch' }])
    expect(parseHfRefsResponse(null)).toEqual([])
    expect(parseHfRefsResponse('nope')).toEqual([])
  })
})

describe('size parsers', () => {
  it('reads treesize { path, size }', () => {
    expect(parseHfTreeSize({ path: '/', size: 5632417295 })).toBe(5632417295)
    expect(parseHfTreeSize({ size: 0 })).toBeNull()
    expect(parseHfTreeSize(12)).toBe(12)
  })

  it('sums siblings using lfs.size when present', () => {
    expect(
      sumHfSiblingSizes({
        siblings: [
          { rfilename: '.gitattributes', size: 445 },
          {
            rfilename: 'model.safetensors',
            size: 100,
            lfs: { size: 2048, pointerSize: 134 }
          }
        ]
      })
    ).toBe(445 + 2048)
    expect(sumHfSiblingSizes({ siblings: [] })).toBeNull()
  })

  it('sums tree files and skips directories', () => {
    expect(
      sumHfTreeSizes([
        { type: 'directory', oid: 'x', size: 0, path: 'onnx' },
        { type: 'file', oid: 'y', size: 445, path: '.gitattributes' },
        { type: 'file', oid: 'z', size: 50, lfs: { size: 999 }, path: 'w.tflite' }
      ])
    ).toBe(445 + 999)
  })
})

describe('calculateDownloadProgress', () => {
  it('returns indeterminate percent when total is unknown', () => {
    expect(
      calculateDownloadProgress({
        bytesOnDisk: 100,
        bytesTotal: null,
        baseline: 0,
        previousMaxBytes: 0,
        previousPercent: null
      })
    ).toEqual({ percent: null, bytesDownloaded: 100, bytesTotal: null })
    expect(
      calculateDownloadProgress({
        bytesOnDisk: 100,
        bytesTotal: 0,
        baseline: 0,
        previousMaxBytes: 0,
        previousPercent: null
      }).percent
    ).toBeNull()
  })

  it('counts existing files as baseline so the bar starts honestly', () => {
    const first = calculateDownloadProgress({
      bytesOnDisk: 5_000,
      bytesTotal: 20_000,
      baseline: 5_000,
      previousMaxBytes: 0,
      previousPercent: null
    })
    expect(first.percent).toBe(25)
    expect(first.bytesDownloaded).toBe(5_000)
  })

  it('never decreases bytes or percent when the folder shrinks', () => {
    const afterDip = calculateDownloadProgress({
      bytesOnDisk: 1_000,
      bytesTotal: 20_000,
      baseline: 5_000,
      previousMaxBytes: 8_000,
      previousPercent: 40
    })
    expect(afterDip.bytesDownloaded).toBe(8_000)
    expect(afterDip.percent).toBe(40)
  })

  it('clamps running progress to 99', () => {
    expect(
      calculateDownloadProgress({
        bytesOnDisk: 20_000,
        bytesTotal: 20_000,
        baseline: 0,
        previousMaxBytes: 20_000,
        previousPercent: 99
      }).percent
    ).toBe(99)
  })

  it('completeDownloadProgress is the only way to reach 100', () => {
    expect(
      completeDownloadProgress({ bytesDownloaded: 19_000, bytesTotal: 20_000 })
    ).toEqual({ percent: 100, bytesDownloaded: 19_000, bytesTotal: 20_000 })
  })
})

describe('redactSecrets / status mapping', () => {
  it('never leaves a token in error text', () => {
    expect(redactSecrets('Bearer hf_abc123xyz Authorization failed')).toBe(
      'Bearer *** Authorization failed'
    )
    expect(redactSecrets('token=hf_secret_value')).toBe('token=hf_***')
  })

  it('maps Hub HTTP statuses', () => {
    expect(hfErrorCodeFromStatus(401)).toBe('unauthorized')
    expect(hfErrorCodeFromStatus(403)).toBe('forbidden')
    expect(hfErrorCodeFromStatus(404)).toBe('not_found')
    expect(hfErrorCodeFromStatus(429)).toBe('rate_limited')
    expect(hfErrorCodeFromStatus(500)).toBe('http_error')
  })
})

describe('classifyFolderCompleteness', () => {
  it('is complete only when on-disk size meets the expected revision size', () => {
    expect(classifyFolderCompleteness(1000, 1000)).toBe('complete')
    expect(classifyFolderCompleteness(1500, 1000)).toBe('complete')
    expect(classifyFolderCompleteness(999, 1000)).toBe('partial')
    expect(classifyFolderCompleteness(0, 1000)).toBe('partial')
  })

  it('is unknown when expected size is missing', () => {
    expect(classifyFolderCompleteness(500, null)).toBe('unknown')
    expect(classifyFolderCompleteness(500, 0)).toBe('unknown')
    expect(classifyFolderCompleteness(500, Number.NaN)).toBe('unknown')
  })
})

describe('nextAvailableFolderName', () => {
  it('keeps the base when it is free', () => {
    expect(nextAvailableFolderName('Qwen3.8-27B', ['other'])).toBe('Qwen3.8-27B')
  })

  it('appends a numeric suffix and skips taken names', () => {
    expect(nextAvailableFolderName('Qwen', ['Qwen'])).toBe('Qwen-2')
    expect(nextAvailableFolderName('Qwen', ['Qwen', 'Qwen-2', 'Qwen-4'])).toBe('Qwen-3')
  })

  it('treats names as case-insensitive on collision', () => {
    expect(nextAvailableFolderName('Qwen', ['qwen', 'QWEN-2'])).toBe('Qwen-3')
  })
})

describe('describeExistingFolder', () => {
  it('builds conflict info for a leftover partial folder', () => {
    expect(
      describeExistingFolder({
        folderName: 'Qwen3.8-27B-exl3-SC_3.00bpw_H4',
        bytesOnDisk: 1_000,
        expectedBytes: 10_000,
        siblingNames: ['Qwen3.8-27B-exl3-SC_3.00bpw_H4']
      })
    ).toEqual({
      folderName: 'Qwen3.8-27B-exl3-SC_3.00bpw_H4',
      bytesOnDisk: 1_000,
      expectedBytes: 10_000,
      completeness: 'partial',
      suggestedFolderName: 'Qwen3.8-27B-exl3-SC_3.00bpw_H4-2'
    })
  })
})

describe('resolveSafeModelSubdir / isPathStrictlyInside', () => {
  const root = resolve('/ai/tabby/models')

  it('accepts a single sanitized folder under modelDir', () => {
    const result = resolveSafeModelSubdir(root, 'Qwen3.8-27B-exl3-SC_3.00bpw_H4')
    expect(result).toEqual({
      ok: true,
      folderName: 'Qwen3.8-27B-exl3-SC_3.00bpw_H4',
      resolved: resolve(root, 'Qwen3.8-27B-exl3-SC_3.00bpw_H4')
    })
    expect(isPathStrictlyInside(root, resolve(root, 'foo'))).toBe(true)
  })

  it('rejects empty names and the modelDir itself', () => {
    expect(resolveSafeModelSubdir('', 'foo')).toEqual({ ok: false, reason: 'empty_root' })
    expect(resolveSafeModelSubdir(root, '')).toEqual({ ok: false, reason: 'empty_name' })
    expect(resolveSafeModelSubdir(root, '   ')).toEqual({ ok: false, reason: 'empty_name' })
    expect(isPathStrictlyInside(root, root)).toBe(false)
  })

  it('rejects path traversal, separators and absolute paths', () => {
    expect(resolveSafeModelSubdir(root, '..').ok).toBe(false)
    expect(resolveSafeModelSubdir(root, '.').ok).toBe(false)
    expect(resolveSafeModelSubdir(root, '../secret').ok).toBe(false)
    expect(resolveSafeModelSubdir(root, '..\\secret').ok).toBe(false)
    expect(resolveSafeModelSubdir(root, 'foo/bar').ok).toBe(false)
    expect(resolveSafeModelSubdir(root, 'foo\\bar').ok).toBe(false)
    expect(resolveSafeModelSubdir(root, 'foo/../bar').ok).toBe(false)
    expect(resolveSafeModelSubdir(root, resolve(root, '../outside')).ok).toBe(false)
    expect(isPathStrictlyInside(root, resolve(root, '..', 'outside'))).toBe(false)
    expect(isPathStrictlyInside(root, resolve(root, 'foo', '..', '..', 'etc'))).toBe(false)
  })
})

describe('parseTabbyFolderExistsError', () => {
  it('extracts the folder name from Tabby 400 JSON', () => {
    expect(
      parseTabbyFolderExistsError(
        'HTTP 400: {"detail":"The path models\\\\Qwen3.8-27B-exl3-SC_3.00bpw_H4 already exists. Remove the folder and try again."}'
      )
    ).toBe('Qwen3.8-27B-exl3-SC_3.00bpw_H4')
  })

  it('redacts tokens before parsing', () => {
    const parsed = parseTabbyFolderExistsError(
      'HTTP 400: The path models\\foo already exists. token=hf_secret_value'
    )
    expect(parsed).toBe('foo')
    expect(redactSecrets('HTTP 400 token=hf_secret_value')).not.toContain('hf_secret_value')
  })

  it('returns null for unrelated errors', () => {
    expect(parseTabbyFolderExistsError('HTTP 500: boom')).toBeNull()
  })
})
