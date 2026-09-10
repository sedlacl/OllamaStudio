/**
 * Jediný compile-time kontrakt bridge. Implementace preloadu i renderer importují
 * stejný typ; transportní vrstva zde nemá vlastní DTO kopie.
 */
export type { Api as StudioApi } from '../src/types/api'
