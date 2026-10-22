import type { ToolSpec } from '../openrouter.js';
import { bashTool } from './bash.js';
import { editTool, lsTool, readTool, writeTool } from './fs.js';
import { globTool, grepTool } from './search.js';
import { todoTool } from './todo.js';
import type { Tool } from './types.js';
import { webFetchTool } from './web.js';

export * from './types.js';

export const ALL_TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool, globTool, grepTool, lsTool, webFetchTool, todoTool];

export function toToolSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
