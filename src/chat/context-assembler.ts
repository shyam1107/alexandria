import type { SearchHit } from '../retrieval/retrieval.service';

/**
 * One numbered context item as the model sees it, and as the client renders
 * it. The model sees only `n` and the text — never chunk UUIDs (models mangle
 * them, and each costs ~15 tokens). We own the n → chunk map.
 */
export interface ContextSource {
  n: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  charStart: number | null;
  charEnd: number | null;
}

export interface AssembledContext {
  sources: ContextSource[];
  /** The rendered <context> body: numbered items in citation order. */
  promptText: string;
  /** Tokens the rendered body actually costs — the caller budgets the rest of
   *  the prompt against what is left. */
  tokens: number;
}

/** Internal: tracks the merge run and its best rank; never leaves the assembler. */
interface MergedItem {
  text: string;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  firstIndex: number;
  lastIndex: number;
  charStart: number | null;
  charEnd: number | null;
  /** Best (lowest) position this run's members held in the ranked input. */
  order: number;
}

const renderItem = (n: number, title: string, text: string) => `[${n}] (${title})\n${text}`;

/**
 * Retrieval hits → the numbered context the prompt is built from.
 *
 * Merging adjacent chunks is done PER DOCUMENT, not over the ranked list.
 * Hits arrive in RRF score order, which interleaves documents, so comparing
 * each hit only against its predecessor in that order almost never finds a
 * neighbour: [A#5, B#2, A#6] would leave A#5 and A#6 unmerged even though
 * they are contiguous text. Grouping by document first is what makes the
 * merge actually fire, and tracking the run's LAST index (not its first) is
 * what lets runs longer than two chunks form.
 *
 * A merged run keeps the best rank any of its members achieved, so fusion
 * order survives the regrouping. The citation span is charStart of the first
 * chunk and charEnd of the last — span-accurate in the original document.
 *
 * Budgeting is best-fit, not prefix-truncation: an item that does not fit is
 * skipped and smaller lower-ranked items may still get in. Items are never
 * cut mid-way, so everything the model sees is whole. Cost is measured on the
 * RENDERED item, marker and title included, because that is what the model is
 * charged for.
 */
export function assembleContext(hits: SearchHit[], tokenBudget: number, countTokens: (text: string) => number): AssembledContext {
  const byDocument = new Map<string, Array<{ hit: SearchHit; order: number }>>();
  hits.forEach((hit, order) => {
    const group = byDocument.get(hit.documentId);
    if (group) group.push({ hit, order });
    else byDocument.set(hit.documentId, [{ hit, order }]);
  });

  const merged: MergedItem[] = [];
  for (const group of byDocument.values()) {
    group.sort((a, b) => a.hit.chunkIndex - b.hit.chunkIndex);
    let run: MergedItem | null = null;
    for (const { hit, order } of group) {
      if (run && hit.chunkIndex === run.lastIndex + 1) {
        run.text += '\n' + hit.content;
        run.lastIndex = hit.chunkIndex;
        run.charEnd = hit.charEnd;
        run.order = Math.min(run.order, order);
        continue;
      }
      run = {
        text: hit.content,
        chunkId: hit.chunkId,
        documentId: hit.documentId,
        documentTitle: hit.documentTitle,
        firstIndex: hit.chunkIndex,
        lastIndex: hit.chunkIndex,
        charStart: hit.charStart,
        charEnd: hit.charEnd,
        order,
      };
      merged.push(run);
    }
  }
  merged.sort((a, b) => a.order - b.order);

  const sources: ContextSource[] = [];
  const parts: string[] = [];
  let spent = 0;
  for (const item of merged) {
    const n = sources.length + 1;
    const rendered = renderItem(n, item.documentTitle, item.text);
    const cost = countTokens(rendered);
    if (spent + cost > tokenBudget) continue;
    spent += cost;
    sources.push({
      n,
      chunkId: item.chunkId,
      documentId: item.documentId,
      documentTitle: item.documentTitle,
      charStart: item.charStart,
      charEnd: item.charEnd,
    });
    parts.push(rendered);
  }
  return { sources, promptText: parts.join('\n\n'), tokens: spent };
}

/**
 * Caps conversation history by TOKENS, dropping the oldest turns first.
 *
 * A message count is not a size bound: CHAT_HISTORY_MESSAGES=10 admits ten
 * 4000-character questions and ten 1024-token answers — roughly 10k tokens,
 * which on its own overruns an 8k window. Overflow is never reported by
 * anyone: Ollama truncates the FRONT of the prompt, taking the system prompt
 * (grounding rules, citation contract, injection defence) with it, and the
 * model simply starts behaving worse.
 *
 * A turn is kept whole or not at all — half a question is worse context than
 * no question.
 */
export function trimHistory<T extends { content: string }>(turns: T[], tokenBudget: number, countTokens: (text: string) => number): T[] {
  const kept: T[] = [];
  let spent = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const cost = countTokens(turns[i].content);
    if (spent + cost > tokenBudget) break;
    spent += cost;
    kept.push(turns[i]);
  }
  return kept.reverse();
}
