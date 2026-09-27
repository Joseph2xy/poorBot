import test from 'node:test';
import assert from 'node:assert/strict';
import { priceAlert } from './notifications.ts';
import type { Decision } from './pricing.ts';
import type { Offer } from './sources.ts';

const offer: Offer = { title: 'Elden Ring', url: 'https://www.allkeyshop.com/blog/buy-elden-ring-cd-key-compare-prices/',
  price: 1999, merchant: 'Example Store', coupon: 'SAVE10', edition: 'Deluxe' };
const decision: Decision = { alert: true, reason: 'meaningful drop', reference: 2500, saving: 501,
  next: { reference: 1999, current: 1999, checkedAt: 0 } };

function embedFor(value: Offer = offer) {
  const payload = priceAlert(value, decision);
  assert.equal(payload.embeds?.length, 1);
  const embed = payload.embeds![0];
  return 'toJSON' in embed ? embed.toJSON() : embed;
}

test('price alert includes exact EUR totals, rounded percentage, and the comparison link', () => {
  const embed = embedFor();
  assert.equal(embed.title, 'Elden Ring — price dropped');
  assert.equal(embed.url, offer.url);
  assert.equal(embed.description, '€25.00 → **€19.99**\nSave €5.01 (20%).');
  assert.deepEqual(embed.fields, [
    { name: 'Edition', value: 'Deluxe', inline: true },
    { name: 'Store', value: 'Example Store', inline: true },
    { name: 'Coupon', value: 'SAVE10', inline: true },
  ]);
  assert.equal(embed.footer?.text,
    'Prices via AllKeyShop • Advertised EUR price; confirm the final total at checkout.');
});

test('price alert disables mentions and omits absent edition and coupon fields', () => {
  const value = { ...offer, title: '@everyone', edition: undefined, coupon: undefined };
  assert.deepEqual(priceAlert(value, decision).allowedMentions, { parse: [] });
  assert.deepEqual(embedFor(value).fields, [{ name: 'Store', value: 'Example Store', inline: true }]);
});

test('long alert text remains usable within Discord title and field limits', () => {
  const embed = embedFor({ ...offer, title: 'T'.repeat(2000), edition: 'E'.repeat(2000),
    merchant: 'M'.repeat(2000), coupon: 'C'.repeat(2000) });
  assert.match(embed.title!, /^T+ — price dropped$/);
  assert.ok(embed.title!.length <= 256);
  for (const [index, letter] of ['E', 'M', 'C'].entries()) {
    assert.match(embed.fields![index].value, new RegExp(`^${letter}+$`));
    assert.ok(embed.fields![index].value.length <= 1024);
  }
});
