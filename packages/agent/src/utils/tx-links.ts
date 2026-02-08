const EXPLORER_TX_BASES: Record<string, string> = {
  arc: "https://testnet.arcscan.app/tx/",
  ethereum: "https://sepolia.etherscan.io/tx/",
  base: "https://sepolia.basescan.org/tx/",
  avalanche: "https://testnet.snowtrace.io/tx/",
};

export function getExplorerTxBase(chainName: string): string | null {
  const envKey = `${chainName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_EXPLORER_TX_BASE`;
  const envValue = process.env[envKey];
  return envValue || EXPLORER_TX_BASES[chainName] || null;
}

export function logExplorerTx(chainName: string, txHash: string | undefined, label: string): void {
  if (!txHash) return;
  const base = getExplorerTxBase(chainName);
  if (!base) {
    console.log(`[Explorer] ${label} (${chainName}): ${txHash}`);
    return;
  }
  console.log(`[Explorer] ${label} (${chainName}): ${base}${txHash}`);
}
