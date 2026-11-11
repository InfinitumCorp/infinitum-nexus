/**
 * Face boxes only, for redaction. Identity is refused unless the person has consented.
 * The detector to run in production is MediaPipe (Apache-2.0, google-ai-edge/mediapipe).
 * This module does not store a face embedding or a gallery.
 */
export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ConsentRequired extends Error {
  constructor() {
    super("Face identity needs the person's consent.");
    this.name = "ConsentRequired";
  }
}

export function redactFaces(boxes: readonly FaceBox[]): { engine: "mediapipe"; redactions: number } {
  return { engine: "mediapipe", redactions: boxes.length };
}

/** Consent must be an explicit token from the person in the frame. A blank string is not consent. */
export function faceIdentity(consent: string): { allowed: true; consent: string } {
  const token = consent.trim();
  if (!token) throw new ConsentRequired();
  return { allowed: true, consent: token };
}
