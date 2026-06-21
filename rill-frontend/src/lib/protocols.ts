export type ProtocolCategory = "DEX" | "Lending" | "Staking" | "NFT" | "Oracle" | "Identity" | "Bridge";

export type ActionDef = {
  id: string;
  name: string;
  description: string;
  inputs: { key: string; label: string; type: "string" | "number" | "address" | "token" }[];
};

export type Protocol = {
  id: string;
  name: string;
  tagline: string;
  category: ProtocolCategory;
  color: "mint" | "peach" | "sky" | "lilac";
  actions: ActionDef[];
};

export const PROTOCOLS: Protocol[] = [
  {
    id: "cetus",
    name: "Cetus",
    tagline: "Concentrated-liquidity DEX on Sui",
    category: "DEX",
    color: "mint",
    actions: [
      { id: "swap", name: "Swap tokens", description: "Swap one token for another via Cetus pools.", inputs: [
        { key: "tokenIn", label: "Token In", type: "token" },
        { key: "tokenOut", label: "Token Out", type: "token" },
        { key: "amount", label: "Amount", type: "number" },
      ]},
      { id: "addLiquidity", name: "Add liquidity", description: "Provide liquidity to a Cetus pool.", inputs: [
        { key: "pool", label: "Pool", type: "string" },
        { key: "amountA", label: "Amount A", type: "number" },
        { key: "amountB", label: "Amount B", type: "number" },
      ]},
    ],
  },
  {
    id: "navi",
    name: "Navi",
    tagline: "Lending & borrowing protocol",
    category: "Lending",
    color: "sky",
    actions: [
      { id: "supply", name: "Supply asset", description: "Deposit collateral into Navi.", inputs: [
        { key: "asset", label: "Asset", type: "token" },
        { key: "amount", label: "Amount", type: "number" },
      ]},
      { id: "borrow", name: "Borrow asset", description: "Borrow against deposited collateral.", inputs: [
        { key: "asset", label: "Asset", type: "token" },
        { key: "amount", label: "Amount", type: "number" },
      ]},
      { id: "repay", name: "Repay loan", description: "Repay outstanding debt.", inputs: [
        { key: "asset", label: "Asset", type: "token" },
        { key: "amount", label: "Amount", type: "number" },
      ]},
    ],
  },
  {
    id: "scallop",
    name: "Scallop",
    tagline: "Money market on Sui",
    category: "Lending",
    color: "peach",
    actions: [
      { id: "deposit", name: "Deposit", description: "Deposit assets to earn yield.", inputs: [
        { key: "asset", label: "Asset", type: "token" },
        { key: "amount", label: "Amount", type: "number" },
      ]},
      { id: "withdraw", name: "Withdraw", description: "Withdraw supplied liquidity.", inputs: [
        { key: "asset", label: "Asset", type: "token" },
        { key: "amount", label: "Amount", type: "number" },
      ]},
    ],
  },
  {
    id: "haedal",
    name: "Haedal",
    tagline: "Liquid staking for SUI",
    category: "Staking",
    color: "lilac",
    actions: [
      { id: "stake", name: "Stake SUI", description: "Stake SUI and mint haSUI.", inputs: [
        { key: "amount", label: "Amount of SUI", type: "number" },
      ]},
      { id: "unstake", name: "Unstake", description: "Redeem haSUI for SUI.", inputs: [
        { key: "amount", label: "Amount of haSUI", type: "number" },
      ]},
    ],
  },
  {
    id: "bluemove",
    name: "BlueMove",
    tagline: "NFT marketplace",
    category: "NFT",
    color: "peach",
    actions: [
      { id: "list", name: "List NFT", description: "List an NFT for sale.", inputs: [
        { key: "nft", label: "NFT ID", type: "string" },
        { key: "price", label: "Price (SUI)", type: "number" },
      ]},
      { id: "buy", name: "Buy NFT", description: "Purchase a listed NFT.", inputs: [
        { key: "listing", label: "Listing ID", type: "string" },
      ]},
    ],
  },
  {
    id: "pyth",
    name: "Pyth",
    tagline: "Real-time price oracle",
    category: "Oracle",
    color: "sky",
    actions: [
      { id: "getPrice", name: "Get price feed", description: "Read latest price for a feed.", inputs: [
        { key: "feed", label: "Feed ID", type: "string" },
      ]},
    ],
  },
  {
    id: "suins",
    name: "SuiNS",
    tagline: "Sui name service",
    category: "Identity",
    color: "mint",
    actions: [
      { id: "resolve", name: "Resolve name", description: "Resolve a .sui name to an address.", inputs: [
        { key: "name", label: "Name", type: "string" },
      ]},
      { id: "register", name: "Register name", description: "Register a new .sui name.", inputs: [
        { key: "name", label: "Name", type: "string" },
        { key: "years", label: "Years", type: "number" },
      ]},
    ],
  },
  {
    id: "wormhole",
    name: "Wormhole",
    tagline: "Cross-chain bridge",
    category: "Bridge",
    color: "lilac",
    actions: [
      { id: "bridge", name: "Bridge asset", description: "Bridge tokens to/from Sui.", inputs: [
        { key: "asset", label: "Asset", type: "token" },
        { key: "amount", label: "Amount", type: "number" },
        { key: "destination", label: "Destination chain", type: "string" },
      ]},
    ],
  },
  {
    id: "deepbook",
    name: "DeepBook",
    tagline: "On-chain central limit order book",
    category: "DEX",
    color: "sky",
    actions: [
      { id: "limit_order", name: "Place limit order", description: "Place a limit order on a DeepBook pool (needs a funded BalanceManager).", inputs: [
        { key: "poolKey", label: "Pool", type: "string" },
        { key: "balanceManagerId", label: "BalanceManager", type: "address" },
        { key: "depositSui", label: "Deposit SUI", type: "number" },
        { key: "price", label: "Price", type: "number" },
        { key: "quantity", label: "Quantity", type: "number" },
        { key: "isBid", label: "Side (bid?)", type: "string" },
      ]},
    ],
  },
];

/** Protocols with live Rill backend compile support (testnet). */
export const BACKEND_PROTOCOL_IDS = new Set(["cetus", "haedal", "deepbook"]);
