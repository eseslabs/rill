import type * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription, DialogClose } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Visual/behavioral shell for the flow builder's dialogs (export, simulate,
 * discover). Composes the project's existing accessible Radix wrapper
 * (components/ui/dialog.tsx) instead of the hand-rolled `motion.div` overlay
 * the three dialogs used to duplicate — focus trap, Escape-to-close, and
 * aria-labelledby/aria-describedby wiring come from Radix for free.
 *
 * `DialogContent` in ui/dialog.tsx bakes in a fixed `bg-black/80` overlay
 * with no className passthrough, so matching the flow dialogs' actual
 * `bg-foreground/30 backdrop-blur-sm` treatment means composing
 * `DialogPortal` + `DialogOverlay` (which DOES take a className) and the raw
 * Radix `Content` primitive directly, rather than the pre-built
 * `DialogContent`. `Dialog`, `DialogTitle`, `DialogDescription`, and
 * `DialogClose` are still the exact ui/dialog.tsx exports.
 */
export function DialogShell({
  open,
  onOpenChange,
  eyebrow,
  title,
  description,
  contentClassName,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="cursor-pointer bg-foreground/30 backdrop-blur-sm" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 cursor-default overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-float)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2 focus:outline-none",
            contentClassName,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              {eyebrow && (
                <div className="flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground">
                  {eyebrow}
                </div>
              )}
              <DialogTitle className="font-display text-2xl tracking-tight">{title}</DialogTitle>
              {description && (
                <DialogDescription className="mt-1 text-sm text-muted-foreground">{description}</DialogDescription>
              )}
            </div>
            <DialogClose className="shrink-0 cursor-pointer rounded-full p-1.5 text-foreground/70 transition hover:bg-secondary hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogClose>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
