// Duplicate of packages/mcp-bridge/src/protocol.ts by design — the extension
// and the bridge are two separate build worlds (browser extension vs. Node
// CLI) and don't share a build graph, so the wire protocol types are copied
// rather than imported cross-package.
import type { Tag } from '@idnerd/overlay-core'

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
