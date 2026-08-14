import { describe, expect, it, loadServerModule, RUNTIME_DIST } from './harness.ts';

type HistoryEntry = {
  event_id: string;
  sender: string;
  ts: string;
  body: string;
  [key: string]: unknown;
};

const { renderHistory } = await loadServerModule<{
  renderHistory: (entries: HistoryEntry[]) => string;
}>('history');

const ENTRY: HistoryEntry = {
  event_id: '$one:example.org',
  sender: '@bob:example.org',
  ts: '2026-08-13T10:00:00.000Z',
  text: 'ship it',
};

describe('renderHistory', () => {
  it('says so plainly when there is nothing', () => {
    expect(renderHistory([])).toBe('(no messages)');
  });

  it('puts the event id on the line, so a reply can quote it', () => {
    expect(renderHistory([ENTRY])).toContain('$one:example.org');
  });

  it('keeps sender, timestamp and text on one line each', () => {
    const rendered = renderHistory([ENTRY, { ...ENTRY, event_id: '$two:example.org' }]);
    expect(rendered.split('\n')).toHaveLength(2);
    expect(rendered).toContain('@bob:example.org');
    expect(rendered).toContain('2026-08-13T10:00:00.000Z');
    expect(rendered).toContain('ship it');
  });

  it('marks an attachment with its kind and name', () => {
    const rendered = renderHistory([
      { ...ENTRY, text: 'chart', attachment: { kind: 'image', name: 'chart.png' } },
    ]);
    expect(rendered).toContain('[image: chart.png]');
  });

  it('marks an attachment with no name by kind alone', () => {
    const rendered = renderHistory([{ ...ENTRY, text: '', attachment: { kind: 'voice' } }]);
    expect(rendered).toContain('[voice]');
  });

  it('flags an edited message, so a stale quote is recognisable', () => {
    expect(renderHistory([{ ...ENTRY, edited: true }])).toContain('(edited)');
  });
});
