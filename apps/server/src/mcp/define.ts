import type { z } from 'zod'

/** One MCP tool: name, description, zod input shape, handler. Registered on every MCP endpoint. */
export interface ToolDef {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

export interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  [k: string]: unknown
}

export function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
  extra?: { annotations?: ToolDef['annotations'] },
): ToolDef {
  return { name, description, inputSchema, handler: handler as ToolDef['handler'], ...(extra?.annotations ? { annotations: extra.annotations } : {}) }
}
