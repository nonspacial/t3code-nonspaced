import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { readComposerImageBytes } from "~/components/chat/composerAttachmentFiles";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { capturePreviewAnnotationScreenshot } from "~/lib/previewAnnotation";

/** Puts an annotation of a 3D view in the composer, with its screenshot as an image. */
export function useAttachModelAnnotation() {
  const gt = useGT();
  const addPreviewAnnotation = useComposerDraftStore((store) => store.addPreviewAnnotation);
  const addImage = useComposerDraftStore((store) => store.addImage);
  return async (composerTarget: ComposerThreadTarget, payload: PreviewAnnotationPayload) => {
    const capture = capturePreviewAnnotationScreenshot(payload);
    const annotation = capture.status === "failed" ? { ...payload, screenshot: null } : payload;
    if (capture.status === "captured") await readComposerImageBytes(capture.file);
    addPreviewAnnotation(composerTarget, annotation);
    if (capture.status === "failed") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not capture the 3D view"),
          description: gt("The annotation was kept without the screenshot."),
        }),
      );
      return;
    }
    if (capture.status === "captured" && annotation.screenshot) {
      addImage(composerTarget, {
        type: "image",
        id: annotation.id,
        name: capture.file.name,
        mimeType: capture.file.type,
        sizeBytes: capture.file.size,
        previewUrl: annotation.screenshot.dataUrl,
        file: capture.file,
      });
    }
  };
}
