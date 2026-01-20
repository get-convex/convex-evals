import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const GUIDELINES_ROOT = join(import.meta.dir, '..', 'generated');
const TMP_ROOT = join(import.meta.dir, '..', 'tmp');

export function sanitizeModelName(model: string): string {
  return model.replace(/\//g, '_');
}

export function getModelSlug(provider: string, model: string): string {
  return `${provider}_${sanitizeModelName(model)}`;
}

export function getCommittedGuidelinesPath(provider: string, model: string): string {
  const slug = getModelSlug(provider, model);
  return join(GUIDELINES_ROOT, `${slug}_guidelines.txt`);
}

export function getTmpModelDir(provider: string, model: string): string {
  const slug = getModelSlug(provider, model);
  return join(TMP_ROOT, slug);
}

export function getLockFilePath(provider: string, model: string): string {
  return join(getTmpModelDir(provider, model), '.lock');
}

export function getRunDir(provider: string, model: string, runId: string): string {
  return join(getTmpModelDir(provider, model), runId);
}

export function readGuidelines(provider: string, model: string): string {
  const path = getCommittedGuidelinesPath(provider, model);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

export function writeGuidelines(provider: string, model: string, content: string): void {
  const path = getCommittedGuidelinesPath(provider, model);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

export function readWorkingGuidelines(provider: string, model: string, runId: string): string {
  const path = join(getRunDir(provider, model, runId), 'working_guidelines.txt');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

export function writeWorkingGuidelines(provider: string, model: string, runId: string, content: string): void {
  const path = join(getRunDir(provider, model, runId), 'working_guidelines.txt');
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

export function readProposal(provider: string, model: string, runId: string, proposalNum: number): string {
  const path = join(getRunDir(provider, model, runId), `proposal_${String(proposalNum).padStart(3, '0')}.txt`);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

export function writeProposal(provider: string, model: string, runId: string, proposalNum: number, content: string): void {
  const path = join(getRunDir(provider, model, runId), `proposal_${String(proposalNum).padStart(3, '0')}.txt`);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

export function countTokens(text: string): number {
  // Simple approximation: ~4 chars per token
  return Math.ceil(text.length / 4);
}
