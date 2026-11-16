# Decisions

One row per decision, newest group first. "Approved" is the owner's call (see CLAUDE.MD); everything
not yet approved is open for review. Bench numbers come from `extension/panel/bench.html`.

## 2026-11-17, hybrid router shipped (owner decisions)

| Date | Decision | Why | Alternatives rejected | Approved |
|---|---|---|---|---|
| 2026-11-17 | The hybrid router is the live lookup-vs-explain router: semantic decides; the built-in model only when the margin is within the cut-off of a tie. It replaces the rules classifier. Rules, semantic-only and Nano-only stay in the bench only (`bench/routers.ts`) | Bake-off: clean 55/60, messy 35/40 (total 90 vs semantic 87, Nano 86, rules 59); ~0 ms median; the built-in model asked ~15% of the time; invented chat facts 0 | Semantic only; Nano only; rules | yes |
| 2026-11-17 | Fallbacks: meaning matcher not ready → the built-in model decides; that unavailable too → explain. The path is logged to the console and kept on the answer (`routedBy`) | Owner spec | — | yes |
| 2026-11-17 | Tech debt (not now): shorthand misses: "y do we need workers", "ye workers kyu chahiye", "y that date" → lookup; "who invented the telephone" → lookup; "lawyer ka naam kya tha" → explain. Possible fix: expand shorthand (y/kyu/wat/pw/u/n) before routing and add these as router examples | Owner | — | yes (deferred) |
| 2026-11-17 | "Not ready" = no margin within 1.5 s (`ROUTER_WAIT.ms`), or the matcher has failed. The example vectors keep loading in the background and are cached, so later questions route by semantic | A first-open model download can take many seconds; the built-in model answers the routing question in about a second | Wait for the matcher (slow first answer); no wait (Nano every time until loaded) | not yet |
| 2026-11-17 | "Answer anyway" and the "Explain the last answer" / "Summarize so far" chips skip routing (explain) | They are explain by definition; routing them would add a built-in-model call to multi-step reading | Route them | not yet |
| 2026-11-17 | Unit tests route with the old classifier unless they test the router, so downstream tests stay deterministic; the e2e stand-in model answers the routing question | The live hybrid needs a matcher or the built-in model | — | n/a |

## 2026-11-17, router bake-off round 2 (owner decisions)

| Date | Decision | Why | Alternatives rejected | Approved |
|---|---|---|---|---|
| 2026-11-17 | Key-word label rule removed; back to overlap labels. Kept: no label text under 8 words, follow-up search, opener strip | It downgraded 6/10 correct explain answers | Keep it | yes |
| 2026-11-17 | Router round 2: a messy set of 40 questions (typos, no punctuation, slang, very short, Hinglish); semantic, Nano and hybrid routers run on both sets, then D.facts / D.absent / D.explain once each; rules stay live | Real users type badly; the 60-question set is too clean | — | test only, not to ship |
| 2026-11-17 | The semantic router's old misses are added to its explain examples as rewordings, not the exact test questions: "Who wrote Hamlet?", "Who painted the Mona Lisa?", "Who are you and what can you do?", "Why that number and not another one?" | Adding the exact clean-set questions ("who are you?", "why that date?") would put test questions in the training examples | Copy them exactly | not yet |
| 2026-11-17 | Hybrid router: Nano decides only when the semantic margin is within 0.03 of a tie (\|margin\| < 0.03); otherwise semantic decides | "Margin below the cut-off" read literally would call Nano for every explain question (most of them), which is the Nano router plus a matcher call | Call Nano whenever semantic says explain | not yet |
| 2026-11-17 | Semantic cut-off stays 0.03. Leave-one-out on the 40 examples: 0.03 and 0.05 give 37/40 (17/18 lookup, 20/22 explain); 0.02 36/40; 0 35/40 | Still on the best plateau | — | not yet |
| 2026-11-17 | During D.routers, D.facts and D.absent run on the long (200k) chat only; the standalone checks still run both chats | Keeps three router passes under 20 minutes | Both chats (about 30 minutes) | not yet |

