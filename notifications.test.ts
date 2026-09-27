import test from 'node:test';
import assert from 'node:assert/strict';
import { priceAlert } from './notifications.ts';
import type { Decision } from './pricing.ts';
import type { Offer } from './sources.ts';

const offer: Offer = { title: 'Elden Ring', url: 'https://www.allkeyshop.com/blog/buy-elden-ring-cd-key-compare-prices/',
  price: 1999, merchant: 'Example Store', coupon: 'SAVE10', source: 'AllKeyShop' };
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
    { name: 'Store', value: 'Example Store', inline: true },
    { name: 'Coupon', value: 'SAVE10', inline: true },
  ]);
  assert.equal(embed.footer?.text,
    'Prices via AllKeyShop • Advertised EUR price; confirm the final total at checkout.');
});

test('price alert disables mentions and omits absent store and coupon fields', () => {
  const value = { ...offer, title: '@everyone', merchant: '', coupon: undefined };
  assert.deepEqual(priceAlert(value, decision).allowedMentions, { parse: [] });
  assert.deepEqual(embedFor(value).fields, []);
});

test('alerts identify separately tracked Steam editions even when game names match', () => {
  for (const edition of ['Standard', 'Deluxe']) {
    const embed = embedFor({ ...offer, edition });
    assert.equal(embed.title, 'Elden Ring — price dropped');
    assert.deepEqual(embed.fields![0], { name: 'Edition', value: edition, inline: true });
  }
  assert.equal(embedFor({ ...offer, edition: 'E'.repeat(1000) }).fields![0].value, 'E'.repeat(200));
});

test('price alert preserves source attribution with a default for missing source', () => {
  assert.match(embedFor({ ...offer, source: 'Example Source' }).footer!.text, /^Prices via Example Source •/);
  assert.match(embedFor({ ...offer, source: '' }).footer!.text, /^Prices via AllKeyShop •/);
});

test('price alert caps source title, store, and coupon text within Discord field limits', () => {
  const embed = embedFor({ ...offer, title: 'T'.repeat(1000), merchant: 'M'.repeat(1000), coupon: 'C'.repeat(1000) });
  assert.equal(embed.title, `${'T'.repeat(200)} — price dropped`);
  assert.ok(embed.title.length <= 256);
  assert.equal(embed.fields![0].value, 'M'.repeat(200));
  assert.equal(embed.fields![1].value, 'C'.repeat(200));
});
