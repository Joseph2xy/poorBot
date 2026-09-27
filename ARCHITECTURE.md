# Architecture review — 2026-09-27

The bot-only rework is adequate for this app. A rewrite would not remove the difficult parts: interpreting AllKeyShop offers, deciding when a returning sale qualifies, and saving price state safely around an external Discord send. The current five production modules give those responsibilities clear homes without introducing a framework.

## What the app needs

One Discord bot manages one shared product list, checks it immediately and then hourly by default, and sends qualifying alerts to one channel. Commands, scheduled checks, and delivery share one process and one JSON store. No webhook, separate watcher, or CLI is needed.

`tracker.json` stores tracked products, settings, and each product's reference/current price and recovery timestamps. It is price state, not a chronological log of every observation. This review leaves the existing store, IDs, settings, saved prices, credentials, and rollback backups unchanged. No data migration is required.

## Why the remaining pieces exist

| Piece | Concrete purpose | Assessment |
| --- | --- | --- |
| `bot.ts` | Discord permissions, replies, destination, connection and shutdown | Keep Discord-specific work at the boundary. |
| `tracker.ts` | Product management, check loop, serialization and persistence | These operations share one state owner; splitting them into services or repositories would add navigation without simplifying behavior. |
| `pricing.ts` | Pure drop/recovery decisions | Keep separate: this is the product policy and benefits from deterministic tests. |
| `sources.ts` | Fetch and interpret eligible AllKeyShop offers | Region, platform, edition, stock, coupon and currency checks prevent false deals. They are necessary domain rules. |
| `notifications.ts` | Format a Discord alert | Small enough to merge, but the separation makes presentation independently testable. Moving it saves no meaningful complexity. |
| Atomic JSON replacement | Save products and their state together | Appropriate for a small list; no database is needed. |
| Lifetime lock | Prevent a second process writing the same store | Solves a different problem from serialization inside the process. |
| Mutation queue | Keep scheduled checks and commands from overwriting each other | Retain the small queue. Read-only lists can return a cloned snapshot immediately. |
| Command busy guard | Avoid accumulating manual checks and mutations behind network work | Keep for add/remove/check; exclude list because reading does not need to wait. |
| Fatal storage-error state | Stop further sends/mutations after a failed save | Continuing would use state that the next restart cannot recover. |

## Changes from this review

- Allow `/games list` during another command. Its completion or failure cannot release the other command's busy guard.
- Carry the selected Steam edition through parsing to the alert, and show it in successful, failed, and preview check results. Standard and Deluxe can have identical display names, so the edition must remain visible.
- Reject clearly unsupported prepaid products when adding them, without a network request. Previously they could be saved and fail every check. The actual page parser still validates the product and eligibility when checking.
- Add request-boundary tests for canonical URLs, rejected URLs, request options, HTTP failures, and sanitized fetch/body-read failures. Existing tests covered parsing but did not exercise the request adapter despite the README's claim.

## Changes not justified by the current requirements

A database, external scheduler, generic source framework, persistent delivery queue, or separate deployment services would create new moving parts. The current one-process ownership model avoids needing them. Nor would merging files or removing validation simplify the actual behavior.

The returning-sale policy has real complexity, but removing it changes the product: comparing only with the previous observation misses accumulated small reductions; comparing forever with the lowest alerted price misses returning sales. The existing bounded recovery state handles both without keeping an entire price history.

## Verification and practical limits

The initial typecheck and all 42 existing tests passed. Two independent reviews examined architecture and correctness before implementation. After the changes, `npm test` passed typechecking and all 51 tests. A third reviewer independently compared the completed code and tests with the pre-change snapshot and found no blocking issues or regressions. The added tests cover the changed behavior and request boundary.

The final SHA-256 comparison confirmed that `tracker.json` remains byte-for-byte identical to the pre-change backup in `backups/architecture-review-20260927-185556/`. That directory also contains the source snapshot for reviewing or rolling back these changes.

A read-only live request for the tracked WoW product also parsed successfully. It did not save observations or contact Discord. The already-running bot was detected and left running; edited code takes effect on its next restart. Tests use temporary stores and mocked Discord calls. No real command or alert delivery was used as a test.

Remaining limits are explicit and reasonable at this scale:

- AllKeyShop embeds undocumented data. Fixture tests cannot guarantee future page compatibility.
- A successful Discord send followed by a crash before saving can produce a duplicate on restart. Eliminating this fully requires delivery guarantees beyond a local JSON store.
- The file lock needs manual recovery after an unclean exit; a clean shutdown releases it. Automatic deletion based only on a PID risks removing another process's lock.
- Shutdown waits for an in-flight operation, including its network timeout, then saves completed progress.
- Hourly checks require the computer and bot process to remain running. Hosting and automatic service restart are separate operational needs.

Reconsider the architecture if there is a concrete new requirement such as multiple independent servers, many concurrent users, time-series reporting, or more price sources. None is needed to support the present app.
