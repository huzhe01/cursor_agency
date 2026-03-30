import type { OpenAIModelAdapter } from './openai.js';

export type VerifierStatus = 'PASS' | 'FAIL' | 'BLOCKED';

export interface AcceptanceCheck {
  type: 'read_only_answer' | 'diff_present' | 'shell_exit_zero' | 'python_exit_zero' | 'duckdb_checks_pass' | 'artifact_exists';
  description: string;
  artifactPath?: string;
}

export interface EvidenceItem {
  kind: string;
  summary: string;
  passed?: boolean;
  artifactPath?: string;
  metadata?: Record<string, unknown>;
}

export interface EvidenceBundle {
  task: string;
  round: number;
  backend: string;
  plan: string;
  finalMessage: string;
  diff: string;
  touchedFiles: string[];
  acceptanceChecks: AcceptanceCheck[];
  requiredEvidence: string[];
  evidence: EvidenceItem[];
  blockedReasons: string[];
  failures: string[];
}

export interface VerifierResult {
  status: VerifierStatus;
  summary: string;
  evidence: string[];
  missingChecks: string[];
  nextAction: string;
}

export interface Verifier {
  verify(bundle: EvidenceBundle): Promise<VerifierResult>;
}

function hasPassedEvidence(bundle: EvidenceBundle, kind: string): boolean {
  return bundle.evidence.some((item) => item.kind === kind && item.passed === true);
}

export class RuleVerifier implements Verifier {
  async verify(bundle: EvidenceBundle): Promise<VerifierResult> {
    const missingChecks: string[] = [];

    if (bundle.blockedReasons.length > 0) {
      return {
        status: 'BLOCKED',
        summary: `Execution is blocked: ${bundle.blockedReasons.join('; ')}`,
        evidence: bundle.evidence.map((item) => item.summary),
        missingChecks,
        nextAction: 'Resolve the blocked dependency, permission, or backend issue before retrying.',
      };
    }

    if (bundle.failures.length > 0) {
      return {
        status: 'FAIL',
        summary: `Execution failed: ${bundle.failures.join('; ')}`,
        evidence: bundle.evidence.map((item) => item.summary),
        missingChecks,
        nextAction: 'Inspect the failing command or check and replan the next round around the concrete failure.',
      };
    }

    for (const check of bundle.acceptanceChecks) {
      if (check.type === 'read_only_answer') {
        if (!bundle.finalMessage.trim()) {
          missingChecks.push(check.description);
        }
        continue;
      }

      if (check.type === 'diff_present') {
        if (!bundle.diff.trim()) {
          missingChecks.push(check.description);
        }
        continue;
      }

      if (check.type === 'shell_exit_zero' && !hasPassedEvidence(bundle, 'shell_success')) {
        missingChecks.push(check.description);
        continue;
      }

      if (check.type === 'python_exit_zero' && !hasPassedEvidence(bundle, 'python_success')) {
        missingChecks.push(check.description);
        continue;
      }

      if (check.type === 'duckdb_checks_pass' && !hasPassedEvidence(bundle, 'duckdb_checks_pass')) {
        missingChecks.push(check.description);
        continue;
      }

      if (check.type === 'artifact_exists') {
        const found = bundle.evidence.some((item) => item.artifactPath === check.artifactPath);
        if (!found) {
          missingChecks.push(check.description);
        }
      }
    }

    if (missingChecks.length > 0) {
      return {
        status: 'FAIL',
        summary: `Required checks are still missing: ${missingChecks.join('; ')}`,
        evidence: bundle.evidence.map((item) => item.summary),
        missingChecks,
        nextAction: 'Gather the missing evidence or perform another execution round.',
      };
    }

    return {
      status: 'PASS',
      summary: 'Rule-based verification passed.',
      evidence: bundle.evidence.map((item) => item.summary),
      missingChecks: [],
      nextAction: 'Stop executing and return the verified result.',
    };
  }
}

export class ModelVerifier implements Verifier {
  private readonly model: OpenAIModelAdapter;

  constructor(model: OpenAIModelAdapter) {
    this.model = model;
  }

  async verify(bundle: EvidenceBundle): Promise<VerifierResult> {
    const systemPrompt = `You are a verification model for a coding and data-analysis agent.
Return strict JSON with keys: status, summary, evidence, missingChecks, nextAction.
status must be one of PASS, FAIL, BLOCKED.
Only use BLOCKED when the task cannot progress without a new external condition.
Only use PASS when the current evidence proves the task is complete.`;
    const userPrompt = JSON.stringify(bundle, null, 2);
    return this.model.generateJson<VerifierResult>(systemPrompt, userPrompt, {
      model: undefined,
      temperature: 0.1,
    });
  }
}

export async function verifyWithFallback(ruleVerifier: Verifier, modelVerifier: Verifier, bundle: EvidenceBundle): Promise<VerifierResult> {
  const ruleResult = await ruleVerifier.verify(bundle);
  if (ruleResult.status !== 'FAIL' || ruleResult.missingChecks.length === 0) {
    return ruleResult;
  }

  let modelResult: VerifierResult;
  try {
    modelResult = await modelVerifier.verify(bundle);
  } catch {
    return ruleResult;
  }
  if (modelResult.status === 'PASS' || modelResult.status === 'BLOCKED') {
    return modelResult;
  }

  return {
    ...modelResult,
    evidence: [...new Set([...ruleResult.evidence, ...modelResult.evidence])],
    missingChecks: modelResult.missingChecks.length > 0 ? modelResult.missingChecks : ruleResult.missingChecks,
  };
}
