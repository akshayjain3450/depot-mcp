import { describe, expect, it } from 'vitest';
import { TextBudget } from '../../src/lib/budget.js';

describe('TextBudget overflow', () => {
  it('rejects every later line once it has overflowed, so the summary has no holes', () => {
    const budget = new TextBudget(30);
    budget.push('a'.repeat(25));
    budget.push('b'.repeat(20));
    budget.push('c');

    expect(budget.didOverflow).toBe(true);
    const rendered = budget.render();
    expect(rendered).toContain('a'.repeat(25));
    expect(rendered).not.toContain('bbbb');
    expect(rendered).not.toMatch(/^c$/m);
  });

  it('truncates the offending line into the remaining room instead of dropping it', () => {
    const budget = new TextBudget(60);
    budget.push('a'.repeat(20));
    budget.push('b'.repeat(100));
    budget.push('c');

    expect(budget.didOverflow).toBe(true);
    const rendered = budget.render();
    const body = rendered.split('\n[output truncated')[0] ?? '';
    expect(body.length).toBeLessThanOrEqual(60);
    expect(body).toContain('b'.repeat(30));
    expect(body).toContain('…');
    expect(body).not.toContain('b'.repeat(100));
    expect(rendered).not.toMatch(/^c$/m);
  });

  it('drops the offending line outright when too little room is left for a useful fragment', () => {
    const budget = new TextBudget(30);
    budget.push('a'.repeat(25));
    budget.push('b'.repeat(100));

    expect(budget.didOverflow).toBe(true);
    expect(budget.render()).not.toContain('bbbb');
  });

  it('still accepts a line that exactly fills the budget', () => {
    const budget = new TextBudget(10);
    budget.push('a'.repeat(9));

    expect(budget.didOverflow).toBe(false);
    expect(budget.render()).toBe('a'.repeat(9));
  });
});
