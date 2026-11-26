import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  HostedBlenderHeldCopy,
  HostedBlenderRunningBlender,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import { heldExpiryDate } from "~/components/blender/HeldCopiesNotice";
import { fileName, useQuitHostedBlender } from "~/components/blender/useQuitHostedBlender";
import { Button } from "~/components/ui/button";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { formatBytes } from "~/lib/formatBytes";
import { useThreadShell } from "~/state/entities";
import {
  hostedBlenderEnvironment,
  useHeldWorkingCopies,
  useRunningHostedBlenders,
} from "~/state/hostedBlender";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { HostedBlenderSetupSettings } from "./HostedBlenderSetupSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function BlenderSettingsPanel() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const connected = environment?.connection.phase === "connected" ? environment : null;
  const setupEnvironmentId =
    connected?.serverConfig?.environment.capabilities.hostedBlenderSetup === true
      ? connected.environmentId
      : null;
  return (
    <SettingsPageContainer>
      <SettingsSection id="blender" title={gt("Blender")}>
        {setupEnvironmentId === null ? null : (
          <HostedBlenderSetupSettings environmentId={setupEnvironmentId} />
        )}
      </SettingsSection>
      {/* A card of its own, spaced from the setup card as settings sections are. */}
      <RunningBlenders environmentId={connected?.environmentId ?? null} />
      <HeldWorkingCopies environmentId={connected?.environmentId ?? null} />
    </SettingsPageContainer>
  );
}

/** Every hosted Blender on the environment, folded away until asked for. */
function RunningBlenders(props: { readonly environmentId: EnvironmentId | null }) {
  const gt = useGT();
  const { environmentId } = props;
  const blenders = useRunningHostedBlenders(environmentId) ?? [];
  return (
    <FoldedSettingsSection
      id="running-blenders"
      title={gt("Running Blenders ({count})", { count: blenders.length })}
    >
      {environmentId === null || blenders.length === 0 ? (
        <SettingsRow
          title={<T>No hosted Blenders are running</T>}
          description={<T>Each thread's hosted Blender shows here while it runs.</T>}
        />
      ) : (
        blenders.map((blender) => (
          <RunningBlenderRow
            key={blender.master ?? blender.threadId}
            environmentId={environmentId}
            blender={blender}
          />
        ))
      )}
    </FoldedSettingsSection>
  );
}

function RunningBlenderRow(props: {
  readonly environmentId: EnvironmentId;
  readonly blender: HostedBlenderRunningBlender;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.blender.threadId);
  const thread = useThreadShell(threadRef);
  const canQuit = useAtomValue(hostedBlenderEnvironment.quit.permissionAtom(props.environmentId));
  // A master is quit by its own key: it may be kept open with no thread left.
  const quit = useQuitHostedBlender(
    threadRef,
    props.blender,
    props.blender.master === undefined ? {} : { role: "master", master: props.blender.master },
  );
  const details = [
    props.blender.relativePath,
    props.blender.memoryBytes === null ? null : formatBytes(props.blender.memoryBytes),
  ].filter((part) => part !== null);
  return (
    <SettingsRow
      title={
        props.blender.master !== undefined ? (
          <T context="the master .blend file">Master</T>
        ) : (
          (thread?.title ?? <T>Unknown thread</T>)
        )
      }
      description={<span className="font-mono">{details.join(" · ")}</span>}
      control={
        canQuit ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={quit.quitting}
              onClick={() => quit.request(props.blender.dirty)}
            >
              <T>Quit</T>
            </Button>
            {quit.dialog}
          </>
        ) : null
      }
    />
  );
}

/** Finished threads' working copies T3 Code moved out of their projects, until they expire. */
function HeldWorkingCopies(props: { readonly environmentId: EnvironmentId | null }) {
  const gt = useGT();
  const { environmentId } = props;
  const held = useHeldWorkingCopies(environmentId) ?? [];
  return (
    <FoldedSettingsSection
      id="held-working-copies"
      title={gt("Held working copies ({count})", { count: held.length })}
    >
      {environmentId === null || held.length === 0 ? (
        <SettingsRow
          title={<T>No working copies are held</T>}
          description={
            <T>
              When a thread settles or is archived, T3 Code moves its agent's working copy out of
              the project and holds it here, so the thread can pick it up again, for up to 30 days.
            </T>
          }
        />
      ) : (
        held.map((copy) => (
          <HeldWorkingCopyRow key={copy.id} environmentId={environmentId} copy={copy} />
        ))
      )}
    </FoldedSettingsSection>
  );
}

function HeldWorkingCopyRow(props: {
  readonly environmentId: EnvironmentId;
  readonly copy: HostedBlenderHeldCopy;
}) {
  const gt = useGT();
  const m = useMessages();
  const { copy } = props;
  const canDelete = useAtomValue(
    hostedBlenderEnvironment.deleteHeld.permissionAtom(props.environmentId),
  );
  const deleteHeld = useAtomCommand(hostedBlenderEnvironment.deleteHeld, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const remove = async () => {
    setPending(true);
    const result = await deleteHeld({
      environmentId: props.environmentId,
      input: { ids: [copy.id] },
    });
    setPending(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Couldn't delete the held working copy"),
          description: formatEnvironmentQueryError(result.cause, m),
        }),
      );
    }
  };
  return (
    <SettingsRow
      title={copy.threadTitle === "" ? <T>Unknown thread</T> : copy.threadTitle}
      description={
        copy.leftInProject === true || copy.expiresAt === undefined ? (
          <T>
            Left in the project at <Var>{copy.path}</Var>: T3 Code couldn't be sure it is its own
            working copy, so it didn't move it.
          </T>
        ) : copy.behind === true ? (
          <T>
            Copy of <Var>{fileName(copy.master)}</Var>, <Var>{formatBytes(copy.bytes)}</Var>. The
            master has changed since. Deleted on <Var>{heldExpiryDate(copy.expiresAt)}</Var>.
          </T>
        ) : (
          <T>
            Copy of <Var>{fileName(copy.master)}</Var>, <Var>{formatBytes(copy.bytes)}</Var>.
            Deleted on <Var>{heldExpiryDate(copy.expiresAt)}</Var>.
          </T>
        )
      }
      control={
        canDelete && copy.leftInProject !== true ? (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => void remove()}>
            <T context="deletes a held working copy">Delete</T>
          </Button>
        ) : null
      }
    />
  );
}
