import { writeFileSync } from 'fs';
import { franc } from 'franc';

const BASE_URL = 'https://arctic-shift.photon-reddit.com';

// ─── Configuration ───────────────────────────────────────────────────────────

const SUBREDDIT  = 'ich_iel';   // Target subreddit (without r/)
const AFTER_DATE = '2016-01-01';  // Fetch items created after this date
const BEFORE_DATE: string | undefined = '2017-01-01'; // Optional upper bound, e.g. '2025-02-01'
const OUTPUT_FILE       = 'output.json';
const WORD_STATS_FILE   = 'word-stats.json';
const TOP_N_WORDS       = 100; // How many top words to include in the stats file
const REQUEST_DELAY_MS  = 150; // Delay before each HTTP request to reduce 422/rate-limit issues
const RETRYABLE_STATUS_CODES = new Set([422, 429]);
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 400;
const RETRY_MAX_DELAY_MS = 8000;
const RETRY_JITTER_MS = 250;

// Comment language filter
const FILTER_MOSTLY_GERMAN = true; // When enabled, only English comments are dropped
const MIN_CHARS_FOR_LANGUAGE_CHECK = 7;
const LOG_DROPPED_COMMENTS = true;
const DROPPED_COMMENT_PREVIEW_LEN = 120;
const DROPPED_COMMENTS_FILE = 'dropped-comments.json';

// Words to explicitly track (case-insensitive). Leave empty [] to skip.
const TRACKED_WORDS = [
  'lol',
  'cringe',
  'based',
];

const TRACKED_WORDS_FILE = 'tracked-words.json';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Post {
  id: string;
  title: string;
  author: string;
  created_utc: number;
  url: string;
  num_comments: number;
  score: number;
}

interface Comment {
  id: string;
  author: string;
  body: string;
  created_utc: number;
  link_id: string;
  parent_id: string;
  score: number;
}

interface ApiResponse<T> {
  data: T[];
}

interface ScrapeResult {
  post: Post;
  comments: Comment[];
}

interface WordStats {
  totalComments: number;
  totalWords: number;
  uniqueWords: number;
  topWords: Array<{ word: string; count: number; percentage: string }>;
}

interface TrackedWordStats {
  totalComments: number;
  totalWords: number;
  trackedWords: Array<{
    word: string;
    count: number;
    percentage: string;       // share of all words
    commentsContaining: number; // how many comments contain the word at least once
    commentPercentage: string;  // share of all comments
  }>;
}

interface DroppedCommentLogEntry {
  post_id: string;
  post_title: string;
  comment_id: string;
  author: string;
  created_utc: number;
  language: string;
  reason: string;
  preview: string;
  body: string;
}

// ─── Word counting ──────────────────────────────────────────────────────────

// Common English stop words to exclude from the top-words list
const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','up','about','into','through','during','is','are','was',
  'were','be','been','being','have','has','had','do','does','did','will',
  'would','could','should','may','might','shall','can','need','dare',
  'i','me','my','we','our','you','your','he','him','his','she','her',
  'it','its','they','them','their','this','that','these','those','what',
  'which','who','whom','not','no','so','if','as','just','more','also',
  'than','then','when','where','how','all','each','every','both','few',
  'other','some','such','only','own','same','too','very','s','t','re',
  've','ll','d','m','don','didn','doesn','isn','wasn','weren','haven',
  'hasn','hadn','wouldn','couldn','shouldn','won','get','got','like',
  'know','think','want','see','go','come','said','say','make','one',
  'two','there','here','out','now','even','back','still','well','way',
]);

/**
 * Tokenizes a comment body into lowercase English words (letters only).
 * Returns all words, including stop words — filtering happens at stats time.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/\b[a-z]{2,}\b/g) ?? [];
}

/**
 * Detects language code for a comment using franc.
 */
