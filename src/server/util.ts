import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Req {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  req: IncomingMessage;
  res: ServerResponse;
}

export type Handler = (r: Req) => unknown | Promise<unknown>;
export type Route = (method: string, path: string, handler: Handler) => void;

/** Returned by handlers that write the response themselves (SSE, HTML). */
export const STREAMED = Symbol('streamed');

export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
