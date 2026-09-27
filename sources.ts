// AllKeyShop embeds the same individual offers used by its comparison table.
// Parse that JSON as data; never execute page scripts or use its aggregate SEO price.
export interface Product {
  url: string;
  name?: string;
  id?: string;
  platform: 'steam' | 'battlenet';
  edition?: string;
}

export interface Offer {
  title: string;
  edition?: string;
  url: string;
  price: number;
  merchant: string;
  coupon?: string;
  source: string;
}

interface PrepaidOffer {
  stock?: string;
  product_id?: number;
  merchant: number;
  geo_preset_buyable_id: number;
  geo_preset_activable_id: number;
  geo_preset_usable_id: number;
  price?: { eur?: {
    currency?: string;
    priceFees?: { card?: unknown };
    coupon?: { isCashback?: boolean; code?: string };
  } };
}

interface SteamOffer {
  region: string;
  account?: boolean;
  activationPlatform?: string;
  edition?: string | number;
  dispo?: number;
  allowCard?: boolean;
  priceCard?: unknown;
  merchantName?: string;
  voucher_code?: string | null;
}

interface SourceData {
  currency?: string;
  activationCountry?: { code?: string; geo_presets?: Array<{ id: number }> };
  product?: { id?: number; amount_label?: string };
  prepaid?: { name?: string };
  merchants?: Record<string, { name?: string }>;
  offers?: PrepaidOffer[];
  prices?: SteamOffer[];
  editions?: Record<string, { name?: string }>;
  regions?: Record<string, { filter_name?: string }>;
}

type Candidate = { price: number | null; merchant?: string; coupon?: string };
type ValidCandidate = Pick<Offer, 'price' | 'merchant' | 'coupon'>;

export function normalizeProductUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Use an AllKeyShop product comparison URL.'); }
  if (url.protocol !== 'https:' || !['allkeyshop.com', 'www.allkeyshop.com'].includes(url.hostname)
      || url.username || url.password || url.port
      || !/^\/blog\/(?:prepaids\/)?[a-z0-9-]+compare-prices\/(?:[a-z0-9-]+\/)?$/.test(url.pathname)) {
    throw new Error('Use an English EUR AllKeyShop product comparison URL.');
  }
  url.hostname = 'www.allkeyshop.com';
  url.search = ''; url.hash = '';
  return url.href;
}

function readOffers(html: string): SourceData {
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const match = /\b(?:var|let|const)\s+gamePageTrans\s*=\s*(?=\{)/.exec(script[1]);
    if (!match) continue;
    // Find the end of the JSON object, allowing formatting and other scripts
    // after it. Braces inside JSON strings do not delimit the object.
    const start = match.index + match[0].length;
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < script[1].length; end++) {
      const char = script[1][end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(script[1].slice(start, end + 1)) as SourceData; }
        catch { throw new Error('AllKeyShop offer data is invalid.'); }
      }
    }
    throw new Error('AllKeyShop offer data is invalid.');
  }
  throw new Error('AllKeyShop offer data was not found.');
}

function cents(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string')
      || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) return null;
  const result = Math.round(Number(value) * 100);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function prepaidOffers(data: SourceData): Array<Candidate | null> {
  if (data.currency !== 'eur' || data.activationCountry?.code !== 'FR') {
    throw new Error('Use a France prepaid comparison page priced in EUR.');
  }
  const validId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
  if (!validId(data.product?.id) || !Array.isArray(data.activationCountry.geo_presets)) {
    throw new Error('AllKeyShop product or region identifiers are missing or invalid.');
  }
  const regions = new Set(data.activationCountry.geo_presets.map(region => region?.id).filter(validId));
  return data.offers!.filter(offer => offer && offer.stock === 'in_stock' && offer.product_id === data.product!.id
    && validId(offer.merchant)
    && (['geo_preset_buyable_id', 'geo_preset_activable_id', 'geo_preset_usable_id'] as const).every(key => validId(offer[key]) && regions.has(offer[key])))
    .map(offer => {
      const price = offer.price?.eur;
      const merchant = data.merchants?.[offer.merchant];
      // Cashback is not a checkout discount, so do not treat it as one.
      if (!price || price.currency !== 'eur'
          || (price.coupon != null && (typeof price.coupon !== 'object' || price.coupon.isCashback !== false))) return null;
      return { price: cents(price.priceFees?.card), merchant: merchant?.name,
        coupon: typeof price.coupon?.code === 'string' ? price.coupon.code || undefined : undefined };
    });
}