function detectLanguageCode(text: string): string {
  if (text.trim().length < MIN_CHARS_FOR_LANGUAGE_CHECK) {
    return 'und';
  }

  return franc(text, {
    minLength: MIN_CHARS_FOR_LANGUAGE_CHECK,
  });
}

function makePreview(text: string, maxLen: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return compact.slice(0, maxLen) + '...';
}

/**
 * Builds a word-frequency map from all comments across all results.
 * Stop words are excluded so the stats surface meaningful vocabulary.
 */
function buildWordFrequency(
  results: ScrapeResult[]
): Map<string, number> {
  const freq = new Map<string, number>();

  for (const { comments } of results) {
    for (const comment of comments) {
      for (const word of tokenize(comment.body)) {
        if (STOP_WORDS.has(word)) continue;
        freq.set(word, (freq.get(word) ?? 0) + 1);
      }
    }
  }

  return freq;
}

/**
 * Derives a WordStats summary from a frequency map.
 */
function buildWordStats(
  freq: Map<string, number>,
  totalComments: number,
  topN: number
): WordStats {
  const totalWords = [...freq.values()].reduce((s, c) => s + c, 0);

  const topWords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word, count]) => ({
      word,
      count,
      percentage: ((count / totalWords) * 100).toFixed(3) + '%',
    }));

  return {
    totalComments,
    totalWords,
    uniqueWords: freq.size,
    topWords,
  };
}

/**
 * Counts occurrences of each tracked word across all comment bodies.
 * Also records how many individual comments contain each word.
 */
function countTrackedWords(
  results: ScrapeResult[],
  trackedWords: string[]
): TrackedWordStats {
  const words = trackedWords.map((w) => w.toLowerCase());
  const counts = new Map<string, number>(words.map((w) => [w, 0]));
  const commentHits = new Map<string, number>(words.map((w) => [w, 0]));
  let totalComments = 0;
  let totalWords = 0;

  for (const { comments } of results) {
    for (const comment of comments) {
      totalComments++;
      const tokens = tokenize(comment.body);
      totalWords += tokens.length;
      const bodyWords = new Set(tokens); // for per-comment presence check
      for (const word of words) {
        const occurrences = tokens.filter((t) => t === word).length;
        counts.set(word, counts.get(word)! + occurrences);
        if (bodyWords.has(word)) {
          commentHits.set(word, commentHits.get(word)! + 1);
        }
      }
    }
  }

  const trackedWordStats = words.map((word) => {
    const count = counts.get(word)!;
    const commentsContaining = commentHits.get(word)!;
    return {
      word,
      count,
      percentage: totalWords > 0
        ? ((count / totalWords) * 100).toFixed(4) + '%'
        : '0%',
      commentsContaining,
      commentPercentage: totalComments > 0
        ? ((commentsContaining / totalComments) * 100).toFixed(2) + '%'
        : '0%',
    };
  }).sort((a, b) => b.count - a.count);

  return { totalComments, totalWords, trackedWords: trackedWordStats };
}



