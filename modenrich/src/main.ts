/**
 * Flair Enforcer — Main entry point.
 *
 * Reddit mod tool that automatically classifies and assigns post flairs
 * using an ML-inspired TF-IDF classifier with a 4-stage fallback chain.
 *
 * Features:
 *   - Automatic flair assignment on post creation
 *   - ML classification with keyword/TF-IDF scoring
 *   - Fallback chain: ML → Keyword → Regex → Default
 *   - Learning from mod corrections
 *   - Stats dashboard with accuracy metrics
 *   - Manageable keyword/regex rules via settings
 */

import { Devvit, FormOnSubmit, TriggerContext } from '@devvit/public-api';
import { appSettings } from './settings.js';
import { classifyWithFallback } from './fallback.js';
import { loadConfig, saveConfig, loadTrainedTerms, trainFromCorrection, generateEventId } from './rules.js';
import { recordClassification, recordOverride } from './stats.js';
import { ClassificationConfig, ClassificationEvent, KV_KEYS } from './types.js';
import './dashboard.js';

Devvit.configure({
  redditAPI: true,
  redis: true,
  http: true,
  kvStore: true,
});

// ── Settings Form: Manage Keyword Rules ──────────────────────────────────

const keywordForm = Devvit.createForm(
  {
    fields: [
      {
        type: 'string',
        name: 'keyword',
        label: 'Keyword / Phrase',
        helpText: 'The keyword to match (case-insensitive). Can be a phrase.',
        required: true,
      },
      {
        type: 'string',
        name: 'flairId',
        label: 'Flair Template ID',
        helpText: 'The flair template ID to assign when this keyword matches. Use comma-separated IDs for multiple flairs.',
        required: true,
      },
      {
        type: 'number',
        name: 'weight',
        label: 'Weight (1–10)',
        helpText: 'Higher weight = stronger signal. Default is 1.',
        defaultValue: 1,
      },
    ],
  },
  async (values, ctx) => {
    const config = await loadConfig(ctx);
    const keyword = (values.keyword as string).trim();
    const flairIds = (values.flairId as string).split(',').map(s => s.trim()).filter(Boolean);
    const weight = Number(values.weight) || 1;

    if (!keyword || flairIds.length === 0) {
      ctx.ui.showToast('Please provide both a keyword and at least one flair ID.');
      return;
    }

    config.keywords.push({ keyword, flairIds, weight: Math.min(10, Math.max(0.1, weight)) });
    await saveConfig(ctx, config);
    ctx.ui.showToast(`Added rule: "${keyword}" → ${flairIds.join(', ')}`);
  },
);

// ── Settings Form: Manage Regex Rules ─────────────────────────────────────

const regexForm = Devvit.createForm(
  {
    fields: [
      {
        type: 'string',
        name: 'pattern',
        label: 'Regex Pattern',
        helpText: 'A JavaScript-compatible regex pattern to match against post title + body.',
        required: true,
      },
      {
        type: 'string',
        name: 'flairId',
        label: 'Flair Template ID',
        helpText: 'The flair template ID to assign when this pattern matches.',
        required: true,
      },
      {
        type: 'string',
        name: 'description',
        label: 'Description',
        helpText: 'Human-readable description of what this rule matches.',
        required: true,
      },
    ],
  },
  async (values, ctx) => {
    const config = await loadConfig(ctx);
    const pattern = (values.pattern as string).trim();
    const flairId = (values.flairId as string).trim();
    const description = (values.description as string).trim();

    // Validate regex
    try {
      new RegExp(pattern, 'i');
    } catch {
      ctx.ui.showToast(`Invalid regex pattern: ${pattern}`);
      return;
    }

    if (!pattern || !flairId) {
      ctx.ui.showToast('Please provide both a pattern and flair ID.');
      return;
    }

    config.regexRules.push({ pattern, flairId, description });
    await saveConfig(ctx, config);
    ctx.ui.showToast(`Added regex rule: "${description}"`);
  },
);

// ── Settings Form: Clear All Rules ────────────────────────────────────────

const clearForm = Devvit.createForm(
  { fields: [] },
  async (_values, ctx) => {
    const config = await loadConfig(ctx);
    config.keywords = [];
    config.regexRules = [];
    await saveConfig(ctx, config);
    ctx.ui.showToast('All rules cleared.');
  },
);

// ── Menu Items ────────────────────────────────────────────────────────────

Devvit.addMenuItem({
  location: 'subreddit',
  label: '✨ Add Keyword Rule',
  description: 'Add a keyword→flair classification rule.',
  forUserType: 'moderator',
  form: keywordForm,
});

Devvit.addMenuItem({
  location: 'subreddit',
  label: '🔍 Add Regex Rule',
  description: 'Add a regex pattern→flair classification rule.',
  forUserType: 'moderator',
  form: regexForm,
});

Devvit.addMenuItem({
  location: 'subreddit',
  label: '🗑️ Clear All Rules',
  description: 'Remove all classification rules.',
  forUserType: 'moderator',
  form: clearForm,
});

// ── Post Create Trigger: Auto-Flair ───────────────────────────────────────

