import type { MessageCreateOptions } from 'discord.js';
import type { Decision } from './pricing.ts';
import type { Offer } from './sources.ts';

const euro = (value: number) => `€${(value / 100).toFixed(2)}`;

export function priceAlert(offer: Offer, decision: Decision): MessageCreateOptions {
  const fields = [];
  if (offer.edition) fields.push({ name: 'Edition', value: offer.edition.slice(0, 200), inline: true });
  if (offer.merchant) fields.push({ name: 'Store', value: offer.merchant.slice(0, 200), inline: true });
  if (offer.coupon) fields.push({ name: 'Coupon', value: offer.coupon.slice(0, 200), inline: true });
  return {
    allowedMentions: { parse: [] },
    embeds: [{
      title: `${offer.title.slice(0, 200)} — price dropped`,
      url: offer.url,
      description: `${euro(decision.reference)} → **${euro(offer.price)}**\nSave ${euro(decision.saving)} (${Math.round(decision.saving / decision.reference * 100)}%).`,
      fields,
      footer: { text: `Prices via ${offer.source || 'AllKeyShop'} • Advertised EUR price; confirm the final total at checkout.` },
    }],
  };
}
