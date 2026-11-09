/**
 * Constant-velocity Kalman filter in 2D.
 * State: [x, y, vx, vy] in metres and metres per second.
 * Measurements: position [x, y] with an isotropic variance per sensor.
 */
export type Vec4 = [number, number, number, number];
export type Mat4 = [Vec4, Vec4, Vec4, Vec4];
export type Mat2 = [[number, number], [number, number]];

export interface KalmanState {
  x: Vec4;
  P: Mat4;
}

export function initState(px: number, py: number, posVar: number, velVar = 100): KalmanState {
  return {
    x: [px, py, 0, 0],
    P: [
      [posVar, 0, 0, 0],
      [0, posVar, 0, 0],
      [0, 0, velVar, 0],
      [0, 0, 0, velVar],
    ],
  };
}

/** Predict forward by dt seconds with white-acceleration noise q (m²/s³). */
export function predict(s: KalmanState, dt: number, q: number): KalmanState {
  if (dt <= 0) return s;
  const [x, y, vx, vy] = s.x;
  const P = s.P;
  const F: Mat4 = [
    [1, 0, dt, 0],
    [0, 1, 0, dt],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const FP = mul(F, P);
  const FPFt = mul(FP, transpose(F));
  const dt2 = dt * dt;
  const dt3 = (dt2 * dt) / 2;
  const dt4 = (dt2 * dt2) / 4;
  const Q: Mat4 = [
    [dt4 * q, 0, dt3 * q, 0],
    [0, dt4 * q, 0, dt3 * q],
    [dt3 * q, 0, dt2 * q, 0],
    [0, dt3 * q, 0, dt2 * q],
  ];
  return { x: [x + vx * dt, y + vy * dt, vx, vy], P: add(FPFt, Q) };
}

/** Innovation and its covariance for a position measurement. */
export function innovation(s: KalmanState, zx: number, zy: number, r: number): { v: [number, number]; S: Mat2 } {
  const P = s.P;
  return {
    v: [zx - s.x[0], zy - s.x[1]],
    S: [
      [P[0][0] + r, P[0][1]],
      [P[1][0], P[1][1] + r],
    ],
  };
}

export function invert2(S: Mat2): Mat2 {
  const det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
  if (Math.abs(det) < 1e-12) throw new Error("singular innovation covariance");
  return [
    [S[1][1] / det, -S[0][1] / det],
    [-S[1][0] / det, S[0][0] / det],
  ];
}

/** Squared Mahalanobis distance of a measurement from the predicted position. */
export function mahalanobis2(s: KalmanState, zx: number, zy: number, r: number): number {
  const { v, S } = innovation(s, zx, zy, r);
  const Si = invert2(S);
  return v[0] * (Si[0][0] * v[0] + Si[0][1] * v[1]) + v[1] * (Si[1][0] * v[0] + Si[1][1] * v[1]);
}

export function update(s: KalmanState, zx: number, zy: number, r: number): KalmanState {
  const { v, S } = innovation(s, zx, zy, r);
  const Si = invert2(S);
  const P = s.P;
  // K = P Hᵀ S⁻¹ ; P Hᵀ is the first two columns of P.
  const K: [number, number][] = P.map((row) => [
    row[0] * Si[0][0] + row[1] * Si[1][0],
    row[0] * Si[0][1] + row[1] * Si[1][1],
  ]);
  const x = s.x.map((xi, i) => xi + K[i]![0] * v[0] + K[i]![1] * v[1]) as Vec4;
  // P = (I − K H) P
  const newP = P.map((row, i) =>
    row.map((pij, j) => pij - (K[i]![0] * P[0][j] + K[i]![1] * P[1][j])),
  ) as Mat4;
  // Keep P symmetric against rounding drift.
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++) {
      const m = (newP[i]![j]! + newP[j]![i]!) / 2;
      newP[i]![j] = m;
      newP[j]![i] = m;
    }
  return { x, P: newP };
}

function mul(A: Mat4, B: Mat4): Mat4 {
  return A.map((row) => [0, 1, 2, 3].map((j) => row.reduce((acc, a, k) => acc + a * B[k]![j]!, 0))) as Mat4;
}

function transpose(A: Mat4): Mat4 {
  return [0, 1, 2, 3].map((i) => A.map((row) => row[i]!)) as Mat4;
}

function add(A: Mat4, B: Mat4): Mat4 {
  return A.map((row, i) => row.map((a, j) => a + B[i]![j]!)) as Mat4;
}
