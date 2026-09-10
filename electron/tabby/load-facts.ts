/**
 * Fakta o posledním loadu z Tabby logu — deterministický zdroj pro GPU/CPU split.
 *
 * TabbyAPI v `/v1/model` velikost ani rozložení po zařízeních neposílá, takže
 * jediná tvrdá data o tom, kde váhy skončily, jsou řádky z ExLlamaV3 loaderu.
 */

/** Režim, jakým ExLlamaV3 rozdělil váhy po GPU. */
export type TabbySplitMode = 'tensor-parallel' | 'autosplit' | 'single-gpu' | 'unknown'

export interface TabbyLoadFacts {
  modelDir: string | null
  splitMode: TabbySplitMode
  /** Loader ohlásil, že je v provozu jedna GPU (`Disabling GPU split…`). */
  singleGpu: boolean
  /** `vision_offload` — váhy vision části zůstávají v pinned host RAM. */
  visionOffload: boolean
  maxSeqLen: number | null
  cacheSize: number | null
  /** `Model successfully loaded.` bez pozdějšího unloadu. */
  loaded: boolean
  /** Kdy dorazil poslední řádek, který fakta změnil. */
  updatedAt: number | null
}

const EMPTY: TabbyLoadFacts = {
  modelDir: null,
  splitMode: 'unknown',
  singleGpu: false,
  visionOffload: false,
  maxSeqLen: null,
  cacheSize: null,
  loaded: false,
  updatedAt: null
}

const LOADING_MODEL_RE = /Loading model:\s*(.+?)\s*$/i
const TENSOR_PARALLEL_RE = /Loading with tensor parallel/i
const AUTOSPLIT_RE = /Loading with autosplit/i
const MANUAL_SPLIT_RE = /Loading with a manual GPU split/i
const SINGLE_GPU_RE = /Disabling GPU split because one GPU is in use/i
const VISION_OFFLOAD_RE = /Keeping vision model weights in system RAM/i
const MAX_SEQ_LEN_RE = /max_seq_len(?:\s+from model)?:\s*(\d+)\s*tokens/i
const CACHE_SIZE_RE = /cache_size:\s*(\d+)\s*tokens/i
const LOADED_RE = /Model successfully loaded/i
const UNLOADED_RE = /Model unloaded|Unloading (?:existing )?model/i

/**
 * Reducer nad jedním řádkem logu. `Loading model:` začíná nový load, takže
 * shodí fakta z předchozího modelu — jinak by se míchal starý split s novým.
 */
export function reduceTabbyLoadFacts(
  facts: TabbyLoadFacts,
  line: string,
  at: number
): TabbyLoadFacts {
  const loadingModel = line.match(LOADING_MODEL_RE)
  if (loadingModel) {
    return { ...EMPTY, modelDir: loadingModel[1], updatedAt: at }
  }

  const next = { ...facts }
  let changed = false

  const setSplit = (mode: TabbySplitMode): void => {
    next.splitMode = mode
    changed = true
  }
  if (TENSOR_PARALLEL_RE.test(line)) setSplit('tensor-parallel')
  else if (AUTOSPLIT_RE.test(line)) setSplit('autosplit')
  else if (MANUAL_SPLIT_RE.test(line)) setSplit('single-gpu')

  if (SINGLE_GPU_RE.test(line)) {
    next.singleGpu = true
    changed = true
  }
  if (VISION_OFFLOAD_RE.test(line)) {
    next.visionOffload = true
    changed = true
  }

  const maxSeqLen = line.match(MAX_SEQ_LEN_RE)
  if (maxSeqLen) {
    next.maxSeqLen = parseInt(maxSeqLen[1], 10)
    changed = true
  }

  const cacheSize = line.match(CACHE_SIZE_RE)
  if (cacheSize) {
    next.cacheSize = parseInt(cacheSize[1], 10)
    changed = true
  }

  if (LOADED_RE.test(line)) {
    next.loaded = true
    changed = true
  } else if (UNLOADED_RE.test(line)) {
    next.loaded = false
    changed = true
  }

  if (!changed) return facts
  next.updatedAt = at
  return next
}

/**
 * True jen když log potvrdil dokončený load v některém GPU režimu a nic
 * nedrží váhy v host RAM. ExLlamaV3 dense CPU offload neumí, takže pak platí,
 * že RAM working set procesu jsou CUDA/host alokace, ne váhy modelu.
 *
 * Pozor: MoE offload (`cpu_moe_offload_layers`) se do logu nepíše. Studio ho
 * nenastavuje, u cizí Tabby ale `gpuOnly` může být optimistické.
 */
export function isGpuOnlyLoad(facts: TabbyLoadFacts): boolean {
  return facts.loaded && facts.splitMode !== 'unknown' && !facts.visionOffload
}

let current: TabbyLoadFacts = EMPTY

export function noteTabbyLogLine(line: string, at: number): void {
  current = reduceTabbyLoadFacts(current, line, at)
}

export function getTabbyLoadFacts(): TabbyLoadFacts {
  return current
}

export function resetTabbyLoadFacts(): void {
  current = EMPTY
}
