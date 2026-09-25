"use client";

import * as React from "react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import { cn } from "@/lib/cn";

/**
 * Conferma per le azioni distruttive (AlertDialog di shadcn/ui), al posto di window.confirm: quella
 * del browser è un riquadro grigio di sistema, fuori stile, e su mobile copre tutta la pagina.
 *
 * Uso: const confirm = useConfirm(); ... if (!(await confirm({ title, description }))) return;
 * e poi rendere {confirm.element} una volta nel componente.
 */
interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
}

export function useConfirm() {
  const [state, setState] = React.useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

  const ask = React.useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...options, resolve })),
    [],
  );

  function close(ok: boolean) {
    state?.resolve(ok);
    setState(null);
  }

  const element = (
    <AlertDialogPrimitive.Root open={state !== null} onOpenChange={(open) => !open && close(false)}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay onClick={(e) => e.stopPropagation()} className="fixed inset-0 z-[60] bg-black/80 data-[state=open]:animate-overlay-in" />
        <AlertDialogPrimitive.Content
          // Il bottone che apre la conferma può stare dentro una <Link> (card): i click qui dentro
          // non devono risalire e far navigare.
          onClick={(e) => e.stopPropagation()}
          className="fixed inset-x-4 top-[20vh] z-[60] mx-auto max-w-md space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-2xl data-[state=open]:animate-dialog-in"
        >
          <div className="space-y-1.5">
            <AlertDialogPrimitive.Title className="font-display text-lg font-semibold text-ink">{state?.title}</AlertDialogPrimitive.Title>
            {state?.description && (
              <AlertDialogPrimitive.Description className="text-sm leading-relaxed text-muted">{state.description}</AlertDialogPrimitive.Description>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Cancel className="btn btn-secondary" onClick={() => close(false)}>
              Annulla
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action className={cn("btn", state?.destructive ? "btn-danger" : "btn-primary")} onClick={() => close(true)}>
              {state?.confirmLabel ?? "Conferma"}
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );

  return Object.assign(ask, { element });
}
