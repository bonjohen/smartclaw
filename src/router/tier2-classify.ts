import type Database from 'better-sqlite3';
import type { ClassificationResult } from '../types.js';

const CLASSIFY_SYSTEM = `You are a request classifier. Analyze the user request and return JSON only.
Classify complexity as one of: simple, medium, complex, reasoning.
Classify task_type as one of: qa, coding, writing, analysis, extraction, classification, conversation, tool_use, math, reasoning, multi_step, summarization.
Estimate total tokens needed for a complete response.
Set sensitive=true if the request contains personal, financial, medical, or proprietary information.

Definitions:
- simple: greetings, status, lookups, yes/no, one-line answers
- medium: short code snippets, single-paragraph writing, reformatting, summarization
- complex: multi-file code, architecture, long analysis, document generation
- reasoning: math proofs, logic puzzles, novel problem-solving, multi-step planning

Respond with ONLY a JSON object. No explanation, no markdown fences.`;

function classifyUserPrompt(text: string): string {
  return `Classify this request:\n\n${text.slice(0, 500)}`;
}

const DEFAULT_CLASSIFICATION: ClassificationResult = {
  complexity: 'medium',
  task_type: 'conversation',
  estimated_tokens: 1000,
  sensitive: false,
};

export interface ClassifyOptions {
  ollamaEndpoint: string;
  modelName: string;
  timeoutMs?: number;
}

/**
 * Tier 2: Classify a request using the local 1.5B model via Ollama HTTP API.
 * Returns a ClassificationResult, falling back to defaults on any error.
 */
export async function classifyRequest(
  text: string,
  options: ClassifyOptions
): Promise<ClassificationResult> {
  const { ollamaEndpoint, modelName, timeoutMs = 5000 } = options;

  try {
    const response = await fetch(`${ollamaEndpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: CLASSIFY_SYSTEM },
          { role: 'user', content: classifyUserPrompt(text) },
        ],
        stream: false,
        options: {
          temperature: 0,
          num_predict: 200,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return DEFAULT_CLASSIFICATION;
    }

    const body = await response.json() as { message?: { content?: string } };
    const content = body?.message?.content?.trim();
    if (!content) return DEFAULT_CLASSIFICATION;

    return parseClassification(content);
  } catch {
    return DEFAULT_CLASSIFICATION;
  }
}

/**
 * Parse the 1.5B model's JSON output into a validated ClassificationResult.
 * Exported for testing.
 */
export function parseClassification(raw: string): ClassificationResult {
  try {
    // Strip markdown fences if present
    let cleaned = raw;
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(cleaned);

    const validComplexities = ['simple', 'medium', 'complex', 'reasoning'];
    const validTaskTypes = [
      'qa', 'coding', 'writing', 'analysis', 'extraction',
      'classification', 'conversation', 'tool_use', 'math',
      'reasoning', 'multi_step', 'summarization',
    ];

    return {
      complexity: validComplexities.includes(parsed.complexity)
        ? parsed.complexity
        : 'medium',
      task_type: validTaskTypes.includes(parsed.task_type)
        ? parsed.task_type
        : 'conversation',
      estimated_tokens: typeof parsed.estimated_tokens === 'number' && parsed.estimated_tokens > 0
        ? parsed.estimated_tokens
        : 1000,
      sensitive: typeof parsed.sensitive === 'boolean'
        ? parsed.sensitive
        : false,
    };
  } catch {
    return DEFAULT_CLASSIFICATION;
  }
}

/**
 * Map a classification result to selection criteria using the DB lookup tables.
 */
export function mapClassificationToCriteria(
  db: Database.Database,
  classification: ClassificationResult
): { quality_floor: number; required_capability: string | null } {
  const qualityRow = db.prepare(
    'SELECT quality_floor FROM complexity_quality_map WHERE complexity = ?'
  ).get(classification.complexity) as { quality_floor: number } | undefined;

  const capRow = db.prepare(
    'SELECT capability FROM task_capability_map WHERE task_type = ?'
  ).get(classification.task_type) as { capability: string } | undefined;

  return {
    quality_floor: qualityRow?.quality_floor ?? 40,
    required_capability: capRow?.capability ?? null,
  };
}
