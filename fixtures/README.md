# Parser fixture provenance

These files retain selected offer fields from public AllKeyShop pages captured on September 27, 2026. They contain the EUR marker, a JavaScript data wrapper, and the JSON fields used by the parser. They are fixed test inputs, not complete page copies or current offers. Tests parse their JSON and never execute page scripts.

| Fixture | Source |
| --- | --- |
| `elden-ring-allkeyshop.html` | [Elden Ring comparison page](https://www.allkeyshop.com/blog/buy-elden-ring-cd-key-compare-prices/) |
| `wow-allkeyshop.html` | [World of Warcraft 60-day France comparison page](https://www.allkeyshop.com/blog/prepaids/buy-world-of-warcraft-subscription-60-day-france-compare-prices/i-co/) |

Merchant names, coupon strings, offer prices and region identifiers come from those captures. Test mutations add synthetic unavailable, incompatible-region, wrong-product and wrong-platform offers. No upstream redistribution license is recorded for the captured data.
