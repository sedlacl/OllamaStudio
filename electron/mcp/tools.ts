import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type {
  BackendId,
  ModelAcquisitionRequest,
  ModelOperationRequest,
  ModelRef
} from '../../shared/backend-contract'
import { sanitizeSecrets } from '../security/sanitize-state'
import {
  formatMcpHandlerError,
  studioMcpHandlers,
  type StudioMcpHandlers
} from './handlers'

const SECRET_FIELD =
  /^(?:authorization|token|hf_?token|api_?key|admin_?key|password|secret|access_?token)$/i
const MAX_RESULT_DEPTH = 24

function sanitizeResult(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_RESULT_DEPTH) return '[truncated]'
  if (value == null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return sanitizeSecrets(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeResult(item, depth + 1, seen))
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const output: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD.test(key)) continue
      output[key] = sanitizeResult(nested, depth + 1, seen)
    }
    return output
  }
  return sanitizeSecrets(String(value))
}

async function execute(handler: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = sanitizeResult(await handler())
    return {
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: formatMcpHandlerError(error) }]
    }
  }
}

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
}
const mutating: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
}
const destructive: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
}

const providerId = z.enum(['ollama', 'tabby']).describe('Backend provider')
const modelId = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'), 'NUL is not allowed')
  .describe('Provider-specific model identifier')
const modelRefShape = { providerId, modelId }
const profile = z.record(z.string(), z.unknown()).describe('Provider-specific model profile')
const presetKind = z.enum(['load', 'serve', 'tabby-load'])
const shortText = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'), 'NUL is not allowed')

const ollamaEnvShape = {
  OLLAMA_HOST: z.string().max(4096).optional(),
  OLLAMA_CONTEXT_LENGTH: z.string().max(128).optional(),
  OLLAMA_KEEP_ALIVE: z.string().max(128).optional(),
  OLLAMA_MAX_LOADED_MODELS: z.string().max(128).optional(),
  OLLAMA_NUM_PARALLEL: z.string().max(128).optional(),
  OLLAMA_FLASH_ATTENTION: z.string().max(128).optional(),
  OLLAMA_KV_CACHE_TYPE: z.string().max(128).optional(),
  OLLAMA_DEBUG: z.string().max(128).optional(),
  OLLAMA_DEBUG_LOG_REQUESTS: z.string().max(128).optional(),
  LLAMA_ARG_CTX_CHECKPOINTS: z.string().max(128).optional(),
  OLLAMA_MODELS: z.string().max(4096).optional()
}

export const STUDIO_TOOL_NAMES = [
  'studio_status',
  'get_logs',
  'get_resources',
  'list_models',
  'get_model',
  'get_acquisitions',
  'integrations_status',
  'get_model_profile',
  'save_model_profile',
  'load_model',
  'unload_model',
  'run_speed_test',
  'acquire_model',
  'start_server',
  'stop_server',
  'restart_server',
  'switch_backend',
  'save_backend_settings',
  'delete_model',
  'copy_model',
  'kill_process',
  'upsert_continue_model',
  'remove_continue_model',
  'upsert_opencode_model',
  'remove_opencode_model',
  'list_presets',
  'save_preset',
  'delete_preset'
] as const

/**
 * Registers the stable Studio tool set. run_test_query is intentionally kept
 * outside this module's handler surface so its parallel provider implementation
 * can add one adjacent registration without changing existing tools.
 */
