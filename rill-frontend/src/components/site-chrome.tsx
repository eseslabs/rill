import { motion } from "framer-motion";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { ConnectButton } from "@mysten/dapp-kit";
import { RillMark } from "@/components/rill-mark";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 backdrop-blur-md bg-background/70 border-b border-border/60">
      <div className="mx-auto max-w-6xl px-6 h-14 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 cursor-pointer">
          <motion.span
            initial={{ rotate: -8, scale: 0.9 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 14 }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground"
          >
            <RillMark className="h-4 w-4" />
          </motion.span>
          <span className="font-display text-xl tracking-tight">Rill</span>
          <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            testnet
          </span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link to="/protocols" className="cursor-pointer px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors">
            Protocols
          </Link>
          <Link to="/docs" className="cursor-pointer px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors">
            Docs
          </Link>
          <Link to="/pitch" className="cursor-pointer px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors">
            Pitch
          </Link>
          <Link
            to="/builder"
            className="ml-2 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-foreground text-background px-3.5 py-1.5 text-sm font-medium hover:opacity-90 transition"
          >
            Open builder <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <span className="ml-2">
            <ConnectButton />
          </span>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-border/60">
      <div className="mx-auto max-w-6xl px-6 py-10 flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
        <div>© {new Date().getFullYear()} Rill</div>
        <div className="flex gap-4">
          <a href="https://sui.io" target="_blank" rel="noreferrer" className="cursor-pointer hover:text-foreground">Sui</a>
          <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer" className="cursor-pointer hover:text-foreground">MCP</a>
          <a href="https://github.com/eseslabs/rill" target="_blank" rel="noreferrer" className="cursor-pointer hover:text-foreground">GitHub</a>
        </div>
      </div>
    </footer>
  );
}
