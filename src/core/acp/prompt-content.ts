/**
 * Prompt content-block handling shared by the Web `session/prompt` route.
 *
 * The transport boundary validates and preserves ACP content blocks instead
 * of flattening requests to text. Provider dispatch then decides, per
 * adapter, whether blocks pass through unchanged (standard ACP providers),
 * embedded text resources become clearly-delimited text (adapters without
 * embedded context), or the prompt fails explicitly (binary content on a
 * path that cannot carry it).
 */

import type {
  AcpContentBlock,
  AcpEmbeddedResource,
} from "./protocol-types";

export interface ParsedPromptContent {
  /** Validated blocks in request order. */
  blocks: AcpContentBlock[];
  /** Text-block content only, for history and text-only adapters. */
  promptText: string;
}

/** Error code carried in JSON-RPC `error.data.code` for capability failures. */
export const PROMPT_IMAGE_UNSUPPORTED_ERROR_CODE = "prompt_images_unsupported";

function parseEmbeddedResource(value: unknown): AcpEmbeddedResource | null {
  if (!value || typeof value !== "object") return null;
  const resource = value as Record<string, unknown>;
  if (typeof resource.uri !== "string" || resource.uri.length === 0) return null;
  const hasText = typeof resource.text === "string";
  const hasBlob = typeof resource.blob === "string" && resource.blob.length > 0;
  if (!hasText && !hasBlob) return null;
  const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : undefined;
  return {
    type: "resource",
    uri: resource.uri,
    ...(hasText ? { text: resource.text as string } : {}),
    ...(hasBlob ? { blob: resource.blob as string } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
  };
}

/**
 * Validate a raw `session/prompt` `prompt` field into preserved content
 * blocks. Plain strings and text-block arrays behave exactly as before;
 * unknown block types stay ignored like the previous text-only extraction.
 */
export function parsePromptContentBlocks(rawPrompt: unknown): ParsedPromptContent {
  if (typeof rawPrompt === "string") {
    return {
      blocks: [{ type: "text", text: rawPrompt }],
      promptText: rawPrompt,
    };
  }

  const blocks: AcpContentBlock[] = [];
  if (!Array.isArray(rawPrompt)) {
    return { blocks, promptText: "" };
  }

  for (const entry of rawPrompt) {
    if (!entry || typeof entry !== "object") continue;
    const block = entry as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (
      block.type === "image"
      && typeof block.data === "string"
      && block.data.length > 0
      && typeof block.mimeType === "string"
    ) {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
      continue;
    }
    if (block.type === "resource") {
      const resource = parseEmbeddedResource(block.resource);
      if (resource) blocks.push({ type: "resource", resource });
    }
  }

  const promptText = blocks
    .filter((block): block is Extract<AcpContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return { blocks, promptText };
}

/** True when any block carries binary content (image data or a blob resource). */
export function hasBinaryContentBlock(blocks: AcpContentBlock[]): boolean {
  return blocks.some(
    (block) => block.type === "image" || (block.type === "resource" && block.resource.blob !== undefined),
  );
}

export const EMBEDDED_RESOURCE_DELIMITER = "----- Attached file";

/** Render one embedded text resource as clearly-delimited prompt text. */
export function formatEmbeddedResourceAsText(resource: AcpEmbeddedResource): string {
  const name = resource.uri.split("/").pop() || resource.uri;
  return [
    `${EMBEDDED_RESOURCE_DELIMITER}: ${name} -----`,
    resource.text ?? "",
    `----- End of attached file: ${name} -----`,
  ].join("\n");
}

/**
 * Flatten preserved blocks for adapters without embedded context: text blocks
 * plus delimited embedded text resources. `hasBinaryContent` reports binary
 * blocks that the caller must reject explicitly instead of dropping.
 */
export function flattenBlocksForTextAdapter(blocks: AcpContentBlock[]): {
  promptText: string;
  hasBinaryContent: boolean;
} {
  const sections: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      sections.push(block.text);
    } else if (block.type === "resource" && block.resource.text !== undefined) {
      sections.push(formatEmbeddedResourceAsText(block.resource));
    }
  }
  return {
    promptText: sections.join("\n\n"),
    hasBinaryContent: hasBinaryContentBlock(blocks),
  };
}

/**
 * Append the delimited embedded text resources to an already-finalized prompt
 * text. Used by text-only dispatch paths whose prompt text already went
 * through history/recovery mutations; binary blocks are never appended and
 * must have been rejected beforehand.
 */
export function appendEmbeddedResourcesAsText(
  promptText: string,
  blocks: AcpContentBlock[],
): string {
  const sections: string[] = [];
  for (const block of blocks) {
    if (block.type === "resource" && block.resource.text !== undefined) {
      sections.push(formatEmbeddedResourceAsText(block.resource));
    }
  }
  if (sections.length === 0) return promptText;
  return [promptText, ...sections].join("\n\n");
}

export interface AgentPromptCapabilities {
  image: boolean;
  embeddedContext: boolean;
}

/**
 * Read the initialized agent's prompt capabilities. A capability the agent
 * did not declare is treated as unsupported, matching the ACP protocol.
 */
export function agentPromptCapabilities(
  initResult: { agentCapabilities?: Record<string, unknown> } | null | undefined,
): AgentPromptCapabilities {
  const promptCapabilities = initResult?.agentCapabilities?.promptCapabilities;
  if (!promptCapabilities || typeof promptCapabilities !== "object") {
    return { image: false, embeddedContext: false };
  }
  const capabilities = promptCapabilities as Record<string, unknown>;
  return {
    image: capabilities.image === true,
    embeddedContext: capabilities.embeddedContext === true,
  };
}
