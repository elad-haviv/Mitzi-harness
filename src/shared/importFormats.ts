// Reads conversations from other assistants' data exports. Shared by the browser (which unpacks the
// export) and the server's tests; no Node-only APIs here.
import type { ImportedConversation, ImportSource } from './types.js';

const MAX_MESSAGE_CHARS = 100_000;

const iso = (v: unknown): string => {
  if (typeof v === 'number') return new Date(v * (v < 1e12 ? 1000 : 1)).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return new Date().toISOString();
};

const clip = (s: string) => (s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS)}\n… [truncated]` : s);

/** ChatGPT's conversations.json: each conversation is a tree of messages; follow the branch that was last shown. */
export function fromChatGPT(data: unknown): ImportedConversation[] {
  if (!Array.isArray(data)) throw new Error('This doesn’t look like ChatGPT’s conversations.json');
  const out: ImportedConversation[] = [];
  for (const conv of data as any[]) {
    const mapping = conv?.mapping;
    if (!mapping || typeof mapping !== 'object') continue;
    // The visible branch ends at current_node; older exports without it use the last leaf.
    let nodeId: string | undefined = conv.current_node ?? Object.keys(mapping).findLast((k) => !mapping[k]?.children?.length);
    const path: any[] = [];
    const seen = new Set<string>();
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      path.push(mapping[nodeId]);
      nodeId = mapping[nodeId].parent;
    }
    path.reverse();
    const messages: ImportedConversation['messages'] = [];
    for (const node of path) {
      const m = node?.message;
      const role = m?.author?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (m.metadata?.is_visually_hidden_from_conversation) continue;
      const type = m.content?.content_type;
      if (type && type !== 'text' && type !== 'multimodal_text') continue;
      const text = (m.content?.parts ?? [])
        .filter((p: unknown) => typeof p === 'string')
        .join('\n')
        .trim();
      if (!text) continue;
      const ts = typeof m.create_time === 'number' ? Math.round(m.create_time * 1000) : undefined;
      // Consecutive messages from the same side (e.g. after tool calls) read as one.
      const last = messages.at(-1);
      if (last && last.role === role) last.text = clip(`${last.text}\n\n${text}`);
      else messages.push({ role, text: clip(text), ts });
    }
    if (!messages.length) continue;
    out.push({
      id: String(conv.conversation_id ?? conv.id ?? `${conv.title}-${conv.create_time}`),
      title: String(conv.title || messages[0].text.slice(0, 60)),
      createdAt: iso(conv.create_time),
      updatedAt: iso(conv.update_time ?? conv.create_time),
      messages,
    });
  }
  return out;
}

/** Claude's conversations.json: each conversation has a flat list of chat_messages. */
export function fromClaude(data: unknown): ImportedConversation[] {
  if (!Array.isArray(data)) throw new Error('This doesn’t look like Claude’s conversations.json');
  const out: ImportedConversation[] = [];
  for (const conv of data as any[]) {
    if (!Array.isArray(conv?.chat_messages)) continue;
    const messages: ImportedConversation['messages'] = [];
    for (const m of conv.chat_messages) {
      const role = m?.sender === 'human' ? 'user' : m?.sender === 'assistant' ? 'assistant' : undefined;
      if (!role) continue;
      const parts = Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text) : [];
      const text = (parts.length ? parts.join('\n') : String(m.text ?? '')).trim();
      if (!text) continue;
      const last = messages.at(-1);
      if (last && last.role === role) last.text = clip(`${last.text}\n\n${text}`);
      else messages.push({ role, text: clip(text), ts: m.created_at ? Date.parse(m.created_at) : undefined });
    }
    if (!messages.length) continue;
    out.push({
      id: String(conv.uuid ?? `${conv.name}-${conv.created_at}`),
      title: String(conv.name || messages[0].text.slice(0, 60)),
      createdAt: iso(conv.created_at),
      updatedAt: iso(conv.updated_at ?? conv.created_at),
      messages,
    });
  }
  return out;
}

/** Recognizes which assistant an export came from. */
export function detectSource(data: unknown): ImportSource | undefined {
  const first = Array.isArray(data) ? data.find((c) => c && typeof c === 'object') : undefined;
  if (!first) return undefined;
  if ('mapping' in first) return 'chatgpt';
  if ('chat_messages' in first) return 'claude';
  return undefined;
}

export function parseExport(data: unknown): { source: ImportSource; conversations: ImportedConversation[] } {
  const source = detectSource(data);
  if (!source) throw new Error('Couldn’t recognize this file. Use conversations.json (or the whole .zip) from a ChatGPT or Claude data export.');
  return { source, conversations: source === 'chatgpt' ? fromChatGPT(data) : fromClaude(data) };
}
