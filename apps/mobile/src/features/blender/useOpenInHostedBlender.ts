import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { msg, useGT } from "gt-react-native";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { hostedBlenderEnvironment, useHostedBlenderState } from "../../state/hostedBlender";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const noPermission = Atom.make(false);

/**
 * "Open in hosted Blender" for a workspace `.blend`: starts the thread's hosted Blender with it,
 * then shows Blender. Watching a Blender that already has the file open needs no more than
 * seeing the thread; starting one needs `orchestration:operate`.
 */
export function useOpenInHostedBlender(
  target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly relativePath: string;
  } | null,
) {
  const gt = useGT();
  const navigation = useNavigation();
  const state = useHostedBlenderState(target).data;
  const canOpen = useAtomValue(
    target === null
      ? noPermission
      : hostedBlenderEnvironment.open.permissionAtom(target.environmentId),
  );
  const open = useAtomCommand(hostedBlenderEnvironment.open, { reportFailure: false });
  const [pending, setPending] = useState(false);
  if (target === null || state === null || state.status === "unavailable") return null;
  const alreadyOpen =
    (state.status === "running" || state.status === "starting") &&
    state.relativePath === target.relativePath;
  if (!canOpen && !alreadyOpen) return null;

  const showBlender = () =>
    navigation.navigate("ThreadBlender", {
      environmentId: String(target.environmentId),
      threadId: String(target.threadId),
    });
  const openFile = async () => {
    // Blender explains what's missing; there is nothing to start yet.
    if (alreadyOpen || state.status === "notSetUp") return showBlender();
    setPending(true);
    const result = await open({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, relativePath: target.relativePath },
    }).finally(() => setPending(false));
    if (result._tag === "Success") return showBlender();
    Dialog.alert(
      m(msg("Couldn't open in hosted Blender")),
      formatEnvironmentQueryError(result.cause),
    );
  };
  return {
    title: gt("Open in hosted Blender"),
    disabled: pending,
    onPress: () => void openFile(),
  };
}
