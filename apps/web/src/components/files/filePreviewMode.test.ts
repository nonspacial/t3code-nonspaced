import { BlendPreviewError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filePreviewReadErrorMessage } from "./filePreviewMode";

describe("filePreviewReadErrorMessage", () => {
  it("says a missing .blend attachment is gone rather than calling it a special file", () => {
    const error = new BlendPreviewError({
      relativePath: "attachment-1",
      failure: "attachment_not_found",
      cause: null,
    });
    expect(filePreviewReadErrorMessage(error)).toBe("This attachment is no longer available.");
  });
});
