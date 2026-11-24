import * as Schema from "effect/Schema";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";

// The chrome the 3D and `.blend` previews share, kept apart from three.js so `.blend` loads light.
const FACTS_OPEN_STORAGE_KEY = "t3code.modelPreviewFactsOpen";

export function PreviewStatusChip(props: {
  readonly tone: "info" | "success" | "warning" | "error";
  readonly children: ReactNode;
}) {
  return (
    <span className="surface-glass inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-2xs text-foreground shadow-xs">
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          props.tone === "info" && "bg-info",
          props.tone === "success" && "bg-success",
          props.tone === "warning" && "bg-warning",
          props.tone === "error" && "bg-destructive",
        )}
      />
      <span className="truncate">{props.children}</span>
    </span>
  );
}

export function PreviewAction(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.label}
            size="icon-xs"
            variant="glass"
            disabled={props.disabled ?? false}
            onClick={props.onPress}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** A collapsible box of label and value rows; whether it is open is remembered across previews. */
export function PreviewFacts(props: {
  readonly title: ReactNode;
  readonly rows: ReadonlyArray<readonly [label: string, value: ReactNode]>;
}) {
  const [open, setOpen] = useLocalStorage(FACTS_OPEN_STORAGE_KEY, true, Schema.Boolean);
  return (
    <div className="surface-glass absolute end-2 bottom-2 w-48 rounded-lg border border-border/60 text-2xs shadow-sm">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-1 px-2.5 py-1.5 text-left font-medium text-muted-foreground hover:text-foreground">
          {props.title}
          <ChevronDownIcon
            className={cn("ms-auto size-3 transition-transform", open && "rotate-180")}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-2.5 pb-2 tabular-nums">
            {props.rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 truncate text-end text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
