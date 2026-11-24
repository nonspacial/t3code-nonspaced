import { useGT } from "gt-react-native";
import { Pressable } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

/** Watches the thread's hosted Blender, beside the thread's device and browser previews. */
export function BlenderPreviewButton(props: {
  readonly fileName: string;
  readonly onPress: () => void;
  readonly compact?: boolean;
}) {
  const compact = props.compact ?? true;
  const gt = useGT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("Watch Blender")}
      accessibilityHint={gt("Watch and control {name} in this thread's hosted Blender", {
        name: props.fileName,
      })}
      onPress={props.onPress}
      className={
        compact
          ? "size-11 shrink-0 items-center justify-center rounded-full active:bg-subtle"
          : "h-11 shrink-0 flex-row items-center justify-center gap-2 rounded-full px-4 active:bg-subtle"
      }
    >
      <SymbolView name="cube" size={20} tintColorClassName="accent-icon" type="monochrome" />
      {!compact ? (
        <AppText numberOfLines={1} className="font-t3-medium text-xs text-foreground">
          {props.fileName}
        </AppText>
      ) : null}
    </Pressable>
  );
}
