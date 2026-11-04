/**
 * Conductor instrument adapters.
 * Real adapters (browser, HTTP APIs, Spectre, etc.) register here.
 */
import { registerInstrument, type Instrument } from "./executor.ts";

export const researchInstrument: Instrument = {
  name: "research",
  async execute(input) {
    const query = String(input.query ?? "");
    return {
      output: { summary: `Research result for: ${query}` },
      evidence: [`research:${query}`],
    };
  },
};

export const spectreInstrument: Instrument = {
  name: "spectre",
  async execute(input) {
    return {
      output: { action: "spectre-call", input },
      evidence: ["spectre:invoked"],
    };
  },
};

export const httpInstrument: Instrument = {
  name: "http",
  async execute(input) {
    const url = String(input.url ?? "");
    return {
      output: { status: 200, body: `Stub response for ${url}` },
      evidence: [`http:${url}`],
    };
  },
};

export function registerDefaultInstruments() {
  registerInstrument(researchInstrument);
  registerInstrument(spectreInstrument);
  registerInstrument(httpInstrument);
}