Devvit.addTrigger({
  event: 'PostCreate',
  onEvent: async (event, ctx) => {
    const settings = ctx.settings;

    // Master toggle
    if (!settings.autoFlairEnabled) return;

    const config = await loadConfig(ctx);

    // Check post type filters
    let post: { title: string; selftext: string; flairId?: string | null; id: string; authorName: string; subredditName: string };
    try {
      post = await ctx.reddit.getPostById(event.post!.id);
    } catch {
      return;
    }

    // Get the subreddit name from context
    const subreddit = await ctx.reddit.getCurrentSubreddit();
    const subName = subreddit.name;

    // Check excluded subreddits
    if (config.excludeSubreddits.map(s => s.toLowerCase()).includes(subName.toLowerCase())) {
      return;
    }

    // Classify
    const trainedTerms = await loadTrainedTerms(ctx);
    const result = classifyWithFallback(post.title, post.selftext || '', config, trainedTerms);

    // Don't assign if no match
    if (!result.flairId || result.stage === 'none') return;

    // Don't overwrite existing flair
    if (post.flairId) return;

    // Assign flair
    try {
      await ctx.reddit.setPostFlair({
        postId: event.post!.id,
        flairTemplateId: result.flairId,
      });
    } catch (e) {
      console.error('Flair Enforcer: Failed to set flair', e);
      return;
    }

    // Log to modlog
    if (settings.logToModLog) {
      try {
        await ctx.reddit.modLog({
          action: 'flair',
          description: `Flair Enforcer [${result.stage}]: Assigned flair ${result.flairId} (confidence: ${(result.confidence * 100).toFixed(0)}%) to post "${post.title}"`,
        });
      } catch {
        // Modlog may not be available in test environments
      }
    }

    // Record stats
    const classificationEvent: ClassificationEvent = {
      id: generateEventId(),
      postId: event.post!.id,
      postTitle: post.title,
      subreddit: subName,
      author: post.authorName,
      classifiedFlairId: result.flairId,
      classifiedFlairText: result.flairText,
      confidence: result.confidence,
      stage: result.stage,
      timestamp: Date.now(),
      overridden: false,
    };

    await recordClassification(ctx, classificationEvent);

    // Store lookup key: postId → eventId
    await ctx.kvStore.put(`fe:post:${event.post!.id}`, classificationEvent.id);
  },
});

// ── Post Update Trigger: Learn from Mod Corrections ───────────────────────

Devvit.addTrigger({
  event: 'PostUpdate',
  onEvent: async (event, ctx) => {
    if (!ctx.settings.enableLearning) return;

    const postId = event.post?.id;
    if (!postId) return;

    // Check if we have a classification for this post
    const eventId = await ctx.kvStore.get(`fe:post:${postId}`);
    if (!eventId) return;

    const eventRaw = await ctx.kvStore.get(KV_KEYS.eventsPrefix + eventId);
    if (!eventRaw) return;

    const classification: ClassificationEvent = JSON.parse(eventRaw);

    // Already overridden — skip
    if (classification.overridden) return;

    // Get current post state
    let post: { title: string; selftext: string; flairId?: string | null };
    try {
      post = await ctx.reddit.getPostById(postId);
    } catch {
      return;
    }

    const newFlairId = post.flairId;

    // If flair changed and it's different from what we assigned
    if (newFlairId && newFlairId !== classification.classifiedFlairId) {
      // Record the override
      await recordOverride(ctx, postId, newFlairId);

      // Learn from correction
      await trainFromCorrection(
        ctx,
        classification.postTitle,
        '', // We don't have the body stored; train from title only
        newFlairId,
      );
    }
  },
});

// ── Scheduled Job: Daily Stats Cleanup (keep last 90 days) ─────────────────

Devvit.addScheduler({
  name: 'fe-cleanup',
  cron: '0 3 * * *', // Run at 3 AM UTC daily
  onRun: async (_event, ctx) => {
    const cutoff = Date.now() - 90 * 86_400_000;
    const allEvents = await ctx.kvStore.getByPrefix(KV_KEYS.eventsPrefix);

    let deleted = 0;
    for (const { key, value } of allEvents) {
      try {
        const evt: ClassificationEvent = JSON.parse(value);
        if (evt.timestamp < cutoff) {
          await ctx.kvStore.delete(key);
          deleted++;
        }
      } catch {
        await ctx.kvStore.delete(key);
        deleted++;
      }
    }

    if (deleted > 0) {
      console.log(`Flair Enforcer cleanup: deleted ${deleted} old events`);
    }
  },
});

// ── App Upgrade: Migrate settings → KV config ─────────────────────────────

Devvit.addAppDelegate({
  onInstall: async (_, ctx) => {
    // Write initial config to KV if not present
    const existing = await ctx.kvStore.get(KV_KEYS.config);
    if (!existing) {
      const { DEFAULT_CONFIG } = await import('./types.js');
      await ctx.kvStore.put(KV_KEYS.config, JSON.stringify(DEFAULT_CONFIG));
      console.log('Flair Enforcer: Installed default config to KV store');
    }
  },
  onAppUpgrade: async (_, ctx) => {
    console.log('Flair Enforcer: App upgraded');
  },
});

export default Devvit;
