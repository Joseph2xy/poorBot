import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type PricingPolicy, type PriceState } from './pricing.ts';

const policy: PricingPolicy = {
  minimumDropPercent: 10, minimumDropEuro: 2, checkIntervalMinutes: 60, resetAfterHours: 48,
};
const hour = 3_600_000;
const baseline = (price: number) => evaluate(undefined, price, policy, 0).next;

test('small drops accumulate; unchanged deals stay quiet and further drops alert', () => {
  let previous: PriceState | undefined;
  let now = 0;
  for (const [price, alert] of [[2500, false], [2400, false], [2300, false], [2250, true], [2250, false], [2200, false], [2000, true]] as const) {
    const decision = evaluate(previous, price, policy, now);
    assert.equal(decision.alert, alert, `price ${price}`);
    previous = decision.next;
    now += hour;
  }
});

test('requires 10 percent AND 2 euros, without a historical-low condition', () => {
  assert.equal(evaluate(baseline(800), 600, policy, hour).alert, true);
  assert.equal(evaluate(baseline(800), 700, policy, hour).alert, false);
  assert.equal(evaluate(baseline(6000), 5500, policy, hour).alert, false);
  assert.equal(evaluate(baseline(2000), 1800, policy, hour).alert, true);
});

test('returning sales require sustained higher observations and use the lowest recovery price', () => {
  let previous = baseline(2000);
  previous = evaluate(previous, 2500, policy, hour).next;
  previous = evaluate(previous, 2000, policy, 2 * hour).next;
  assert.equal(previous.higherSince, undefined);
  for (let time = 3; time <= 51; time++) {
    const decision = evaluate(previous, time === 27 ? 2400 : 2600, policy, time * hour);
    assert.equal(decision.alert, false);
    assert.equal(decision.next.reference, time === 51 ? 2400 : 2000);
    previous = decision.next;
  }
  assert.equal(previous.higherSince, undefined);
  assert.equal(previous.recoveryFloor, undefined);
  const returning = evaluate(previous, 2000, policy, 52 * hour);
  assert.equal(returning.alert, true);
  assert.equal(returning.reference, 2400);
  assert.equal(returning.next.reference, 2000);
});

test('downtime and failed source checks cannot establish a higher baseline', () => {
  const beforeGap = evaluate(baseline(2000), 2500, policy, hour).next;
  const afterGap = evaluate(beforeGap, 2600, policy, 168 * hour).next;
  assert.equal(afterGap.reference, 2000);
  assert.equal(afterGap.higherSince, 168 * hour);
  assert.equal(afterGap.recoveryFloor, 2600);
  assert.equal(evaluate(afterGap, 2000, policy, 169 * hour).alert, false);
  // A newly observed low price still qualifies after any duration of downtime.
  assert.equal(evaluate(beforeGap, 1800, policy, 168 * hour).alert, true);
  assert.equal(beforeGap.higherSince, hour);
  assert.equal(beforeGap.recoveryFloor, 2500);
});

test('recovery permits short scheduling delays but resets beyond two intervals', () => {
  const recovering = evaluate(baseline(2000), 2500, policy, hour).next;
  assert.equal(evaluate(recovering, 2500, policy, 3 * hour).next.higherSince, hour);
  assert.equal(evaluate(recovering, 2500, policy, 3 * hour + 1).next.higherSince, 3 * hour + 1);
  assert.equal(evaluate(recovering, 2500, policy, 0).next.higherSince, 0);
});