## 2026-11-17, router bake-off and label fixes (owner decisions)

| Date | Decision | Why | Alternatives rejected | Approved |
|---|---|---|---|---|
| 2026-11-17 | Router bake-off: rules, semantic and Nano routers behind one interface (`router.ts`); "rules" stays live until the owner picks | 8/10 plain fact questions went to explain mode (the rules need "we/our"); absent facts were invented 2/10 and labelled "From the chat" | — | test only, not to ship |
| 2026-11-17 | Key-word label rule: "From the chat" / "+ general knowledge" only if every key word of the question is somewhere in the chat; else "General knowledge" | "Berlin budget is 48,000 euros" (Lisbon's) and "printer password is pinecone-77" (cabin wifi) were labelled "From the chat" | — | yes; removed in round 2 (downgraded 6/10 correct explain answers) |
| 2026-11-17 | No label text on answers under 8 words; sources kept | A correct "Biscotti." was labelled "General knowledge" | — | yes |
| 2026-11-17 | Follow-ups are searched with the current question plus the previous question's words, current weighted higher; no extra model call | "still unable to understand why we need them" searched "them" alone and lost the chat | — | yes |
| 2026-11-17 | Code strips a leading "The conversation states/says/mentions (that)" and capitalises the rest | One opener still got through the prompt rule | — | yes |
| 2026-11-17 | Semantic router: 18 lookup + 18 explain examples (none in the test set; a unit test checks); score = mean of the top-3 cosine similarities; lookup only if it beats explain by ≥ 0.03. Cut-off chosen by leave-one-out on the examples: 0.02–0.05 all give 34/36 (17/18 each way); 0.03 is the middle of that plateau. (Test set, measured after: 53/60 at 0.02, 55/60 at 0.03.) | The spec asks for a margin cut-off; leave-one-out keeps the test set out of the tuning | 0 (lookup recall 17/18, explain 16/18); 0.08 (lookup 14/18) | not yet |
| 2026-11-17 | Semantic router embeds in batches of 8 so the examples run on the question worker; that worker uses the fp16 file on graphics-card machines (approved earlier), not q8 as the spec says | Same model file as the indexer; no extra download | Force q8 (23 MB extra download) | not yet |
| 2026-11-17 | Nano router prompt: LOOKUP = a specific fact from the conversation (value, name, number, date, code or decision); EXPLAIN = anything else; the previous question is given for follow-ups; a reply counts as lookup only if it says "lookup" and not "explain" | Spec: one word; unparseable → explain | — | not yet |
| 2026-11-17 | Key words exclude stop words, chat words, label words and a list of common words (even, still, need, use, explain, example, mean, call, name, …); a trailing "s" is ignored | Without the common-word list, "why do we even need workers?" lost its label over "even" | Full stemming (a dependency) | not yet |
| 2026-11-17 | When the key-word rule relabels an answer "General knowledge", its sources stay | A correct meaning-matched answer ("How much did it cost?" → the budget) keeps its clickable source; the Berlin answer shows that its number came from the Lisbon message | Clear the sources too (tried: hid the source of a correct answer) | not yet |
| 2026-11-17 | Follow-up weights: 0.7 current, 0.3 previous, for word score, word cover and meaning alike | "Current weighted higher"; an unrelated follow-up can reach at most 0.3 from the previous question | 0.5 / 0.5 | not yet |
| 2026-11-17 | Short-answer rule is applied when showing the label; the stored label is unchanged and still decides "Answer anyway" | Short lookup answers ("48,000 euros.") are the main case for "Answer anyway" | Drop the label (would hide the button) | not yet |

## 2026-11-17, explain mode (owner decisions)

| Date | Decision | Why | Alternatives rejected | Approved |
|---|---|---|---|---|
| 2026-11-17 | Explain mode is the default. Code classifies every question, follow-ups included, never inherited from the thread: strict lookup only when it refers to the chat AND asks for a specific value; everything else and unsure → explain | Real thread: "why do we even need workers?" repeated the chat's definition; "what is the population of india?" (a follow-up) was refused twice. The bench tested only fact lookup, so the tuning leaned toward refusing | — | yes |
| 2026-11-17 | Explain prompt: the chat parts as background when some clear the floor, else none; never "can't find"; never claim the chat says what it doesn't | Owner spec | — | yes |
| 2026-11-17 | Code labels every explain answer from its overlap with the chat parts sent: "From the chat" / "From the chat + general knowledge" / "General knowledge"; replaces "Not in this chat. In general:" | Owner spec | — | yes |
| 2026-11-17 | Strict lookup keeps the old behaviour: chat-only rule, keyword rewrite, code refusal, likely passage, "Unverified" | Owner spec | — | yes |
| 2026-11-17 | "Answer anyway" button under strict-lookup refusals and under "From the chat" answers: re-asks the same question in explain mode | Owner spec | — | yes |
| 2026-11-17 | Follow-ups: history is the last 3 exchanges, earlier answers cut to their first 2 sentences; prompts forbid repeating earlier answers and "The conversation states/says/mentions" openers; code drops near-duplicate paragraphs | Owner spec | — | yes |
| 2026-11-17 | Classifier words. Chat refs: we, our, ours, us, "you said/say/mentioned/suggested/recommended/told/gave/picked", earlier, above, previously, "in the chat/conversation/thread", "the chat said/says/mentioned", "did we/you/it". Value words: what, which, who, whom, whose, when, how much, how many. Never lookup when it also has: why, "how do/does/did/can/could/would/should/is/are/to", explain, example(s), mean(s/ing), understand, difference, use case(s), simply. And it must name a subject (a word that isn't a chat word like "decide", "say"). "my" is not a chat ref | The spec's lists, plus "unsure → explain" | Include "my" (would make "what is my name?" a lookup) | not yet |
| 2026-11-17 | Overlap = share of the answer's sentences (4+ content words) that a sent part backs by the source-attribution test (one number, or two rare words). "From the chat" at ≥ 0.6; "+ general knowledge" when at least one sentence is backed; "General knowledge" at 0 or when no chat was sent. Set by reasoning, not measured: the bench now reports every answer's overlap so the cut-off can be checked on the built-in model | Reuses attribution as the spec asks; one backed sentence means the chat was used | Word-overlap share (rewards copying); a model judgement (an extra call) | not yet |
| 2026-11-17 | Near-duplicate = 80% of content words shared (Jaccard), both sides 4+ content words. Checked per paragraph and, in plain paragraphs, per sentence, against the same answer and the previous answer. Lists and code blocks are only compared as whole paragraphs. An answer is never emptied | The owner's thread repeated one definition twice inside one answer, likely as sentences | Paragraphs only (would miss the in-paragraph repeat) | not yet |
| 2026-11-17 | Explain mode attaches the chat for "what is this chat about?"-style questions (chat words, no subject), even when no chunk clears the floor | Without it, "What is this chat about?" got no chat at all (caught by a browser check) | Leave it to the floor | not yet |
| 2026-11-17 | The keyword rewrite keeps its old gating in both modes (first questions where nothing clears the "matched" floor and the question isn't clearly general); follow-ups never rewrite | No change to the number of model calls | Rewrite only in lookup mode (would lose "get online at the lodge") | not yet |
| 2026-11-17 | "Answer anyway" adds one rule to the explain prompt: "The user asked for an answer beyond the conversation: use your general knowledge fully" | Otherwise the re-ask is identical to a normal explain question | — | not yet |
| 2026-11-17 | The label is stored with the side note (`label`, local and server); older notes keep showing their `general` flag | Labels must survive reloads, like the old flag | Recompute (impossible later) | not yet |
| 2026-11-17 | The explain prompt keeps "about the user's own life or work you weren't given, say you don't know" | Limits invented personal facts for absent-fact questions now sent to explain mode | Drop it ("never say you can't find") | not yet |
| 2026-11-17 | Server test updated for selector config version 2 (from the previous round, which had not run the server tests) | Bug in the test, not the server | — | n/a |

## 2026-11-17, first real-chat use (owner: "proceed with the best method to fix both")

| Date | Decision | Why | Alternatives rejected | Approved |
|---|---|---|---|---|
| 2026-11-17 | When the page is read as one block of text (no messages found), answers show no "Based on" sources and no "Unverified" mark | On a real ChatGPT chat every answer said "Based on Page text, message 1": there is only one part, so the label says nothing | Keep the label; show "Read from page text" under each answer (the header already says "reading page text") | yes (owner asked for the fix; this method chosen by Claude) |
| 2026-11-17 | Source attribution ignores the words of Gutter's own introduction in the prompt, the site's name, chat words and label words | "Who are you?" was answered "I am Gutter, a friendly sidekick… (ChatGPT)" and got a source: the model was repeating its prompt | Only names, numbers and codes count (tried: a correct two-word paraphrase, "turns light into sugar", lost its source and became "Unverified") | yes (as above) |
| 2026-11-17 | ChatGPT: second-chance selectors, tried only when `[data-message-author-role]` finds nothing: `[data-turn]` (role from the attribute), then `article[data-testid^="conversation-turn"]` (role unknown). New optional `fallback` list per site in the selector config; config version 2 | The main selector found nothing on the owner's real ChatGPT chat. These are guesses: the live page could not be inspected | Wait for the owner's console output before changing anything | yes (as above); the selectors themselves are unverified |

## 2026-11-17, fourth round (owner decisions)

| Date | Decision | Why | Alternatives rejected | Approved |
|---|---|---|---|---|
| 2026-11-17 | Refusal-text trigger for the likely passage: on a chat-route answer that `CANT_FIND` classifies as "can't find", code takes the specific terms the refusal names and shows the sent part that holds them; preferred over the meaning match when both fire. Code refusals keep the meaning match only | The model often names the fact while refusing ("it mentions Dr. Amara Okafor as the keynote speaker, but…") | A model judgement (an extra call) | yes |
| 2026-11-17 | Keep the 0.4 "maybe" floor | Owner decision | — | yes |
| 2026-11-17 | After this round, stop tuning on synthetic chats; next is real-chat use | Owner decision | — | yes |
| 2026-11-17 | Terms taken from a refusal: numbers and codes (any word with a digit), phrases in double quotes, and capitalised words that don't start a sentence (so "Okafor" in "Dr. Amara Okafor", "Ridge" in "Eagle Ridge"); minus the question's words, stop words, chat words ("chat", "said"…) and label words ("user", "assistant", "message"). Single quotes are ignored (they are apostrophes too) | "Specific terms", per the spec, with no model | Every rare word of the refusal (would match on "keynote", "speaker") | not yet |
| 2026-11-17 | Matching reuses source attribution's scoring (`matchParts` in `ai.ts`): a sent part qualifies with one term that is a number or rare among the sent parts; the highest rarity-weighted score wins; the passage is the sentence with the most terms plus the next | Same rule as attribution; one term is enough here because the terms are already specific | Two terms required, as for attribution (would miss "350") | not yet |
| 2026-11-17 | The trigger needs a `CANT_FIND` phrase in the answer: "The recipe mentions 350 grams of rye flour, but not a pinch of caraway." alone does not qualify (no phrase), so it gets no passage | The spec: only answers code already classifies as "can't find" | Widen `CANT_FIND` to "but not …" (risk: passages under correct answers) | not yet |
| 2026-11-17 | Daily-use production build in `release/` (git-ignored), server URL `http://localhost:4000` (the build default) | Separate from the bench build in `extension/dist` | Load the bench build for daily use | not yet |

## 2026-11-16, third round (owner decisions)

| Date | Decision | Why | Alternatives rejected | Approved |
|---|---|---|---|---|
| 2026-11-16 | Hints + looser rule tested and rejected; the `EXPERIMENT.hints` switch and its code are removed | Bench D, hints ON vs OFF: reworded (picked) 6/10 → 4/10, facts (picked) 10 → 9, invented on absent (whole) 0 → 1, hint words leaked into an answer | Ship it; keep it behind the switch | yes (rejected) |
| 2026-11-16 | "Likely passage": under a can't-find answer (code's refusal, or a chat-route answer matching `CANT_FIND`), code shows "This part of the chat might answer it:", about two sentences of the chunk closest in meaning, with a jump link; never on general or "Not in this chat" answers; no model call | A reworded fact the model misses is often in the chat; give the user a lead instead of a dead end | Hints in the prompt (rejected above); a second model call | yes |
| 2026-11-16 | The "maybe" floor is meaning ≥ 0.4 (`TUNING.maybeMeaning`), on the chunk closest in meaning (its best ~300-character window) | Bench C.maybe, before the rewrite: unanswerable questions reach 0.4 on 2/10 per chat (the target is at most 2); reworded facts 8/20, 8 holding the fact; general 0/20. 0.45 drops reworded to 4/20 with absent 0–2/10; 0.35 adds a wrong lead | 0.35, 0.45, 0.5 | not yet |
| 2026-11-16 | `CANT_FIND` phrases: REFUSAL ("can't / cannot / couldn't / unable to find", "not mentioned / discussed / found / covered / included in the chat", "the chat doesn't mention / say / include / contain / cover / discuss"), plus "does / did not say / mention / specify / state / include", "not stated / specified / given / provided / mentioned", "no mention / information / details of / about / on / regarding", "don't see any / that / it / a / the", "don't know" | The model refuses in many wordings; text matching is the only signal without a model call | A model judgement (an extra call) | not yet |
| 2026-11-16 | The passage is chosen by words inside the best window: the sentence sharing most words with the (rewritten) question, plus the next one (the previous one if it is last); capped at 400 characters | No extra model call; the window is already the best by meaning | Embed each sentence (an extra matcher run) | not yet |
| 2026-11-16 | The passage is kept in the panel's memory only, not saved with the side note or synced; it is gone after a reload | It is chat text; storing chat text is a separate decision ("Chat text is never stored", below) | Store it with the message (local and server) | not yet |

## 2026-11-16, second round (owner decisions)

| Date | Decision | Why | Alternatives rejected | Approved |
|---|---|---|---|---|
| 2026-11-16 | Keep the labelled auto answer ("Not in this chat. In general: …") as it is | Quick run: general questions 0 unlabelled, 0 chatty, 3.0–3.7 s; the 2–4/10 sent to notInChat were answered correctly with the label | Change the wording or the route | yes (keep) |
| 2026-11-16 | Hints + looser rule, behind `EXPERIMENT.hints` in `ai.ts`, default OFF: the best-matching part first (a copy, before the document), the rewrite's search words as a hint line, and the rule "the chat may state the answer in different words; if a part answers it, use it" | Reworded facts were in the prompt but refused ("What does Priya call her pet?", "grain powder", "summit") | — | approved to test, not to ship; tested and rejected in the third round |
| 2026-11-16 | Prompt injection: no change. The bait-removal options (remove, mark, or a rule line) are not adopted | Injection not obeyed; the whole-mode miss next to the bait is known (control without the bait answers 2/2) | Remove instruction-like sentences in code; mark them; add a rule | yes (no change) |

## Approved 2026-11-16 (routing, GPU, labels)

| Date | Decision | Why | Alternatives rejected | Approved |
|---|---|---|---|---|
| 2026-11-16 | Index chats on WebGPU (fp16) in bulk, then shut that worker down: 1.5 s after its last step, and at once when an answer starts | Even idle, a model on the graphics card cut the built-in model from 26.5 to 9.7 tokens/s; indexing on it, 11.9 | Keep the WebGPU worker loaded (slow answers); index on WebAssembly only (12× slower indexing) | yes |
| 2026-11-16 | Embed questions in a separate WebAssembly worker, with the same fp16 model file as the indexer (q8 when there is no graphics card) | Question vectors score within 0.001 of WebGPU's and found the same facts on 4 chats (bench B.mixed); no extra download | WebAssembly q8 for questions (extra 23 MB download on graphics-card machines; scores shift up to 0.033) | yes |
| 2026-11-16 | Routing order: (a) highlight or follow-up → chat prompt; (b) no chat words, best meaning < 0.2 and cover < 0.46 → general prompt, one call; (c) otherwise, if nothing clears the "matched" floor, rewrite the question into keywords and search again, then decide | Run 3: reworded questions refused by code although the fact was in the chat ("get online at the lodge") | Decide before the rewrite (refused findable facts); the three-way route with a held-back fallback (two calls) | yes |
| 2026-11-16 | Code says "I can't find that in this chat" only for a question with chat words and a subject, when nothing relates even after the rewrite | Keeps a no-model answer for clearly empty searches without refusing reworded facts | Refuse before the rewrite | yes |
| 2026-11-16 | Not in the chat and no chat words: one call to the general prompt; code writes "Not in this chat. In general: " before the answer | One honest answer instead of a refusal or a silent general answer | The silent "ask twice" fallback (removed); a refusal | yes |
| 2026-11-16 | A panel badge "General knowledge, not from this chat" on every general-knowledge answer (step b and not-in-chat) | No answer uses general knowledge without a label | Badge only on not-in-chat answers | yes |
| 2026-11-16 | Short chats (sent whole) follow the same routing rule as long chats; a whole chat's "matched" is computed from its scores | General questions on short chats were refused 10/10 | Always send short chats to the chat prompt | yes |
| 2026-11-16 | General prompt tone: plain and brief, start with the answer, no greeting or filler | "Hey there!" style openers | — | yes |
| 2026-11-16 | Built-in model sampling stays temperature 0.3, top-K 3, passed directly (Chrome 157's `params()` returns `{}` but accepts both together; the session confirms 0.3 / 3) | Lower randomness | Chrome default | yes |

## Not yet approved (decisions already in the code)

| Date | Decision | Why | Alternatives rejected | Approved |
|---|---|---|---|---|
| 2026-11-16 | If the meaning matcher is unavailable, questions go to the chat prompt (no general route, no code refusal) | Code can't tell a chat question from a general one without it | Route on words alone | not yet |
| 2026-11-16 | A highlight or a follow-up settles the route; a chat sent whole then doesn't wait for the meaning matcher | Avoids waiting up to 8 s (e.g. first-use model download) when scores change nothing | Always wait | not yet |
| 2026-11-16 | Store a `general` flag on side-note messages (local storage and server sync) so the label survives reloads | The label must persist | Recompute (impossible later) | not yet |
| 2026-11-15 | Index every chat when it is opened, in steps of 64 texts; show "indexing this chat, N%" in the panel; steps wait while an answer is written | Routing needs scores for every chat; the question's own matching goes first | Index only long chats | not yet |
| 2026-11-15 | Built-in model: no citations asked; code attributes sources (a sent part holding one of the answer's numbers or two of its rare words) | It cited the right message 1–5 times in 10 and leaked "Sources:" text | Model citations | not yet |
| 2026-11-15 | Cloud models end with "Sources: [message N]"; code keeps only labels that were in the prompt | Cloud models cite reliably enough; code checks | No citations | not yet |
| 2026-11-15 | Strip any "Sources:" line from every answer, anywhere | It leaked into answers, sometimes first | — | not yet |
| 2026-11-15 | Mark a chat-prompt answer that no sent part backs as "Unverified" (badge; flag stored and synced) | Trust: shows answers that can't be traced to the chat | No mark | not yet |
| 2026-11-15 | Built-in model: send the whole chat only if Chrome counts it at ≤ 3,500 tokens; above that, picked parts up to 3,500 tokens | Reading costs ~1.4 s per 1,000 prompt tokens | Fill the 9,216-token window (11+ s waits) | not yet |
| 2026-11-15 | The chat goes in the user turn as a `<conversation_document>`, rules restated after it; the system prompt holds only who Gutter is and the rules (also in multi-step reading) | Injection was obeyed 3/3 when the chat sat in the system prompt; 0 since | Chat in the system prompt | not yet |
| 2026-11-15 | Absolute "matched" floor: a chunk with ≥ 60% of the question's word weight, or meaning ≥ 0.55 | Unanswerable questions marked found fell from 6–7 to 1 of 10; same-wording stays 20/20 | Relative word score (best match always counts) | not yet |
| 2026-11-15 | Meaning is matched on ~300-character windows; a chunk scores as its best window | Reworded facts found 8 → 12 of 20 (filler), 16 → 19 (on-topic) | Whole 900-character chunks; meaning weight 0.4 / 0.8 (no difference) | not yet |
| 2026-11-15 | Cloud models: budget left after the matches is filled with the newest messages | Reworded facts on a 60k chat 11 → 16 of 20 | Leave the budget unused | not yet |
| 2026-11-15 | Meaning matcher on WebGPU fp16 with batches of 32 when available, WebAssembly q8 otherwise; ship both runtimes (14 MB + 26 MB) | 106 vs 8.4 chunks/s | WebGPU q8 (10.5/s), fp32 (85/s, 90 MB download); WebAssembly only | not yet |
| 2026-11-14 | Server limit on one chat message raised to 70,000 characters | The chat document now travels in the user message | — | not yet |
| v0.4 | Meaning matcher model (all-MiniLM-L6-v2) downloaded from Hugging Face on first use, cached by the browser; vectors cached in IndexedDB on the device | No model in the extension package; a chat is indexed once | Ship the model inside the extension; host it on the Gutter server | not yet |
| v0.4 | Long chats: code picks the relevant parts (word match + meaning match), newest 35% always kept | Answer time stays flat; a small model gets a small input | Send everything; multi-step reading for every question | not yet |
| v0.4 | Multi-step reading for "Explain the last answer" / "Summarize so far" over 20,000 characters: parts of 9,000–16,000 characters, at most 10, copied sentences checked against the source | A whole long text can't fit the built-in model | Retrieval only | not yet |
| v0.4 | Default answer source: Chrome's built-in model (Gemini Nano), free, on the device | No key, no cost, nothing leaves the computer | A cloud model by default | not yet |
| v0.4 | Smart (cloud) answers go through the Gutter server, which holds the provider keys | Users need no key; the free limit can be enforced | Calls straight from the extension with Gutter's keys | not yet |
| v0.4 | 3 free smart answers per account, ever; then paid; the check and the count are one atomic database update; failed answers aren't counted | People already pay for AI elsewhere; the free model must carry daily use | Daily limit | not yet |
| v0.4 | Accounts are marked paid by hand with an admin token; no billing yet | Billing postponed | Stripe now | not yet |
| v0.4 | Own API keys (Settings → Advanced) stored unencrypted in `chrome.storage.local`, calls go straight to the provider | For developers and machines without the built-in model | Encrypt with a passphrase; no own keys | not yet |
| v0.4 | Side notes stored in `chrome.storage.local`, and in MongoDB when signed in; newest copy wins; deletes leave a marker | Sync across devices | Local only | not yet |
| v0.4 | Chat text is never stored; it is sent to the chosen model only when the user asks | Privacy | Cache chats for faster answers | not yet |
| v0.4 | Reading the chat from the page's HTML with per-site selectors; selectors are data served by the Gutter server and refreshed every 6 h | Fixes ship without a store review | Network interception (parked, `docs/network-interception.md`) | not yet |
| v0.4 | Sites: ChatGPT, Claude, Gemini, Grok; a Manifest V3 side panel | Vendor-neutral; low install friction | Desktop overlay; own chat app | not yet |
| v0.4 | Stack: MongoDB, Express, React, Node, TypeScript | Owner's choice | — | not yet |
| v0.4 | Email and password accounts, JWT for 30 days, bcrypt; CORS limited to extension origins; rate limits on auth and AI | Simple accounts | OAuth only | not yet |
| v0.4 | "Second opinion" uses a cloud model from a different company than the chat site | An independent check | The same vendor | not yet |
| v0.4 | Nothing is sent in the main chat; "Send to main" only drafts a follow-up | The user stays in control | Auto-send | not yet |
