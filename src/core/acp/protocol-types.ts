export type NotificationHandler = (msg: JsonRpcMessage) => void;

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * ACP `session/prompt` content blocks — the subset Routa preserves
 * end-to-end. Text-only callers keep sending exactly one text block.
 */
export interface AcpTextContentBlock {
  type: "text";
  text: string;
}

export interface AcpImageContentBlock {
  type: "image";
  /** Raw Base64 image bytes (no data: prefix). */
  data: string;
  mimeType: string;
}

export interface AcpEmbeddedResource {
  type: "resource";
  uri: string;
  /** UTF-8 text content; mutually exclusive with `blob`. */
  text?: string;
  /** Raw Base64 binary content; mutually exclusive with `text`. */
  blob?: string;
  mimeType?: string;
}

export interface AcpResourceContentBlock {
  type: "resource";
  resource: AcpEmbeddedResource;
}

export type AcpContentBlock =
  | AcpTextContentBlock
  | AcpImageContentBlock
  | AcpResourceContentBlock;
