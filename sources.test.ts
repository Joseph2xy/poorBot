import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchOffer, normalizeProductUrl, parseOffer, type Product } from './sources.ts';

interface FixtureData {
  offers: Array<{
    stock?: string;
    geo_preset_activable_id?: number;
    product_id?: number;
    price: { eur: { priceFees: { card: unknown }; coupon: { isCashback: boolean } } };
  }>;
  prices: Array<{
    account: boolean;
    activationPlatform: string;
    dispo: number;
    allowCard: boolean;
    region: string;
    edition: string;
    priceCard: number;
  }>;
  product?: { id?: number };
  activationCountry: { code: string; geo_presets: Array<{ id?: number }> };
}

const wow: Product = { name: 'WoW 60 days', platform: 'battlenet', url: 'https://www.allkeyshop.com/blog/prepaids/buy-world-of-warcraft-subscription-60-day-france-compare-prices/i-co/' };
const elden: Product = { name: 'Elden Ring', platform: 'steam', url: 'https://www.allkeyshop.com/blog/buy-elden-ring-cd-key-compare-prices/' };
const wowHtml = await readFile(new URL('./fixtures/wow-allkeyshop.html', import.meta.url), 'utf8');
const eldenHtml = await readFile(new URL('./fixtures/elden-ring-allkeyshop.html', import.meta.url), 'utf8');
function change(html: string, callback: (data: FixtureData) => void): string {
  const data = JSON.parse(html.match(/var gamePageTrans = (.*);/)![1]) as FixtureData;
  callback(data);
  return '<!-- Detected Currency: EUR --><script>var gamePageTrans = ' + JSON.stringify(data) + ';</script>';
}

test('WoW selects the lowest valid card total and falls back if that offer is unsuitable', () => {
  const offer = parseOffer(wowHtml, wow);
  assert.equal(offer.price, 2283);
  assert.equal(offer.merchant, 'GAMESEAL');
  assert.equal(offer.coupon, 'SEAL17AKS');
  assert.equal(offer.edition, undefined);
  for (const invalid of [{ stock: 'out_of_stock' }, { geo_preset_activable_id: 999 }, { product_id: 999 }]) {
    const html = change(wowHtml, data => Object.assign(data.offers[0], invalid));
    assert.equal(parseOffer(html, wow).price, 2306);
  }
});

test('unusable Steam offers and cheap SEO metadata are ignored', () => {
  assert.equal(parseOffer(eldenHtml, elden).price, 4249);
  assert.equal(parseOffer(eldenHtml, elden).edition, 'Standard');
  const withCheapOffer = (invalid: Partial<FixtureData['prices'][number]>) => change(eldenHtml, data => data.prices.push({ ...data.prices[0], priceCard: 0.01, ...invalid }));
  // Positive control: this same offer wins before each disqualifying change.
  assert.equal(parseOffer(withCheapOffer({}), elden).price, 1);
  for (const invalid of [{ account: true }, { activationPlatform: 'gog' }, { dispo: 0 },
    { allowCard: false }, { region: '412' }, { region: '25' }, { region: 'steamrow' },
    { region: 'unrecognized' }, { edition: '7' }]) {
    const html = withCheapOffer(invalid);
    assert.equal(parseOffer('<meta itemprop="price" content="0.01">' + html, elden).price, 4249);
  }
  const deluxe = change(eldenHtml, data => data.prices.push({ ...data.prices[0], edition: '7', priceCard: 60 }));
  assert.equal(parseOffer(deluxe, { ...elden, edition: 'Deluxe' }).price, 6000);
  assert.equal(parseOffer(deluxe, { ...elden, edition: '  dELUXE  ' }).price, 6000);
  assert.equal(parseOffer(deluxe, { ...elden, edition: '  dELUXE  ' }).edition, 'dELUXE');
});

test('fails closed on missing data, currency mismatch or no eligible offers', () => {
  assert.throws(() => parseOffer('<h1>Challenge</h1>', wow), /not found/);
  assert.throws(() => parseOffer(wowHtml.replace('Detected Currency: EUR', 'Detected Currency: USD'), wow), /currency/);
  assert.throws(() => parseOffer(change(wowHtml, data => { data.activationCountry.code = 'US'; }), wow), /France/);
  assert.throws(() => parseOffer(change(wowHtml, data => { data.offers = []; }), wow), /No matching/);
});

test('rejects invalid prices and cashback rather than sending artificial drops', () => {
  for (const value of [null, '', -1, 0, '1,00', 0.001]) {
    const html = change(wowHtml, data => { data.offers[0].price.eur.priceFees.card = value; });
    assert.equal(parseOffer(html, wow).price, 2306);
  }
  assert.equal(parseOffer(change(wowHtml, data => { data.offers[0].price.eur.coupon.isCashback = true; }), wow).price, 2306);
});

