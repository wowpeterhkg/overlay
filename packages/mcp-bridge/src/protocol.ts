import type { Tag } from './store'

export type Up =
  | { type: 'hello'; tags: Tag[] }
  | { type: 'upsert'; tag: Tag; shotBase64?: string }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'pong' }

export type Down =
  | { type: 'resolve'; id: string }
  | { type: 'create'; tag: Tag }
  | { type: 'ping' }
