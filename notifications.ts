import type { MessageCreateOptions } from 'discord.js';
import type { Decision } from './pricing.ts';
import type { Offer } from './sources.ts';

const euro = (value: number) => `€${(value / 100).toFixed(2)}`;

function offerFields(offer: Offer) {
  const fields = [];
  if (offer.edition) fields.push({ name: 'Edition', value: offer.edition.slice(0, 200), inline: true });
  fields.push({ name: 'Store', value: offer.merchant.slice(0, 200), inline: true });
  if (offer.coupon) fields.push({ name: 'Coupon', value: offer.coupon.slice(0, 200), inline: true });
  return fields;
}

const footer = { text: 'Prices via AllKeyShop • Advertised EUR price; confirm the final total at checkout.' };

export function priceAlert(offer: Offer, decision: Decision): MessageCreateOptions {
  return {
    content: '@everyone',
    allowedMentions: { parse: ['everyone'] },
    embeds: [{
      title: `${offer.title.slice(0, 200)} — price dropped`,
      url: offer.url,
      description: `${euro(decision.reference)} → **${euro(offer.price)}**\nSave ${euro(decision.saving)} (${Math.round(decision.saving / decision.reference * 100)}%).`,
      fields: offerFields(offer),
      footer,
    }],
  };
}

export function priceUpdate(offer: Offer): MessageCreateOptions {
  return {
    allowedMentions: { parse: [] },
    embeds: [{
      title: `${offer.title.slice(0, 200)} — price check`,
      url: offer.url,
      description: `Current price: **${euro(offer.price)}**`,
      fields: offerFields(offer),
      footer,
      timestamp: new Date().toISOString(),
    }],
  };
}
