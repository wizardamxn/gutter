// Unit tests for context selection and the quote check. Run: npm run test:unit
import assert from 'node:assert/strict';
import type { PageContext, PageMessage } from '../../shared/types';
import { chunkChat, splitText, trimMiddle } from '../panel/src/lib/chunk';
import { MAX_PARTS, splitParts, verifyQuotes } from '../panel/src/lib/digest';
import { keywordCoverage, keywordScores } from '../panel/src/lib/keyword';
import { buildContext, setEmbedder } from '../panel/src/lib/retrieve';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`  ok  ${++passed}. ${name}`);
}

const filler = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} about ${topic}. ${`The ${topic} discussion continues with more detail here. `.repeat(6)}`).join('\n\n');

function chat(messages: PageMessage[]): PageContext {
  return { site: 'chatgpt', siteName: 'ChatGPT', title: 'Test', convKey: 'chatgpt:/c/1', url: '', fallback: false, messages };
}

// 40 messages, ~60,000 characters. One old message holds a specific fact.
const topics = ['gardening', 'sailing', 'baking', 'chess', 'astronomy', 'cycling', 'pottery', 'hiking'];
const long: PageMessage[] = Array.from({ length: 40 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  text: filler(topics[i % topics.length], 4)
}));
long[5] = {
  role: 'assistant',
  text: `${filler('travel', 2)}\n\nThe zebra migration tour has a budget of 4,200 dollars per person, flights included.\n\n${filler('travel', 2)}`
};
long[11] = { role: 'assistant', text: `${filler('shopping', 2)}\n\nThe price of the standing desk is 310 euros.\n\n${filler('shopping', 2)}` };
long[39] = { role: 'assistant', text: 'Final message: we agreed to revisit everything on Friday.' };
const BUDGET = 9000;

setEmbedder(async () => null); // word matching only, unless a test says otherwise

await test('splitText keeps every word and respects the size limit', () => {
  const text = filler('rivers', 12) + '\n\n' + 'x'.repeat(5000);
  const parts = splitText(text, 900, 1400);
  assert.ok(parts.every((p) => p.length <= 1400), 'a chunk is over the limit');
  assert.equal(parts.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
});

await test('trimMiddle keeps the start and the end', () => {
  const out = trimMiddle('START ' + 'm'.repeat(5000) + ' END', 400);
  assert.ok(out.length <= 400);
  assert.ok(out.startsWith('START') && out.endsWith('END') && out.includes('middle left out'));
  assert.equal(trimMiddle('short', 400), 'short');
});

await test('word matching ranks the chunk with the rare word first', () => {
  const docs = ['we talked about gardening and soil', 'the zebra budget is 4,200 dollars', 'gardening again, and more gardening'];
  const s = keywordScores('what was the zebra budget?', docs);
  assert.equal(s.indexOf(Math.max(...s)), 1);
  assert.deepEqual(keywordScores('quantum', docs), [0, 0, 0]);
});

await test('a short chat is sent whole', async () => {
  const b = await buildContext(chat(long.slice(0, 2)), 'anything', '', 60_000);
  assert.equal(b.mode, 'full');
  assert.ok(b.text.includes('[User, message 1]') && b.text.includes('[Assistant, message 2]'));
  assert.equal(b.shown[2].label, 'Assistant, message 2'); // every message may be cited
});

await test('a long chat: the matching old chunk, the newest message, gaps marked, budget kept', async () => {
  const b = await buildContext(chat(long), 'What was the zebra budget?', '', BUDGET);
  assert.equal(b.mode, 'picked');
  assert.equal(b.found, true);
  assert.ok(b.text.includes('budget of 4,200 dollars'), 'old fact not retrieved');
  assert.ok(b.text.includes('revisit everything on Friday'), 'newest message missing');
  assert.ok(b.text.includes('parts of the chat left out'));
  assert.ok(b.text.length <= BUDGET * 1.15, `over budget: ${b.text.length}`);
  assert.ok(!b.text.includes('standing desk'), 'an unrelated chunk was included');
  assert.ok(b.shown[6], 'the fact message is not citable');
  assert.ok(!b.shown[3], 'a message that was left out is citable');
  // In chat order: the old fact comes before the newest message.
  assert.ok(b.text.indexOf('4,200 dollars') < b.text.indexOf('revisit everything'));
});

await test('the highlighted passage and its neighbours are always included', async () => {
  const quote = 'The price of the standing desk is 310 euros.';
  const b = await buildContext(chat(long), 'Explain this simply.', quote, BUDGET);
  assert.ok(b.text.includes(quote));
  assert.ok(b.shown[12]);
  const chunks = chunkChat(long);
  const home = chunks.find((c) => c.text.includes(quote))!;
  const neighbours = [chunks[home.id - 1], chunks[home.id + 1]].filter((c) => c && c.msg === home.msg);
  assert.ok(neighbours.length > 0);
  for (const n of neighbours) assert.ok(b.text.includes(n.text.slice(-60)), 'a neighbour from the same message is missing');
});

await test('nothing matches: says so, still sends the newest part', async () => {
  const b = await buildContext(chat(long), 'Tell me about quantum chromodynamics.', '', BUDGET);
  assert.equal(b.found, false);
  assert.ok(b.text.includes('revisit everything on Friday'));
});

await test('meaning matching finds different wording ("cost" finds "price")', async () => {
  // Without it, "cost" shares no words with the desk chunk.
  const none = await buildContext(chat(long), 'How much did it cost?', '', BUDGET);
  assert.ok(!none.text.includes('standing desk'));

  // A stand-in embedder: texts about money point one way, everything else another.
  setEmbedder(async (texts) =>
    texts.map((t) => (/\b(cost|price|euros)\b/i.test(t) ? new Float32Array([1, 0]) : new Float32Array([0, 1])))
  );
  const b = await buildContext(chat(long), 'How much did it cost?', '', BUDGET);
  assert.ok(b.text.includes('standing desk is 310 euros'));
  assert.ok(b.shown[12]);
  setEmbedder(async () => null);
});

await test('a failing or slow matcher falls back to word matching', async () => {
  setEmbedder(async () => {
    throw new Error('model download blocked');
  });
  const b = await buildContext(chat(long), 'What was the zebra budget?', '', BUDGET);
  assert.ok(b.text.includes('budget of 4,200 dollars'));
  setEmbedder(async () => null);
});

await test('one giant message still fits the budget', async () => {
  const giant = chat([{ role: 'user', text: 'Explain' }, { role: 'assistant', text: filler('volcanoes', 80) + '\n\nThe key number is 77 kilometres.' }]);
  const b = await buildContext(giant, 'What is the key number?', '', BUDGET);
  assert.equal(b.mode, 'picked');
  assert.ok(b.text.length <= BUDGET * 1.15);
  assert.ok(b.text.includes('77 kilometres'));
});

await test('quote check keeps real sentences and drops invented ones', () => {
  const part = 'Plants use chlorophyll to capture light.\nThe Calvin cycle then fixes carbon dioxide into sugar. It happens in the stroma.';
  const reply = [
    '- The Calvin cycle then fixes carbon dioxide into sugar.',
    '2. "plants use  chlorophyll to capture light"',
    'Photosynthesis was discovered in 1492 by Columbus.',
    'NONE',
    'short'
  ].join('\n');
  const { kept, dropped } = verifyQuotes(reply, part);
  assert.deepEqual(kept, ['The Calvin cycle then fixes carbon dioxide into sugar.', 'plants use  chlorophyll to capture light']);
  assert.equal(dropped, 2);
  assert.deepEqual(verifyQuotes('NONE', part), { kept: [], dropped: 0 });
});

await test('multi-step reading is capped at a fixed number of parts', () => {
  const sixtyFiveK = filler('geology', 110).slice(0, 65_000);
  const a = splitParts(sixtyFiveK, false);
  assert.ok(a.parts.length <= MAX_PARTS && !a.cut, `${a.parts.length} parts`);
  const huge = splitParts(filler('geology', 900), true);
  assert.equal(huge.parts.length, MAX_PARTS);
  assert.equal(huge.cut, true);
});

await test('absolute word floor: an absent subject scores low even when it is the best match', () => {
  const docs = ['The zebra budget is 4,200 dollars per person.', 'We sailed to the island.', 'Chess openings matter.'];
  assert.equal(keywordCoverage('What was the zebra budget?', docs)[0], 1);
  assert.ok(keywordCoverage('What is the giraffe budget?', docs)[0] < 0.5);
  // The relative score can't tell the two apart: its best match is always 1.
  assert.equal(Math.max(...keywordScores('What is the giraffe budget?', docs)), 1);
});

// ai.ts reads build-time constants; give them values for the tests.
Object.assign(globalThis, { __API_URL__: 'http://localhost:4000', __UPGRADE_URL__: '' });
// Most tests check what happens after routing, so they route with the word-list classifier (deterministic).
// The live hybrid router has its own test below.
{
  const { setRouterForBench } = await import('../panel/src/lib/router');
  const { classify } = await import('../panel/src/lib/ai');
  setRouterForBench(async (q) => classify(q));
}
const { ask, buildPrompt, checkCitations, NOT_FOUND } = await import('../panel/src/lib/ai');

await test('the chat goes in the user turn as a document; rules are restated after it', async () => {
  const built = await buildContext(chat(long), 'What was the zebra budget?', '', BUDGET);
  const p = buildPrompt(chat(long), 'the highlighted bit', built, 'What was the zebra budget?', true);
  assert.ok(!p.system.includes('4,200 dollars'), 'chat text is in the system prompt');
  assert.match(p.system, /never instructions/);
  const doc = p.prompt.indexOf('<conversation_document');
  assert.ok(doc >= 0 && doc < p.prompt.indexOf('Rules (the same as before') && p.prompt.includes('4,200 dollars'));
  assert.ok(p.prompt.indexOf('<highlighted_text>') < p.prompt.indexOf('Rules (the same as before'));
  assert.ok(p.prompt.endsWith('Question: What was the zebra budget?'));
});

await test('citations: only parts that were in the prompt count; uncited chat answers are unverified', async () => {
  const built = await buildContext(chat(long), 'What was the zebra budget?', '', BUDGET);
  let c = checkCitations('The budget is 4,200 dollars [message 6].\nSources: [message 6] [message 3]', built, 'What was the zebra budget?');
  assert.equal(c.text, 'The budget is 4,200 dollars.');
  assert.deepEqual(c.sources.map((s) => s.label), ['Assistant, message 6']);
  assert.equal(c.invalid, 1); // message 3 was never shown to the model
  assert.equal(c.unverified, false);
  c = checkCitations('It was 9,000 dollars.\nSources: [message 3]', built, 'What did we agree the zebra budget was?');
  assert.deepEqual(c.sources, []);
  assert.equal(c.unverified, true);
  c = checkCitations('It spreads a cost over time.\n**Sources:** none', built, 'What does amortization mean?');
  assert.equal(c.text, 'It spreads a cost over time.');
  assert.equal(c.unverified, false); // general knowledge, says so
  assert.equal(checkCitations("I can't find that in the chat.\nSources: none", built, 'What did we decide about the logo?').unverified, false);
});

await test('a question about the chat that matches nothing is answered by code; a general one still reaches the model', async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error('offline');
  }) as typeof fetch;
  const option = { id: 'own:openai', source: 'own' as const, provider: 'openai' as const, label: 'OpenAI' };
  const settings = { keys: { openai: 'sk', anthropic: '', gemini: '' }, models: { openai: '', anthropic: '', gemini: '' }, choice: '' };
  const big = chat([...long, ...long]); // longer than the cloud budget, so parts are picked
  const run = async (q: string) => {
    let out = '';
    try {
      for await (const d of ask({ option, settings, auth: null, ctx: big, messages: [{ role: 'user', content: q }], quote: '' })) out += d;
    } catch {
      out = 'model was called';
    }
    return out;
  };
  try {
    // A working matcher that finds nothing related (similarity 0.1 everywhere).
    setEmbedder(async (texts) => texts.map((_, i) => (i === 0 ? new Float32Array([1, 0]) : new Float32Array([0.1, 0.995]))));
    assert.equal(await run('What did we decide about quantum chromodynamics?'), NOT_FOUND);
    assert.equal(fetched, 0);
    assert.equal(await run('What does amortization mean?'), 'model was called'); // clearly general: one call
    assert.equal(fetched, 1);
    // No matcher: code can't tell, so the question goes to the chat prompt instead of being refused.
    setEmbedder(async () => null);
    assert.equal(await run('What did we decide about quantum chromodynamics?'), 'model was called');
  } finally {
    globalThis.fetch = realFetch;
    setEmbedder(async () => null);
  }
});

const { attribute, classify, cleanAnswer, clearlyGeneral, dedupe, labelOf, LABEL, ROUTE, trimHistory } = await import('../panel/src/lib/ai');

await test('classifier: strict lookup only for a specific value from the chat; everything else, and unsure, is explain', async () => {
  const { EXPLAIN, TRANSCRIPT } = await import('../panel/src/bench/data');
  for (const q of [
    'What did we decide about the logo?',
    'Which port does our staging database run on?',
    'What is the budget we agreed for the Lisbon office relaunch?',
    'How much did we budget for the zebra tour?',
    'Who did you recommend for the design job?',
    'When did we say the launch is?',
    "What's the name of the lawyer we hired?",
    'What was the wifi password in the chat?'
  ])
    assert.equal(classify(q), 'lookup', q);
  for (const q of [
    // the owner's real thread
    'what are workers?',
    'what are the use cases for worker architecture? and can u tell me which popular apps use it?',
    'who are you?',
    ...TRANSCRIPT.map((t) => t.q),
    // why / how / explain / examples / general
    ...EXPLAIN,
    'Why did we choose Postgres over MongoDB?',
    'How do we deploy this?',
    'What does amortization mean?',
    'What is the capital of Australia?',
    // refers to the chat but names nothing to look up → unsure → explain
    'What did we decide?',
    'What is this chat about?',
    'Summarize what we discussed so far.',
    // a specific value, but nothing ties it to the chat
    "What is Priya's cat named?"
  ])
    assert.equal(classify(q), 'explain', q);
  // General first questions that nothing in the chat comes close to: no chat, no rewrite (as before).
  const best = (meaning: number | null, cover = 0) => ({ meaning, cover });
  assert.equal(clearlyGeneral('What does amortization mean?', '', false, best(ROUTE.general - 0.05)), true);
  assert.equal(clearlyGeneral('What does amortization mean?', '', false, best(ROUTE.general + 0.05)), false);
  assert.equal(clearlyGeneral('What does amortization mean?', '', false, best(null)), false); // no matcher
});

await test('labels by code: overlap cut-offs, and answers that repeat themselves or the previous answer are trimmed', () => {
  assert.deepEqual([labelOf(null), labelOf(0), labelOf(0.2), labelOf(LABEL.chat - 0.01), labelOf(LABEL.chat), labelOf(1)], ['general', 'general', 'mixed', 'mixed', 'chat', 'chat']);
  const def = 'Workers are continuously running processes that listen for jobs from the queue.';
  // The same definition twice in one answer (the owner's thread): the repeat goes.
  let d = dedupe(`${def} They take one job at a time.\n\nIn short, ${def.toLowerCase()}`);
  assert.equal(d.dropped, 1);
  assert.equal(d.text, `${def} They take one job at a time.`);
  // A sentence repeated from the previous answer goes; new sentences stay.
  d = dedupe(`${def} Without them, a slow email would block the web request.`, `${def} They request jobs themselves.`);
  assert.equal(d.text, 'Without them, a slow email would block the web request.');
  // Nothing new at all: the answer is kept rather than emptied. Lists are kept whole.
  assert.equal(dedupe(def, def).text, def);
  assert.equal(dedupe('Steps:\n- add a job\n- add a job', '').dropped, 0);
  assert.equal(dedupe('Short. Short.', '').dropped, 0); // under 4 content words: not judged
});

await test('follow-ups: the last 3 exchanges; earlier questions in full, earlier answers cut to 2 sentences', () => {
  const past = Array.from({ length: 5 }, (_, i) => [
    { role: 'user' as const, content: `Question ${i + 1}, asked in full with all its words?` },
    { role: 'assistant' as const, content: `Answer ${i + 1} first. Answer ${i + 1} second. Answer ${i + 1} third.` }
  ]).flat();
  const h = trimHistory(past);
  assert.equal(h.length, 6);
  assert.equal(h[0].content, 'Question 3, asked in full with all its words?');
  assert.equal(h[1].content, 'Answer 3 first. Answer 3 second.');
  assert.equal(h[5].content, 'Answer 5 first. Answer 5 second.');
});

await test('"can\'t find" detection: the phrases that count, and answers that don\'t', async () => {
  const { CANT_FIND } = await import('../panel/src/lib/ai');
  for (const yes of [
    NOT_FOUND,
    'I cannot find the budget in the conversation.',
    "I couldn't find that.",
    'I was unable to find a password.',
    'That is not mentioned in the chat.',
    'This conversation does not mention a dog.',
    "The chat doesn't say when the flight leaves.",
    'The wifi password is not stated anywhere.',
    'There is no mention of a printer password.',
    'There is no information about the lawyer.',
    "I don't see any details about the hotel.",
    "I don't know what the doctor said."
  ])
    assert.ok(CANT_FIND.test(yes), yes);
  for (const no of ['The budget is 48,000 euros.', "Priya's cat is named Biscotti.", 'The trail is closed until the bridge is repaired.', 'Use port 6543.'])
    assert.ok(!CANT_FIND.test(no), no);
});

await test('likely passage: under a "can\'t find" answer above the maybe floor, never on general answers', async () => {
  const { likelyFor } = await import('../panel/src/lib/ai');
  const { passageOf, TUNING } = await import('../panel/src/lib/retrieve');
  // ~2 sentences around the one sharing most words with the query.
  assert.equal(passageOf('Bring firewood. Pack games. The wifi password is pinecone-77. The router restarts.', 'wifi password'), 'The wifi password is pinecone-77. The router restarts.');
  assert.equal(passageOf('Bring firewood. Pack games. The wifi password is pinecone-77.', 'wifi password'), 'Pack games. The wifi password is pinecone-77.');
  const lodge = chat([
    { role: 'user', text: 'What should we pack for the cabin?' },
    { role: 'assistant', text: 'Bring firewood and board games. The wifi password at the cabin is pinecone-77. The router is under the stairs.' },
    { role: 'user', text: 'Thanks!' }
  ]);
  setEmbedder(async (texts) => texts.map((t, i) => (i === 0 ? new Float32Array([1, 0]) : new Float32Array(t.includes('pinecone') ? [0.5, 0.866] : [0, 1]))));
  const Q = "How do I get online when we're at the lodge?";
  const built = await buildContext(lodge, Q, '', 60_000);
  setEmbedder(async () => null);
  assert.ok(built.likely && Math.abs((built.likely.meaning ?? 0) - 0.5) < 0.01);
  assert.ok(built.likely.passage.includes('pinecone-77'));
  assert.equal(built.likely.source.label, 'Assistant, message 2');
  const p = (route: 'chat' | 'refused' | 'general' | 'explain') => ({ built, route, mode: 'lookup' as const, rewritten: true });
  const floor = TUNING.maybeMeaning;
  TUNING.maybeMeaning = 0.45; // this passage scores 0.5
  try {
  assert.equal(likelyFor(p('chat'), "I can't find that in the chat.", Q), built.likely);
  assert.equal(likelyFor(p('refused'), NOT_FOUND, Q), built.likely);
  assert.equal(likelyFor(p('chat'), 'The password is pinecone-77.', Q), null); // answered: nothing to add
  assert.equal(likelyFor(p('general'), "I don't know.", Q), null);
  assert.equal(likelyFor(p('explain'), "I don't know the password.", Q), null); // explain mode: never
    TUNING.maybeMeaning = 0.55; // now above this passage's score
    assert.equal(likelyFor(p('chat'), "I can't find that in the chat.", Q), null);
  } finally {
    TUNING.maybeMeaning = floor;
  }
});

await test('refusal-text trigger: the sent part holding the terms a refusal names; preferred over the meaning match', async () => {
  const { likelyFor, refusalMatch, refusalTerms } = await import('../panel/src/lib/ai');
  const event = chat([
    { role: 'user', text: 'Where are we with the conference and the bake sale?' },
    { role: 'assistant', text: `${filler('venues', 2)}\n\nThe keynote speaker for the conference is Dr. Amara Okafor. The opening session is in the main hall.` },
    { role: 'user', text: 'And the bread?' },
    { role: 'assistant', text: `${filler('baking', 2)}\n\nThe recipe needs 350 grams of rye flour and a pinch of caraway. Bake it covered.` },
    { role: 'user', text: "Priya's cat is named Biscotti." }
  ]);
  const built = await buildContext(event, 'x', '', 60_000); // short chat: every part is sent
  const keynote = refusalMatch("The conversation mentions Dr. Amara Okafor as the keynote speaker, but it doesn't say who is giving the main talk.", 'Who is giving the main talk at the event?', built);
  assert.equal(keynote?.source.label, 'Assistant, message 2');
  assert.ok(keynote?.passage.includes('Amara Okafor') && keynote.by === 'refusal');
  const recipe = refusalMatch('The recipe mentions 350 grams of rye flour, but not a pinch of caraway.', 'What quantity of grain powder goes into the bread?', built);
  assert.equal(recipe?.source.label, 'Assistant, message 4');
  assert.ok(recipe?.passage.startsWith('The recipe needs 350 grams'));
  // A plain refusal names nothing.
  assert.deepEqual(refusalTerms('I cannot find that information in the chat.', 'What is the Berlin budget?'), []);
  assert.equal(refusalMatch('I cannot find that information in the chat.', 'What is the Berlin budget?', built), null);
  assert.equal(refusalMatch(NOT_FOUND, 'What is the Berlin budget?', built), null);
  // Words from the question don't count; a term the chat doesn't hold finds nothing.
  assert.deepEqual(refusalTerms("The chat mentions Priya's cat Biscotti, but not a dog.", "What is Priya's dog called?"), ['biscotti']);
  assert.equal(refusalMatch('It mentions Lisbon, but not Berlin.', 'What is the Berlin budget?', built), null);
  // Both triggers fire: the refusal-text match wins; code refusals never use it.
  const near = { by: 'meaning' as const, meaning: 0.9, passage: 'Paragraph 1 about venues.', source: { label: 'Assistant, message 2', snippet: '' } };
  const p = { built: { ...built, likely: near }, route: 'chat' as const, rewritten: false };
  const talk = 'Who is giving the main talk at the event?';
  const okafor = likelyFor(p, "The conversation mentions Dr. Amara Okafor as the keynote speaker, but it doesn't say who is giving the main talk.", talk);
  assert.equal(okafor?.by, 'refusal');
  assert.ok(okafor?.passage.includes('Okafor'));
  assert.equal(likelyFor(p, 'I cannot find that information in the chat.', talk), near);
  assert.equal(likelyFor({ ...p, route: 'refused' }, NOT_FOUND, talk), near);
  // Only answers code classifies as "can't find": "…but not a pinch of caraway" has no CANT_FIND phrase.
  assert.equal(likelyFor(p, 'The recipe mentions 350 grams of rye flour, but not a pinch of caraway.', 'What quantity of grain powder goes into the bread?'), null);
});

await test('stray "Sources:" text is stripped wherever it appears', () => {
  assert.equal(cleanAnswer('Sources: [message 2]\nThe budget is 4,200 dollars.'), 'The budget is 4,200 dollars.');
  assert.equal(cleanAnswer('The budget is 4,200 dollars [message 6].\n\n**Sources:** none'), 'The budget is 4,200 dollars.');
  assert.equal(cleanAnswer('Sources: none'), '');
  assert.equal(cleanAnswer('Open sources: are fine mid-line.'), 'Open sources: are fine mid-line.');
});

await test('code attribution: sources are the sent parts holding the answer’s numbers and rare words', async () => {
  setEmbedder(async () => null);
  const built = await buildContext(chat(long), 'What was the zebra budget?', '', BUDGET);
  assert.deepEqual(attribute('The zebra migration tour costs 4,200 dollars per person.', built).map((s) => s.label), ['Assistant, message 6']);
  assert.deepEqual(attribute('It is about 4,200.', built).map((s) => s.label), ['Assistant, message 6']); // one number is enough
  assert.deepEqual(attribute('Photosynthesis turns light into sugar.', built), []); // nothing in the chat backs it
  assert.deepEqual(attribute('The discussion continues with more detail.', built), []); // common words only
});

/** A stand-in for Chrome's built-in model: 4 characters a token, answers chosen by the prompt. */
function stubNano(answer: (prompt: string) => string, rewriteReply = 'keywords'): string[] {
  const prompts: string[] = [];
  Object.assign(globalThis, {
    LanguageModel: {
      availability: async () => 'available',
      params: async () => ({}),
      create: async () => ({
        inputQuota: 9216,
        measureInputUsage: async (t: string) => Math.ceil(t.length / 4),
        prompt: async () => rewriteReply, // the keyword rewrite

        promptStreaming: (t: string) => {
          prompts.push(t);
          return new ReadableStream<string>({ start: (c) => (c.enqueue(answer(t)), c.close()) });
        },
        destroy() {}
      })
    }
  });
  return prompts;
}
const nanoArgs = {
  option: { id: 'nano', source: 'nano' as const, label: 'Built-in' },
  settings: { keys: { openai: '', anthropic: '', gemini: '' }, models: { openai: '', anthropic: '', gemini: '' }, choice: '' },
  auth: null,
  quote: ''
};

type Result = { out: string; checked: { route: string; mode: string; label: string | null; rewritten: boolean; text: string; deduped: number } | null };
const askOnce = async (ctx: PageContext, q: string, history: { role: 'user' | 'assistant'; content: string }[] = [], anyway = false): Promise<Result> => {
  let out = '';
  let checked: Result['checked'] = null;
  for await (const d of ask({ ...nanoArgs, ctx, messages: [...history, { role: 'user', content: q }], cite: true, anyway, onDone: (c) => (checked = c) })) out += d;
  return { out, checked };
};
const vec = (...xs: number[]) => new Float32Array(xs);

await test('attribution: words the model repeats from its own prompt back nothing; a page read as one block gets no sources', async () => {
  setEmbedder(async () => null);
  // The real case: ChatGPT's page read as one block of text, and "who are you?".
  const block = chat([
    {
      role: 'unknown',
      text: 'ChatGPT\nNew chat\n\nWorkers are continuously running processes that listen for jobs. They request jobs from the queue. The conversation with the assistant continues below.\n\nChatGPT can make mistakes.'
    }
  ]);
  const built = await buildContext(block, 'who are you?', '', 60_000);
  const self = 'I am Gutter, a friendly sidekick who answers side questions about a conversation the user is having with another AI assistant (ChatGPT).';
  assert.deepEqual(attribute(self, built, 'ChatGPT'), []);
  assert.equal(attribute('Workers are processes that listen for jobs from the queue.', built, 'ChatGPT').length, 1); // the chat's own words still count
  // End to end: with the page read as one block, no "Based on" and no "Unverified".
  stubNano(() => 'Workers are continuously running processes that listen for jobs.');
  let checked: { sources: unknown[]; unverified: boolean } | null = null;
  for await (const _ of ask({ ...nanoArgs, ctx: { ...block, fallback: true }, messages: [{ role: 'user', content: 'what are workers in this chat?' }], cite: true, onDone: (c) => (checked = c) })) void _;
  assert.deepEqual([checked!.sources, checked!.unverified], [[], false]);
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
});

await test('explain mode: nothing related → one call, no chat attached, labelled "General knowledge" by code; never refused', async () => {
  // Every chat part scores 0.25: not clearly general, nothing related, and the rewrite doesn't change that.
  setEmbedder(async (texts) => texts.map((_, i) => (i === 0 ? vec(1, 0) : vec(0.25, 0.968))));
  const prompts = stubNano((p) => (p.includes('<conversation_document') ? 'from the chat' : 'It spreads a cost over time.'));
  const r = await askOnce(chat(long.slice(0, 4)), 'What does amortization mean?');
  assert.equal(r.out, 'It spreads a cost over time.'); // no "Not in this chat." prefix any more
  assert.deepEqual([r.checked?.route, r.checked?.mode, r.checked?.label, r.checked?.rewritten], ['general', 'explain', 'general', true]);
  assert.equal(prompts.length, 1); // one call, no second try
  assert.ok(!prompts[0].includes('<conversation_document'), 'the chat was attached although nothing related');
  const { buildExplainPrompt } = await import('../panel/src/lib/ai');
  assert.ok(buildExplainPrompt(null, '', null, 'q', false, true).system.includes('beyond the conversation'));
  assert.ok(!buildExplainPrompt(null, '', null, 'q', false).system.includes('beyond the conversation'));
  setEmbedder(async () => null);
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
});

await test('the owner\'s thread: a general follow-up is answered, not refused; a chat-topic "why" gets the chat as background', async () => {
  const workers = chat([
    { role: 'user', text: 'what are workers?' },
    { role: 'assistant', text: 'Workers are continuously running processes that listen for jobs. They independently request jobs from the queue. BullMQ, Celery and Sidekiq are popular tools.' }
  ]);
  setEmbedder(async (texts) => texts.map((t, i) => (i === 0 ? (/worker/i.test(t) ? vec(1, 0) : vec(0, 1)) : /worker/i.test(t) ? vec(0.8, 0) : vec(0, 0))));
  const prompts = stubNano((p) =>
    p.includes('population') ? 'About 1.45 billion people live in India.' : 'A web request should return fast. Workers take slow jobs like emails off the request, using BullMQ or Celery.'
  );
  const history = [
    { role: 'user' as const, content: 'what are workers?' },
    { role: 'assistant' as const, content: 'Workers are continuously running processes that listen for jobs. They request jobs from the queue. They need no notification.' }
  ];
  let r = await askOnce(workers, 'why do we even need workers?', history);
  assert.deepEqual([r.checked?.mode, r.checked?.route], ['explain', 'explain']);
  assert.ok(prompts.at(-1)!.includes('<conversation_document'), 'chat parts are background');
  assert.ok(!/say you cannot find it/.test(prompts.at(-1)!), 'the chat-only rule is not in the explain prompt');
  assert.ok(r.checked?.label === 'mixed' || r.checked?.label === 'chat'); // "BullMQ", "Celery" come from the chat
  // Earlier answers reach the model cut to 2 sentences.
  r = await askOnce(workers, 'what is the population of india?', history);
  assert.deepEqual([r.checked?.mode, r.checked?.route, r.checked?.label], ['explain', 'general', 'general']);
  assert.equal(r.out, 'About 1.45 billion people live in India.');
  setEmbedder(async () => null);
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
});

await test('strict lookup: the keyword rewrite runs before code refuses; "Answer anyway" re-asks in explain mode', async () => {
  const lodge = chat([
    { role: 'user', text: 'What should we pack for the cabin?' },
    { role: 'assistant', text: 'Bring firewood and board games. The wifi password at the cabin is pinecone-77.' },
    { role: 'user', text: 'Thanks!' }
  ]);
  // The question alone matches nothing; with the rewritten keywords it matches the wifi part.
  setEmbedder(async (texts) =>
    texts.map((t, i) => (i === 0 ? (t.includes('wifi') ? vec(1, 0, 0) : vec(0, 0, 1)) : t.includes('pinecone') ? vec(1, 0, 0) : vec(0, 1, 0)))
  );
  const lookup = 'What did you tell us about getting online at the lodge?';
  let prompts = stubNano(() => 'The password is pinecone-77.', 'wifi password internet network');
  let r = await askOnce(lodge, lookup);
  assert.deepEqual([r.checked?.mode, r.checked?.route, r.checked?.rewritten, r.checked?.label], ['lookup', 'chat', true, 'chat']);
  assert.ok(prompts[0].includes('pinecone-77'));
  // The rewrite finds nothing either: code says it can't find it, without the model.
  prompts = stubNano(() => 'Use the hotel wifi or a phone hotspot.', 'something unrelated');
  r = await askOnce(lodge, lookup);
  assert.equal(r.out, NOT_FOUND);
  assert.equal(r.checked?.route, 'refused');
  assert.equal(prompts.length, 0);
  // "Answer anyway": the same question in explain mode, answered and labelled by code.
  r = await askOnce(lodge, lookup, [], true);
  assert.deepEqual([r.checked?.mode, r.checked?.route, r.checked?.label], ['explain', 'general', 'general']);
  assert.equal(r.out, 'Use the hotel wifi or a phone hotspot.');
  // The explain-mode wording of the same question is never refused either.
  r = await askOnce(lodge, "How do I get online when we're at the lodge?");
  assert.notEqual(r.out, NOT_FOUND);
  setEmbedder(async () => null);
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
});

await test('follow-up search: "why we need them" finds the workers part with the previous question\'s words', async () => {
  const msgs = [...long];
  msgs[3] = { role: 'assistant', text: `${filler('sailing', 2)}\n\nWorkers are continuously running processes that listen for jobs on the queue.\n\n${filler('sailing', 2)}` };
  const ctx = chat(msgs);
  // Axes: workers part, filler, the current question's own topic, India. The current question alone
  // barely relates to the workers part (0.2); the previous question does (0.9).
  setEmbedder(async (texts) =>
    texts.map((t) =>
      /still unable/.test(t) ? vec(0.2, 0, 0.98, 0)
      : /india/.test(t) ? vec(0, 0, 0, 1)
      : /even need workers/.test(t) ? vec(0.9, 0, 0.44, 0)
      : /worker/i.test(t) ? vec(1, 0, 0, 0)
      : vec(0, 1, 0, 0)
    )
  );
  const q = 'still unable to understand why we need them. what are other use cases?';
  const alone = await buildContext(ctx, q, '', BUDGET);
  assert.equal(alone.related, false, JSON.stringify(alone.best));
  const withPrev = await buildContext(ctx, q, '', BUDGET, false, true, 'why do we even need workers?');
  assert.equal(withPrev.related, true);
  assert.ok(withPrev.text.includes('continuously running processes'), 'the workers part was not sent');
  // An unrelated follow-up stays unrelated: the previous question only carries 30%.
  const india = await buildContext(ctx, 'what is the population of india?', '', BUDGET, false, true, 'why do we even need workers?');
  assert.equal(india.related, false);
  setEmbedder(async () => null);
});

await test('short answers and "The conversation states" openers', async () => {
  const { shownLabel, stripOpener } = await import('../panel/src/lib/ai');
  // Under 8 words: no label text (sources are kept by the caller).
  assert.equal(shownLabel('Biscotti.', 'general'), null);
  assert.equal(shownLabel('The cat is called Biscotti, and she is allergic to fish.', 'chat'), 'chat');
  assert.equal(stripOpener('The conversation states that workers listen for jobs.'), 'Workers listen for jobs.');
  assert.equal(stripOpener('The chat mentions, the budget is 48,000 euros.'), 'The budget is 48,000 euros.');
  assert.equal(stripOpener('Workers listen for jobs.'), 'Workers listen for jobs.');
});

await test('bench routers: semantic margin, the Nano router\'s one-word reply, test sets apart from the examples', async () => {
  const { SEMANTIC, setRouterEmbedder } = await import('../panel/src/lib/router');
  const { ROUTERS } = await import('../panel/src/bench/routers');
  // Semantic: a question next to the lookup examples (stand-in vectors) routes to lookup.
  const { ROUTER_EXAMPLES } = await import('../panel/src/lib/router');
  const { ROUTER_TEST, ROUTER_MESSY } = await import('../panel/src/bench/data');
  const examples = [...ROUTER_EXAMPLES.lookup, ...ROUTER_EXAMPLES.explain];
  assert.equal([...ROUTER_TEST, ...ROUTER_MESSY].filter((c) => examples.includes(c.q)).length, 0, 'a test set overlaps the examples');
  assert.equal(ROUTER_MESSY.length, 40);
  assert.ok(ROUTER_TEST.length >= 55 && ROUTER_EXAMPLES.lookup.length >= 15 && ROUTER_EXAMPLES.explain.length >= 15);
  const lookupLike = (t: string) => ROUTER_EXAMPLES.lookup.includes(t) || /gate/.test(t);
  setRouterEmbedder(async (texts) => texts.map((t) => (lookupLike(t) ? vec(1, 0) : vec(0, 1))));
  assert.equal(await ROUTERS.semantic('What gate did we get for the flight?'), 'lookup');
  assert.equal(await ROUTERS.semantic('Why do we need workers?'), 'explain');
  assert.ok(SEMANTIC.margin > 0);
  setRouterEmbedder(async () => null);
  assert.equal(await ROUTERS.semantic('What gate did we get for the flight?'), 'explain'); // no matcher → explain
  // Nano: one word back; anything unparseable → explain.
  for (const [reply, want] of [['LOOKUP', 'lookup'], ['Lookup.', 'lookup'], ['EXPLAIN', 'explain'], ['I think it is a lookup or explain', 'explain'], ['hmm', 'explain']] as const) {
    stubNano(() => '', reply);
    assert.equal(await ROUTERS.nano('What gate did we get?'), want, reply);
  }
  // Hybrid (live): semantic when it is sure; the built-in model near a tie or while the matcher isn't ready;
  // explain when the built-in model is unavailable too.
  const { HYBRID_STATS, chooseMode, setRouterForBench } = await import('../panel/src/lib/router');
  const { classify } = await import('../panel/src/lib/ai');
  setRouterForBench(null);
  setRouterEmbedder(async (texts) => texts.map((t) => (lookupLike(t) ? vec(1, 0) : /tie/.test(t) ? vec(0.707, 0.707) : vec(0, 1))));
  stubNano(() => '', 'LOOKUP');
  const before = HYBRID_STATS.nano;
  assert.equal(await ROUTERS.hybrid('What gate did we get for the flight?'), 'lookup'); // sure: no model call
  assert.equal(await ROUTERS.hybrid('Why do we need workers?'), 'explain'); // sure: no model call
  assert.equal(HYBRID_STATS.nano, before);
  assert.equal(await ROUTERS.hybrid('a tie question'), 'lookup'); // margin 0: the model decides
  assert.equal(HYBRID_STATS.nano, before + 1);
  assert.deepEqual(await chooseMode('What gate did we get for the flight?'), { mode: 'lookup', path: 'semantic' });
  assert.deepEqual(await chooseMode('a tie question'), { mode: 'lookup', path: 'nano-tie' });
  setRouterEmbedder(async () => null); // matcher not ready → the built-in model decides
  assert.deepEqual(await chooseMode('What gate did we get for the flight?'), { mode: 'lookup', path: 'nano-not-ready' });
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel; // and without it → explain
  assert.deepEqual(await chooseMode('What gate did we get for the flight?'), { mode: 'explain', path: 'explain-fallback' });
  setRouterForBench(async (q) => classify(q));
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
});

await test('live hybrid router: semantic when sure, the built-in model near a tie or while loading, explain as the last resort', async () => {
  const { chooseMode, HYBRID, ROUTER_EXAMPLES, ROUTER_WAIT, SEMANTIC, setRouterEmbedder, setRouterForBench } = await import('../panel/src/lib/router');
  const { classify } = await import('../panel/src/lib/ai');
  const { TRANSCRIPT } = await import('../panel/src/bench/data');
  setRouterForBench(null); // the live path
  // Stand-in vectors (no model download here): lookup examples on one axis, explain examples on the other.
  // A question's vector sets its margin: cos to lookup − cos to explain.
  const at = (margin: number) => {
    const x = (1 + margin) / 2;
    return vec(x, 1 - x); // not normalised; only the difference matters here
  };
  const questions = new Map<string, Float32Array>([
    ['What gate did we get for the flight?', at(0.6)], // clearly lookup
    ['Why do we need a queue?', at(-0.6)], // clearly explain
    ['gate thing', at(SEMANTIC.margin / 3)] // near a tie
  ]);
  // The owner's transcript: where the real matcher put them in the bench (all explain, clear margins).
  for (const t of TRANSCRIPT) questions.set(t.q, at(-0.2));
  const stand = async (texts: string[]) =>
    texts.map((t) => (ROUTER_EXAMPLES.lookup.includes(t) ? vec(1, 0) : ROUTER_EXAMPLES.explain.includes(t) ? vec(0, 1) : questions.get(t) ?? vec(0, 1)));
  // A built-in model that records what it was asked.
  const asked: string[] = [];
  const nanoSays = (reply: string) =>
    Object.assign(globalThis, {
      LanguageModel: {
        availability: async () => 'available',
        params: async () => ({}),
        create: async () => ({ prompt: async (t: string) => (asked.push(t), reply), destroy() {} })
      }
    });
  const noNano = () => delete (globalThis as { LanguageModel?: unknown }).LanguageModel;

  try {
    // 1. Margin high: semantic decides, the built-in model is never asked.
    setRouterEmbedder(stand);
    nanoSays('EXPLAIN');
    assert.deepEqual(await chooseMode('What gate did we get for the flight?'), { mode: 'lookup', path: 'semantic' });
    assert.deepEqual(await chooseMode('Why do we need a queue?'), { mode: 'explain', path: 'semantic' });
    assert.equal(asked.length, 0, 'the built-in model was asked although semantic was sure');

    // 2. Margin low (within the band): the built-in model decides, with the previous question as context.
    assert.ok(SEMANTIC.margin / 3 < HYBRID.band);
    nanoSays('LOOKUP');
    assert.deepEqual(await chooseMode('gate thing', 'Which flight do we take?'), { mode: 'lookup', path: 'nano-tie' });
    assert.equal(asked.length, 1);
    assert.ok(asked[0].includes('Previous question: Which flight do we take?') && asked[0].includes('Question: gate thing'));

    // 3. The embedding model isn't loaded yet (slower than the wait) → the built-in model decides.
    const wait = ROUTER_WAIT.ms;
    ROUTER_WAIT.ms = 50;
    setRouterEmbedder((texts) => new Promise((r) => setTimeout(() => r(texts.map(() => vec(1, 0))), 400)));
    nanoSays('EXPLAIN');
    assert.deepEqual(await chooseMode('What gate did we get for the flight?'), { mode: 'explain', path: 'nano-not-ready' });
    ROUTER_WAIT.ms = wait;
    // …and when the matcher failed outright.
    setRouterEmbedder(async () => null);
    nanoSays('LOOKUP');
    assert.deepEqual(await chooseMode('What gate did we get for the flight?'), { mode: 'lookup', path: 'nano-not-ready' });

    // 4. No matcher and no built-in model → explain.
    noNano();
    assert.deepEqual(await chooseMode('What gate did we get for the flight?'), { mode: 'explain', path: 'explain-fallback' });

    // 5. The owner's transcript routes as in the bench: all explain, by semantic, as follow-ups in order.
    setRouterEmbedder(stand);
    nanoSays('LOOKUP'); // would be wrong; must not be asked
    asked.length = 0;
    let previous = 'what are workers?';
    for (const t of TRANSCRIPT) {
      assert.deepEqual(await chooseMode(t.q, previous), { mode: 'explain', path: 'semantic' }, t.q);
      previous = t.q;
    }
    assert.deepEqual(await chooseMode('what is the population of india?', 'still unable to understand why we need them. what are other use cases?'), { mode: 'explain', path: 'semantic' });
    assert.equal(asked.length, 0);
  } finally {
    noNano();
    setRouterEmbedder(async () => null);
    setRouterForBench(async (q) => classify(q));
  }
});

await test('built-in model: the whole chat only up to 3,500 tokens, picked parts above', async () => {
  const prompts = stubNano(() => 'ok');
  const { settings, option } = nanoArgs;
  const sized = (chars: number) => {
    const fact = 'The zebra migration tour has a budget of 4,200 dollars per person.';
    const msgs: PageMessage[] = [{ role: 'assistant', text: fact }];
    while (msgs.map((m, i) => `[x, message ${i + 1}]\n${m.text}`).join('\n\n').length < chars) msgs.push({ role: msgs.length % 2 ? 'user' : 'assistant', text: filler('sailing', 2) });
    return chat(msgs);
  };
  for (const [chars, mode] of [[13_000, 'whole'], [14_400, 'picked'], [30_000, 'picked']] as const) {
    for await (const _ of ask({ option, settings, auth: null, ctx: sized(chars), messages: [{ role: 'user', content: 'What was our zebra budget?' }], quote: '' })) void _;
    const prompt = prompts.at(-1)!;
    assert.equal(prompt.includes('only the parts most relevant') ? 'picked' : 'whole', mode, `${chars} characters (~${chars / 4} tokens)`);
  }
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
});

console.log(`\n${passed} unit tests passed`);
