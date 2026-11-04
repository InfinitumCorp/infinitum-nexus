/**
 * VEIL rewards.
 * Tracks browsing-time rewards in $VEIL.
 */
export interface RewardEvent {
  user: string;
  seconds: number;
  veil: string;
  at: string;
}

const RATE = 0.001; // $VEIL per second (scaffold)

export function accrue(user: string, seconds: number): RewardEvent {
  return {
    user,
    seconds,
    veil: (seconds * RATE).toFixed(6),
    at: new Date().toISOString(),
  };
}

export function sessionBonus(seconds: number): number {
  return seconds >= 60 ? Math.floor(seconds / 60) * 0.05 : 0;
}
