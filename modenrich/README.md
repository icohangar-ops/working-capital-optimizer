# Flair Enforcer

> Auto-flair Reddit posts with ML classification that learns from mod corrections — no config headaches.

Built for the **[Reddit Mod Tools and Migrated Apps Hackathon](https://mod-tools-migration.devpost.com)** on the Devvit platform.

---

## Inspiration

Moderating a subreddit is unpaid, thankless work — and one of the most tedious parts is flair management. Every day, thousands of moderators manually sort posts into the right categories because existing tools aren't smart enough. Reddit's native AutoModerator can assign flairs based on simple keyword matches, but it breaks the moment someone phrases something differently. Third-party tools like Toolbox require complex JavaScript snippets that only power-users can write. Meanwhile, large subreddits like r/AskReddit, r/Technology, and r/gaming process hundreds of posts per hour — there's simply no way human moderators can keep up.

We asked ourselves: **what if a mod tool could read a post, understand what it's about, and assign the right flair — while getting smarter every time a moderator corrects it?** That question became Flair Enforcer. The inspiration came from watching mods in communities we moderate spend 30+ minutes per day just sorting new posts into flair categories. That's 180 hours per year of repetitive work that a machine learning system could handle. We wanted to build something that requires zero ML expertise to set up, works out of the box with just a few keyword rules, and genuinely improves itself over time through the simple act of moderators doing what they already do — fixing wrong flairs.

## What it does

Flair Enforcer is a Devvit app that automatically assigns post flairs using a multi-stage classification pipeline. When a new post is submitted, the system runs it through a 4-stage classification chain:

1. **ML Classifier** — A TF-IDF-inspired scoring engine that tokenises post titles and bodies, compares them against a weighted keyword index built from both manual rules and learned training data, and produces a ranked list of flair candidates with confidence scores. The top candidate is selected if its confidence exceeds a configurable threshold.

2. **Keyword Fallback** — If the ML stage doesn't meet the confidence threshold, the system falls back to exact keyword/phrase matching. Moderators define rules like "if post contains 'help needed' → assign Help flair" through a simple menu form — no regex knowledge required.

3. **Regex Fallback** — For advanced use cases, moderators can define regex patterns. This handles structured content like "[OC] Original Content" prefixes, bug report formats, or title templates that specific communities use.

4. **Default Fallback** — If nothing matches, an optional default flair is applied, ensuring every post gets categorized.

What makes Flair Enforcer unique is the **learning loop**. When a moderator manually changes a flair that was auto-assigned, the system extracts key terms from the original post and associates them with the correct flair. Over time, this training data makes the ML classifier progressively more accurate without any manual model retraining. The system also maintains a full statistics dashboard — accessible as a custom post type — showing total posts processed, auto-assignment accuracy, average confidence scores, top flairs by volume, and a 7-day trend view. Moderators can see exactly how well the system is performing and which flair categories need better rules.

## How we built it

Flair Enforcer is built entirely on **Devvit** — Reddit's official developer platform — using TypeScript with the `@devvit/public-api` SDK. The architecture follows a clean modular design with seven source files, each responsible for a single concern:

- **`types.ts`** — All TypeScript interfaces and constants, including `ClassificationConfig`, `ClassificationResult`, `DailyStats`, and KV store key prefixes. This serves as the single source of truth for data shapes across the app.

- **`classifier.ts`** — The ML classification engine. Implements a TF-IDF-inspired scoring algorithm that tokenises input text, builds a weighted term index from keyword rules and training data, and scores each flair candidate. Tokenisation strips punctuation, lowercases all text, and filters 80+ English stop-words to focus on meaningful terms.

- **`fallback.ts`** — The 4-stage classification chain. Orchestrates ML → Keyword → Regex → Default stages, only advancing to the next stage when the previous one doesn't produce a confident result. Each stage returns a `ClassificationResult` with a stage label for debugging.

- **`rules.ts`** — Configuration management and the learning system. Handles CRUD operations for the classification config stored in Devvit's KV store. The `trainFromCorrection()` function powers the learning loop — when a mod overrides an auto-flair, it extracts tokens from the post and stores them as weighted training data keyed by the correct flair ID.

- **`stats.ts`** — Statistics tracking with daily granularity. Every classification event is recorded with its confidence score, classification stage, and flair assignment. The system tracks auto-assignments, manual overrides, unclassified posts, and per-flair distribution. A scheduled cleanup job runs daily at 3 AM UTC to prune events older than 90 days.

- **`settings.ts`** — Devvit settings schema exposing configuration options like the master toggle, minimum confidence threshold, post type filters (image/video/link), modlog logging, and learning enable/disable.

- **`main.ts`** — The entry point that wires everything together. Registers three `PostCreate` and `PostUpdate` triggers, four moderator menu items (Add Keyword Rule, Add Regex Rule, Clear Rules, View Dashboard), form handlers for rule management, and the daily cleanup scheduler.

All persistent data lives in Devvit's KV store — no external databases or APIs required. The app is fully self-contained within the Devvit ecosystem.

## Challenges we ran into

The biggest challenge was building a classification system that works well **without** access to external ML services or large language model APIs. Devvit apps run in a sandboxed environment with no network access to external AI services, so we couldn't simply call OpenAI or Gemini for text classification. This forced us to implement our own TF-IDF-inspired scoring system from scratch in pure TypeScript. Getting the weighting right took several iterations — our first version used raw term frequency, which heavily biased toward longer posts. We solved this by normalising scores against the square root of token count, which is a standard TF-IDF dampening technique.

The second challenge was the **learning loop design**. We needed the system to learn from moderator corrections without storing raw post content (which would raise privacy concerns). Our solution was to extract and store only the tokenised terms, not the original text. Each flair maintains its own term frequency dictionary in KV storage, and during classification these trained terms are merged with the manual keyword rules at a slightly lower weight (0.8 vs 1.0) so that manual rules always take precedence.

A third challenge was Devvit's **KV store limitations**. The store is key-value only — no queries, no indexes, no aggregation. Building the statistics system required us to maintain daily summary records and perform all aggregation in application code. The `getLifetimeStats()` function has to iterate over all daily keys to compute totals, which could become slow at scale. We mitigated this with the 90-day auto-cleanup scheduler and efficient JSON serialisation.

Finally, we ran into issues with the **PostUpdate trigger**. Devvit fires this event for any post edit — not just flair changes. We had to implement a diffing strategy: store the original classification result keyed by post ID, and on update, compare the current flair with what we originally assigned. If they differ, it's a mod correction; otherwise, ignore the event.

## Accomplishments that we're proud of

We're most proud that Flair Enforcer provides genuine **self-improving ML classification** running entirely within Devvit's sandbox — no external APIs, no model hosting, no Python dependencies. Everything is pure TypeScript running on Reddit's infrastructure. The learning loop genuinely works: after a moderator corrects just 10–20 posts, you can see the confidence scores improve for similar future posts.

The **stats dashboard** is another highlight. It gives moderators real-time visibility into the system's performance — something most auto-flair tools completely lack. Knowing that your accuracy is 87% or that a specific flair category has a 40% override rate is immediately actionable information. Moderators can see exactly where the system is struggling and add targeted rules to fix it.

We're also proud of the **4-stage fallback chain** design. Most auto-flair tools use a single classification method — if it fails, the post goes unflaired. Our chain ensures that even if the ML classifier is uncertain, the keyword and regex stages provide multiple opportunities to get the right answer. This makes the system robust out of the box while still improving over time.

The **developer experience** for moderators is something we invested in heavily. Adding a new classification rule requires just two fields (keyword + flair ID) through a native Devvit form — no JSON editing, no regex syntax for basic rules, no configuration files. We believe mod tools should empower moderators, not require them to become developers.

## What we learned

Building Flair Enforcer taught us a great deal about building practical ML systems under constraints. The biggest insight was that **simple algorithms with good training data outperform complex algorithms with no training data**. Our TF-IDF scorer with 20 learned corrections produces better results than a naive keyword matcher with 200 rules, because the learned data captures the actual language patterns that community members use.

We learned a lot about the **Devvit platform** itself. The KV store's simplicity is both a strength and a limitation — it's incredibly easy to use, but the lack of query capabilities means you have to design your data model carefully. We learned to use prefix scanning (`getByPrefix`) efficiently and to maintain pre-aggregated daily summaries rather than computing them from raw events on every read.

On the product side, we learned that **moderators have very different needs from developers**. Features that seem technically interesting (like confidence score heatmaps or classification latency tracking) are less valuable than simple things like "show me which flair categories are being overridden most." We iterated the dashboard design multiple times based on this understanding.

We also learned about the importance of **graceful degradation**. On day one, with zero training data and no rules, the system should still work — even if it just assigns a default flair or skips classification entirely. No errors, no broken modlog entries, no KV store pollution. Every edge case (deleted posts, empty titles, crossposts, mod-only posts) needs to be handled silently.

## What's next for Flair Enforcer

**Short term:** We plan to add a bulk training feature that lets moderators upload a CSV of historical post titles and their correct flairs to bootstrap the classifier without waiting for organic corrections. This would dramatically improve accuracy on day one for large subreddits.

**Medium term:** We want to implement flair suggestion mode — instead of auto-assigning, the system would add a comment or modmail suggesting a flair and letting the moderator approve or reject it. This "human-in-the-loop" mode would be ideal for communities that want the ML benefits without fully automated assignments.

**Medium term:** A flair health report that runs weekly and proactively notifies moderators when accuracy drops below a threshold or when new trending topics are being consistently misclassified. This turns Flair Enforcer from a passive tool into an active moderation assistant.

**Long term:** Cross-subreddit flair models. If multiple subreddits use Flair Enforcer and share their trained term data (anonymously), the classifier could leverage community-contributed training data from similar subreddits. A gaming subreddit's classification model could help a new gaming community get 80%+ accuracy on day one.

**Long term:** Integration with Reddit's content understanding APIs as they become available on Devvit. If Reddit exposes embeddings or text classification as platform features, Flair Enforcer is architected to swap in a more powerful backend without changing the fallback chain, settings UI, or stats dashboard.

---

## Technologies Used

- **Devvit** — Reddit's developer platform
- **TypeScript** — Primary language
- **TF-IDF Algorithm** — Text classification approach
- **Devvit KV Store** — Persistent data storage
- **Devvit Triggers** — PostCreate, PostUpdate events
- **Devvit Forms** — Moderator UI for rule management
- **Devvit Custom Posts** — Stats dashboard
- **Devvit Scheduler** — Daily cleanup cron job
