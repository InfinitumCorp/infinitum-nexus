/**
 * ei·det·ic interface scaffold.
 * Authorized, lawful identity intelligence only.
 * No biometric implementation in this phase — this is the contract Spectre and others call.
 */

export interface IdentityQuery {
  /** Opaque subject reference (never a raw biometric). */
  subjectRef: string;
  /** Purpose of the query (audit logged). */
  purpose: string;
  /** Requesting product / CID. */
  requester: string;
}

export interface IdentityResult {
  subjectRef: string;
  /** Confidence 0..1; 0 if no match or unauthorized. */
  confidence: number;
  /** Attributes that are allowed to be returned. */
  attributes: Record<string, string>;
  /** Firmament audit reference. */
  auditRef?: string;
}

export interface EideticService {
  query(input: IdentityQuery): Promise<IdentityResult>;
}

/** Stub service that always returns no match. Real implementation is out of scope. */
export const stubEidetic: EideticService = {
  async query(input) {
    return {
      subjectRef: input.subjectRef,
      confidence: 0,
      attributes: {},
    };
  },
};
