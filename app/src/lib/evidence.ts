import { keccak256, toBytes, type Hex } from "viem";

export interface Observation {
  slotStart: number;
  observedAt: number;
  price: string;
}

export interface EvidenceDataset {
  mode: string;
  sourceId: string;
  datasetId: string;
  hardware: { model: string; memoryGiB: number; gpuCount: number; region: string };
  currency: string;
  units: string;
  priceDecimals: number;
  slotSeconds: number;
  periodStart: number;
  periodEnd: number;
  publishedAt: number;
  indexId: Hex;
  specHash: Hex;
  observations: Observation[];
}

export interface EvidenceCheck {
  hashMatches: boolean;
  computedHash: Hex;
  priceMatches: boolean | null;
  computedMean: bigint | null;
  methodology: string | null;
  dataset: EvidenceDataset | null;
  parseError: string | null;
}

// The workflow hashes the canonical JSON string as UTF-8, so the served file must be byte-identical to it.
export function hashEvidence(text: string): Hex {
  return keccak256(toBytes(text));
}

// Equal-slot mean, rounded down: the methodology "equal-slot-mean-floor-v1".
export function meanFloor(observations: readonly Observation[]): bigint | null {
  if (observations.length === 0) return null;
  const total = observations.reduce((sum, o) => sum + BigInt(o.price), 0n);
  return total / BigInt(observations.length);
}

export function checkEvidence(text: string, onchain: { evidenceHash: Hex; price: bigint }): EvidenceCheck {
  const computedHash = hashEvidence(text);
  const hashMatches = computedHash.toLowerCase() === onchain.evidenceHash.toLowerCase();
  try {
    const parsed = JSON.parse(text) as { methodology?: string; dataset?: EvidenceDataset };
    const dataset = parsed.dataset ?? null;
    if (!dataset || !Array.isArray(dataset.observations)) {
      return { hashMatches, computedHash, priceMatches: null, computedMean: null, methodology: parsed.methodology ?? null, dataset: null, parseError: "no dataset.observations in evidence file" };
    }
    const computedMean = meanFloor(dataset.observations);
    return {
      hashMatches,
      computedHash,
      computedMean,
      priceMatches: computedMean === null ? null : computedMean === onchain.price,
      methodology: parsed.methodology ?? null,
      dataset,
      parseError: null,
    };
  } catch (error) {
    return { hashMatches, computedHash, priceMatches: null, computedMean: null, methodology: null, dataset: null, parseError: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const text = await response.text();
    // Vite's dev server answers unknown paths with index.html; treat that as missing.
    return text.trimStart().startsWith("<") ? null : text;
  } catch {
    return null;
  }
}