function steamOffers(data: SourceData, product: Product): Candidate[] {
  if (product.platform && product.platform !== 'steam') throw new Error('This game page supports Steam tracking only.');
  const editionName = (product.edition || 'Standard').trim().toLowerCase();
  const edition = Object.entries(data.editions || {}).find(([, item]) => typeof item?.name === 'string' && item.name.trim().toLowerCase() === editionName)?.[0];
  if (!edition) throw new Error('Selected edition is not listed on this page; check the edition setting.');
  return data.prices!.filter(offer => {
    if (!offer || typeof offer.region !== 'string'
        || (typeof offer.edition !== 'string' && typeof offer.edition !== 'number')) return false;
    const region = data.regions?.[offer.region];
    // Explicit keys for France-compatible regions. Accounts, gifts, ROW and unknown
    // restrictions cannot become the minimum simply because they are cheaper.
    const suitableRegion = typeof region?.filter_name === 'string' && /^STEAM (?:GLOBAL|EU|EUROPE|EMEA|FRANCE)$/.test(region.filter_name);
    return offer.account === false && offer.activationPlatform === 'steam'
      && String(offer.edition) === edition && offer.dispo === 1 && offer.allowCard === true && suitableRegion;
  }).map(offer => ({ price: cents(offer.priceCard), merchant: offer.merchantName,
    coupon: typeof offer.voucher_code === 'string' ? offer.voucher_code || undefined : undefined }));
}

export function parseOffer(html: string, product: Product): Offer {
  const url = normalizeProductUrl(product.url);
  const data = readOffers(html);
  if (!/<!--\s*Detected Currency:\s*EUR\s*-->/.test(html)) throw new Error('Page currency is not confirmed as EUR.');
  const prepaid = new URL(url).pathname.includes('/prepaids/');
  let candidates: Array<Candidate | null>;
  if (prepaid && Array.isArray(data.offers)) {
    if (product.platform !== 'battlenet' || data.prepaid?.name !== 'World of Warcraft Subscription') {
      throw new Error('Prepaid tracking currently supports WoW game time on Battle.net only.');
    }
    candidates = prepaidOffers(data);
  } else if (!prepaid && Array.isArray(data.prices)) candidates = steamOffers(data, product);
  else throw new Error('AllKeyShop page format changed.');
  const validCandidates = candidates.filter((offer): offer is ValidCandidate => Boolean(offer && offer.price !== null && typeof offer.merchant === 'string' && offer.merchant.trim()));
  validCandidates.sort((a, b) => a.price - b.price);
  if (!validCandidates.length) throw new Error('No matching in-stock EUR offers.');
  const title = product.name || (prepaid ? `${data.prepaid?.name || 'Prepaid'} ${data.product?.amount_label || ''}`.trim()
    : new URL(url).pathname.split('/').filter(Boolean).at(-1)!.replace(/^buy-/, '').replace(/-(?:cd-key-|key-)?compare-prices$/, '').replaceAll('-', ' '));
  return { title, url, ...(!prepaid ? { edition: product.edition?.trim() || 'Standard' } : {}),
    ...validCandidates[0], source: 'AllKeyShop' };
}

export async function fetchOffer(product: Product, { request = fetch }: { request?: typeof fetch } = {}): Promise<Offer> {
  const url = normalizeProductUrl(product.url);
  let response: Response, html: string;
  try {
    response = await request(url, { signal: AbortSignal.timeout(30000), redirect: 'error',
      headers: { Accept: 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' } });
  } catch { throw new Error('AllKeyShop request failed.'); }
  if (!response.ok) throw new Error(`AllKeyShop returned HTTP ${response.status}.`);
  try { html = await response.text(); } catch { throw new Error('AllKeyShop response could not be read.'); }
  return parseOffer(html, product);
}