test('prepaid product and region identifiers must be present and valid', () => {
  const missingProduct = change(wowHtml, data => {
    delete data.product!.id;
    for (const offer of data.offers) delete offer.product_id;
    data.offers[0].price.eur.priceFees.card = 0.01;
  });
  assert.throws(() => parseOffer(missingProduct, wow), /identifiers/);
  for (const id of [undefined, -1, 1.5]) {
    const missingRegion = change(wowHtml, data => {
      data.activationCountry.geo_presets = [{ id: 1 }, { id }];
      for (const offer of data.offers) offer.geo_preset_activable_id = id;
    });
    assert.throws(() => parseOffer(missingRegion, wow), /No matching/);
  }
});

test('JSON extraction accepts formatting and braces in strings without executing scripts', () => {
  const json = JSON.parse(wowHtml.match(/var gamePageTrans = (.*);/)![1]);
  json.merchants['38'].name = 'Merchant }; "quoted" \\ {name}';
  const html = '<!-- Detected Currency: EUR --><script>const gamePageTrans =\n'
    + JSON.stringify(json, null, 2) + '; throw new Error("must not execute"); var extra = {};</script>';
  const offer = parseOffer(html, wow);
  assert.equal(offer.price, 2283);
  assert.equal(offer.merchant, json.merchants['38'].name);
  assert.throws(() => parseOffer('<!-- Detected Currency: EUR --><script>var gamePageTrans = {bad};</script>', wow), /invalid/);
});

test('malformed eligibility values cannot qualify a cheaper offer', () => {
  const malformedSteam = change(eldenHtml, data => {
    data.prices.push({ ...data.prices[0], priceCard: 0.01, edition: ['1'] as unknown as string });
    data.prices.push(null as unknown as FixtureData['prices'][number]);
  });
  assert.equal(parseOffer(malformedSteam, elden).price, 4249);
  const uncertainCashback = change(wowHtml, data => {
    data.offers[0].price.eur.coupon.isCashback = 'false' as unknown as boolean;
  });
  assert.equal(parseOffer(uncertainCashback, wow).price, 2306);
});

test('product URLs normalize host and tracking parameters and reject unsupported destinations before fetching', async () => {
  assert.equal(normalizeProductUrl(elden.url.replace('www.', '') + '?currency=usd#offers'), elden.url);
  assert.equal(normalizeProductUrl(wow.url), wow.url);
  for (const url of [
    'not a URL',
    elden.url.replace('https:', 'http:'),
    elden.url.replace('www.allkeyshop.com', 'www.allkeyshop.com.example.com'),
    elden.url.replace('https://', 'https://user:private-password@'),
    elden.url.replace('.com/', '.com:8443/'),
    elden.url.replace('/blog/', '/blog/fr/'),
    'https://www.allkeyshop.com/blog/',
    'https://store.steampowered.com/app/1245620/',
  ]) {
    let requested = false;
    await assert.rejects(fetchOffer({ ...elden, url }, { request: async () => {
      requested = true;
      return new Response(eldenHtml);
    } }), /AllKeyShop product comparison URL/);
    assert.equal(requested, false);
  }
});

test('fetch requests normalized HTML with a timeout and redirects disabled, then parses the response', async t => {
  const timeout = new AbortController().signal;
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 30_000);
    return timeout;
  });
  let calls = 0;
  const offer = await fetchOffer({ ...elden, url: elden.url.replace('www.', '') + '?currency=usd#offers' }, {
    request: async (url, options) => {
      calls++;
      assert.equal(url, elden.url);
      assert.equal(options?.signal, timeout);
      assert.equal(options?.redirect, 'error');
      const headers = new Headers(options?.headers);
      assert.equal(headers.get('Accept'), 'text/html');
      assert.equal(headers.get('Accept-Language'), 'en-GB,en;q=0.9');
      return new Response(eldenHtml);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(offer, parseOffer(eldenHtml, elden));
});

test('HTTP failures are reported without parsing even a valid-looking response body', async () => {
  for (const status of [301, 500]) {
    await assert.rejects(fetchOffer(elden, { request: async () => new Response(eldenHtml, { status }) }), {
      message: `AllKeyShop returned HTTP ${status}.`,
    });
  }
});

test('request and body failures expose safe errors without leaking underlying details', async () => {
  const sensitiveDetails = 'private-token-in-request-details';
  await assert.rejects(fetchOffer(elden, { request: async () => { throw new Error(sensitiveDetails); } }), {
    message: 'AllKeyShop request failed.',
  });
  const unreadable = new Response(new ReadableStream({
    start(controller) { controller.error(new Error(sensitiveDetails)); },
  }));
  await assert.rejects(fetchOffer(elden, { request: async () => unreadable }), {
    message: 'AllKeyShop response could not be read.',
  });
});
