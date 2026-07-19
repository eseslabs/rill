import { createFileRoute } from "@tanstack/react-router";
import { MotionConfig } from "framer-motion";
import { pitchSlides } from "@/routes/pitch";

export const Route = createFileRoute("/pitch_/print")({
  head: () => ({
    meta: [{ title: "Pitch — Rill (print)" }, { name: "robots", content: "noindex" }],
  }),
  component: PitchPrintPage,
});

const PAGE_W = 1280;
// Taller than a strict 16:9 (720) — the "Composable" slide's live ReactFlow
// canvas needs the extra headroom so its heading doesn't clip.
const PAGE_H = 880;

function PitchPrintPage() {
  return (
    <MotionConfig reducedMotion="always">
      <style>{`
        @page { size: ${PAGE_W}px ${PAGE_H}px; margin: 0; }
        html, body { background: transparent; }
        * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        @media print {
          .print-slide { break-after: page; }
          .print-slide:last-child { break-after: auto; }
        }
        /* Chrome's print-to-pdf layout viewport doesn't reliably match the @page
           width for evaluating min-width media queries, so Tailwind's md: variants
           (which the live /pitch deck relies on at this width) don't engage. Force
           every md: utility actually used in the deck to its active value here —
           this page is always PAGE_W wide, so "active" is correct unconditionally. */
        .print-slide .md\\:flex { display: flex !important; }
        .print-slide .md\\:flex-row { flex-direction: row !important; }
        .print-slide .md\\:gap-4 { gap: 1rem !important; }
        .print-slide .md\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
        .print-slide .md\\:grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
        .print-slide .md\\:h-11 { height: 2.75rem !important; }
        .print-slide .md\\:h-24 { height: 6rem !important; }
        .print-slide .md\\:items-center { align-items: center !important; }
        .print-slide .md\\:items-stretch { align-items: stretch !important; }
        .print-slide .md\\:text-2xl { font-size: 1.5rem !important; line-height: 2rem !important; }
        .print-slide .md\\:text-5xl { font-size: 3rem !important; line-height: 1 !important; }
        .print-slide .md\\:text-6xl { font-size: 3.75rem !important; line-height: 1 !important; }
        .print-slide .md\\:text-8xl { font-size: 6rem !important; line-height: 1 !important; }
        .print-slide .md\\:text-left { text-align: left !important; }
        .print-slide .md\\:w-24 { width: 6rem !important; }
        .print-slide .md\\:w-56 { width: 14rem !important; }
      `}</style>
      <div>
        {pitchSlides.map((slide, i) => (
          <section
            key={i}
            className="print-slide relative flex flex-col items-center justify-center overflow-hidden bg-background px-16"
            style={{
              width: PAGE_W,
              height: PAGE_H,
              backgroundImage: "var(--gradient-aura)",
            }}
          >
            <div className="absolute top-8 left-10 text-xs uppercase tracking-[0.25em] text-muted-foreground">
              {slide.kicker}
            </div>
            <div className="absolute top-8 right-10 font-mono text-xs text-muted-foreground">
              {i + 1} / {pitchSlides.length}
            </div>
            <div className="w-full">{slide.render()}</div>
          </section>
        ))}
      </div>
    </MotionConfig>
  );
}
