import { describe, expect, it } from "vite-plus/test";

import { chatHostedBlenderThread, hostedBlenderLane } from "./hostedBlender.ts";

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

describe("hostedBlenderLane", () => {
  it("R3: runs a discard beside the thread's lane, so a stuck Save and quit can't hold it", () => {
    const lane = (
      threadId: string,
      input: { readonly save: boolean; readonly discard?: boolean },
    ) => hostedBlenderLane({ environmentId: "environment-1", input: { threadId, ...input } });
    expect(lane("thread-1", { save: false })).toBe(lane("thread-1", { save: true }));
    expect(lane("thread-1", { save: false, discard: true })).not.toBe(
      lane("thread-1", { save: true }),
    );
    expect(lane("thread-2", { save: true })).not.toBe(lane("thread-1", { save: true }));
  });
});
