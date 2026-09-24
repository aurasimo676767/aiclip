"use client";

import * as React from "react";
import { DropdownMenu as MenuPrimitive, Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@/lib/cn";

// DropdownMenu e Tooltip di shadcn/ui, adattati ai colori del sito.

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(({ className, sideOffset = 6, align = "end", ...props }, ref) => (
  <MenuPrimitive.Portal>
    <MenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      align={align}
      className={cn("z-[70] min-w-[13rem] overflow-hidden rounded-xl border border-line-strong bg-overlay p-1 shadow-[0_16px_48px_-8px_rgba(0,0,0,0.8)] data-[state=open]:animate-fade-in", className)}
      {...props}
    />
  </MenuPrimitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof MenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <MenuPrimitive.Item
    ref={ref}
    className={cn(
      "flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none transition data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      destructive ? "text-red-300 data-[highlighted]:bg-red-500/15" : "text-ink data-[highlighted]:bg-white/[0.07]",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export function DropdownMenuSeparator() {
  return <MenuPrimitive.Separator className="my-1 h-px bg-line" />;
}

export const TooltipProvider = TooltipPrimitive.Provider;

/** Tooltip semplice: <Tip label="...">{trigger}</Tip>. */
export function Tip({ label, children, side = "top" }: { label: React.ReactNode; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipPrimitive.Root delayDuration={250}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-[70] max-w-xs rounded-lg border border-line bg-overlay px-2.5 py-1.5 text-xs text-ink shadow-xl data-[state=delayed-open]:animate-fade-in"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
