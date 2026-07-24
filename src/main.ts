import { writeFileSync } from 'fs';

const BASE_URL = 'https://arctic-shift.photon-reddit.com';

// ─── Configuration ───────────────────────────────────────────────────────────

const SUBREDDIT  = 'ich_iel';   // Target subreddit (without r/)
const AFTER_DATE = '2016-01-01';  // Fetch items created after this date
const BEFORE_DATE: string | undefined = '2017-01-01'; // Optional upper bound, e.g. '2025-02-01'
const OUTPUT_FILE       = 'output.json';
const WORD_STATS_FILE   = 'word-stats.json';
const TOP_N_WORDS       = 100; // How many top words to include in the stats file

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

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  params: Record<string, string>
): Promise<T[]> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  console.log(`  GET ${url.toString()}`);

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'arctic-shift-scraper/1.0' },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}: ${await res.text()}`);
  }

  const json = (await res.json()) as ApiResponse<T>;
  return json.data;
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

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i]!;
    process.stdout.write(
      `  [${i + 1}/${posts.length}] "${post.title}" (${post.id}) ... `
    );

    const comments = await fetchCommentsForPost(post.id, AFTER_DATE, BEFORE_DATE);
    process.stdout.write(`${comments.length} comments\n`);
    results.push({ post, comments });

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

  // Step 4: Write output files
  console.log(`\nSummary: ${posts.length} posts, ${totalComments} comments`);

  writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`Results  written to ${OUTPUT_FILE}`);

  writeFileSync(WORD_STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
  console.log(`Word stats written to ${WORD_STATS_FILE}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

