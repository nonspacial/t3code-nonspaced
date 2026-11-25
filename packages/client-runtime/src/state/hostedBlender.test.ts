import { describe, expect, it } from "vite-plus/test";

import { chatHostedBlenderThread } from "./hostedBlender.ts";

describe("chatHostedBlenderThread", () => {
  it("P2: watches no thread's Blender until the environment has Hosted Blender on", () => {
    const thread = { environmentId: "environment-1", threadId: "thread-1" };
    expect(chatHostedBlenderThread(null, thread)).toBeNull();
    expect(
      chatHostedBlenderThread({ settings: { hostedBlenderEnabled: false } }, thread),
    ).toBeNull();
    expect(chatHostedBlenderThread({ settings: { hostedBlenderEnabled: true } }, thread)).toBe(
      thread,
    );
  });
});
