import type { ClaudeSdkUserMessage } from "../harness/claude/sdk-types.ts";
import type { ValidatedLlmImage } from "./images.ts";

/** One Claude-native user message with images first and the existing prompt last. */
export function claudeImageUserMessage(
  prompt: string,
  images: readonly ValidatedLlmImage[],
): ClaudeSdkUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        ...images.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: image.base64,
          },
        })),
        { type: "text", text: prompt },
      ],
    },
    parent_tool_use_id: null,
  };
}
