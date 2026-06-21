import { Box } from "lucide-react";
import { cn } from "@/lib/utils";

export const PROTOCOL_LOGOS: Record<string, string> = {
  cetus:
    "https://camo.githubusercontent.com/0a4950f46878c9f295174757bcffbd129ce234beec47cebb8c975af86328b9dc/68747470733a2f2f617263686976652e63657475732e7a6f6e652f6173736574732f696d6167652f6c6f676f2e706e67",
  haedal: "https://images.cryptorank.io/coins/150x150.haedal1705486502241.png",
  deepbook:
    "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSHPQ4VZxqTG1rkMr4buTO8Y0ZsGX87X8r2iWeSdHQ7OQ&s=10",
};

type Props = {
  protocolId: string;
  name: string;
  className?: string;
  imgClassName?: string;
};

export function ProtocolLogo({ protocolId, name, className, imgClassName }: Props) {
  const src = PROTOCOL_LOGOS[protocolId];

  if (!src) {
    return (
      <span
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
          className,
        )}
      >
        <Box className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-background ring-1 ring-border/60",
        className,
      )}
    >
      <img
        src={src}
        alt={`${name} logo`}
        className={cn("h-full w-full object-cover", imgClassName)}
        loading="lazy"
        decoding="async"
        onError={(e) => {
          e.currentTarget.style.display = "none";
        }}
      />
    </span>
  );
}
