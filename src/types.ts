export type Side = 'R1' | 'R2';
export type Strategy = 'discard_pair' | 'keep_singletons';
export type Category = 'paired' | 'singleton_R1' | 'singleton_R2' | 'dropped_pair';

export interface Limits {
  maxBytes: number;
  maxRecords: number;
  maxRecordLength: number;
}

export interface TrimParams {
  windowSize: number;
  qualityThreshold: number;
  minLength: number;
  maxNRatio: number;
}

export interface FastqRecord {
  recordNumber: number;
  name: string;
  description: string;
  headerLine: string;
  sequence: string;
  plusLine: string;
  quality: string;
  pairKey: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  side?: Side;
  recordNumber?: number;
  column?: number;
}

export interface TrimEvidence {
  windowSize: number;
  firstFailedWindowStart: number | null;
  windowQualitySum: number | null;
  thresholdSum: number;
}

export interface TrimDecision {
  cutPosition: number;
  passed: boolean;
  reasons: string[];
  evidence: TrimEvidence;
}

export interface PairRecord {
  ordinal: number;
  pairKey: string;
  R1: FastqRecord;
  R2: FastqRecord;
}

export interface PairResult extends PairRecord {
  category: Category;
  r1: TrimDecision;
  r2: TrimDecision;
}

export interface RunStats {
  totalPairs: number;
  paired: number;
  singletonR1: number;
  singletonR2: number;
  droppedPairs: number;
}