async function apiFetch<T>(
  path: string,
  params: Record<string, string>
): Promise<T[]> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const getRetryDelayMs = (attempt: number, retryAfterHeader: string | null): number => {
    if (retryAfterHeader) {
      const asSeconds = Number(retryAfterHeader);
      if (!Number.isNaN(asSeconds) && asSeconds >= 0) {
        return Math.min(asSeconds * 1000, RETRY_MAX_DELAY_MS);
      }

      const asDate = Date.parse(retryAfterHeader);
      if (!Number.isNaN(asDate)) {
        const waitMs = asDate - Date.now();
        if (waitMs > 0) {
          return Math.min(waitMs, RETRY_MAX_DELAY_MS);
        }
      }
    }

    const exp = RETRY_BASE_DELAY_MS * (2 ** attempt);
    const jitter = Math.floor(Math.random() * RETRY_JITTER_MS);
    return Math.min(exp + jitter, RETRY_MAX_DELAY_MS);
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Gentle pacing before every request to avoid API-side validation/rate issues.
    await delay(REQUEST_DELAY_MS);

    console.log(`  GET ${url.toString()}${attempt > 0 ? ` (retry ${attempt}/${MAX_RETRIES})` : ''}`);

    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'arctic-shift-scraper/1.0' },
    });

    if (res.ok) {
      const json = (await res.json()) as ApiResponse<T>;
      return json.data;
    }

    const body = await res.text();
    const isRetryable = RETRYABLE_STATUS_CODES.has(res.status);
    const hasRetriesLeft = attempt < MAX_RETRIES;

    if (isRetryable && hasRetriesLeft) {
      const waitMs = getRetryDelayMs(attempt, res.headers.get('retry-after'));
      console.warn(
        `  HTTP ${res.status} for ${url} (attempt ${attempt + 1}/${MAX_RETRIES + 1}). ` +
        `Retrying in ${waitMs}ms...`
      );
      await delay(waitMs);
      continue;
    }

    throw new Error(`HTTP ${res.status} for ${url}: ${body}`);
  }

  throw new Error(`Request failed after retries for ${url}`);
}

// ─── Paginated fetchers ───────────────────────────────────────────────────────

/**
 * Fetches all posts for a subreddit after `after` (sorted ascending).
 * Paginates by advancing the `after` cursor to the last item's created_utc.
 * Uses a seen-ID set to deduplicate items that share the same second timestamp.
 */
async function fetchAllPosts(
  subreddit: string,
  after: string,
  before?: string
): Promise<Post[]> {
  const all: Post[] = [];
  const seenIds = new Set<string>();
  let cursor = after;

  while (true) {
    const params: Record<string, string> = {
      subreddit,
      after: cursor,
      sort: 'asc',
      limit: '100',
      fields: 'id,title,author,created_utc,url,num_comments,score',
    };
    if (before) params['before'] = before;

    const batch = await apiFetch<Post>('/api/posts/search', params);
    if (batch.length === 0) break;

    let newCount = 0;
    for (const post of batch) {
      if (!seenIds.has(post.id)) {
        seenIds.add(post.id);
        all.push(post);
        newCount++;
      }
    }

    console.log(
      `  Posts batch: ${batch.length} received, ${newCount} new → ${all.length} total`
    );

    // Fewer than 100 results → last page reached
    if (batch.length < 100) break;

    // Advance cursor to the last item's timestamp (same-second items handled by seenIds)
    cursor = String(batch[batch.length - 1]!.created_utc);
  }

  return all;
}

/**
 * Fetches all comments for a single post (by post ID) after `after`.
 * Uses the same cursor-based pagination as fetchAllPosts.
 */
async function fetchCommentsForPost(
  postId: string,
  after: string,
  before?: string
): Promise<Comment[]> {
  const all: Comment[] = [];
  const seenIds = new Set<string>();
  let cursor = after;

  while (true) {
    const params: Record<string, string> = {
      link_id: postId,
      after: cursor,
      sort: 'asc',
      limit: '100',
      fields: 'id,author,body,created_utc,link_id,parent_id,score',
    };
    if (before) params['before'] = before;

    const batch = await apiFetch<Comment>('/api/comments/search', params);
    if (batch.length === 0) break;

    let newCount = 0;
    for (const comment of batch) {
      if (!seenIds.has(comment.id)) {
        seenIds.add(comment.id);
        all.push(comment);
        newCount++;
      }
    }

    if (batch.length < 100) break;
    cursor = String(batch[batch.length - 1]!.created_utc);
  }

  return all;
}

