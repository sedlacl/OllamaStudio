import { describe, expect, it } from 'vitest'
import {
  suggestTextOnlyCloneName,
  stripVisionFromModelfile,
  blobPathToDigest,
  filesFromFromValues,
  parseParametersBlock,
  buildTextOnlyCreateRequest,
  type FromKind
} from './modelfile-vision'
import { parseGgufStringMetadata } from './gguf-metadata'

describe('suggestTextOnlyCloneName', () => {
  it('uses the last path segment and appends -text to the tag', () => {
    expect(suggestTextOnlyCloneName('hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL')).toBe(
      'Qwen3.8-27B-GGUF:UD-Q3_K_XL-text'
    )
  })
})

describe('stripVisionFromModelfile', () => {
  const classify = (value: string): FromKind =>
    value.includes('mmproj') || value.includes('83ee4f4f') ? 'mmproj' : 'weights'

  it('drops mmproj FROM and keeps weights plus template', () => {
    const source = `# generated
FROM C:\\blobs\\sha256-weights
FROM C:\\blobs\\sha256-83ee4f4f-mmproj
TEMPLATE "{{ .Prompt }}"
PARAMETER stop "<|im_end|>"
`
    const result = stripVisionFromModelfile(source, classify)
    expect(result.removed).toHaveLength(1)
    expect(result.modelfile).toContain('FROM C:\\blobs\\sha256-weights')
    expect(result.modelfile).not.toContain('mmproj')
    expect(result.modelfile).toContain('TEMPLATE')
  })

  it('throws when there is no separate projector', () => {
    expect(() =>
      stripVisionFromModelfile('FROM C:\\blobs\\sha256-weights\nTEMPLATE "x"\n', classify)
    ).toThrow('MODEL_HAS_NO_SEPARATE_VISION_PROJECTOR')
  })
})

describe('create payload helpers', () => {
  it('turns a blob path into a sha256 digest and .gguf file map', () => {
    const digest = blobPathToDigest(
      'C:\\Users\\x\\.ollama\\models\\blobs\\sha256-5a4655dcd27d1316ca113df54bfc176f6867c6a71f6df3e5171cadb748308aa0'
    )
    expect(digest).toBe('sha256:5a4655dcd27d1316ca113df54bfc176f6867c6a71f6df3e5171cadb748308aa0')
    expect(filesFromFromValues([
      'C:\\blobs\\sha256-5a4655dcd27d1316ca113df54bfc176f6867c6a71f6df3e5171cadb748308aa0'
    ])).toEqual({
      'model.gguf': 'sha256:5a4655dcd27d1316ca113df54bfc176f6867c6a71f6df3e5171cadb748308aa0'
    })
  })

  it('collects repeated stop parameters into an array', () => {
    expect(
      parseParametersBlock('stop                           "<|im_end|>"\nstop                           "<think>"\nnum_ctx                        32768\n')
    ).toEqual({
      stop: ['<|im_end|>', '<think>'],
      num_ctx: 32768
    })
  })

  it('does not send a Jinja chat template on create (Ollama parses it as Go)', () => {
    const digest =
      'C:\\blobs\\sha256-5a4655dcd27d1316ca113df54bfc176f6867c6a71f6df3e5171cadb748308aa0'
    const request = buildTextOnlyCreateRequest({
      model: 'qwen-text',
      strippedModelfile: `FROM ${digest}\n`,
      template: '{% macro render_content(content) %}{{ content }}{% endmacro %}'
    })
    expect(request.template).toBeUndefined()
    expect(request.files['model.gguf']).toMatch(/^sha256:/)
  })
})

describe('parseGgufStringMetadata', () => {
  it('reads general.type from a minimal GGUF header', () => {
    const buf = buildGgufHeader({ 'general.type': 'mmproj' })
    expect(parseGgufStringMetadata(buf, ['general.type'])['general.type']).toBe('mmproj')
  })
})

function buildGgufHeader(pairs: Record<string, string>): Buffer {
  const chunks: Buffer[] = []
  const magic = Buffer.alloc(24)
  magic.writeUInt32LE(0x46554747, 0)
  magic.writeUInt32LE(3, 4)
  magic.writeBigUInt64LE(0n, 8)
  magic.writeBigUInt64LE(BigInt(Object.keys(pairs).length), 16)
  chunks.push(magic)
  for (const [key, value] of Object.entries(pairs)) {
    chunks.push(ggufString(key))
    const type = Buffer.alloc(4)
    type.writeUInt32LE(8, 0)
    chunks.push(type, ggufString(value))
  }
  return Buffer.concat(chunks)
}

function ggufString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  const header = Buffer.alloc(8)
  header.writeBigUInt64LE(BigInt(bytes.length), 0)
  return Buffer.concat([header, bytes])
}
