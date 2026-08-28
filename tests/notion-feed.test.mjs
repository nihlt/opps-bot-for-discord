import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toFeedProperties } from '../src/lib/notion-feed.js';

describe('toFeedProperties', () => {
  it('maps the core Opportunity fields onto Notion property shapes', () => {
    const props = toFeedProperties({
      id: 'abc123',
      sourceId: 'dou-ai',
      kind: 'event',
      title: 'AI Meetup',
      link: 'https://dou.ua/calendar/1/',
      location: 'Online',
      payment: null,
      tags: ['AI', 'meetup'],
      description: 'A short meetup about AI.',
      company: null,
      dateNormalized: '2026-09-01',
      dateEndNormalized: null,
    });

    assert.deepEqual(props.Name, { title: [{ text: { content: 'AI Meetup' } }] });
    assert.deepEqual(props.Kind, { select: { name: 'event' } });
    assert.deepEqual(props.Source, { select: { name: 'dou-ai' } });
    assert.deepEqual(props['External Id'], { rich_text: [{ text: { content: 'abc123' } }] });
    assert.deepEqual(props.Link, { url: 'https://dou.ua/calendar/1/' });
    assert.deepEqual(props.Tags, { multi_select: [{ name: 'AI' }, { name: 'meetup' }] });
    assert.deepEqual(props.Location, { rich_text: [{ text: { content: 'Online' } }] });
    assert.deepEqual(props.Description, { rich_text: [{ text: { content: 'A short meetup about AI.' } }] });
    assert.deepEqual(props.Deadline, { date: { start: '2026-09-01', end: undefined } });
    assert.equal(props.Payment, undefined);
    assert.equal(props.Company, undefined);
    assert.equal(props.Summary, undefined);
    assert.equal(typeof props.Score.number, 'number');
    assert.deepEqual(props.Payable, { checkbox: false });
  });

  it('sets Payable to true for a hackathon/fellowship with a real prize figure', () => {
    const props = toFeedProperties({
      id: 'x',
      sourceId: 'dou-hackathon',
      kind: 'event',
      title: 'AI Hackathon',
      tags: [],
      payment: '500 000 грн',
    });
    assert.deepEqual(props.Payable, { checkbox: true });
  });

  it('includes Summary when present, omits it when absent', () => {
    const withSummary = toFeedProperties({ id: 'x', sourceId: 'ain', kind: 'event', title: 't', summary: 'Concrete benefit.' });
    assert.deepEqual(withSummary.Summary, { rich_text: [{ text: { content: 'Concrete benefit.' } }] });

    const withoutSummary = toFeedProperties({ id: 'x', sourceId: 'ain', kind: 'event', title: 't', summary: null });
    assert.equal(withoutSummary.Summary, undefined);
  });

  it('includes a date range when dateEndNormalized is set', () => {
    const props = toFeedProperties({
      id: 'x',
      sourceId: 'dou-hackathon',
      kind: 'event',
      title: 't',
      dateNormalized: '2026-09-01',
      dateEndNormalized: '2026-09-03',
    });
    assert.deepEqual(props.Deadline, { date: { start: '2026-09-01', end: '2026-09-03' } });
  });

  it('omits Deadline entirely when there is no date', () => {
    const props = toFeedProperties({ id: 'x', sourceId: 'ain', kind: 'event', title: 't' });
    assert.equal(props.Deadline, undefined);
  });

  it('truncates very long text fields instead of sending them raw', () => {
    const longDescription = 'a'.repeat(3000);
    const props = toFeedProperties({ id: 'x', sourceId: 'ain', kind: 'event', title: 't', description: longDescription });
    assert.ok(props.Description.rich_text[0].text.content.length <= 1901);
    assert.ok(props.Description.rich_text[0].text.content.endsWith('…'));
  });
});