export function registerStudioTools(
  server: McpServer,
  handlers: StudioMcpHandlers = studioMcpHandlers
): void {
  server.registerTool(
    'studio_status',
    {
      description: 'Return the Studio version, active backend, serve state, and capabilities.',
      annotations: readOnly
    },
    () => execute(() => handlers.studioStatus())
  )

  server.registerTool(
    'get_logs',
    {
      description: 'Return a bounded, redacted tail of backend logs with optional filters.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().default(200),
        text: z.string().trim().max(256).optional(),
        level: z.enum(['info', 'error', 'warn', 'debug']).optional(),
        category: z.enum(['general', 'error', 'load', 'unload', 'request']).optional()
      },
      annotations: readOnly
    },
    (args) => execute(() => handlers.getLogs(args))
  )

  server.registerTool(
    'get_resources',
    {
      description:
        'Inspect GPU, VRAM split, RAM, CPU, loaded models, backend processes, and active requests.',
      annotations: readOnly
    },
    () => execute(() => handlers.getResources())
  )

  server.registerTool(
    'list_models',
    {
      description: 'List the provider-qualified local model catalog, including offline providers.',
      annotations: readOnly
    },
    () => execute(() => handlers.listModels())
  )

  server.registerTool(
    'get_model',
    {
      description:
        'Inspect model metadata, provider details, effective profile, last load options, and speed test.',
      inputSchema: modelRefShape,
      annotations: readOnly
    },
    (ref) => execute(() => handlers.getModel(ref as ModelRef))
  )

  server.registerTool(
    'get_acquisitions',
    {
      description: 'List current and recent Ollama pulls and Hugging Face downloads.',
      annotations: readOnly
    },
    () => execute(() => handlers.getAcquisitions())
  )

  server.registerTool(
    'integrations_status',
    {
      description: 'Inspect Continue and OpenCode configuration status for selected models.',
      inputSchema: {
        models: z.array(z.object(modelRefShape).strict()).max(200).optional().default([])
      },
      annotations: readOnly
    },
    ({ models }) => execute(() => handlers.integrationsStatus(models as ModelRef[]))
  )

  server.registerTool(
    'get_model_profile',
    {
      description: 'Return the stored and effective provider-specific profile for a model.',
      inputSchema: modelRefShape,
      annotations: readOnly
    },
    (ref) => execute(() => handlers.getModelProfile(ref as ModelRef))
  )

  server.registerTool(
    'save_model_profile',
    {
      description: 'Validate and persist a provider-specific model profile.',
      inputSchema: { ...modelRefShape, profile },
      annotations: mutating
    },
    ({ providerId: id, modelId: name, profile: value }) =>
      execute(() => handlers.saveModelProfile({ providerId: id, modelId: name }, value))
  )

  server.registerTool(
    'load_model',
    {
      description:
        'Activate the model provider and load or reuse the model with an optional validated profile.',
      inputSchema: { ...modelRefShape, profile: profile.optional() },
      annotations: mutating
    },
    ({ providerId: id, modelId: name, profile: value }) =>
      execute(() =>
        handlers.loadModel({
          ref: { providerId: id, modelId: name },
          ...(value ? { profile: value } : {})
        } as ModelOperationRequest)
      )
  )

  server.registerTool(
    'unload_model',
    {
      description: 'Unload a model and clear its volatile load and benchmark state.',
      inputSchema: modelRefShape,
      annotations: mutating
    },
    (ref) => execute(() => handlers.unloadModel(ref as ModelRef))
  )

  server.registerTool(
    'run_speed_test',
    {
      description: 'Load if necessary and run the existing provider speed benchmark.',
      inputSchema: modelRefShape,
      annotations: mutating
    },
    (ref) => execute(() => handlers.runSpeedTest(ref as ModelRef))
  )

  server.registerTool(
    'acquire_model',
    {
      description:
        'Start an Ollama library pull or Tabby Hugging Face download. Secrets are accepted but never returned.',
      inputSchema: z.discriminatedUnion('providerId', [
        z
          .object({
            providerId: z.literal('ollama'),
            source: z.literal('library'),
            modelId
          })
          .strict(),
        z
          .object({
            providerId: z.literal('tabby'),
            source: z.literal('hugging-face'),
            modelId: modelId.optional(),
            repoId: shortText,
            revision: z.string().trim().max(512).optional(),
            folderName: z.string().trim().max(512).optional(),
            token: z.string().trim().max(8192).optional()
          })
          .strict()
      ]),
      annotations: mutating
    },
    (request) => execute(() => handlers.acquireModel(request as ModelAcquisitionRequest))
  )

  server.registerTool(
    'start_server',
    {
      description:
        'Start the active inference backend. forceKillConflict may terminate a conflicting managed process.',
      inputSchema: { forceKillConflict: z.boolean().optional().default(false) },
      annotations: mutating
    },
    ({ forceKillConflict }) => execute(() => handlers.startServer(forceKillConflict))
  )

  server.registerTool(
    'stop_server',
    {
      description:
        'DESTRUCTIVE: stop the active Studio-owned backend and interrupt active inference requests.',
      annotations: destructive
    },
    () => execute(() => handlers.stopServer())
  )

  server.registerTool(
    'restart_server',
    {
      description:
        'DESTRUCTIVE: restart the active backend, unloading models and interrupting active requests.',
      inputSchema: { forceKillConflict: z.boolean().optional().default(false) },
      annotations: destructive
    },
    ({ forceKillConflict }) => execute(() => handlers.restartServer(forceKillConflict))
  )

  server.registerTool(
    'switch_backend',
    {
      description:
        'DESTRUCTIVE: switch the active backend; the previous Studio-owned backend may be stopped.',
      inputSchema: { providerId },
      annotations: destructive
    },
    ({ providerId: id }) => execute(() => handlers.switchBackend(id))
  )

  server.registerTool(
    'save_backend_settings',
    {
      description:
        'Persist validated backend settings. Restart the backend separately when changed fields require it.',
      inputSchema: z.discriminatedUnion('providerId', [
        z
          .object({
            providerId: z.literal('ollama'),
            patch: z
              .object({
                autoStartServe: z.boolean().optional(),
                env: z.object(ollamaEnvShape).strict().optional(),
                profileDefaults: z
                  .object({
                    keepAlive: z.string().trim().min(1).max(128).optional(),
                    numCtx: z.number().int().min(1).max(16_777_216).optional()
                  })
                  .strict()
                  .optional()
              })
              .strict()
          })
          .strict(),
        z
          .object({
            providerId: z.literal('tabby'),
            patch: z
              .object({
                installDir: z.string().max(4096).optional(),
                pythonPath: z.string().max(4096).optional(),
                configPath: z.string().max(4096).optional(),
                host: z.string().trim().min(1).max(253).optional(),
                port: z.number().int().min(1).max(65_535).optional(),
                modelDir: z.string().max(4096).optional(),
                autoStartServe: z.boolean().optional()
              })
              .strict()
          })
          .strict()
      ]),
      annotations: mutating
    },
    ({ providerId: id, patch }) =>
      execute(() => handlers.saveBackendSettings(id as BackendId, patch))
  )

  server.registerTool(
    'delete_model',
    {
      description:
        'DESTRUCTIVE AND IRREVERSIBLE: permanently delete a local model and clear its runtime state.',
      inputSchema: modelRefShape,
      annotations: destructive
    },
    (ref) => execute(() => handlers.deleteModel(ref as ModelRef))
  )

  server.registerTool(
    'copy_model',
    {
      description: 'Copy an Ollama model to a new local model name.',
      inputSchema: {
        providerId,
        source: shortText.describe('Existing model identifier'),
        destination: shortText.describe('New model identifier')
      },
      annotations: mutating
    },
    ({ providerId: id, source, destination }) =>
      execute(() => handlers.copyModel(id, source, destination))
  )

  server.registerTool(
    'kill_process',
    {
      description:
        'DESTRUCTIVE: terminate only a backend process validated by the selected provider. Use a PID from get_resources.',
      inputSchema: {
        providerId,
        pid: z.number().int().positive().max(2_147_483_647)
      },
      annotations: destructive
    },
    ({ providerId: id, pid }) => execute(() => handlers.killProcess(id, pid))
  )

  server.registerTool(
    'upsert_continue_model',
    {
      description: 'Add or update an Ollama model in the user Continue configuration.',
      inputSchema: modelRefShape,
      annotations: mutating
    },
    (ref) => execute(() => handlers.upsertContinue(ref as ModelRef))
  )

  server.registerTool(
    'remove_continue_model',
    {
      description: 'DESTRUCTIVE: remove a matching Ollama model from Continue configuration.',
      inputSchema: modelRefShape,
      annotations: destructive
    },
    (ref) => execute(() => handlers.removeContinue(ref as ModelRef))
  )

  server.registerTool(
    'upsert_opencode_model',
    {
      description: 'Add or update a provider-qualified model in the user OpenCode configuration.',
      inputSchema: modelRefShape,
      annotations: mutating
    },
    (ref) => execute(() => handlers.upsertOpenCode(ref as ModelRef))
  )

  server.registerTool(
    'remove_opencode_model',
    {
      description: 'DESTRUCTIVE: remove a matching model from OpenCode configuration.',
      inputSchema: modelRefShape,
      annotations: destructive
    },
    (ref) => execute(() => handlers.removeOpenCode(ref as ModelRef))
  )

  server.registerTool(
    'list_presets',
    {
      description: 'List Studio load or serve presets of the selected kind.',
      inputSchema: { kind: presetKind },
      annotations: readOnly
    },
    ({ kind }) => execute(() => handlers.listPresets(kind))
  )

  server.registerTool(
    'save_preset',
    {
      description: 'Validate and create or update a Studio load or serve preset.',
      inputSchema: {
        kind: presetKind,
        name: shortText,
        data: z.record(z.string(), z.unknown()),
        id: z.string().uuid().optional()
      },
      annotations: mutating
    },
    ({ kind, name, data, id }) => execute(() => handlers.savePreset(kind, name, data, id))
  )

  server.registerTool(
    'delete_preset',
    {
      description: 'DESTRUCTIVE: permanently delete a Studio preset.',
      inputSchema: { kind: presetKind, id: z.string().uuid() },
      annotations: destructive
    },
    ({ kind, id }) => execute(() => handlers.deletePreset(kind, id))
  )
}

export function createStudioMcpServer(version: string): McpServer {
  const server = new McpServer(
    { name: 'OllamaStudio', version },
    {
      instructions:
        'Inspect status and resources before mutating runtime state. Destructive tools are explicitly marked.'
    }
  )
  registerStudioTools(server)
  return server
}
