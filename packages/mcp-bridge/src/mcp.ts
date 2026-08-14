import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import type { BridgeStore } from './store'

interface Broadcaster { broadcast(msg: object): void }

export function buildMcpServer(store: BridgeStore, srv: Broadcaster) {
  const mcp = new McpServer({ name: 'overlay', version: '0.1.0' })

  mcp.registerTool('list_tags', {
    description: 'List UI feedback tags captured in the browser overlay. Each tag is one requested change: selector into the live DOM, nearby text, optional React component name, and the user note.',
    inputSchema: { route: z.string().optional(), includeResolved: z.boolean().optional() },
  }, async ({ route, includeResolved }) => {
    let tags = store.list()
    if (!includeResolved) tags = tags.filter(t => t.status !== 'resolved')
    if (route) tags = tags.filter(t => t.route === route)
    const out = tags.map(t => ({
      id: t.id, route: t.route, scope: t.scope, selector: t.selector, testid: t.testid,
      textHint: t.textHint, component: t.component, note: t.note, origin: t.origin ?? 'user',
      status: t.status ?? 'open',
      hasScreenshot: !!(t.screenshotId && store.shotPath(t.screenshotId)),
      screenshotId: t.screenshotId,
    }))
    return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] }
  })

  mcp.registerTool('get_screenshot', {
    description: 'Fetch the cropped element screenshot for a tag, as an image.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const p = store.shotPath(id)
    if (!p) return { content: [{ type: 'text' as const, text: `No screenshot stored for id ${id}` }], isError: true }
    return { content: [{ type: 'image' as const, data: readFileSync(p).toString('base64'), mimeType: 'image/png' }] }
  })

  mcp.registerTool('resolve_tag', {
    description: 'Mark a tag resolved after you have made the requested change. The pin disappears live in the browser.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    if (!store.resolve(id)) {
      return { content: [{ type: 'text' as const, text: `no tag with id ${id}` }], isError: true }
    }
    srv.broadcast({ type: 'resolve', id })
    return { content: [{ type: 'text' as const, text: `resolved ${id}` }] }
  })

  mcp.registerTool('create_tag', {
    description: 'Create a new tag (rendered in a distinct agent color). Only reference routes/selectors you learned from existing tags or the codebase.',
    inputSchema: {
      route: z.string(), note: z.string(),
      selector: z.string().optional(), scope: z.enum(['element', 'page']).optional(),
    },
  }, async (input) => {
    const tag = store.create(input)
    srv.broadcast({ type: 'create', tag })
    return { content: [{ type: 'text' as const, text: JSON.stringify(tag, null, 2) }] }
  })

  return mcp
}

export function startMcp(store: BridgeStore, srv: Broadcaster) {
  const mcp = buildMcpServer(store, srv)
  mcp.connect(new StdioServerTransport())
}