// ─── Delay helper ────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `Scraping r/${SUBREDDIT} | after: ${AFTER_DATE}${BEFORE_DATE ? ` | before: ${BEFORE_DATE}` : ''}`
  );

  // Step 1: Fetch all posts in date range
  console.log('\n[1/2] Fetching posts...');
  const posts = await fetchAllPosts(SUBREDDIT, AFTER_DATE, BEFORE_DATE);
  console.log(`→ ${posts.length} posts found\n`);

  if (posts.length === 0) {
    console.log('No posts found. Adjust AFTER_DATE / SUBREDDIT and try again.');
    return;
  }

  // Step 2: For each post fetch its comments in date range
  console.log('[2/2] Fetching comments for each post...');
  const results: ScrapeResult[] = [];
  const droppedComments: DroppedCommentLogEntry[] = [];

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]!;
    process.stdout.write(
      `  [${i + 1}/${posts.length}] "${post.title}" (${post.id}) ... `
    );

    const comments = await fetchCommentsForPost(post.id, AFTER_DATE, BEFORE_DATE);
    const filteredComments: Comment[] = [];

    for (const comment of comments) {
      if (!FILTER_MOSTLY_GERMAN) {
        filteredComments.push(comment);
        continue;
      }

      const lang = detectLanguageCode(comment.body);
      if (lang !== 'eng') {
        filteredComments.push(comment);
        continue;
      }

      if (LOG_DROPPED_COMMENTS) {
        const reason = `lang=${lang}`;
        const preview = makePreview(comment.body, DROPPED_COMMENT_PREVIEW_LEN);

        droppedComments.push({
          post_id: post.id,
          post_title: post.title,
          comment_id: comment.id,
          author: comment.author,
          created_utc: comment.created_utc,
          language: lang,
          reason,
          preview,
          body: comment.body,
        });

        console.log(
          `    dropped comment ${comment.id} by ${comment.author} (${reason}) :: ${preview}`
        );
      }
    }

    process.stdout.write(`${filteredComments.length}/${comments.length} comments kept\n`);
    results.push({ post, comments: filteredComments });

    // Polite delay between posts to avoid rate-limiting
    if (i < posts.length - 1) await delay(300);
  }

  // Step 3: Word statistics
  const totalComments = results.reduce((sum, r) => sum + r.comments.length, 0);
  console.log('\n[Word stats] Building word frequency map...');
  const freq  = buildWordFrequency(results);
  const stats = buildWordStats(freq, totalComments, TOP_N_WORDS);

  console.log(`  Total words (excl. stop words): ${stats.totalWords.toLocaleString()}`);
  console.log(`  Unique words:                   ${stats.uniqueWords.toLocaleString()}`);
  console.log(`  Top 10 words:`);
  stats.topWords.slice(0, 10).forEach(({ word, count, percentage }) => {
    console.log(`    ${word.padEnd(20)} ${String(count).padStart(7)}  (${percentage})`);
  });

  // Step 3b: Tracked words
  if (TRACKED_WORDS.length > 0) {
    console.log('\n[Tracked words]');
    const tracked = countTrackedWords(results, TRACKED_WORDS);
    tracked.trackedWords.forEach(({ word, count, percentage, commentsContaining, commentPercentage }) => {
      console.log(
        `  ${word.padEnd(20)} ${String(count).padStart(7)} occurrences (${percentage} of words)` +
        `  |  in ${commentsContaining} comments (${commentPercentage})`
      );
    });
    writeFileSync(TRACKED_WORDS_FILE, JSON.stringify(tracked, null, 2), 'utf-8');
    console.log(`Tracked words written to ${TRACKED_WORDS_FILE}`);
  }

  // Step 4: Write output files
  console.log(`\nSummary: ${posts.length} posts, ${totalComments} comments`);

  writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`Results  written to ${OUTPUT_FILE}`);

  writeFileSync(WORD_STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
  console.log(`Word stats written to ${WORD_STATS_FILE}`);

  if (LOG_DROPPED_COMMENTS && FILTER_MOSTLY_GERMAN) {
    writeFileSync(DROPPED_COMMENTS_FILE, JSON.stringify(droppedComments, null, 2), 'utf-8');
    console.log(`Dropped comments written to ${DROPPED_COMMENTS_FILE} (${droppedComments.length})`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

