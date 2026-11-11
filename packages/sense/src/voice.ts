/**
 * Voice control for platforms that already have a safety interlock.
 * A transcript may only ask for a safer action. It cannot arm, navigate, or designate a target.
 * Offline transcripts come from whisper.cpp (MIT). Browser transcripts can come from the
 * vendored Yandex SpeechKit client (Apache-2.0) in third_party/yandex-speechkit.
 */
export type SafetyCommand = "hold" | "return_to_base" | "land_now";

export function parseSafetyCommand(transcript: string): SafetyCommand | null {
  const text = transcript.trim().toLowerCase().replace(/[!.?]/g, "");
  if (!text) return null;
  if (/^(land now|land)$/.test(text)) return "land_now";
  if (/^(return home|return to base|go home|rtl|return)$/.test(text)) return "return_to_base";
  if (/^(hold|stop|freeze|hold position)$/.test(text)) return "hold";
  return null;
}
