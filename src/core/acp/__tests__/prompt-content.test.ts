import { describe, expect, it } from "vitest";

import {
  PROMPT_IMAGE_UNSUPPORTED_ERROR_CODE,
  agentPromptCapabilities,
  appendEmbeddedResourcesAsText,
  flattenBlocksForTextAdapter,
  formatEmbeddedResourceAsText,
  hasBinaryContentBlock,
  parsePromptContentBlocks,
} from "../prompt-content";
import type { AcpContentBlock } from "../protocol-types";

const TEXT_RESOURCE: AcpContentBlock = {
  type: "resource",
  resource: {
    type: "resource",
    uri: "routa-team-input://transfer-1/0",
    mimeType: "text/plain",
    text: "attached text",
  },
};

const IMAGE_BLOCK: AcpContentBlock = {
  type: "image",
  data: "aW1hZ2U=",
  mimeType: "image/png",
};

describe("parsePromptContentBlocks", () => {
  it("treats a plain string as one text block (legacy behavior)", () => {
    const parsed = parsePromptContentBlocks("hello");
    expect(parsed.promptText).toBe("hello");
    expect(parsed.blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("preserves valid blocks in order and projects text-block content", () => {
    const parsed = parsePromptContentBlocks([
      { type: "text", text: "request" },
      { type: "text", text: "Repository files:\n- src/main.rs" },
      TEXT_RESOURCE,
      IMAGE_BLOCK,
      { type: "unknown" },
    ]);
    expect(parsed.promptText).toBe("request\nRepository files:\n- src/main.rs");
    expect(parsed.blocks).toHaveLength(4);
  });

  it("ignores invalid blocks instead of failing the prompt", () => {
    const parsed = parsePromptContentBlocks([
      { type: "text" },
      { type: "image", data: "", mimeType: "image/png" },
      { type: "image", data: "aW1hZ2U=" },
      { type: "resource", resource: { uri: "" } },
      { type: "resource", resource: { uri: "file:///a" } },
      "not-an-object",
      null,
    ]);
    expect(parsed.blocks).toEqual([]);
    expect(parsed.promptText).toBe("");
  });

  it("returns an empty result for non-string, non-array input", () => {
    expect(parsePromptContentBlocks(undefined).blocks).toEqual([]);
    expect(parsePromptContentBlocks(42).blocks).toEqual([]);
    expect(parsePromptContentBlocks({}).blocks).toEqual([]);
  });
});

describe("hasBinaryContentBlock", () => {
  it("flags image blocks and blob resources as binary", () => {
    expect(hasBinaryContentBlock([IMAGE_BLOCK])).toBe(true);
    expect(
      hasBinaryContentBlock([
        { type: "resource", resource: { type: "resource", uri: "file:///a.bin", blob: "YmluYXJ5" } },
      ]),
    ).toBe(true);
  });

  it("does not flag text blocks or text resources", () => {
    expect(hasBinaryContentBlock([{ type: "text", text: "hi" }, TEXT_RESOURCE])).toBe(false);
    expect(hasBinaryContentBlock([])).toBe(false);
  });
});

describe("formatEmbeddedResourceAsText / appendEmbeddedResourcesAsText", () => {
  it("wraps a text resource in clearly delimited sections named after the URI tail", () => {
    const formatted = formatEmbeddedResourceAsText(TEXT_RESOURCE.resource);
    expect(formatted).toContain("----- Attached file: 0 -----");
    expect(formatted).toContain("attached text");
    expect(formatted).toContain("----- End of attached file: 0 -----");
  });

  it("appends delimited resources to a finalized prompt text", () => {
    const combined = appendEmbeddedResourcesAsText("final prompt", [TEXT_RESOURCE, IMAGE_BLOCK]);
    expect(combined.startsWith("final prompt\n\n")).toBe(true);
    expect(combined).toContain("attached text");
  });

  it("returns the prompt text unchanged when there are no text resources", () => {
    expect(appendEmbeddedResourcesAsText("final prompt", [IMAGE_BLOCK])).toBe("final prompt");
    expect(appendEmbeddedResourcesAsText("final prompt", [])).toBe("final prompt");
  });

  it("never flattens blob resources into text", () => {
    const blob: AcpContentBlock = {
      type: "resource",
      resource: { type: "resource", uri: "file:///a.bin", blob: "YmluYXJ5" },
    };
    expect(appendEmbeddedResourcesAsText("prompt", [blob])).toBe("prompt");
  });
});

describe("flattenBlocksForTextAdapter", () => {
  it("joins text blocks and delimited resources and reports binary content", () => {
    const flattened = flattenBlocksForTextAdapter([
      { type: "text", text: "request" },
      TEXT_RESOURCE,
      IMAGE_BLOCK,
    ]);
    expect(flattened.promptText).toContain("request");
    expect(flattened.promptText).toContain("attached text");
    expect(flattened.hasBinaryContent).toBe(true);
  });
});

describe("agentPromptCapabilities", () => {
  it("treats missing capabilities as unsupported", () => {
    expect(agentPromptCapabilities(null)).toEqual({ image: false, embeddedContext: false });
    expect(agentPromptCapabilities(undefined)).toEqual({ image: false, embeddedContext: false });
    expect(agentPromptCapabilities({})).toEqual({ image: false, embeddedContext: false });
    expect(agentPromptCapabilities({ agentCapabilities: {} })).toEqual({
      image: false,
      embeddedContext: false,
    });
  });

  it("accepts only explicit boolean true declarations", () => {
    expect(
      agentPromptCapabilities({
        agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } },
      }),
    ).toEqual({ image: true, embeddedContext: true });
    expect(
      agentPromptCapabilities({
        agentCapabilities: { promptCapabilities: { image: "yes", embeddedContext: 1 } },
      }),
    ).toEqual({ image: false, embeddedContext: false });
  });

  it("exposes a stable structured reason for capability failures", () => {
    expect(PROMPT_IMAGE_UNSUPPORTED_ERROR_CODE).toBe("prompt_images_unsupported");
  });
});
