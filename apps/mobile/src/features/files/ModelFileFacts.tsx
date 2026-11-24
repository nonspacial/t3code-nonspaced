import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type { BlendPreview } from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";
import { useGT, useMessages } from "gt-react-native";
import type { ReactNode } from "react";
import { Image, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { useContentBottomInset, useContentTopInset } from "../../components/ui/useBarInset";
import type { EnvironmentQueryView } from "../../state/query";
import { FilePreviewLoading } from "./FilePreviewFeedback";

function FactsScroll(props: { readonly children: ReactNode }) {
  const topInset = useContentTopInset();
  const bottomInset = useContentBottomInset();
  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentContainerClassName="items-center gap-4 px-4"
      contentContainerStyle={{ paddingTop: topInset + 16, paddingBottom: bottomInset + 16 }}
    >
      {props.children}
    </ScrollView>
  );
}

function FactRows(props: { readonly rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <View className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card">
      {props.rows.map(([label, value], index) => (
        <View
          key={label}
          className={
            index === 0
              ? "flex-row gap-3 px-4 py-2.5"
              : "flex-row gap-3 border-t border-border-subtle px-4 py-2.5"
          }
        >
          <Text className="text-sm text-foreground-muted">{label}</Text>
          <Text className="flex-1 text-right text-sm text-foreground" numberOfLines={2}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A `.blend`'s saved thumbnail and scene facts, read on the environment without Blender. */
export function BlendFileFacts(props: {
  readonly name: string;
  readonly query: EnvironmentQueryView<BlendPreview>;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { query } = props;
  const preview = query.data;
  if (preview === null) {
    return query.error !== null ? (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState
          title={gt("Blender file unavailable")}
          detail={query.error}
          actionLabel={gt("Try again")}
          onAction={query.refresh}
        />
      </View>
    ) : (
      <FilePreviewLoading message={gt("Reading Blender file...")} />
    );
  }
  const rows: Array<readonly [string, string]> = [];
  if (preview.scene) {
    rows.push([gt("Scene", { $context: "a Blender scene" }), preview.scene.name]);
    rows.push([
      gt("Frames", { $context: "an animation's frame range" }),
      gt("{start}–{end}", { start: preview.scene.frameStart, end: preview.scene.frameEnd }),
    ]);
  }
  if (preview.scenes > 1) rows.push([gt("Scenes"), preview.scenes.toLocaleString()]);
  rows.push([gt("Objects", { $context: "Blender objects" }), preview.objects.toLocaleString()]);
  rows.push([gt("Meshes"), preview.meshes.toLocaleString()]);
  rows.push([gt("Materials"), preview.materials.toLocaleString()]);
  for (const library of preview.libraries)
    rows.push([gt("Linked file"), fileBasename(library.replace(/^\/\//, ""))]);
  rows.push([
    gt("Saved by", { $context: "the app version that saved a file" }),
    `Blender ${preview.blenderVersion}`,
  ]);
  rows.push([
    gt("Size", { $context: "file size" }),
    formatAttachmentSize(preview.byteLength, messages),
  ]);
  return (
    <FactsScroll>
      {preview.thumbnail ? (
        <Image
          accessibilityLabel={gt("Saved thumbnail of {name}", {
            name: props.name,
          })}
          source={{ uri: preview.thumbnail.dataUrl }}
          className="aspect-square w-full max-w-xs rounded-2xl bg-card"
          resizeMode="contain"
        />
      ) : (
        <View className="aspect-square w-full max-w-xs items-center justify-center rounded-2xl bg-card px-6">
          <Text className="text-center text-sm text-foreground-muted">
            {gt("No thumbnail saved in this file")}
          </Text>
        </View>
      )}
      {preview.thumbnail ? (
        <Text className="max-w-md text-center text-xs text-foreground-muted">
          {gt(
            "Blender saves this picture with the file, so it can be out of date when a script saved the file.",
          )}
        </Text>
      ) : null}
      <FactRows rows={rows} />
    </FactsScroll>
  );
}

/** Other 3D formats render on desktop and web only. */
export function ModelFileNotice(props: {
  readonly name: string;
  readonly byteLength: number | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  return (
    <FactsScroll>
      <FactRows
        rows={[
          [gt("Name"), props.name],
          ...(props.byteLength === null
            ? []
            : [
                [
                  gt("Size", { $context: "file size" }),
                  formatAttachmentSize(props.byteLength, messages),
                ] as const,
              ]),
        ]}
      />
      <Text className="max-w-md text-center text-sm text-foreground-muted">
        {gt("Open this file in T3 Code on desktop or the web to view it in 3D.")}
      </Text>
    </FactsScroll>
  );
}
