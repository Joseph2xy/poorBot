export interface PricingPolicy {
  minimumDropPercent: number;
  minimumDropEuro: number;
  checkIntervalMinutes: number;
  resetAfterHours: number;
}

export interface PriceState {
  reference: number;
  current: number;
  checkedAt: number;
  higherSince?: number;
  recoveryFloor?: number;
}

export interface Decision {
  alert: boolean;
  reason: string;
  reference: number;
  saving: number;
  next: PriceState;
}

function meaningfulDrop(high: number, low: number, policy: PricingPolicy): boolean {
  const saving = high - low;
  return saving > 0 && saving >= Math.round(policy.minimumDropEuro * 100)
    && saving * 100 >= high * policy.minimumDropPercent;
}

export function evaluate(previous: PriceState | undefined, price: number, policy: PricingPolicy, now = Date.now()): Decision {
  if (!Number.isSafeInteger(price) || price < 0) throw new Error('Invalid price.');
  if (!previous) return { alert: false, reason: 'baseline recorded', reference: price, saving: 0,
    next: { reference: price, current: price, checkedAt: now } };
  const next = { ...previous, current: price, checkedAt: now };
  // Downtime is not evidence of sustained higher prices. Allow ordinary check
  // duration and scheduling delays, but restart recovery after a longer gap.
  const gap = now - previous.checkedAt;
  if (gap < 0 || gap > policy.checkIntervalMinutes * 60_000 * 2) {
    delete next.higherSince;
    delete next.recoveryFloor;
  }
  if (meaningfulDrop(price, previous.reference, policy)) {
    next.higherSince ??= now;
    next.recoveryFloor = Math.min(next.recoveryFloor ?? price, price);
    if (now - next.higherSince >= policy.resetAfterHours * 3_600_000) {
      next.reference = next.recoveryFloor;
      delete next.higherSince;
      delete next.recoveryFloor;
    }
  } else {
    delete next.higherSince;
    delete next.recoveryFloor;
  }
  const reference = next.reference;
  const alert = meaningfulDrop(reference, price, policy);
  if (alert) {
    next.reference = price;
    delete next.higherSince;
    delete next.recoveryFloor;
  }
  return { alert, reference, saving: reference - price, next,
    reason: alert ? 'meaningful drop' : 'no meaningful drop' };
}
