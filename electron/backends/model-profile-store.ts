import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  isBackendId,
  modelRefKey,
  type BackendId,
  type ModelProfile,
  type ModelRef
} from '../../shared/backend-contract'
import { atomicWriteJson } from '../storage/atomic-json'
import { normalizeModelProfile, profileFingerprint } from './definitions'

interface StoredProfile {
  ref: ModelRef
  schemaVersion: number
  updatedAt: number
  profile: unknown
}

interface ProfileStoreFile {
  version: 1
  profiles: Record<string, StoredProfile>
}

function defaultPath(): string {
  return join(app.getPath('userData'), 'model-profiles.json')
}

export class ModelProfileStore {
  constructor(private readonly path = defaultPath()) {}

  get<I extends BackendId>(ref: ModelRef & { providerId: I }): ModelProfile<I> {
    const stored = this.read().profiles[modelRefKey(ref)]
    return normalizeModelProfile(ref.providerId, stored?.profile)
  }

  getStored<I extends BackendId>(
    ref: ModelRef & { providerId: I }
  ): { profile: ModelProfile<I>; updatedAt: number; fingerprint: string } | null {
    const stored = this.read().profiles[modelRefKey(ref)]
    if (!stored) return null
    const profile = normalizeModelProfile(ref.providerId, stored.profile)
    return { profile, updatedAt: stored.updatedAt, fingerprint: profileFingerprint(ref.providerId, profile) }
  }

  save<I extends BackendId>(
    ref: ModelRef & { providerId: I },
    value: unknown
  ): ModelProfile<I> {
    if (!ref.modelId.trim()) throw new Error('Model ID must not be empty')
    const profile = normalizeModelProfile(ref.providerId, value)
    const store = this.read()
    store.profiles[modelRefKey(ref)] = {
      ref: { providerId: ref.providerId, modelId: ref.modelId.trim() },
      schemaVersion: 1,
      updatedAt: Date.now(),
      profile
    }
    atomicWriteJson(this.path, store)
    return profile
  }

  private read(): ProfileStoreFile {
    if (!existsSync(this.path)) return { version: 1, profiles: {} }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<ProfileStoreFile>
      const profiles: Record<string, StoredProfile> = {}
      if (parsed.profiles && typeof parsed.profiles === 'object') {
        for (const candidate of Object.values(parsed.profiles)) {
          if (
            candidate &&
            typeof candidate === 'object' &&
            candidate.ref &&
            isBackendId(candidate.ref.providerId) &&
            typeof candidate.ref.modelId === 'string' &&
            candidate.ref.modelId.trim() &&
            typeof candidate.updatedAt === 'number'
          ) {
            profiles[modelRefKey(candidate.ref)] = candidate
          }
        }
      }
      return { version: 1, profiles }
    } catch {
      return { version: 1, profiles: {} }
    }
  }
}

export const modelProfileStore = new ModelProfileStore()
